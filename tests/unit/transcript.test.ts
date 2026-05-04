/**
 * Tests for `findResponseForSession` — extracts the agent's final
 * text response, stop_reason, and thinking blocks from the local
 * Claude Code transcript JSONL.
 *
 * The transcript shape (one JSON per line):
 *   { type: 'user', message: { content: ... }, ... }
 *   { type: 'assistant', message: { role: 'assistant', model, content: [
 *     { type: 'thinking', thinking: '...' },
 *     { type: 'text', text: '...' },
 *     { type: 'tool_use', name, input, id },
 *     ...
 *   ], stop_reason: 'end_turn', usage: {...} }, uuid: ... }
 *
 * We walk backward from the end of the file. The most recent
 * assistant message (regardless of session_id, since one transcript
 * = one session anyway) carries the final response, stop_reason,
 * and last thinking block.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findResponseForSession } from '../../src/transcript.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'voight-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeTranscript(lines: object[]): string {
  const path = join(tmpDir, 'session.jsonl')
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path
}

describe('findResponseForSession', () => {
  it('returns null when transcript path does not exist', () => {
    const result = findResponseForSession('/nonexistent/path.jsonl')
    expect(result).toBeNull()
  })

  it('returns empty object for an empty transcript', () => {
    const path = writeTranscript([])
    expect(findResponseForSession(path)).toEqual({})
  })

  it('captures the last assistant text content', () => {
    const path = writeTranscript([
      { type: 'user', message: { content: 'hi' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
          stop_reason: 'end_turn',
        },
      },
    ])
    const result = findResponseForSession(path)
    expect(result?.responseText).toBe('Hello! How can I help?')
    expect(result?.stopReason).toBe('end_turn')
  })

  it('truncates response text to maxTextLength', () => {
    const longText = 'x'.repeat(5000)
    const path = writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: longText }],
        },
      },
    ])
    const result = findResponseForSession(path, { maxTextLength: 100 })
    // 100 chars + ellipsis suffix when truncation happened
    expect(result?.responseText).toBe('x'.repeat(100) + '…')
  })

  it('captures the last thinking block', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer.' },
          ],
        },
      },
    ])
    const result = findResponseForSession(path)
    expect(result?.thinkingPreview).toBe('Let me think about this...')
  })

  it('truncates thinking to maxThinkingLength', () => {
    const longThink = 'y'.repeat(2000)
    const path = writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: longThink }],
        },
      },
    ])
    const result = findResponseForSession(path, { maxThinkingLength: 50 })
    expect(result?.thinkingPreview).toBe('y'.repeat(50) + '…')
  })

  it('skips text capture when captureText is false', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'visible content' },
            { type: 'thinking', thinking: 'inner thoughts' },
          ],
          stop_reason: 'end_turn',
        },
      },
    ])
    const result = findResponseForSession(path, { captureText: false })
    expect(result?.responseText).toBeUndefined()
    expect(result?.stopReason).toBe('end_turn') // stop_reason still captured
    expect(result?.thinkingPreview).toBe('inner thoughts')
  })

  it('skips thinking capture when captureThinking is false', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'visible' },
            { type: 'thinking', thinking: 'should not appear' },
          ],
        },
      },
    ])
    const result = findResponseForSession(path, { captureThinking: false })
    expect(result?.responseText).toBe('visible')
    expect(result?.thinkingPreview).toBeUndefined()
  })

  it('skips malformed JSON lines gracefully', () => {
    const path = writeTranscript([])
    // Manually rewrite with a junk line in the middle
    const junkPath = path
    writeFileSync(
      junkPath,
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        '{ this is not valid json',
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'response' }],
            stop_reason: 'end_turn',
          },
        }),
      ].join('\n') + '\n',
    )
    const result = findResponseForSession(junkPath)
    expect(result?.responseText).toBe('response')
  })
})
