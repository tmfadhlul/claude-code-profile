import type { Manifest, ProfileDecl } from './manifest.js'
import type { Platform } from './platform.js'

export const BEGIN_MARK = '# >>> ccprofiles managed >>>'
export const END_MARK = '# <<< ccprofiles managed <<<'
const SECRET_PREFIX = 'secret://'

// Defense in depth: manifest validation already rejects shell metacharacters in
// identifiers, but free-form env *values* are still escaped for their quoted context.
function escapePosix(v: string): string {
  return v.replace(/(["\\$`])/g, '\\$1') // inside "..." — escape " \ $ `
}
function escapePwsh(v: string): string {
  return v.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$') // inside "..." — ` is PS escape
}

function homeVar(p: Platform): string {
  return p.os === 'win32' ? '$env:USERPROFILE' : '$HOME'
}

function profileDirExpr(pr: ProfileDecl, p: Platform): string {
  const suffix = pr.dir.replace('{home}', '')
  return p.os === 'win32' ? homeVar(p) + suffix.replaceAll('/', '\\') : homeVar(p) + suffix
}

function renderPosix(pr: ProfileDecl, p: Platform): string {
  const lines = [`${pr.launcher}() {`]
  for (const [k, v] of Object.entries(pr.env)) {
    lines.push(v.startsWith(SECRET_PREFIX)
      ? `  export ${k}="$(ccprofiles secrets get ${v.slice(SECRET_PREFIX.length)})"`
      : `  export ${k}="${escapePosix(v)}"`)
  }
  const flag = pr.skipPermissions ? ' --dangerously-skip-permissions' : ''
  lines.push(`  CLAUDE_CONFIG_DIR="${profileDirExpr(pr, p)}" claude${flag} "$@"`, '}')
  return lines.join('\n')
}

function renderPwsh(pr: ProfileDecl, p: Platform): string {
  const lines = [`function ${pr.launcher} {`]
  for (const [k, v] of Object.entries(pr.env)) {
    lines.push(v.startsWith(SECRET_PREFIX)
      ? `  $env:${k} = (ccprofiles secrets get ${v.slice(SECRET_PREFIX.length)})`
      : `  $env:${k} = "${escapePwsh(v)}"`)
  }
  const flag = pr.skipPermissions ? ' --dangerously-skip-permissions' : ''
  lines.push(`  $env:CLAUDE_CONFIG_DIR = "${profileDirExpr(pr, p)}"`, `  claude${flag} @args`, '}')
  return lines.join('\n')
}

export function renderRcBlock(m: Manifest, p: Platform): string {
  const fns = m.profiles
    .filter(pr => pr.launcher)
    .map(pr => (p.os === 'win32' ? renderPwsh(pr, p) : renderPosix(pr, p)))
  return [BEGIN_MARK, ...fns, END_MARK].join('\n')
}

export function upsertManagedBlock(content: string, block: string): string {
  const start = content.indexOf(BEGIN_MARK)
  const end = content.indexOf(END_MARK)
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + block + content.slice(end + END_MARK.length)
  }
  return content.trimEnd() + (content.trim() ? '\n\n' : '') + block + '\n'
}
