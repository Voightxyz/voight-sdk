/**
 * Tests for the pure helpers in `setup.ts`.
 *
 * `runSetup` itself is integration-shaped (readline + filesystem +
 * process.exit), so it's exercised via manual verification at
 * publish time (B.8.4). The pure helpers below cover every input
 * decision the wizard makes — if these are right, the orchestration
 * is straightforward.
 */

import { describe, it, expect } from 'vitest'

import { parseArgs, parsePrivacyChoice } from '../../src/setup.js'

describe('parseArgs', () => {
  it('returns empty key + claude target on empty argv', () => {
    expect(parseArgs([])).toEqual({
      key: undefined,
      target: 'claude',
      privacy: undefined,
    })
  })

  it('parses --key flag (space-separated and =-separated)', () => {
    expect(parseArgs(['--key', 'vk_abc'])).toMatchObject({ key: 'vk_abc' })
    expect(parseArgs(['--key=vk_abc'])).toMatchObject({ key: 'vk_abc' })
  })

  it('parses --target flag and ignores unknown targets', () => {
    expect(parseArgs(['--target', 'cursor'])).toMatchObject({ target: 'cursor' })
    expect(parseArgs(['--target=codex'])).toMatchObject({ target: 'codex' })
    // Unknown target stays on default
    expect(parseArgs(['--target', 'vscode'])).toMatchObject({ target: 'claude' })
  })

  it('parses --privacy flag (numeric and named values)', () => {
    expect(parseArgs(['--privacy', 'minimal'])).toMatchObject({
      privacy: 'minimal',
    })
    expect(parseArgs(['--privacy=full'])).toMatchObject({ privacy: 'full' })
    expect(parseArgs(['--privacy', '1'])).toMatchObject({ privacy: 'minimal' })
    expect(parseArgs(['--privacy=2'])).toMatchObject({ privacy: 'standard' })
    expect(parseArgs(['--privacy', '3'])).toMatchObject({ privacy: 'full' })
  })

  it('drops invalid --privacy values to undefined (wizard re-asks)', () => {
    expect(parseArgs(['--privacy', 'paranoid'])).toMatchObject({
      privacy: undefined,
    })
    expect(parseArgs(['--privacy=4'])).toMatchObject({ privacy: undefined })
  })

  it('combines key + target + privacy in one invocation', () => {
    expect(
      parseArgs(['--target=cursor', '--privacy=minimal', '--key', 'vk_x']),
    ).toEqual({
      key: 'vk_x',
      target: 'cursor',
      privacy: 'minimal',
    })
  })
})

describe('parsePrivacyChoice', () => {
  it('maps numeric menu shortcuts', () => {
    expect(parsePrivacyChoice('1')).toBe('minimal')
    expect(parsePrivacyChoice('2')).toBe('standard')
    expect(parsePrivacyChoice('3')).toBe('full')
  })

  it('accepts the level names case-insensitively', () => {
    expect(parsePrivacyChoice('minimal')).toBe('minimal')
    expect(parsePrivacyChoice('STANDARD')).toBe('standard')
    expect(parsePrivacyChoice('Full')).toBe('full')
  })

  it('returns the default on empty / whitespace-only input', () => {
    expect(parsePrivacyChoice('')).toBe('standard')
    expect(parsePrivacyChoice('   ')).toBe('standard')
  })

  it('uses the supplied default when caller overrides', () => {
    expect(parsePrivacyChoice('', 'minimal')).toBe('minimal')
    expect(parsePrivacyChoice('   ', 'full')).toBe('full')
  })

  it('returns null when caller passes default=null and input is empty', () => {
    // The CLI flag parser uses this: an empty `--privacy` value is an
    // invalid invocation, not a request for the recommended default.
    expect(parsePrivacyChoice('', null)).toBeNull()
    expect(parsePrivacyChoice('   ', null)).toBeNull()
  })

  it('returns null on garbage so the wizard can re-prompt', () => {
    expect(parsePrivacyChoice('paranoid')).toBeNull()
    expect(parsePrivacyChoice('4')).toBeNull()
    expect(parsePrivacyChoice('-1')).toBeNull()
  })
})
