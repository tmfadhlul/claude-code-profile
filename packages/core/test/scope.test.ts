import { describe, it, expect } from 'vitest'
import { globToRegExp, inScope, scopeReport } from '../src/scope.js'

describe('globToRegExp', () => {
  it('matches * within one segment only', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false)
  })

  it('matches ** across any depth, including zero', () => {
    const re = globToRegExp('src/web/**')
    expect(re.test('src/web/Hero.tsx')).toBe(true)
    expect(re.test('src/web/a/b/c.tsx')).toBe(true)
    expect(globToRegExp('src/**/x.ts').test('src/x.ts')).toBe(true) // ** may be empty
    expect(re.test('src/server/api.ts')).toBe(false)
  })

  it('escapes regex metacharacters so a dot is a literal dot', () => {
    expect(globToRegExp('a.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('a.ts').test('axts')).toBe(false)
    expect(globToRegExp('pkg(1)/a.ts').test('pkg(1)/a.ts')).toBe(true)
  })

  it('anchors — a lane must not match a longer sibling path', () => {
    expect(globToRegExp('src/web').test('src/website')).toBe(false)
  })
})

describe('inScope', () => {
  it('accepts anything when no lane is declared', () => {
    expect(inScope('anywhere/at/all.ts', [])).toBe(true)
  })

  it('passes a file inside any one of several lanes', () => {
    const lanes = ['src/web/**', 'src/styles/**']
    expect(inScope('src/styles/tokens.css', lanes)).toBe(true)
    expect(inScope('src/server/db.ts', lanes)).toBe(false)
  })

  it('treats windows separators as path separators', () => {
    expect(inScope('src\\web\\Hero.tsx', ['src/web/**'])).toBe(true)
  })
})

describe('scopeReport', () => {
  const fp = (s: string) => s

  it('flags a file the delegate created outside its lane', () => {
    const before = new Map<string, string>()
    const after = new Map([['src/web/Hero.tsx', fp('a')], ['src/server/routes.ts', fp('b')]])
    const r = scopeReport(before, after, ['src/web/**'])
    expect(r.touched).toEqual(['src/server/routes.ts', 'src/web/Hero.tsx'])
    expect(r.violations).toEqual(['src/server/routes.ts'])
  })

  it('catches a further edit to a file that was already dirty', () => {
    // a bare path-set diff would miss this: the path is in both snapshots
    const before = new Map([['src/server/routes.ts', fp('v1')]])
    const after = new Map([['src/server/routes.ts', fp('v2')]])
    expect(scopeReport(before, after, ['src/web/**']).violations).toEqual(['src/server/routes.ts'])
  })

  it('ignores a pre-existing dirty file the delegate did not touch', () => {
    const same = new Map([['src/server/routes.ts', fp('v1')]])
    const r = scopeReport(same, new Map(same), ['src/web/**'])
    expect(r.touched).toEqual([])
    expect(r.violations).toEqual([])
  })

  it('reports touched files with no violations when the lane holds', () => {
    const after = new Map([['src/web/a.tsx', fp('x')], ['src/web/b.tsx', fp('y')]])
    const r = scopeReport(new Map(), after, ['src/web/**'])
    expect(r.touched).toHaveLength(2)
    expect(r.violations).toEqual([])
  })
})
