import {
  discoverProfiles, buildManifest, saveManifest, executeApply,
  ensureRootGitignore, loadManifest, loadDevices, fetchRemote, fetchSecrets,
  writeAssets, parseManifest, backupFiles, renderRcBlock, upsertManagedBlock,
  atomicWrite, BEGIN_MARK, END_MARK, assertSafeManifest, preserveSecretRefs, type Manifest,
} from 'ccprofiles-core'
import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireManifest, type CliContext } from '../context.js'
import { secretsStore, migrateRcSecrets, migrateSettingsSecrets, KEY_VARS } from '../commands/secrets.js'
import { sendJson, readJson, HttpError, type Route } from './http.js'
import { planActions, planActionsPreflight } from '../plan.js'

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

function profileName(dirName: string): string {
  return dirName === '.claude' ? 'default' : dirName.slice('.claude-'.length)
}

export function buildRoutes(ctx: CliContext): Route[] {
  const routes: Route[] = []
  const add = (method: string, pattern: RegExp, handler: Route['handler']) => routes.push({ method, pattern, handler })

  // A missing secret ref is a recoverable/user-facing state (not a server error) — surface as 409.
  async function planActionsOr409(m: Manifest) {
    try { return await planActions(ctx, m) }
    catch (e) {
      const msg = (e as Error).message
      if (/secret not found/.test(msg)) throw new HttpError(409, msg)
      throw e
    }
  }

  async function applyAndReport(m: Manifest) {
    const actions = await planActionsOr409(m)
    return executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp() })
  }

  // requireManifest throws a plain Error; surface "no manifest yet" as a 409 the UI can detect.
  async function mustManifest(): Promise<Manifest> {
    try { return await requireManifest(ctx) }
    catch (e) { throw new HttpError(409, (e as Error).message) }
  }

  // Guard mutation routes: never persist a manifest that would interpolate unsafely into the rc file.
  function assertSafe(m: Manifest): void {
    try { assertSafeManifest(m) }
    catch (e) { throw new HttpError(400, (e as Error).message) }
  }

  function targetsOf(m: Manifest, targets: string[] | 'all'): string[] {
    if (targets === 'all') return m.profiles.map(p => p.name)
    for (const t of targets) if (!m.profiles.some(p => p.name === t)) throw new HttpError(400, `unknown profile: ${t}`)
    return targets
  }

  // ── adopt / profiles / status / apply / doctor ──────────────────────────────
  add('POST', /^\/api\/adopt$/, async (_m, _req, res) => {
    const manifest = buildManifest(await discoverProfiles(ctx.home), ctx.platform)
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
      const oldM = await loadManifest(ctx.manifestRoot)
      let store: Awaited<ReturnType<typeof secretsStore>> | null = null
      await preserveSecretRefs(manifest, oldM, async name => { store ??= await secretsStore(ctx); return store.get(name) })
    }
    if (!existsSync(join(ctx.manifestRoot, '.git'))) {
      try { execFileSync('git', ['init', ctx.manifestRoot], { stdio: 'ignore' }) } catch { /* git optional */ }
    }
    await ensureRootGitignore(ctx.manifestRoot)
    await saveManifest(ctx.manifestRoot, manifest)
    sendJson(res, 200, { profiles: manifest.profiles.length, mcpServers: Object.keys(manifest.mcpServers).length })
  })

  add('GET', /^\/api\/profiles$/, async (_m, _req, res) => {
    const live = await discoverProfiles(ctx.home)
    let manifest: Manifest | null = null
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) manifest = await loadManifest(ctx.manifestRoot)
    const rows = live.map(lp => {
      const name = profileName(lp.dirName)
      const decl = manifest?.profiles.find(p => p.name === name) ?? null
      return {
        name, dir: lp.dir, auth: decl?.auth ?? (lp.account ? 'oauth' : 'env'),
        account: lp.account, mcp: Object.keys(lp.mcpServers).length,
        launcher: decl?.launcher ?? (name === 'default' ? null : `cl-${name}`),
        adopted: !!decl,
        env: decl?.env ?? {}, links: decl?.links ?? {}, mcpNames: decl?.mcp ?? [],
        settingsEnv: decl?.settingsEnv ?? {}, liveSettingsEnv: lp.settingsEnv,
        skipPermissions: decl?.skipPermissions ?? false,
      }
    })
    sendJson(res, 200, rows)
  })

  add('POST', /^\/api\/profiles$/, async (_m, req, res) => {
    const { name, from } = await readJson<{ name: string; from?: string }>(req)
    if (!name) throw new HttpError(400, 'name required')
    const m = await mustManifest()
    if (m.profiles.some(p => p.name === name)) throw new HttpError(409, `profile exists: ${name}`)
    const src = from ? m.profiles.find(p => p.name === from) : null
    if (from && !src) throw new HttpError(400, `unknown profile: ${from}`)
    m.profiles.push({
      name, dir: `{home}/.claude-${name}`, launcher: `cl-${name}`, auth: 'env', env: {},
      links: src ? { ...src.links } : (m.hub ? { skills: 'hub', commands: 'hub' } : {}),
      mcp: src ? [...src.mcp] : [],
      settingsEnv: {},
      skipPermissions: false,
    })
    assertSafe(m)
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(m)
    sendJson(res, 200, { ok: true })
  })

  add('PATCH', /^\/api\/profiles\/([^/]+)$/, async (mtch, req, res) => {
    const m = await mustManifest()
    const name = decodeURIComponent(mtch[1])
    const pr = m.profiles.find(p => p.name === name)
    if (!pr) throw new HttpError(404, `unknown profile: ${name}`)
    const body = await readJson<{ env?: Record<string, string>; links?: Record<string, string>; launcher?: string | null; settingsEnv?: Record<string, string>; skipPermissions?: boolean }>(req)
    if (body.env) {
      if (!Object.values(body.env).every(v => typeof v === 'string')) throw new HttpError(400, 'env values must be strings')
      pr.env = body.env
    }
    if (body.links) {
      if (!Object.values(body.links).every(v => typeof v === 'string')) throw new HttpError(400, 'links values must be strings')
      pr.links = body.links
    }
    if (body.launcher !== undefined) pr.launcher = body.launcher
    if (body.settingsEnv) {
      for (const v of Object.values(body.settingsEnv)) if (typeof v !== 'string') throw new HttpError(400, 'settingsEnv values must be strings')
      pr.settingsEnv = body.settingsEnv
    }
    if (body.skipPermissions !== undefined) {
      if (typeof body.skipPermissions !== 'boolean') throw new HttpError(400, 'skipPermissions must be a boolean')
      pr.skipPermissions = body.skipPermissions
    }
    assertSafe(m)
    try { await planActionsPreflight(ctx, m) } catch (e) { throw new HttpError(400, (e as Error).message) }
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(m)
    sendJson(res, 200, { ok: true })
  })

  add('DELETE', /^\/api\/profiles\/([^/]+)$/, async (mtch, _req, res) => {
    const m = await mustManifest()
    const name = decodeURIComponent(mtch[1])
    const idx = m.profiles.findIndex(p => p.name === name)
    if (idx === -1) throw new HttpError(404, `unknown profile: ${name}`)
    if (m.hub === name) throw new HttpError(400, `profile "${name}" is the hub — change the hub first`)
    m.profiles.splice(idx, 1)
    for (const s of Object.keys(m.mcpServers))
      if (!m.profiles.some(p => p.mcp.includes(s))) delete m.mcpServers[s]
    assertSafe(m)
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(m)
    sendJson(res, 200, { ok: true })
  })

  add('GET', /^\/api\/status$/, async (_m, _req, res) => {
    const m = await mustManifest()
    const actions = await planActionsOr409(m)
    const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: true })
    sendJson(res, 200, { inSync: actions.length === 0, pending: r.performed })
  })

  add('POST', /^\/api\/apply$/, async (_m, _req, res) => {
    const m = await mustManifest()
    const r = await applyAndReport(m)
    sendJson(res, 200, { performed: r.performed, backupDir: r.backupDir })
  })

  add('GET', /^\/api\/doctor$/, async (_m, _req, res) => {
    const problems: string[] = []
    const live = await discoverProfiles(ctx.home)
    let man: Manifest | null = null
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) man = await loadManifest(ctx.manifestRoot)
    for (const lp of live) {
      for (const nm of readdirSync(lp.dir)) {
        const f = join(lp.dir, nm)
        try { if (lstatSync(f).isSymbolicLink() && !existsSync(f)) problems.push(`broken symlink: ${f} -> ${readlinkSync(f)}`) } catch { /* skip */ }
      }
      const decl = man?.profiles.find(p => p.name === profileName(lp.dirName)) ?? null
      for (const varName of KEY_VARS) {
        if (lp.settingsEnv[varName] && !decl?.settingsEnv[varName])
          problems.push(`plaintext token ${varName} in ${join(lp.dir, 'settings.json')} — adopt profile then run: secrets migrate`)
        if (decl?.settingsEnv[varName] && !decl.settingsEnv[varName].startsWith('secret://'))
          problems.push(`plaintext token ${varName} in manifest for profile "${profileName(lp.dirName)}" — run: secrets migrate`)
      }
    }
    if (existsSync(ctx.platform.rcFile)) {
      const rc = readFileSync(ctx.platform.rcFile, 'utf8')
      const outside = rc.split('# >>> ccprofiles managed >>>')[0] + (rc.split('# <<< ccprofiles managed <<<')[1] ?? '')
      if (/sk-ant-/.test(outside)) problems.push(`plaintext Anthropic key in ${ctx.platform.rcFile} — run secrets migrate`)
    }
    if (man) for (const pr of man.profiles) {
      const dir = pr.dir.replace('{home}', ctx.home)
      if (!existsSync(dir)) problems.push(`manifest profile "${pr.name}" missing on disk: ${dir} — run apply`)
    }
    sendJson(res, 200, { problems })
  })

  // ── shell rc ────────────────────────────────────────────────────────────────
  function currentRcBlock(): string | null {
    if (!existsSync(ctx.platform.rcFile)) return null
    const rc = readFileSync(ctx.platform.rcFile, 'utf8')
    const start = rc.indexOf(BEGIN_MARK)
    const end = rc.indexOf(END_MARK)
    if (start === -1 || end === -1 || end < start) return null
    return rc.slice(start, end + END_MARK.length)
  }

  add('GET', /^\/api\/rc$/, async (_m, _req, res) => {
    const m = await mustManifest()
    const rendered = renderRcBlock(m, ctx.platform)
    const current = currentRcBlock()
    sendJson(res, 200, { rcFile: ctx.platform.rcFile, current, rendered, inSync: current === rendered })
  })

  add('POST', /^\/api\/rc$/, async (_m, _req, res) => {
    const m = await mustManifest()
    const rendered = renderRcBlock(m, ctx.platform)
    let rc = ''
    let backupDir: string | null = null
    if (existsSync(ctx.platform.rcFile)) {
      rc = readFileSync(ctx.platform.rcFile, 'utf8')
      backupDir = await backupFiles([ctx.platform.rcFile], ctx.backupRoot, stamp())
    }
    await atomicWrite(ctx.platform.rcFile, upsertManagedBlock(rc, rendered))
    sendJson(res, 200, { ok: true, backupDir })
  })

  // ── mcp ─────────────────────────────────────────────────────────────────────
  add('GET', /^\/api\/mcp$/, async (_m, _req, res) => {
    const m = await mustManifest()
    sendJson(res, 200, {
      servers: Object.keys(m.mcpServers).sort(),
      profiles: m.profiles.map(p => ({ name: p.name, has: p.mcp })),
    })
  })

  add('POST', /^\/api\/mcp$/, async (_m, req, res) => {
    const { name, command, args, targets } = await readJson<{ name: string; command?: string; args?: string[]; targets: string[] | 'all' }>(req)
    if (!name) throw new HttpError(400, 'name required')
    const m = await mustManifest()
    if (!m.mcpServers[name]) {
      if (!command) throw new HttpError(400, `unknown server "${name}" — command required to define it`)
      m.mcpServers[name] = { command, ...(args && args.length ? { args } : {}) }
    }
    for (const t of targetsOf(m, targets)) {
      const pr = m.profiles.find(p => p.name === t)!
      if (!pr.mcp.includes(name)) pr.mcp.push(name)
    }
    assertSafe(m)
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(m)
    sendJson(res, 200, { ok: true })
  })

  add('DELETE', /^\/api\/mcp\/([^/]+)$/, async (mtch, req, res) => {
    const { targets } = await readJson<{ targets: string[] | 'all' }>(req)
    const m = await mustManifest()
    const name = decodeURIComponent(mtch[1])
    for (const t of targetsOf(m, targets)) {
      const pr = m.profiles.find(p => p.name === t)!
      pr.mcp = pr.mcp.filter(x => x !== name)
    }
    if (!m.profiles.some(p => p.mcp.includes(name))) delete m.mcpServers[name]
    assertSafe(m)
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(m)
    sendJson(res, 200, { ok: true })
  })

  add('POST', /^\/api\/mcp\/sync$/, async (_m, req, res) => {
    const { from, to } = await readJson<{ from: string; to: string[] | 'all' }>(req)
    const m = await mustManifest()
    const src = m.profiles.find(p => p.name === from)
    if (!src) throw new HttpError(400, `unknown profile: ${from}`)
    for (const t of targetsOf(m, to)) {
      if (t === src.name) continue
      m.profiles.find(p => p.name === t)!.mcp = [...src.mcp]
    }
    assertSafe(m)
    await saveManifest(ctx.manifestRoot, m)
    await applyAndReport(m)
    sendJson(res, 200, { ok: true })
  })

  // ── secrets ─────────────────────────────────────────────────────────────────
  add('GET', /^\/api\/secrets$/, async (_m, _req, res) => {
    let store
    try { store = await secretsStore(ctx) }
    catch (e) { return sendJson(res, 200, { names: [], backend: 'unavailable', error: (e as Error).message }) }
    sendJson(res, 200, { names: await store.list(), backend: store.backendName })
  })
  add('GET', /^\/api\/secrets\/([^/]+)$/, async (mtch, _req, res) => {
    const store = await secretsStore(ctx)
    const value = await store.get(decodeURIComponent(mtch[1]))
    if (value === null) throw new HttpError(404, 'not found')
    sendJson(res, 200, { value })
  })
  add('PUT', /^\/api\/secrets\/([^/]+)$/, async (mtch, req, res) => {
    const { value } = await readJson<{ value: string }>(req)
    if (typeof value !== 'string') throw new HttpError(400, 'value required')
    const store = await secretsStore(ctx)
    await store.set(decodeURIComponent(mtch[1]), value)
    sendJson(res, 200, { ok: true })
  })
  add('DELETE', /^\/api\/secrets\/([^/]+)$/, async (mtch, _req, res) => {
    const name = decodeURIComponent(mtch[1])
    const ref = `secret://${name}`
    if (existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
      const m = await loadManifest(ctx.manifestRoot)
      for (const pr of m.profiles) {
        for (const [k, v] of Object.entries(pr.env)) if (v === ref) throw new HttpError(409, `secret "${name}" is referenced by profile "${pr.name}" (${k}) — detach it first`)
        for (const [k, v] of Object.entries(pr.settingsEnv)) if (v === ref) throw new HttpError(409, `secret "${name}" is referenced by profile "${pr.name}" (${k}) — detach it first`)
      }
    }
    const store = await secretsStore(ctx)
    await store.delete(name)
    sendJson(res, 200, { ok: true })
  })
  add('POST', /^\/api\/secrets\/migrate$/, async (_m, _req, res) => {
    const migrated = [...await migrateRcSecrets(ctx), ...await migrateSettingsSecrets(ctx)]
    // Apply so the manifest's newly-minted secret:// refs are (re-)resolved and written back out.
    if (migrated.length && existsSync(join(ctx.manifestRoot, 'manifest.yaml'))) {
      const m = await loadManifest(ctx.manifestRoot)
      await applyAndReport(m)
    }
    sendJson(res, 200, { migrated })
  })

  // ── devices / sync ──────────────────────────────────────────────────────────
  add('GET', /^\/api\/devices$/, async (_m, _req, res) => {
    sendJson(res, 200, await loadDevices(ctx.manifestRoot))
  })

  add('POST', /^\/api\/sync$/, async (_m, req, res) => {
    const { from, withSecrets, dryRun } = await readJson<{ from: string; withSecrets?: boolean; dryRun?: boolean }>(req)
    const device = (await loadDevices(ctx.manifestRoot)).find(d => d.name === from)
    if (!device) throw new HttpError(400, `unknown device: ${from}`)
    const { manifestYaml, assets } = await fetchRemote(device)
    const m = parseManifest(manifestYaml)

    // Fetch+store secrets BEFORE touching local state, so a preflight below that needs
    // a just-transferred secret succeeds instead of failing after the manifest is overwritten.
    let secrets: string[] = []
    if (withSecrets) {
      const values = await fetchSecrets(device, [])
      if (!dryRun) { const store = await secretsStore(ctx); for (const [k, v] of Object.entries(values)) await store.set(k, v) }
      secrets = Object.keys(values)
    }

    // Validate the pulled manifest resolves cleanly before saving/applying anything — a peer
    // manifest with a settingsEnv secret ref we don't have must not overwrite local state.
    try { await planActionsPreflight(ctx, m) }
    catch (e) { throw new HttpError(409, (e as Error).message) }

    if (!dryRun) {
      await backupFiles([join(ctx.manifestRoot, 'manifest.yaml')], ctx.backupRoot, stamp())
      await saveManifest(ctx.manifestRoot, m)
      await writeAssets(assets, m, ctx.platform)
    }
    const actions = await planActions(ctx, m)
    const r = await executeApply(actions, { backupRoot: ctx.backupRoot, stamp: stamp(), dryRun: !!dryRun })
    sendJson(res, 200, { performed: r.performed, secrets })
  })

  return routes
}
