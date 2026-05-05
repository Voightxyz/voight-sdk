/**
 * Tests for permission-denial classification.
 *
 * Each `it` block describes one shape of message the SDK might see
 * from Claude Code's `tool_response`, and asserts the expected
 * DenialType. The patterns are intentionally conservative — anything
 * that doesn't clearly match one of the five known shapes returns
 * null and is treated as a regular runtime error.
 */

import { describe, it, expect } from 'vitest'

import { detectDenial, DENIAL_TYPES } from '../../src/denials.js'

describe('detectDenial — null cases', () => {
  it('returns null for empty / undefined input', () => {
    expect(detectDenial('Bash', undefined)).toBeNull()
    expect(detectDenial('Bash', '')).toBeNull()
  })

  it('returns null for runtime errors that are not denials', () => {
    expect(detectDenial('Bash', 'ENOENT: no such file or directory')).toBeNull()
    expect(detectDenial('Bash', 'command not found: foo')).toBeNull()
    expect(
      detectDenial('Bash', 'segmentation fault (core dumped)'),
    ).toBeNull()
  })

  it('does not treat raw OS "permission denied" as a denial', () => {
    // A real Bash command failing with the OS-level error is NOT a
    // Voight permission denial — the tool ran. Only specific
    // Claude-Code-emitted phrases count.
    expect(
      detectDenial('Bash', 'cat: /etc/shadow: Permission denied'),
    ).toBeNull()
    expect(detectDenial('Bash', 'EACCES: permission denied')).toBeNull()
  })
})

describe('detectDenial — user_rejected', () => {
  it('matches "user rejected the tool call"', () => {
    const r = detectDenial('Bash', 'User rejected the tool call.')
    expect(r?.type).toBe('user_rejected')
    expect(r?.requestedTool).toBe('Bash')
  })

  it('matches "user did not approve"', () => {
    expect(
      detectDenial('Edit', 'The user did not approve the tool call.')?.type,
    ).toBe('user_rejected')
  })

  it('matches the real Claude Code rejection phrasing (0.3.10 fix)', () => {
    // This is the exact string Claude Code returns to the agent
    // when the user clicks "no" on the interactive approval prompt.
    // 0.3.9's regex missed it because it required the literal word
    // "user" right before "rejected". Real message has it as
    // "tool use was rejected" and "user doesn't want to proceed".
    const realMessage =
      "The user doesn't want to proceed with this tool use. " +
      'The tool use was rejected (eg. if it was a file edit, the ' +
      'new_string was NOT written to the file). STOP what you are ' +
      'doing and wait for the user to tell you how to proceed.'
    const r = detectDenial('WebFetch', realMessage)
    expect(r?.type).toBe('user_rejected')
    expect(r?.requestedTool).toBe('WebFetch')
  })

  it('matches "tool use was rejected" / "tool_use was rejected"', () => {
    expect(
      detectDenial('Bash', 'The tool use was rejected by the user.')?.type,
    ).toBe('user_rejected')
    expect(
      detectDenial('Bash', 'tool_use was rejected by policy.')?.type,
    ).toBe('user_rejected')
  })

  it('matches "user denied" / "user cancelled" / "user declined"', () => {
    expect(detectDenial('Write', 'User denied the operation.')?.type).toBe(
      'user_rejected',
    )
    expect(detectDenial('Bash', 'User cancelled this run')?.type).toBe(
      'user_rejected',
    )
    expect(detectDenial('Bash', 'User declined permission')?.type).toBe(
      'user_rejected',
    )
  })
})

describe('detectDenial — settings_blocked', () => {
  it('matches "blocked by settings" / "blocked by policy"', () => {
    expect(
      detectDenial('Bash', 'This tool is blocked by settings.')?.type,
    ).toBe('settings_blocked')
    expect(
      detectDenial('Bash', 'Blocked by policy configuration.')?.type,
    ).toBe('settings_blocked')
  })

  it('matches "tool is not allowed"', () => {
    expect(
      detectDenial('Bash', 'Tool is not allowed by user configuration')
        ?.type,
    ).toBe('settings_blocked')
  })

  it('matches "deny rule" / "forbidden by policy"', () => {
    expect(detectDenial('Bash', 'Matched a deny rule.')?.type).toBe(
      'settings_blocked',
    )
    expect(detectDenial('Bash', 'Forbidden by policy.')?.type).toBe(
      'settings_blocked',
    )
  })
})

describe('detectDenial — sandbox_denied', () => {
  it('matches "outside the allowed paths"', () => {
    expect(
      detectDenial('Edit', 'Path is outside the allowed directories.')?.type,
    ).toBe('sandbox_denied')
    expect(
      detectDenial('Edit', 'Target is outside permitted paths')?.type,
    ).toBe('sandbox_denied')
  })

  it('matches "sandbox refused / blocked / denied"', () => {
    expect(
      detectDenial('Bash', 'Sandbox refused to run this command.')?.type,
    ).toBe('sandbox_denied')
    expect(
      detectDenial('Bash', 'Sandbox denied write access.')?.type,
    ).toBe('sandbox_denied')
  })

  it('matches "path not allowed"', () => {
    expect(
      detectDenial('Read', 'Path not allowed by tool restrictions.')?.type,
    ).toBe('sandbox_denied')
  })
})

describe('detectDenial — requires_approval', () => {
  it('matches "requires approval" / "requires user permission"', () => {
    expect(
      detectDenial('Bash', 'This tool requires user approval.')?.type,
    ).toBe('requires_approval')
    expect(
      detectDenial('Bash', 'This action requires user permission.')?.type,
    ).toBe('requires_approval')
  })

  it('matches "approval required"', () => {
    expect(detectDenial('Bash', 'Approval required.')?.type).toBe(
      'requires_approval',
    )
  })

  it('matches "non-interactive session"', () => {
    expect(
      detectDenial('Bash', 'Cannot prompt: running in non-interactive mode.')
        ?.type,
    ).toBe('requires_approval')
  })
})

describe('detectDenial — hook_blocked', () => {
  it('matches "blocked by hook"', () => {
    expect(detectDenial('Bash', 'Tool was blocked by hook.')?.type).toBe(
      'hook_blocked',
    )
    expect(detectDenial('Bash', 'Blocked by a hook decision.')?.type).toBe(
      'hook_blocked',
    )
  })

  it('matches "hook returned" / "PreToolUse hook"', () => {
    expect(
      detectDenial('Bash', 'PreToolUse hook returned: block.')?.type,
    ).toBe('hook_blocked')
    expect(detectDenial('Bash', 'Hook decided to block.')?.type).toBe(
      'hook_blocked',
    )
  })
})

describe('detectDenial — payload', () => {
  it('truncates the reason field at 400 chars', () => {
    const long = 'User rejected ' + 'x'.repeat(2000)
    const r = detectDenial('Bash', long)
    expect(r?.reason.length).toBe(400)
  })

  it('uses "unknown" when toolName is empty', () => {
    expect(detectDenial(undefined, 'User rejected the tool')?.requestedTool).toBe(
      'unknown',
    )
    expect(detectDenial('   ', 'User rejected the tool')?.requestedTool).toBe(
      'unknown',
    )
  })

  it('preserves toolName when provided', () => {
    expect(
      detectDenial('Edit', 'User rejected the tool')?.requestedTool,
    ).toBe('Edit')
  })
})

describe('DENIAL_TYPES', () => {
  it('lists every type used in patterns', () => {
    // Cheap sanity check: exporting the enum lets the dashboard
    // build filters without hard-coding strings.
    expect(DENIAL_TYPES).toContain('user_rejected')
    expect(DENIAL_TYPES).toContain('settings_blocked')
    expect(DENIAL_TYPES).toContain('sandbox_denied')
    expect(DENIAL_TYPES).toContain('requires_approval')
    expect(DENIAL_TYPES).toContain('hook_blocked')
    expect(DENIAL_TYPES.length).toBe(5)
  })
})
