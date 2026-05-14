/**
 * Tests for the Cursor adapter — every pure helper that translates
 * Cursor's hook payloads into Voight's `LogInput`. The runHook
 * dispatcher itself remains integration-shaped (filesystem + network)
 * and is exercised via manual end-to-end validation, but every
 * field-level decision happens in the helpers below.
 *
 * Fixtures are minimised but real — copy-pasted from the empirical
 * probe of Cursor 3.4.17 to ensure we test against the actual wire
 * format rather than guessed shapes.
 */

import { describe, it, expect } from 'vitest'

import {
  cursorAgentIdentity,
  cursorTokens,
  isCursorEvent,
  mapCursorEvent,
  normaliseCursorModel,
  parseCursorToolOutput,
  type CursorEvent,
} from '../../src/cursor.js'

describe('isCursorEvent', () => {
  it('matches when cursor_version is present', () => {
    expect(isCursorEvent({ cursor_version: '3.4.17' })).toBe(true)
  })

  it('rejects Claude Code payloads', () => {
    expect(
      isCursorEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'abc',
        tool_name: 'Bash',
      }),
    ).toBe(false)
  })

  it('rejects payloads where cursor_version is not a string', () => {
    expect(isCursorEvent({ cursor_version: 3 })).toBe(false)
    expect(isCursorEvent({ cursor_version: null })).toBe(false)
    expect(isCursorEvent({})).toBe(false)
  })
})

describe('cursorAgentIdentity', () => {
  // Use a path that DEFINITELY doesn't exist on the test runner so
  // we never accidentally hit a real marker file (the live SDK
  // writes one of those to workspace roots after a successful
  // first event, which would shadow the label-fallback path
  // we're asserting on).
  const TEST_WORKSPACE = '/tmp/voight-unit-test-cursor-workspace-DNE'
  const baseEvt: CursorEvent = {
    cursor_version: '3.4.17',
    session_id: '943adf19-875b-4223-bbe3-f3cd1393e97e',
    workspace_roots: [TEST_WORKSPACE],
  }

  it('honours VOIGHT_AGENT_ID env override above everything else', () => {
    const ident = cursorAgentIdentity(baseEvt, {
      VOIGHT_AGENT_ID: 'my-bot.sol',
    })
    expect(ident.agentId).toBe('my-bot.sol')
    // Marker path is still computed so the caller can persist the
    // server's CUID there on first write.
    expect(ident.markerPath).toBe(`${TEST_WORKSPACE}/.voight-agent-id`)
  })

  it('falls back to a workspace-derived label when no marker exists', () => {
    const ident = cursorAgentIdentity(baseEvt, {})
    expect(ident.agentId).toBe(
      'cursor:voight-unit-test-cursor-workspace-DNE',
    )
  })

  it('falls back to a session slice when there is no workspace root', () => {
    const ident = cursorAgentIdentity(
      { ...baseEvt, workspace_roots: [] },
      {},
    )
    expect(ident.agentId).toBe('cursor:943adf19')
    expect(ident.markerPath).toBeNull()
  })

  it('returns cursor:unknown when nothing else is available', () => {
    const ident = cursorAgentIdentity(
      { cursor_version: '3.4.17', workspace_roots: [] },
      {},
    )
    expect(ident.agentId).toBe('cursor:unknown')
  })
})

describe('normaliseCursorModel', () => {
  it('relabels "default" as "cursor-auto" so the dashboard renders honestly', () => {
    expect(normaliseCursorModel('default')).toBe('cursor-auto')
  })

  it('relabels "auto" as "cursor-auto" too (Cursor sometimes uses this form)', () => {
    expect(normaliseCursorModel('auto')).toBe('cursor-auto')
  })

  it('passes concrete model names through unchanged', () => {
    expect(normaliseCursorModel('claude-opus-4-7-thinking-xhigh')).toBe(
      'claude-opus-4-7-thinking-xhigh',
    )
    expect(normaliseCursorModel('gpt-4o-2024-08-06')).toBe('gpt-4o-2024-08-06')
  })

  it('passes undefined / empty through unchanged', () => {
    expect(normaliseCursorModel(undefined)).toBeUndefined()
    expect(normaliseCursorModel('')).toBe('')
  })
})

describe('cursorTokens', () => {
  it('returns null when no token fields are present', () => {
    expect(cursorTokens({})).toBeNull()
  })

  it('maps a full breakdown including cache reads / writes', () => {
    // Real payload from probe, conversation 943adf19, third stop event.
    const result = cursorTokens({
      input_tokens: 81310,
      output_tokens: 1478,
      cache_read_tokens: 77312,
      cache_write_tokens: 0,
    })
    expect(result).not.toBeNull()
    expect(result!.tokens).toEqual({
      // Total input = uncached + cache_read + cache_creation
      input: 81310 + 77312 + 0,
      output: 1478,
      total: 81310 + 77312 + 0 + 1478,
    })
    expect(result!.breakdown).toEqual({
      inputBase: 81310,
      cacheRead: 77312,
      cacheCreation: 0,
      output: 1478,
    })
  })

  it('handles output-only events (no input tokens reported)', () => {
    const result = cursorTokens({ output_tokens: 66 })
    expect(result!.tokens).toEqual({
      input: undefined,
      output: 66,
      total: 66,
    })
  })
})

describe('parseCursorToolOutput', () => {
  it('returns success for an undefined output', () => {
    expect(parseCursorToolOutput(undefined)).toEqual({ outcome: 'success' })
  })

  it('returns success for a Shell exit code 0', () => {
    expect(
      parseCursorToolOutput(JSON.stringify({ output: 'hi', exitCode: 0 })),
    ).toEqual({ outcome: 'success' })
  })

  it('flags Shell exit code != 0 as failed with a snippet of stdout', () => {
    const raw = JSON.stringify({
      output: 'EPERM: permission denied\n',
      exitCode: 1,
    })
    const result = parseCursorToolOutput(raw)
    expect(result.outcome).toBe('failed')
    expect(result.errorMessage).toContain('EPERM')
  })

  it('flags { success: false } shape as failed', () => {
    const raw = JSON.stringify({ success: false, error: 'pattern empty' })
    expect(parseCursorToolOutput(raw)).toEqual({
      outcome: 'failed',
      errorMessage: 'pattern empty',
    })
  })

  it('returns success when output is unparseable JSON', () => {
    // Don't blow up on tools that emit raw text instead of JSON; the
    // dashboard can still surface durationMs and tool name.
    expect(parseCursorToolOutput('not json')).toEqual({ outcome: 'success' })
  })
})

describe('mapCursorEvent', () => {
  const sessionId = '943adf19-875b-4223-bbe3-f3cd1393e97e'
  const generationId = 'd9a10f35-d654-49f2-a92c-8148388832a5'
  const baseFields = {
    cursor_version: '3.4.17',
    session_id: sessionId,
    generation_id: generationId,
    conversation_id: sessionId,
    workspace_roots: ['/Users/locotoo/Desktop/Cursor test'],
    user_email: 'dangelxp2@gmail.com',
  }

  it('returns null when hook_event_name is missing', () => {
    expect(mapCursorEvent({})).toBeNull()
  })

  it('maps beforeSubmitPrompt to a decision with input.prompt + reasoning + outcome', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'beforeSubmitPrompt',
      composer_mode: 'agent',
      model: 'claude-opus-4-7-thinking-xhigh',
      prompt: 'Set up Voight observability here:\nnpx -y @voightxyz/sdk setup',
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped).not.toBeNull()
    expect(mapped!.type).toBe('decision')
    // reasoning carries the visible preview — matches Claude Code's
    // UserPromptSubmit so the dashboard trace card renders consistently.
    expect(mapped!.reasoning).toBe(evt.prompt)
    expect(mapped!.outcome).toBe('success')
    expect(mapped!.input?.prompt).toBe(evt.prompt)
    expect(mapped!.model).toBe('claude-opus-4-7-thinking-xhigh')
    expect(mapped!.traceId).toBe(generationId)
    expect(mapped!.metadata).toMatchObject({
      kind: 'user_prompt',
      hookEvent: 'beforeSubmitPrompt',
      composerMode: 'agent',
      sessionId,
      cwd: '/Users/locotoo/Desktop/Cursor test',
      promptSource: 'user',
      prompt_length: evt.prompt!.length,
    })
  })

  it('truncates very long prompts to 800 chars + ellipsis on the preview', () => {
    const long = 'x'.repeat(2000)
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'beforeSubmitPrompt',
      prompt: long,
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.reasoning).toHaveLength(801) // 800 + ellipsis
    expect(mapped!.metadata).toMatchObject({ prompt_length: 2000 })
  })

  it('falls back to a placeholder reasoning when the prompt is empty', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'beforeSubmitPrompt',
      prompt: '',
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.reasoning).toBe('user prompt')
  })

  it('maps preToolUse to an action with outcome=pending', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'preToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'ls -la', cwd: '', timeout: 30000 },
      tool_use_id: 'tool_07496ee3',
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.type).toBe('action')
    expect(mapped!.toolExecuted).toBe('Shell')
    expect(mapped!.outcome).toBe('pending')
    expect(mapped!.metadata).toMatchObject({
      kind: 'pre_tool_use',
      toolUseId: 'tool_07496ee3',
    })
  })

  it('maps postToolUse to an action with parsed outcome + durationMs', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'ls -la', cwd: '', timeout: 30000 },
      tool_output: JSON.stringify({ output: 'hi\n', exitCode: 0 }),
      duration: 6324.238,
      tool_use_id: '2d99046f',
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.type).toBe('action')
    expect(mapped!.outcome).toBe('success')
    expect(mapped!.durationMs).toBeCloseTo(6324.238)
  })

  it('marks postToolUse as failed when the Shell exit code is non-zero', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_output: JSON.stringify({
        output: 'voight cli failed: EPERM\n',
        exitCode: 1,
      }),
      duration: 3448.217,
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.outcome).toBe('failed')
    expect(mapped!.errorMessage).toContain('EPERM')
  })

  it('maps afterAgentResponse with full token breakdown + text', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'afterAgentResponse',
      model: 'default',
      text: "Here's what was changed.",
      input_tokens: 81310,
      output_tokens: 1478,
      cache_read_tokens: 77312,
      cache_write_tokens: 0,
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.type).toBe('decision')
    // Cursor reports model="default" in Auto mode — the mapper
    // relabels to "cursor-auto" so the dashboard renders something
    // meaningful and pricing has a known entry to match.
    expect(mapped!.model).toBe('cursor-auto')
    expect(mapped!.reasoning).toBe("Here's what was changed.")
    expect(mapped!.tokens).toEqual({
      input: 81310 + 77312,
      output: 1478,
      total: 81310 + 77312 + 1478,
    })
    expect(mapped!.metadata).toMatchObject({
      kind: 'agent_response',
      tokensBreakdown: {
        inputBase: 81310,
        cacheRead: 77312,
        cacheCreation: 0,
        output: 1478,
      },
    })
  })

  it('maps stop completed → outcome=success', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'stop',
      status: 'completed',
      loop_count: 0,
      input_tokens: 17248,
      output_tokens: 66,
      cache_read_tokens: 2304,
      cache_write_tokens: 0,
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.outcome).toBe('success')
    expect(mapped!.metadata).toMatchObject({
      kind: 'stop',
      status: 'completed',
      loopCount: 0,
    })
  })

  it('maps stop aborted → outcome=failed', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'stop',
      status: 'aborted',
      loop_count: 0,
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.outcome).toBe('failed')
    expect(mapped!.reasoning).toBe('Cursor turn aborted')
  })

  it('skips sessionStart for background agents to keep the timeline clean', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'sessionStart',
      is_background_agent: true,
    }
    expect(mapCursorEvent(evt)).toBeNull()
  })

  it('maps sessionStart for foreground agents to a decision', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'sessionStart',
      is_background_agent: false,
      composer_mode: 'agent',
      model: 'claude-opus-4-7-thinking-xhigh',
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.type).toBe('decision')
    expect(mapped!.metadata).toMatchObject({
      kind: 'session_start',
      hookEvent: 'sessionStart',
    })
  })

  it('maps postToolUseFailure to action with outcome=failed', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'postToolUseFailure',
      tool_name: 'Shell',
      tool_output: JSON.stringify({ output: 'EACCES\n', exitCode: 1 }),
      tool_use_id: 'tool_abc',
      duration: 42,
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.type).toBe('action')
    expect(mapped!.outcome).toBe('failed')
    expect(mapped!.errorMessage).toContain('EACCES')
    expect(mapped!.durationMs).toBe(42)
    expect(mapped!.metadata).toMatchObject({
      kind: 'post_tool_use_failure',
      toolUseId: 'tool_abc',
    })
  })

  it('maps subagentStart to decision with subagent metadata', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'subagentStart',
      subagent_type: 'generalPurpose',
      subagent_input: { task: 'find bugs' },
      parent_session_id: 'parent-sess',
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.type).toBe('decision')
    expect(mapped!.reasoning).toContain('generalPurpose')
    expect(mapped!.outcome).toBe('success')
    expect(mapped!.metadata).toMatchObject({
      kind: 'subagent_start',
      subagentType: 'generalPurpose',
      subagentInput: { task: 'find bugs' },
      parentSessionId: 'parent-sess',
    })
  })

  it('maps subagentStop completed → outcome=success with tokens', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'subagentStop',
      subagent_type: 'shell',
      status: 'completed',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 200,
      cache_write_tokens: 0,
      duration: 1234.5,
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.outcome).toBe('success')
    expect(mapped!.durationMs).toBeCloseTo(1234.5)
    expect(mapped!.tokens?.output).toBe(50)
    expect(mapped!.metadata).toMatchObject({
      kind: 'subagent_stop',
      subagentType: 'shell',
      status: 'completed',
    })
  })

  it('maps subagentStop aborted → outcome=failed', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'subagentStop',
      status: 'aborted',
    }
    expect(mapCursorEvent(evt)!.outcome).toBe('failed')
  })

  it('maps preCompact to decision with kind=pre_compact', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'preCompact',
      trigger: 'auto',
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.type).toBe('decision')
    expect(mapped!.reasoning).toBe('Context compaction triggered')
    expect(mapped!.outcome).toBe('success')
    expect(mapped!.metadata).toMatchObject({
      kind: 'pre_compact',
      trigger: 'auto',
    })
  })

  it('maps afterAgentThought to decision capturing the thought as reasoning', () => {
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'afterAgentThought',
      thought: 'I should refactor this function before adding the test.',
    }
    const mapped = mapCursorEvent(evt)
    expect(mapped!.type).toBe('decision')
    expect(mapped!.reasoning).toBe(evt.thought)
    expect(mapped!.metadata).toMatchObject({
      kind: 'agent_thought',
      thought_length: evt.thought!.length,
    })
  })

  it('falls back to text field when afterAgentThought uses text instead of thought', () => {
    // Until we have probe data confirming the exact field name, the
    // mapper accepts either 'thought' or 'text' so we capture the
    // content regardless of which Cursor sends.
    const evt: CursorEvent = {
      ...baseFields,
      hook_event_name: 'afterAgentThought',
      text: 'fallback content',
    }
    expect(mapCursorEvent(evt)!.reasoning).toBe('fallback content')
  })

  it('lifts generation_id to traceId at top level AND in metadata', () => {
    // Cursor groups everything in one agent turn under a single
    // generation_id; the dashboard's per-trace grouping mirrors that.
    // traceId must live in BOTH places: top-level (public LogInput
    // field) and metadata.traceId (which runHook lifts to ship as
    // a first-class column).
    const types: CursorEvent['hook_event_name'][] = [
      'beforeSubmitPrompt',
      'preToolUse',
      'postToolUse',
      'afterAgentResponse',
      'stop',
    ]
    for (const t of types) {
      const evt: CursorEvent = {
        ...baseFields,
        hook_event_name: t,
        tool_name: 'Shell',
        tool_output: JSON.stringify({ output: '', exitCode: 0 }),
      }
      const mapped = mapCursorEvent(evt)
      expect(mapped?.traceId).toBe(generationId)
      expect(mapped?.metadata).toMatchObject({ traceId: generationId })
    }
  })
})
