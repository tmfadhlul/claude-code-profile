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

/** True when `file` falls inside any lane. An empty scope list means "no lane declared". */
export function inScope(file: string, scopes: string[]): boolean {
  if (!scopes.length) return true
  const normalized = file.replace(/\\/g, '/')
  return scopes.some(s => globToRegExp(s.replace(/\\/g, '/')).test(normalized))
}

export interface ScopeReport {
  touched: string[]
  violations: string[]
}

/**
 * Which files the delegate touched, and which of those left the lane.
 *
 * `before`/`after` map a repo-relative path to a change fingerprint (see snapshotChanges).
 * A path is "touched" if it appears only in `after`, or if its fingerprint moved.
 */
export function scopeReport(
  before: Map<string, string>,
  after: Map<string, string>,
  scopes: string[],
): ScopeReport {
  const touched: string[] = []
  for (const [file, fp] of after) {
    if (before.get(file) !== fp) touched.push(file)
  }
  touched.sort()
  return { touched, violations: touched.filter(f => !inScope(f, scopes)) }
}
