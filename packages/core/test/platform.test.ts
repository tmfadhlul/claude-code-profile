import { describe, it, expect } from 'vitest'
import { detectPlatform, renderPath, toTemplate } from '../src/platform.js'

describe('platform', () => {
  const mac = detectPlatform({ osKind: 'darwin', home: '/Users/x', shell: '/bin/zsh' })
  const win = detectPlatform({ osKind: 'win32', home: 'C:\\Users\\x' })

  it('picks zshrc for zsh shells', () => {
    expect(mac.rcFile).toBe('/Users/x/.zshrc')
  })
  it('picks bashrc otherwise', () => {
    expect(detectPlatform({ osKind: 'linux', home: '/home/x', shell: '/bin/bash' }).rcFile).toBe('/home/x/.bashrc')
  })
  it('picks PowerShell profile on windows', () => {
    expect(win.rcFile).toBe('C:\\Users\\x\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1')
  })
  it('renders {home} and separators', () => {
    expect(renderPath('{home}/.claude-oauth', mac)).toBe('/Users/x/.claude-oauth')
    expect(renderPath('{home}/.claude-oauth', win)).toBe('C:\\Users\\x\\.claude-oauth')
  })
  it('templates absolute paths back', () => {
    expect(toTemplate('/Users/x/.claude-oauth', mac)).toBe('{home}/.claude-oauth')
    expect(toTemplate('C:\\Users\\x\\.claude-oauth', win)).toBe('{home}/.claude-oauth')
  })
})
