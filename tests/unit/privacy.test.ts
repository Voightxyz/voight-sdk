/**
 * Tests for the PII scrubbing helper.
 *
 * Coverage philosophy:
 *   - Each pattern: at least one positive (matches) + one negative
 *     (looks similar but should NOT match) test.
 *   - Adversarial cases lifted from real Claude Code usage to catch
 *     false positives (e.g. `email_template`, `support@app` without
 *     TLD, `1234567890123` non-Luhn).
 *   - Idempotency: scrubbing already-scrubbed text leaves it stable.
 *   - Mixed content: multiple secrets in one string all scrub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  scrubPii,
  scrubAnyValue,
  applyPrivacy,
  luhnValid,
  isPrivacyLevel,
  resolvePrivacyLevel,
  _patternNames,
  PRIVACY_LEVELS,
  DEFAULT_PRIVACY_LEVEL,
} from '../../src/privacy.js'
import type { LogInput } from '../../src/index.js'

describe('scrubPii — Anthropic API keys', () => {
  it('redacts a realistic-looking Anthropic key', () => {
    const key =
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKl' +
      'MnOpQrStUvWxYz_xY1234567890ABCD'
    const out = scrubPii(`auth=${key} done`)
    expect(out).toBe('auth=[REDACTED-API-KEY] done')
  })

  it('does not match the literal string `sk-ant` without the body', () => {
    expect(scrubPii('comment about sk-ant prefix')).toBe(
      'comment about sk-ant prefix',
    )
  })
})

describe('scrubPii — OpenAI API keys', () => {
  it('redacts a classic sk- key', () => {
    const out = scrubPii('OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
    expect(out).toBe('OPENAI_KEY=[REDACTED-API-KEY]')
  })

  it('redacts a project-scoped sk-proj- key', () => {
    const out = scrubPii(
      'export OPENAI_KEY=sk-proj-Abc123Def456Ghi789Jkl0_mn-opqrstuv',
    )
    expect(out).toBe('export OPENAI_KEY=[REDACTED-API-KEY]')
  })

  it('does NOT also re-redact an Anthropic key as OpenAI', () => {
    // Anthropic ran first; result already contains [REDACTED-API-KEY],
    // which has no `sk-` prefix and so the OpenAI rule won't re-fire.
    const ant =
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKl' +
      'MnOpQrStUvWxYz_xY1234567890ABCD'
    expect(scrubPii(ant)).toBe('[REDACTED-API-KEY]')
  })
})

describe('scrubPii — Stripe live keys', () => {
  it('redacts sk_live_ secret keys', () => {
    expect(scrubPii('STRIPE=sk_live_AbCdEfGh1234567890XYZ')).toBe(
      'STRIPE=[REDACTED-API-KEY]',
    )
  })

  it('redacts pk_live_ publishable keys', () => {
    expect(scrubPii('publishable=pk_live_AbCdEfGh1234567890XYZ')).toBe(
      'publishable=[REDACTED-API-KEY]',
    )
  })

  it('leaves sk_test_ keys alone (not actual money)', () => {
    expect(scrubPii('sk_test_AbCdEfGh1234567890XYZ in fixture')).toBe(
      'sk_test_AbCdEfGh1234567890XYZ in fixture',
    )
  })
})

describe('scrubPii — GitHub tokens', () => {
  it('redacts a classic ghp_ PAT (36 char body)', () => {
    expect(
      scrubPii('git push https://x:ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789@host'),
    ).toBe('git push https://x:[REDACTED-API-KEY]@host')
  })

  it('redacts a fine-grained github_pat_ token', () => {
    const tok = `github_pat_${'a'.repeat(82)}`
    expect(scrubPii(`token=${tok}`)).toBe('token=[REDACTED-API-KEY]')
  })
})

describe('scrubPii — AWS / Slack / Voight', () => {
  it('redacts AKIA-prefixed AWS access keys', () => {
    expect(scrubPii('access=AKIAIOSFODNN7EXAMPLE')).toBe(
      'access=[REDACTED-API-KEY]',
    )
  })

  it('does NOT match AKIA followed by lowercase (real keys are uppercase)', () => {
    expect(scrubPii('AKIAfoo not a key')).toBe('AKIAfoo not a key')
  })

  it('redacts Slack xoxb/xoxp tokens', () => {
    expect(scrubPii('SLACK=xoxb-1234567890-AbCdEfGh-XyZ')).toBe(
      'SLACK=[REDACTED-API-KEY]',
    )
    expect(scrubPii('SLACK=xoxp-AbCdEfGhIjKl')).toBe(
      'SLACK=[REDACTED-API-KEY]',
    )
  })

  it('redacts Voight API keys (defense-in-depth)', () => {
    expect(scrubPii('vk_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_x')).toBe(
      '[REDACTED-API-KEY]',
    )
  })
})

describe('scrubPii — JWT', () => {
  it('redacts a three-segment JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(scrubPii(`Authorization: Bearer ${jwt}`)).toBe(
      'Authorization: Bearer [REDACTED-JWT]',
    )
  })

  it('does NOT match an isolated `eyJ` segment (one part only)', () => {
    expect(scrubPii('header is eyJabc')).toBe('header is eyJabc')
  })
})

describe('scrubPii — PEM private key block', () => {
  it('redacts a multi-line BEGIN/END block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const input = `before\n${pem}\nafter`
    const out = scrubPii(input)
    expect(out).toBe('before\n[REDACTED-PRIVATE-KEY]\nafter')
  })

  it('redacts an OpenSSH-format private key block', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAA',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    expect(scrubPii(pem)).toBe('[REDACTED-PRIVATE-KEY]')
  })
})

describe('scrubPii — Email', () => {
  it('redacts a standard email address', () => {
    expect(scrubPii('contact alice@example.com today')).toBe(
      'contact [REDACTED-EMAIL] today',
    )
  })

  it('does NOT match `email_template` (no @)', () => {
    expect(scrubPii('using email_template_v2 helper')).toBe(
      'using email_template_v2 helper',
    )
  })

  it('does NOT match `user@host` without TLD', () => {
    expect(scrubPii('connect to user@host now')).toBe(
      'connect to user@host now',
    )
  })

  it('redacts plus-tagged emails', () => {
    expect(scrubPii('alice+tag@example.co.uk')).toBe('[REDACTED-EMAIL]')
  })
})

describe('scrubPii — Phone E.164', () => {
  it('redacts a +-prefixed international number', () => {
    expect(scrubPii('call +14155552671 to confirm')).toBe(
      'call [REDACTED-PHONE] to confirm',
    )
  })

  it('does NOT match a 10-digit number without +', () => {
    expect(scrubPii('order 4155552671 shipped')).toBe(
      'order 4155552671 shipped',
    )
  })
})

describe('scrubPii — Credit cards (Luhn-validated)', () => {
  it('redacts a Visa-shaped Luhn-valid 16-digit number', () => {
    // 4242 4242 4242 4242 — Stripe's documented test number; Luhn passes.
    expect(scrubPii('paid with 4242424242424242')).toBe(
      'paid with [REDACTED-CARD]',
    )
  })

  it('redacts dashed/spaced card forms', () => {
    expect(scrubPii('card 4242-4242-4242-4242 declined')).toBe(
      'card [REDACTED-CARD] declined',
    )
    expect(scrubPii('card 4242 4242 4242 4242 ok')).toBe(
      'card [REDACTED-CARD] ok',
    )
  })

  it('does NOT redact a 16-digit number that fails Luhn', () => {
    expect(scrubPii('order id 1234567812345678')).toBe(
      'order id 1234567812345678',
    )
  })

  it('does NOT redact short digit runs that pass Luhn coincidentally', () => {
    // 8 digits is below 13 — should never match.
    expect(scrubPii('id 12345678')).toBe('id 12345678')
  })
})

describe('luhnValid', () => {
  it('returns true for known-valid card numbers', () => {
    expect(luhnValid('4242424242424242')).toBe(true) // Visa test
    expect(luhnValid('5555555555554444')).toBe(true) // Mastercard test
    expect(luhnValid('378282246310005')).toBe(true) // AMEX test (15)
  })

  it('returns false for invalid candidates', () => {
    expect(luhnValid('4242424242424241')).toBe(false)
    expect(luhnValid('1234567812345678')).toBe(false)
    expect(luhnValid('')).toBe(false)
    expect(luhnValid('not-digits')).toBe(false)
  })
})

describe('scrubPii — composition + idempotency', () => {
  it('redacts multiple distinct secrets in one string', () => {
    const input =
      'EMAIL=alice@example.com KEY=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'
    const out = scrubPii(input)
    expect(out).toBe('EMAIL=[REDACTED-EMAIL] KEY=[REDACTED-API-KEY]')
  })

  it('is idempotent — already-scrubbed text stays the same', () => {
    const once = scrubPii(
      'EMAIL=alice@example.com KEY=AKIAIOSFODNN7EXAMPLE',
    )
    expect(scrubPii(once)).toBe(once)
  })

  it('returns empty string unchanged', () => {
    expect(scrubPii('')).toBe('')
  })

  it('returns input unchanged when no patterns match', () => {
    const clean =
      'feat: add deleteAgent helper to API; covers issues #42, #43.'
    expect(scrubPii(clean)).toBe(clean)
  })

  it('does not crash on non-string input (defensive guard)', () => {
    // The function signature is `(input: string) => string`, but the
    // hook integration walks unknown JSON. Our defensive guard
    // returns the value unchanged for non-strings.
    // @ts-expect-error — exercising the runtime guard intentionally
    expect(scrubPii(null)).toBe(null)
    // @ts-expect-error — exercising the runtime guard intentionally
    expect(scrubPii(123)).toBe(123)
  })
})

describe('PrivacyLevel surface', () => {
  it('exposes the three level identifiers', () => {
    expect(PRIVACY_LEVELS).toEqual(['minimal', 'standard', 'full'])
  })

  it('defaults to "full" for backwards-compat with SDK <0.4.0', () => {
    expect(DEFAULT_PRIVACY_LEVEL).toBe('full')
  })

  it('isPrivacyLevel rejects garbage', () => {
    expect(isPrivacyLevel('minimal')).toBe(true)
    expect(isPrivacyLevel('STANDARD')).toBe(false) // case-sensitive
    expect(isPrivacyLevel('paranoid')).toBe(false)
    expect(isPrivacyLevel(undefined)).toBe(false)
    expect(isPrivacyLevel(null)).toBe(false)
    expect(isPrivacyLevel(2)).toBe(false)
  })
})

describe('resolvePrivacyLevel', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('returns "full" when VOIGHT_PRIVACY is unset', () => {
    expect(resolvePrivacyLevel({})).toBe('full')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns the level when set to a valid lowercase value', () => {
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: 'minimal' })).toBe('minimal')
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: 'standard' })).toBe(
      'standard',
    )
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: 'full' })).toBe('full')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('normalises case (STANDARD → standard)', () => {
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: 'STANDARD' })).toBe(
      'standard',
    )
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: 'Minimal' })).toBe('minimal')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('trims surrounding whitespace', () => {
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: '  minimal  ' })).toBe(
      'minimal',
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('treats empty / whitespace-only as unset (default "full", no warn)', () => {
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: '' })).toBe('full')
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: '   ' })).toBe('full')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('falls through to "full" + warns once for unknown values', () => {
    expect(resolvePrivacyLevel({ VOIGHT_PRIVACY: 'paranoid' })).toBe('full')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = warnSpy.mock.calls[0]?.[0] as string
    expect(message).toContain('VOIGHT_PRIVACY="paranoid"')
    expect(message).toContain('"full"')
  })

  it('treats non-string env values as unset (defensive guard)', () => {
    // Real `process.env` always serialises to string|undefined, but the
    // function is called bare from production code so a defensive
    // guard means callers can't accidentally pass through a number
    // from a stubbed test env.
    expect(
      // @ts-expect-error — exercising the runtime guard intentionally
      resolvePrivacyLevel({ VOIGHT_PRIVACY: 1 }),
    ).toBe('full')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('reads from process.env by default when called bare', () => {
    const previous = process.env.VOIGHT_PRIVACY
    try {
      process.env.VOIGHT_PRIVACY = 'minimal'
      expect(resolvePrivacyLevel()).toBe('minimal')
    } finally {
      if (previous === undefined) {
        delete process.env.VOIGHT_PRIVACY
      } else {
        process.env.VOIGHT_PRIVACY = previous
      }
    }
  })
})

// ─── applyPrivacy: per-event payload filtering ─────────────────────

// Realistic PostToolUse-shaped payload, mirrors what `mapEvent` in
// hook.ts produces. Used as the seed for the level-specific tests.
function samplePostToolUseEvent(): LogInput & { reasoning: string } {
  return {
    type: 'action',
    toolExecuted: 'Bash',
    reasoning: '✓ $ curl -H "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" https://api.example.com (1.2s)',
    outcome: 'success',
    durationMs: 1234,
    tokens: { input: 1000, output: 200, total: 1200 },
    model: 'claude-opus-4-7',
    metadata: {
      source: 'claude-code',
      hookEvent: 'PostToolUse',
      sessionId: 'abc-123',
      cwd: '/Users/locotoo/voight',
      traceId: 't_x_abc',
      git: { branch: 'main', remote: 'voightxyz/voight', sha: 'deadbeef' },
      phase: 'post',
      detail: {
        command: 'curl -H "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" https://api.example.com',
        description: 'fetch data',
      },
      response_preview: '{"ok":true,"email":"alice@example.com"}',
      tokens: { input: 1000, output: 200, total: 1200 },
      tokensBreakdown: {
        inputBase: 50,
        cacheCreation: 100,
        cacheRead: 850,
        output: 200,
      },
      model: 'claude-opus-4-7',
    },
  }
}

describe('scrubAnyValue (deep walker)', () => {
  it('scrubs strings inside nested objects and arrays', () => {
    const input = {
      command: 'echo alice@example.com',
      tags: ['safe', 'bob@example.com', 'AKIAIOSFODNN7EXAMPLE'],
      nested: {
        msg: 'token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
        count: 42,
        flag: true,
      },
    }
    const out = scrubAnyValue(input) as Record<string, unknown>
    expect(out.command).toBe('echo [REDACTED-EMAIL]')
    expect((out.tags as unknown[])[1]).toBe('[REDACTED-EMAIL]')
    expect((out.tags as unknown[])[2]).toBe('[REDACTED-API-KEY]')
    const nested = out.nested as Record<string, unknown>
    expect(nested.msg).toBe('token=[REDACTED-API-KEY]')
    // Numeric + boolean leaves preserved
    expect(nested.count).toBe(42)
    expect(nested.flag).toBe(true)
  })

  it('preserves null + undefined', () => {
    expect(scrubAnyValue(null)).toBe(null)
    expect(scrubAnyValue(undefined)).toBe(undefined)
  })
})

describe('applyPrivacy — full mode', () => {
  it('returns the payload unchanged + stamps privacyLevel="full"', () => {
    const event = samplePostToolUseEvent()
    const out = applyPrivacy(event, 'full')
    expect(out.reasoning).toBe(event.reasoning)
    expect((out.metadata as Record<string, unknown>).cwd).toBe(
      '/Users/locotoo/voight',
    )
    expect((out.metadata as Record<string, unknown>).privacyLevel).toBe('full')
    // Original API key still present (this is the trust-the-operator path)
    expect(out.reasoning).toContain('sk-ant-')
  })
})

describe('applyPrivacy — minimal mode', () => {
  it('drops all content fields, keeps tool name + tokens + outcome', () => {
    const event = samplePostToolUseEvent()
    const out = applyPrivacy(event, 'minimal')
    expect(out.toolExecuted).toBe('Bash')
    expect(out.outcome).toBe('success')
    expect(out.durationMs).toBe(1234)
    expect(out.tokens).toEqual({ input: 1000, output: 200, total: 1200 })
    expect(out.model).toBe('claude-opus-4-7')
    // Content fields removed entirely
    expect(out.reasoning).toBeUndefined()
    expect(out.input).toBeUndefined()
    expect(out.errorMessage).toBeUndefined()
  })

  it('strips metadata down to the allowlisted keys', () => {
    const event = samplePostToolUseEvent()
    const out = applyPrivacy(event, 'minimal')
    const meta = out.metadata as Record<string, unknown>
    // Allowlist keeps these
    expect(meta.source).toBe('claude-code')
    expect(meta.hookEvent).toBe('PostToolUse')
    expect(meta.sessionId).toBe('abc-123')
    expect(meta.traceId).toBe('t_x_abc')
    expect(meta.phase).toBe('post')
    expect(meta.tokens).toBeDefined()
    expect(meta.tokensBreakdown).toBeDefined()
    expect(meta.model).toBe('claude-opus-4-7')
    // Drops the rest
    expect(meta.cwd).toBeUndefined()
    expect(meta.git).toBeUndefined()
    expect(meta.detail).toBeUndefined()
    expect(meta.response_preview).toBeUndefined()
    expect(meta.responseText).toBeUndefined()
    expect(meta.thinkingPreview).toBeUndefined()
  })

  it('stamps privacyLevel="minimal"', () => {
    const out = applyPrivacy(samplePostToolUseEvent(), 'minimal')
    expect((out.metadata as Record<string, unknown>).privacyLevel).toBe(
      'minimal',
    )
  })

  it('handles a Stop event (drops responseText + thinkingPreview)', () => {
    const event: LogInput = {
      type: 'decision',
      reasoning: 'session stopped',
      outcome: 'success',
      metadata: {
        source: 'claude-code',
        hookEvent: 'Stop',
        sessionId: 's',
        traceId: 't',
        responseText: 'Here is your answer with secret sk-ant-...',
        stopReason: 'end_turn',
        thinkingPreview: 'I think the user wants...',
      },
    }
    const out = applyPrivacy(event, 'minimal')
    const meta = out.metadata as Record<string, unknown>
    expect(meta.responseText).toBeUndefined()
    expect(meta.thinkingPreview).toBeUndefined()
    // stopReason is metadata, not content — stays
    expect(meta.stopReason).toBe('end_turn')
  })

  it('handles an empty payload safely', () => {
    const out = applyPrivacy({}, 'minimal')
    expect(out.metadata).toEqual({ privacyLevel: 'minimal' })
  })
})

describe('applyPrivacy — standard mode', () => {
  it('scrubs PII in reasoning string', () => {
    const event = samplePostToolUseEvent()
    const out = applyPrivacy(event, 'standard')
    expect(out.reasoning).toContain('[REDACTED-API-KEY]')
    expect(out.reasoning).not.toContain('sk-ant-')
  })

  it('scrubs PII in nested metadata.detail.command', () => {
    const event = samplePostToolUseEvent()
    const out = applyPrivacy(event, 'standard')
    const meta = out.metadata as Record<string, unknown>
    const detail = meta.detail as Record<string, unknown>
    expect(detail.command).toContain('[REDACTED-API-KEY]')
    expect(detail.command).not.toContain('sk-ant-')
    // Description is harmless — passes through
    expect(detail.description).toBe('fetch data')
  })

  it('scrubs PII in metadata.response_preview', () => {
    const event = samplePostToolUseEvent()
    const out = applyPrivacy(event, 'standard')
    const meta = out.metadata as Record<string, unknown>
    expect(meta.response_preview).toBe('{"ok":true,"email":"[REDACTED-EMAIL]"}')
  })

  it('preserves token counts + USD-relevant numeric fields', () => {
    const event = samplePostToolUseEvent()
    const out = applyPrivacy(event, 'standard')
    expect(out.tokens).toEqual({ input: 1000, output: 200, total: 1200 })
    expect(out.durationMs).toBe(1234)
    const meta = out.metadata as Record<string, unknown>
    expect(meta.tokensBreakdown).toEqual({
      inputBase: 50,
      cacheCreation: 100,
      cacheRead: 850,
      output: 200,
    })
  })

  it('preserves cwd + git context (only credentials get redacted)', () => {
    const event = samplePostToolUseEvent()
    const out = applyPrivacy(event, 'standard')
    const meta = out.metadata as Record<string, unknown>
    expect(meta.cwd).toBe('/Users/locotoo/voight')
    expect(meta.git).toEqual({
      branch: 'main',
      remote: 'voightxyz/voight',
      sha: 'deadbeef',
    })
  })

  it('stamps privacyLevel="standard"', () => {
    const out = applyPrivacy(samplePostToolUseEvent(), 'standard')
    expect((out.metadata as Record<string, unknown>).privacyLevel).toBe(
      'standard',
    )
  })

  it('scrubs errorMessage', () => {
    const event: LogInput = {
      type: 'error',
      outcome: 'failed',
      errorMessage:
        'Auth failed for alice@example.com — token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA invalid',
    }
    const out = applyPrivacy(event, 'standard')
    expect(out.errorMessage).toContain('[REDACTED-EMAIL]')
    expect(out.errorMessage).toContain('[REDACTED-API-KEY]')
    expect(out.errorMessage).not.toContain('alice@example.com')
  })

  it('scrubs input.prompt for UserPromptSubmit events', () => {
    const event: LogInput = {
      type: 'decision',
      reasoning: 'Authenticate with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      input: {
        prompt: 'Please call API with token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
      metadata: { source: 'claude-code', hookEvent: 'UserPromptSubmit' },
    }
    const out = applyPrivacy(event, 'standard')
    expect(out.input?.prompt).toContain('[REDACTED-API-KEY]')
    expect(out.input?.prompt).not.toContain('sk-ant-')
  })
})

describe('applyPrivacy — idempotency', () => {
  it('re-applying the same level produces the same output', () => {
    const event = samplePostToolUseEvent()
    const once = applyPrivacy(event, 'standard')
    const twice = applyPrivacy(once, 'standard')
    expect(twice).toEqual(once)
  })

  it('full → standard further reduces; standard → minimal further reduces', () => {
    const event = samplePostToolUseEvent()
    const full = applyPrivacy(event, 'full')
    const std = applyPrivacy(full, 'standard')
    const min = applyPrivacy(std, 'minimal')
    expect((min.metadata as Record<string, unknown>).privacyLevel).toBe(
      'minimal',
    )
    // Minimal still has no detail/cwd/git regardless of upstream level
    const meta = min.metadata as Record<string, unknown>
    expect(meta.cwd).toBeUndefined()
    expect(meta.detail).toBeUndefined()
  })
})

describe('_patternNames inventory', () => {
  it('lists every pattern + the credit-card slot', () => {
    const names = _patternNames()
    expect(names).toContain('pem-private-key')
    expect(names).toContain('jwt')
    expect(names).toContain('anthropic-key')
    expect(names).toContain('openai-key')
    expect(names).toContain('stripe-live-key')
    expect(names).toContain('github-fine-pat')
    expect(names).toContain('github-classic-pat')
    expect(names).toContain('aws-access-key')
    expect(names).toContain('slack-token')
    expect(names).toContain('voight-key')
    expect(names).toContain('email')
    expect(names).toContain('phone-e164')
    expect(names).toContain('credit-card')
    expect(names).toHaveLength(13)
  })
})
