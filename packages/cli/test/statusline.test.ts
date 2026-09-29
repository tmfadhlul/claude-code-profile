import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_STATUS_LINE } from '../../core/src/manifest.js'
import { renderStatusline } from '../src/statusline.js'
import { ensureManifestStatusline, installDefaultStatusline } from '../src/statusline-install.js'

describe('bundled Claude statusline', () => {
  it('defaults new manifests and carries forward a declared custom line', () => {
    const created = { version: 1 as const, hub: null, profiles: [], mcpServers: {}, marketplaces: {} }
    ensureManifestStatusline(created)
    expect(created).toHaveProperty('statusLine', DEFAULT_STATUS_LINE)
    const rebuilt = { ...created, statusLine: undefined }
    const custom = { ...created, statusLine: { type: 'command', command: 'mine' } }
    ensureManifestStatusline(rebuilt, custom)
    expect(rebuilt.statusLine).toEqual(custom.statusLine)
  })

  it('renders the three-line layout from Claude status data', () => {
    const out = renderStatusline({
      model: { display_name: 'Opus' },
      context_window: { total_input_tokens: 12500, total_output_tokens: 500 },
      rate_limits: {
        five_hour: { used_percentage: 34.2, resets_at: 7200 },
        seven_day: { used_percentage: 71, resets_at: 200000 },
      },
    }, '/home/alex/.claude-work', { now: 0, branch: 'feature' }).replace(/\x1b\[[0-9;]*m/g, '')
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toContain('work · Opus · 13.0k ctx · feature')
    expect(out).toContain('S: 34.2% · W: 71.0% · Fable: —')
    expect(out).toContain('Reset: 2h00m')
  })

  it('installs default at 0600, preserves other settings and existing custom lines', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-statusline-'))
    const defaultDir = join(home, '.claude')
    const customDir = join(home, '.claude-work')
    await mkdir(defaultDir)
    await mkdir(customDir)
    await writeFile(join(defaultDir, 'settings.json'), JSON.stringify({ env: { KEEP: 'yes' } }))
    await writeFile(join(customDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    const changed = await installDefaultStatusline(home)
    expect(changed).toEqual([join(defaultDir, 'settings.json')])
    const saved = JSON.parse(await readFile(join(defaultDir, 'settings.json'), 'utf8'))
    expect(saved.env).toEqual({ KEEP: 'yes' })
    expect(saved.statusLine).toEqual(DEFAULT_STATUS_LINE)
    if (process.platform !== 'win32')
      expect((await stat(join(defaultDir, 'settings.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(customDir, 'settings.json'), 'utf8')).statusLine.command).toBe('mine')
    expect(await installDefaultStatusline(home)).toEqual([])
  })

  it('refuses to replace corrupt settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ccp-statusline-corrupt-'))
    await mkdir(join(home, '.claude'))
    await writeFile(join(home, '.claude', 'settings.json'), '{broken')
    await expect(installDefaultStatusline(home)).rejects.toThrow(/refusing to overwrite unreadable/)
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{broken')
  })
})
