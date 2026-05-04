/**
 * @voightxyz/sdk — Voight client for AI agents on Solana.
 *
 * Three methods in one surface:
 *   - voight.log()      — ship an event to the timeline + Explorer.
 *   - voight.check()    — (v0.2) ask the policy engine whether to proceed.
 *   - voight.enforce()  — (v0.2) route decisions through a human-in-the-loop.
 *
 * Docs:    https://voight.xyz
 * Issues:  https://github.com/voightxyz/voight-sdk/issues
 */

export type VoightOptions = {
  /**
   * Public agent identifier. Recommended: an SNS `.sol` domain you own
   * (e.g. 'trading-bot.sol'). Any stable string also works.
   */
  agentId: string

  /**
   * API key from your Voight dashboard. Pass the value, not `Bearer …`.
   * Optional during local development — events will be rejected by the
   * server without a valid key once authenticated events ship.
   */
  apiKey?: string

  /**
   * Override the Voight API endpoint. Defaults to the hosted service.
   */
  endpoint?: string

  /**
   * Extra metadata (model, version, environment) applied to every event.
   */
  defaults?: Record<string, unknown>

  /**
   * Swallow network failures instead of throwing. Defaults to `true`:
   * your agent should never crash because Voight is down. Set to `false`
   * if you want log failures to propagate.
   */
  swallowErrors?: boolean

  /**
   * Custom fetch implementation (Node <18, test doubles, etc).
   */
  fetch?: typeof globalThis.fetch

  /**
   * Number of automatic retries on transient failures (network errors,
   * 5xx responses, 429 with Retry-After). Defaults to 3 — set to 0
   * to disable.
   */
  retries?: number
}

export type EventType = 'decision' | 'action' | 'error'
export type EventOutcome = 'pending' | 'success' | 'failed'

export type LogInput = {
  /** Event type. Defaults to `'decision'`. */
  type?: EventType

  /** What the agent received / was thinking about. */
  input?: { prompt?: string; context?: Record<string, unknown> }

  /** Free-form reasoning trace. */
  reasoning?: string

  /** Candidate tools the agent considered (before picking). */
  toolsConsidered?: string[]

  /** Tool the agent actually executed. */
  toolExecuted?: string

  /** On-chain signature / tx hash, if any. */
  transaction?: string | null

  /** Token + value moved, if any. */
  amount?: { token: string; value: number } | null

  /** Outcome of the action. Defaults to `'success'`. */
  outcome?: EventOutcome

  /** Wall-clock duration of the action in milliseconds (e.g. tool exec time). */
  durationMs?: number

  /** Human-readable error message when `outcome === 'failed'`. */
  errorMessage?: string

  /** LLM model that produced the action (e.g. `claude-sonnet-4-5`). */
  model?: string

  /** Token usage for the action, if known. */
  tokens?: { input?: number; output?: number; total?: number }

  /**
   * Optional trace identifier — events sharing the same traceId are
   * one logical operation in the dashboard. The Claude Code hook
   * auto-injects a trace per UserPromptSubmit so you don't have to
   * pass this manually.
   */
  traceId?: string

  /** Anything else worth recording. Merged on top of `defaults`. */
  metadata?: Record<string, unknown>

  /** Client-side timestamp (ms). Defaults to `Date.now()`. */
  timestamp?: number
}

/**
 * Discriminated union of failure modes from `voight.log()`. Callers
 * wrapping the SDK can branch on `error.code` for retry / alerting
 * logic without parsing message strings.
 */
export type LogError =
  | { code: 'invalid_payload'; message: string }
  | { code: 'unauthorized'; message: string }
  | { code: 'rate_limited'; message: string; retryAfterMs: number }
  | { code: 'network'; message: string; cause: Error }
  | { code: 'server'; message: string; status: number; body: string }
  | { code: 'unknown'; message: string }

export type LogResponse =
  | {
      ok: true
      eventId?: string
      /**
       * Server-assigned agent CUID. May differ from the `agentId`
       * the caller sent — when the client sends a label like
       * `claude-code:Foo`, the server resolves it to the underlying
       * Agent row's id. The Claude Code hook persists this to
       * `.voight-agent-id` so subsequent events match by primary
       * key (rename-proof, folder-move-proof).
       */
      agentId?: string
    }
  | { ok: false; error: LogError }

const DEFAULT_ENDPOINT = 'https://voight-production.up.railway.app'

/**
 * Voight client. Instantiate once at agent boot, reuse for every event.
 */
export class Voight {
  readonly agentId: string
  readonly endpoint: string

  private readonly apiKey: string | undefined
  private readonly defaults: Record<string, unknown>
  private readonly swallowErrors: boolean
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly retries: number

  constructor(options: VoightOptions) {
    if (!options || typeof options.agentId !== 'string' || !options.agentId) {
      throw new Error('Voight: `agentId` is required')
    }

    this.agentId = options.agentId
    this.apiKey = options.apiKey
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
    this.defaults = options.defaults ?? {}
    this.swallowErrors = options.swallowErrors ?? true
    this.retries = Math.max(0, options.retries ?? 3)

    const fetchFn = options.fetch ?? globalThis.fetch
    if (typeof fetchFn !== 'function') {
      throw new Error(
        'Voight: no fetch implementation available. Pass `fetch` in options or run on Node 18+.',
      )
    }
    this.fetchImpl = fetchFn.bind(globalThis)
  }

  /**
   * Record an agent event. Safe to call inside hot paths — the call is
   * non-blocking from your agent's perspective when `swallowErrors` is on
   * (the default).
   */
  async log(input: LogInput = {}): Promise<LogResponse> {
    // Carry traceId both at top level (so the API can persist it as a
    // column when that schema lands) and in metadata.traceId so the
    // current backend already groups by it.
    const traceId = input.traceId
    const metadata = {
      ...this.defaults,
      ...input.metadata,
      ...(traceId ? { traceId } : {}),
    }

    const body = {
      agentId: this.agentId,
      type: input.type ?? 'decision',
      timestamp: input.timestamp ?? Date.now(),
      input: input.input,
      reasoning: input.reasoning,
      toolsConsidered: input.toolsConsidered,
      toolExecuted: input.toolExecuted,
      transaction: input.transaction ?? null,
      amount: input.amount ?? null,
      outcome: input.outcome ?? 'success',
      durationMs: input.durationMs,
      errorMessage: input.errorMessage,
      model: input.model,
      tokens: input.tokens,
      traceId,
      metadata,
    }

    let lastError: LogError | null = null
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const result = await this.attemptLog(body)
      if (result.ok) return result
      lastError = result.error

      // Don't retry permanent failures.
      if (
        result.error.code === 'invalid_payload' ||
        result.error.code === 'unauthorized'
      ) {
        break
      }

      // Don't retry past the final attempt.
      if (attempt >= this.retries) break

      // Compute backoff. Honor server-provided Retry-After when given,
      // otherwise exponential with jitter: 100ms, 400ms, 1600ms…
      const baseMs =
        result.error.code === 'rate_limited' && result.error.retryAfterMs > 0
          ? result.error.retryAfterMs
          : 100 * Math.pow(4, attempt)
      const jitterMs = Math.floor(Math.random() * 80)
      await sleep(baseMs + jitterMs)
    }

    if (!this.swallowErrors) {
      throw new Error(lastError?.message ?? 'voight.log failed')
    }
    return { ok: false, error: lastError ?? unknownError('exhausted retries') }
  }

  /** Single network attempt — classified into typed LogError codes. */
  private async attemptLog(body: unknown): Promise<LogResponse> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.endpoint}/v1/events`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      })
    } catch (err) {
      const e = err as Error
      return {
        ok: false,
        error: {
          code: 'network',
          message: e.message,
          cause: e,
        },
      }
    }

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        eventId?: string
        agentId?: string
      }
      return { ok: true, eventId: data.eventId, agentId: data.agentId }
    }

    const text = await res.text().catch(() => '')
    const message = `Voight API responded ${res.status}: ${text.slice(0, 200)}`

    if (res.status === 400 || res.status === 422) {
      return { ok: false, error: { code: 'invalid_payload', message } }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: { code: 'unauthorized', message } }
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '0') || 0
      return {
        ok: false,
        error: {
          code: 'rate_limited',
          message,
          retryAfterMs: retryAfter * 1000,
        },
      }
    }
    if (res.status >= 500) {
      return {
        ok: false,
        error: {
          code: 'server',
          status: res.status,
          message,
          body: text.slice(0, 500),
        },
      }
    }
    return { ok: false, error: unknownError(message) }
  }

  /**
   * Policy pre-check. Coming in v0.2 (Voight HITL module). Shipping
   * today as a no-op so you can wire call sites now and flip a flag
   * later without code changes.
   */
  async check(
    _request: { action: string; context?: Record<string, unknown> },
  ): Promise<{ allow: true; reason: 'not-implemented' }> {
    return { allow: true, reason: 'not-implemented' }
  }

  /**
   * Enforced action + human-in-the-loop routing. Coming in v0.2.
   * No-op today; instrument call sites now to avoid future diffs.
   */
  async enforce(
    request: { action: string; context?: Record<string, unknown> },
  ): Promise<{ allow: true; reason: 'not-implemented' }> {
    return this.check(request)
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-voight-sdk': `@voightxyz/sdk@0.3.5`,
    }
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`
    return headers
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unknownError(message: string): LogError {
  return { code: 'unknown', message }
}

export default Voight
