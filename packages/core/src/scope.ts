/**
 * Path-lane enforcement for parallel delegation.
 *
 * Running two agents at once is only safe while they touch disjoint files. A scope stated in
 * the prompt is a request, not a constraint — models drift the moment a task turns out to need
 * a shared type or config. These helpers turn "they probably stayed in their lane" into a
 * checkable fact after the run.
 */

/**
 * Glob → RegExp for the subset that matters here: `**` (any depth, may be empty), `*` (one
 * segment), `?` (one char). Everything else is escaped literally. Deliberately not a full
 * globbing implementation — a scope is a coarse directory lane, not a filter language.
 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          // mid-pattern `a/**/b` must also match `a/b`, so the whole group is optional
          i++
          re += '(?:.*/)?'
        } else {
          // trailing `a/**` is "everything under a/", files included
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * A lane written as a bare directory (`src/web` or `src/web/`) means everything under it.
 * Taken literally it would match exactly zero files and flag every in-lane edit as a
 * violation — a footgun that makes the check useless in precisely the way that looks broken.
 */
export function normalizeScope(scope: string): string {
  const s = scope.replace(/\\/g, '/').replace(/\/+$/, '')
  return /[*?]/.test(s) ? s : `${s}/**`
}

/** True when `file` falls inside any lane. An empty scope list means "no lane declared". */
export function inScope(file: string, scopes: string[]): boolean {
  if (!scopes.length) return true
  const normalized = file.replace(/\\/g, '/')
  return scopes.some(s => globToRegExp(normalizeScope(s)).test(normalized))
}

export interface ScopeReport {
  touched: string[]
  violations: string[]
}

/**
 * Which files the delegate touched, and which of those left the lane.
 *
 * `before`/`after` map a repo-relative path to a change fingerprint (see snapshotChanges).
 * A path counts as touched if its fingerprint appeared, vanished, or moved — the vanish case
 * matters because a delegate that reverts your edit or deletes your untracked file would
 * otherwise be invisible.
 *
 * `committed` carries paths from commits the delegate made, which leave the working tree clean
 * and so never show up in either snapshot at all.
 */
export function scopeReport(
  before: Map<string, string>,
  after: Map<string, string>,
  scopes: string[],
  committed: string[] = [],
): ScopeReport {
  const touched = new Set(committed.map(f => f.replace(/\\/g, '/')))
  for (const [file, fp] of after) {
    if (before.get(file) !== fp) touched.add(file)
  }
  for (const file of before.keys()) {
    if (!after.has(file)) touched.add(file) // reverted or deleted
  }
  const list = [...touched].sort()
  return { touched: list, violations: list.filter(f => !inScope(f, scopes)) }
}
