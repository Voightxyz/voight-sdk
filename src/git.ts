/**
 * Git-context capture for events emitted by the Claude Code hook.
 *
 * Every event ships with a `metadata.git` block describing the working
 * tree at the moment the hook fired:
 *
 *   git: {
 *     sha:      "b921fa6e3c..."   // full HEAD sha
 *     shortSha: "b921fa6"          // 7-char prefix, dashboard-friendly
 *     branch:   "main"             // null when detached HEAD
 *     remote:   "github.com/voightxyz/voight"  // host + path, no protocol
 *     dirty:    true               // uncommitted changes present?
 *   }
 *
 * This makes every trace traceable back to the exact code state that
 * produced it — the differentiator for agent observability vs.
 * Sentry/Datadog. "What SHA was running when this failed?" becomes a
 * one-click answer instead of an archaeology session.
 *
 * Cost control: git invocations are spawned synchronously (the hook
 * is a short-lived process) but cached in tmpdir for 30 seconds so
 * a burst of events on the same cwd does not pay the latency cost
 * over and over. Cache keyed by cwd; TTL chosen to be short enough
 * that a commit made by the agent itself shows up on the next event
 * within the same trace.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type GitContext = {
  /** Full 40-char HEAD SHA. */
  sha?: string
  /** First 7 chars of the SHA — dashboard-friendly. */
  shortSha?: string
  /** Current branch name, or null when detached HEAD. */
  branch?: string | null
  /** Origin URL normalised to "host/owner/repo" form. SSH and HTTPS
   * collapse to the same shape. Null when no origin remote exists. */
  remote?: string | null
  /** True when `git status --porcelain` is non-empty. */
  dirty?: boolean
}

const CACHE_DIR = join(tmpdir(), 'voight-git')
const CACHE_TTL_MS = 30 * 1000
/** Hard cap on how long any single git invocation may run. Hook
 * subprocesses are short-lived; we'd rather drop a slow command than
 * hang the editor. */
const GIT_TIMEOUT_MS = 800

function cacheKey(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

function cachePath(cwd: string): string {
  return join(CACHE_DIR, `${cacheKey(cwd)}.json`)
}

function readCache(cwd: string): { ctx: GitContext; ts: number } | null {
  try {
    const path = cachePath(cwd)
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      ctx?: GitContext
      ts?: number
    }
    if (
      !raw.ctx ||
      typeof raw.ts !== 'number' ||
      Date.now() - raw.ts > CACHE_TTL_MS
    ) {
      return null
    }
    return { ctx: raw.ctx, ts: raw.ts }
  } catch {
    return null
  }
}

function writeCache(cwd: string, ctx: GitContext): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(
      cachePath(cwd),
      JSON.stringify({ ctx, ts: Date.now() }),
    )
  } catch {
    /* ignore — cache is best-effort */
  }
}

/** Execute a git command synchronously and return its stdout, or null
 * on any failure (non-zero exit, timeout, missing binary, etc.).
 * Errors are intentionally swallowed — git context is an enrichment,
 * never a failure path. */
function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true,
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/** Normalise a git remote URL to "host/owner/repo" form. Both
 * `git@github.com:voightxyz/voight.git` and
 * `https://github.com/voightxyz/voight.git` collapse to
 * `github.com/voightxyz/voight`. Anything we can't recognise is
 * returned unchanged so the dashboard can still display something. */
export function normaliseRemote(url: string | null | undefined): string | null {
  if (!url) return null
  let s = url.trim()
  if (!s) return null

  // Strip trailing .git
  s = s.replace(/\.git$/i, '')

  // SSH form: git@host:owner/repo
  const sshMatch = /^[^@]+@([^:]+):(.+)$/.exec(s)
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`

  // HTTPS / SSH-protocol form: scheme://[user@]host/path
  const urlMatch = /^[a-z]+:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/.exec(s)
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2]}`

  return s
}

/**
 * Compute git context for `cwd`, ignoring cache. Returns null when
 * the directory is not a git repo or git isn't installed. Each
 * field is independently best-effort: a partial result (e.g. SHA
 * present, branch missing because detached) is still useful.
 */
export function getGitContext(cwd: string | undefined): GitContext | null {
  if (!cwd) return null
  // Cheapest possible check — bail before spawning four subprocesses
  // for a non-repo directory. `rev-parse --git-dir` succeeds inside
  // the repo and inside any worktree.
  if (!git(cwd, ['rev-parse', '--git-dir'])) return null

  const sha = git(cwd, ['rev-parse', 'HEAD'])
  const branchRaw = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const remote = normaliseRemote(
    git(cwd, ['config', '--get', 'remote.origin.url']),
  )
  const status = git(cwd, ['status', '--porcelain'])

  const ctx: GitContext = {}
  if (sha) {
    ctx.sha = sha
    ctx.shortSha = sha.slice(0, 7)
  }
  // 'HEAD' is what `--abbrev-ref` returns for detached HEAD. Map to
  // null so the dashboard renders "detached" rather than literal
  // "HEAD" which would be confusing.
  ctx.branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null
  ctx.remote = remote
  ctx.dirty = status !== null && status.length > 0

  // If we couldn't even read the SHA, treat as not-a-repo and return
  // null. Avoids shipping `{ dirty: false, branch: null }` bricks
  // that confuse the dashboard.
  if (!ctx.sha && !ctx.branch && !ctx.remote) return null

  return ctx
}

/**
 * Cached wrapper around `getGitContext`. Reads from a tmpdir cache
 * keyed by cwd with a 30-second TTL. The first event after a fresh
 * commit pays the recompute cost; subsequent events within the
 * window read straight from cache.
 */
export function getGitContextCached(
  cwd: string | undefined,
): GitContext | null {
  if (!cwd) return null
  const cached = readCache(cwd)
  if (cached) return cached.ctx
  const ctx = getGitContext(cwd)
  if (ctx) writeCache(cwd, ctx)
  return ctx
}

/** Probabilistic GC of stale cache entries. Same pattern as the
 * other tmpdir caches in the SDK. */
export function gcGitDir(): void {
  if (Math.random() > 0.05) return
  try {
    if (!existsSync(CACHE_DIR)) return
    const now = Date.now()
    for (const f of readdirSync(CACHE_DIR)) {
      const p = join(CACHE_DIR, f)
      try {
        const st = statSync(p)
        // Drop entries older than 1 hour. The 30-second TTL covers
        // freshness; this just keeps the directory from growing.
        if (now - st.mtimeMs > 60 * 60 * 1000) unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export const _internals = {
  CACHE_DIR,
  CACHE_TTL_MS,
  GIT_TIMEOUT_MS,
  cachePath,
}
