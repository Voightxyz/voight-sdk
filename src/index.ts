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

  /** Anything else worth recording. Merged on top of `defaults`. */
  metadata?: Record<string, unknown>

  /** Client-side timestamp (ms). Defaults to `Date.now()`. */
  timestamp?: number
}

export type LogResponse = {
  ok: boolean
  eventId?: string
  error?: string
}

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

  constructor(options: VoightOptions) {
    if (!options || typeof options.agentId !== 'string' || !options.agentId) {
      throw new Error('Voight: `agentId` is required')
    }

    this.agentId = options.agentId
    this.apiKey = options.apiKey
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
    this.defaults = options.defaults ?? {}
    this.swallowErrors = options.swallowErrors ?? true

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
      metadata: { ...this.defaults, ...input.metadata },
    }

    try {
      const res = await this.fetchImpl(`${this.endpoint}/v1/events`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const error = `Voight API responded ${res.status}: ${text.slice(0, 200)}`
        if (!this.swallowErrors) throw new Error(error)
        return { ok: false, error }
      }

      const data = (await res.json().catch(() => ({}))) as {
        eventId?: string
      }
      return { ok: true, eventId: data.eventId }
    } catch (err) {
      if (!this.swallowErrors) throw err
      return { ok: false, error: (err as Error).message }
    }
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
      'x-voight-sdk': `@voightxyz/sdk@0.1.1`,
    }
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`
    return headers
  }
}

export default Voight
