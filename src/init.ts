/**
 * `voight init` — scaffolds Voight observability into a production
 * Node app that already calls OpenAI and/or Anthropic.
 *
 * Distinct from `voight setup` (which wires hooks into Claude Code,
 * Cursor, or Codex by editing global IDE config files):
 *   - `init` operates entirely inside `process.cwd()` — the user's
 *     project directory. It never touches `~/.claude`, `~/.cursor`,
 *     `~/.codex`, or any path outside cwd. This is enforced
 *     structurally: this module has no imports from `setup.ts`,
 *     no `homedir()` calls, no global config paths.
 *   - The output is a single generated file (`src/lib/voight.ts`)
 *     + an appended `.env.local` line for `VOIGHT_KEY`.
 *
 * Flow top-down:
 *   1. Read `package.json` for `openai` and/or `@anthropic-ai/sdk`
 *      in deps. Abort early if neither is present.
 *   2. Detect package manager (pnpm/yarn/bun/npm) so the install
 *      command we print matches the user's conventions.
 *   3. Detect Next.js to tailor the usage snippet at the end.
 *      Everything else falls back to the Express snippet.
 *   4. Prompt (TTY) or accept flags (non-TTY) for: privacy level,
 *      Voight API key, agent name.
 *   5. Validate the key with `GET /v1/me`. Refuse to write files
 *      if invalid — surfaces typos before the user ships to prod.
 *   6. Generate `src/lib/voight.ts` (or `lib/voight.ts` if no
 *      `src/`) with a header comment explaining how to adjust if
 *      provider keys come from a secrets manager instead of env.
 *   7. Append `VOIGHT_KEY=...` to `.env.local` (create if absent).
 *      Provider keys are never asked for or stored.
 *   8. Print the install command (right package manager) + a
 *      framework-tailored usage snippet.
 */

import { join, basename } from 'node:path'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs'
import { createInterface } from 'node:readline'

import { isPrivacyLevel, type PrivacyLevel } from './privacy.js'

const DEFAULT_PRIVACY: PrivacyLevel = 'standard'
const VOIGHT_API_BASE = 'https://api.voight.xyz'

// ─── Types ───────────────────────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export type Framework = 'next' | 'vanilla'

export interface DetectedProviders {
  /** Version range from package.json (e.g. `^4.79.2`), or `null`. */
  openai: string | null
  anthropic: string | null
}

export interface InitArgs {
  key?: string
  privacy?: PrivacyLevel
  agent?: string
}

// ─── Pure helpers (exported for testing) ─────────────────────────────

/**
 * Parse the argv slice handed to `voight init`. Accepts the same
 * `--flag value` and `--flag=value` styles as `parseArgs` in
 * setup.ts. Intentionally independent of setup.ts's parser to keep
 * the two surfaces decoupled — a future change to setup's flags
 * can't accidentally leak into init's flags.
 */
export function parseInitArgs(argv: string[]): InitArgs {
  let key: string | undefined
  let privacy: PrivacyLevel | undefined
  let agent: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--key' && argv[i + 1]) {
      key = argv[++i]
    } else if (a?.startsWith('--key=')) {
      key = a.slice('--key='.length)
    } else if (a === '--privacy' && argv[i + 1]) {
      const v = argv[++i]?.toLowerCase()
      if (v && isPrivacyLevel(v)) privacy = v
    } else if (a?.startsWith('--privacy=')) {
      const v = a.slice('--privacy='.length).toLowerCase()
      if (isPrivacyLevel(v)) privacy = v
    } else if (a === '--agent' && argv[i + 1]) {
      agent = argv[++i]
    } else if (a?.startsWith('--agent=')) {
      agent = a.slice('--agent='.length)
    }
  }

  return { key, privacy, agent }
}

/**
 * Read `<cwd>/package.json` and report which LLM SDKs the project
 * already depends on. Both `dependencies` and `devDependencies`
 * are inspected. Missing file, parse error, or missing fields all
 * collapse to `{ openai: null, anthropic: null }` so the caller
 * gets a uniform shape regardless of failure mode.
 *
 * The returned version strings are verbatim — `^4.79.2`, `~5.0.0`,
 * `0.96.0`, etc. The wizard later prints these to the user so they
 * can correlate with what's installed.
 */
export function detectAppProviders(cwd: string): DetectedProviders {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return { openai: null, anthropic: null }
  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw)
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    }
    const openai = typeof deps['openai'] === 'string' ? deps['openai'] : null
    const anthropic =
      typeof deps['@anthropic-ai/sdk'] === 'string'
        ? deps['@anthropic-ai/sdk']
        : null
    return { openai, anthropic }
  } catch {
    return { openai: null, anthropic: null }
  }
}

/**
 * Detect the package manager by looking for the lockfile each tool
 * writes. Falls back to `npm` when no lockfile is found.
 *
 * Order matters: pnpm > yarn > bun > npm. A project with multiple
 * lockfiles (rare, usually accidents) gets the higher-precedence
 * tool. Users with multiple lockfiles typically have one source of
 * truth — picking pnpm first matches real-world prevalence in 2026.
 */
export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  return 'npm'
}

/**
 * Build the install command for the user's package manager.
 */
export function packageManagerInstallCommand(pm: PackageManager): string {
  const pkgs = '@voightxyz/openai @voightxyz/anthropic'
  if (pm === 'pnpm') return `pnpm add ${pkgs}`
  if (pm === 'yarn') return `yarn add ${pkgs}`
  if (pm === 'bun') return `bun add ${pkgs}`
  return `npm install ${pkgs}`
}

/**
 * Detect Next.js by inspecting `package.json` deps. Used only to
 * tailor the usage snippet at the end of the wizard — never affects
 * the file that gets written, which is framework-agnostic.
 */
export function detectFramework(cwd: string): Framework {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return 'vanilla'
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    }
    if (typeof deps['next'] === 'string') return 'next'
  } catch {
    // fall through
  }
  return 'vanilla'
}

/**
 * Default agent name surfaced in the TTY prompt. Reads `package.json
 * name` when available; falls back to the cwd's last segment.
 */
export function readDefaultAgentName(cwd: string): string {
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        return pkg.name
      }
    } catch {
      // fall through
    }
  }
  return basename(cwd)
}

/**
 * Render the contents of `src/lib/voight.ts` for the providers we
 * detected. The header comment is part of the contract — it tells
 * the user what to change if their provider keys don't come from
 * env vars (AWS Secrets Manager, Vault, Doppler, etc.). Without it,
 * users with non-env key flows would have to guess.
 *
 * Always re-exports `withTrace` and `log` so callers can import
 * everything from one place. Re-exported from whichever provider
 * package we already imported — both wrappers share the same
 * async-context store at runtime, so the choice is arbitrary.
 */
export function generateAppVoightModule(opts: {
  providers: DetectedProviders
  agentName: string
  privacy: PrivacyLevel
}): string {
  const { providers, agentName, privacy } = opts
  const hasOpenai = providers.openai !== null
  const hasAnthropic = providers.anthropic !== null

  if (!hasOpenai && !hasAnthropic) {
    throw new Error(
      'generateAppVoightModule: at least one of openai or @anthropic-ai/sdk must be present',
    )
  }

  const header = [
    '// ──────────────────────────────────────────────────────────────────',
    '// Voight observability — generated by `npx @voightxyz/sdk init`',
    '//',
    '// Both wrapped clients use the standard `new OpenAI()` /',
    '// `new Anthropic()` constructors, which read OPENAI_API_KEY and',
    '// ANTHROPIC_API_KEY from process.env. This is the convention for',
    '// most apps (the values typically live in .env / .env.local).',
    '//',
    '// If your provider keys come from elsewhere (AWS Secrets Manager,',
    '// HashiCorp Vault, Doppler, a database, etc.), adjust the',
    '// constructor calls below to pass the key explicitly, e.g.:',
    '//',
    '//   const openai = wrapOpenAI(',
    `//     new OpenAI({ apiKey: await loadFromVault('openai') }),`,
    `//     { agent: '${agentName}', privacy: '${privacy}' }`,
    '//   )',
    '//',
    '// The Voight wrapper never sees the provider key — it wraps',
    '// whatever client you construct.',
    '// ──────────────────────────────────────────────────────────────────',
  ].join('\n')

  const imports: string[] = []
  if (hasOpenai) imports.push(`import OpenAI from 'openai'`)
  if (hasAnthropic) imports.push(`import Anthropic from '@anthropic-ai/sdk'`)
  if (hasOpenai) imports.push(`import { wrapOpenAI } from '@voightxyz/openai'`)
  if (hasAnthropic)
    imports.push(`import { wrapAnthropic } from '@voightxyz/anthropic'`)

  const blocks: string[] = []
  if (hasOpenai) {
    blocks.push(
      [
        `export const openai = wrapOpenAI(new OpenAI(), {`,
        `  agent: '${agentName}',`,
        `  privacy: '${privacy}',`,
        `})`,
      ].join('\n'),
    )
  }
  if (hasAnthropic) {
    blocks.push(
      [
        `export const anthropic = wrapAnthropic(new Anthropic(), {`,
        `  agent: '${agentName}',`,
        `  privacy: '${privacy}',`,
        `})`,
      ].join('\n'),
    )
  }

  const reexportFrom = hasOpenai ? '@voightxyz/openai' : '@voightxyz/anthropic'
  blocks.push(
    [
      `// Re-exports — import everything from one place.`,
      `export { withTrace, log } from '${reexportFrom}'`,
    ].join('\n'),
  )

  return [header, '', imports.join('\n'), '', blocks.join('\n\n'), ''].join('\n')
}

/**
 * Append (or create) `.env.local` with `VOIGHT_KEY=...`. If the
 * file already contains a `VOIGHT_KEY=` line we leave it alone —
 * overwriting silently would be hostile. Returns the action so the
 * caller can log it.
 */
export function writeEnvLocal(
  cwd: string,
  key: string,
): 'created' | 'appended' | 'already-set' {
  const envPath = join(cwd, '.env.local')
  const line = `VOIGHT_KEY=${key}`

  if (!existsSync(envPath)) {
    writeFileSync(envPath, line + '\n', 'utf-8')
    return 'created'
  }

  const existing = readFileSync(envPath, 'utf-8')
  if (/^VOIGHT_KEY=/m.test(existing)) {
    return 'already-set'
  }

  const needsNewline = existing.length > 0 && !existing.endsWith('\n')
  appendFileSync(envPath, (needsNewline ? '\n' : '') + line + '\n', 'utf-8')
  return 'appended'
}

/**
 * Where the generated module lives. `src/lib/voight.ts` if a `src/`
 * directory exists (Next.js default + most modern conventions);
 * `lib/voight.ts` otherwise.
 */
export function resolveVoightModulePath(cwd: string): {
  fullPath: string
  /** Relative path for printing to user. */
  display: string
} {
  const hasSrc = existsSync(join(cwd, 'src'))
  const display = hasSrc ? 'src/lib/voight.ts' : 'lib/voight.ts'
  return { fullPath: join(cwd, display), display }
}

// ─── TTY helpers (side-effecting) ────────────────────────────────────

function printHeader(cwd: string): void {
  console.log('')
  console.log(`  Voight · init → ${cwd}`)
  console.log('')
}

function printDetectionSummary(
  providers: DetectedProviders,
  pm: PackageManager,
  framework: Framework,
): void {
  const detected: string[] = []
  if (providers.openai) detected.push(`openai (${providers.openai})`)
  if (providers.anthropic)
    detected.push(`@anthropic-ai/sdk (${providers.anthropic})`)
  console.log(`  ✓ Detected providers: ${detected.join(' + ')}`)
  console.log(`  ✓ Detected package manager: ${pm}`)
  console.log(
    `  ✓ Detected framework: ${framework === 'next' ? 'Next.js' : 'none (vanilla)'}`,
  )
  console.log('')
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function askPrivacy(): Promise<PrivacyLevel> {
  console.log('  Privacy level for this project?')
  console.log('')
  console.log('    1) Minimal · metadata only (tokens, latency, cost)')
  console.log(
    '    2) Standard ★ Required for customer-facing apps — PII scrubbing on',
  )
  console.log('    3) Full · raw, no scrubbing (debugging only)')
  console.log('')
  for (let attempt = 0; attempt < 5; attempt++) {
    const ans = (await ask('  > ')).toLowerCase()
    if (ans === '' || ans === '2' || ans === 'standard') return 'standard'
    if (ans === '1' || ans === 'minimal') return 'minimal'
    if (ans === '3' || ans === 'full') return 'full'
    console.log(`  Didn't recognise "${ans}". Try 1, 2, or 3.`)
  }
  console.log('  Sticking with default: standard.')
  return DEFAULT_PRIVACY
}

/**
 * Validate the supplied API key by pinging `POST /v1/events` with an
 * empty payload. The two relevant codes:
 *
 *   401 — `unauthorized` / `unknown_key`. Key is invalid; refuse to
 *         write files so the user discovers the typo before they
 *         ship to production.
 *   400 — auth passed; Zod rejected the empty body (`agentId_required`).
 *         This is success from our perspective: it confirms the key
 *         is real without creating any event in the dashboard.
 *
 * `/v1/me` (the Privy-authed dashboard endpoint) would be the wrong
 * target — it accepts JWTs from the dashboard, not `vk_` SDK keys.
 * We use the ingestion endpoint precisely because it's the one the
 * SDK key is for.
 */
export async function validateVoightKey(
  key: string,
  apiBase: string = VOIGHT_API_BASE,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`${apiBase}/v1/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    if (res.status === 401) {
      return { ok: false, reason: 'invalid key (401)' }
    }
    // 400 = auth passed, Zod rejected the empty payload (expected).
    // 2xx = key valid and (improbably) accepted the empty body.
    // 4xx other than 401 = treat as authenticated (e.g. 403 quota,
    // 429 rate-limited — the key itself is real).
    if (res.status < 500) {
      return { ok: true }
    }
    return { ok: false, reason: `unexpected ${res.status}` }
  } catch (err) {
    return {
      ok: false,
      reason: `network error: ${(err as Error).message}`,
    }
  }
}

function printUsageSnippet(framework: Framework, hasOpenai: boolean): void {
  console.log('  Use it in your handlers:')
  console.log('')
  if (framework === 'next') {
    if (hasOpenai) {
      console.log(`    // app/api/chat/route.ts`)
      console.log(`    import { openai, withTrace } from '@/lib/voight'`)
      console.log('')
      console.log(`    export async function POST(req: Request) {`)
      console.log(`      return withTrace(`)
      console.log(`        async () => {`)
      console.log(`          const r = await openai.chat.completions.create({`)
      console.log(`            model: 'gpt-4o-mini',`)
      console.log(
        `            messages: [{ role: 'user', content: 'Hello' }],`,
      )
      console.log(`          })`)
      console.log(
        `          return Response.json({ reply: r.choices[0].message })`,
      )
      console.log(`        },`)
      console.log(`        {`)
      console.log(`          routeTag: 'POST /api/chat',`)
      console.log(`          tags: { userId: 'user_123', plan: 'pro' },`)
      console.log(`        },`)
      console.log(`      )`)
      console.log(`    }`)
    } else {
      console.log(`    // app/api/chat/route.ts`)
      console.log(`    import { anthropic, withTrace } from '@/lib/voight'`)
      console.log('')
      console.log(`    export async function POST(req: Request) {`)
      console.log(`      return withTrace(`)
      console.log(`        async () => {`)
      console.log(`          const r = await anthropic.messages.create({`)
      console.log(`            model: 'claude-haiku-4-5',`)
      console.log(`            max_tokens: 256,`)
      console.log(
        `            messages: [{ role: 'user', content: 'Hello' }],`,
      )
      console.log(`          })`)
      console.log(`          return Response.json({ reply: r })`)
      console.log(`        },`)
      console.log(
        `        { routeTag: 'POST /api/chat', tags: { userId: 'user_123' } },`,
      )
      console.log(`      )`)
      console.log(`    }`)
    }
  } else {
    const provider = hasOpenai ? 'openai' : 'anthropic'
    const callExample = hasOpenai
      ? `await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [...] })`
      : `await anthropic.messages.create({ model: 'claude-haiku-4-5', max_tokens: 256, messages: [...] })`
    console.log(`    import { ${provider}, withTrace } from './lib/voight'`)
    console.log('')
    console.log(`    app.post('/api/chat', async (req, res) => {`)
    console.log(`      await withTrace(`)
    console.log(`        async () => {`)
    console.log(`          const r = ${callExample}`)
    console.log(`          res.json({ reply: r })`)
    console.log(`        },`)
    console.log(`        {`)
    console.log(`          routeTag: 'POST /api/chat',`)
    console.log(`          tags: { userId: req.user.id, plan: req.user.plan },`)
    console.log(`        },`)
    console.log(`      )`)
    console.log(`    })`)
  }
  console.log('')
}

/**
 * Main orchestrator. Side effects start at file write (step 5+) —
 * everything before that is detection + prompting + validation, so
 * a failure exits cleanly without touching the user's project.
 */
export async function runInit(argv: string[]): Promise<void> {
  const cwd = process.cwd()
  const args = parseInitArgs(argv)

  printHeader(cwd)

  // ── Detect providers (abort if neither) ──────────────────────────
  const providers = detectAppProviders(cwd)
  const hasOpenai = providers.openai !== null
  const hasAnthropic = providers.anthropic !== null
  if (!hasOpenai && !hasAnthropic) {
    console.error(
      '  ✗ No openai or @anthropic-ai/sdk detected in package.json.',
    )
    console.error('')
    console.error(
      '    Voight init is for projects that already use one of these SDKs.',
    )
    console.error(
      '    If you are in a monorepo, cd into the app folder first (e.g. cd apps/web).',
    )
    console.error('    Otherwise, install the provider SDK you plan to use:')
    console.error('')
    console.error('      npm install openai')
    console.error('      npm install @anthropic-ai/sdk')
    console.error('')
    console.error('    Then re-run `npx -y @voightxyz/sdk init`.')
    process.exit(1)
  }

  const pm = detectPackageManager(cwd)
  const framework = detectFramework(cwd)
  printDetectionSummary(providers, pm, framework)

  // ── Privacy ──────────────────────────────────────────────────────
  let privacy: PrivacyLevel | undefined = args.privacy
  if (!privacy && typeof process.env.VOIGHT_PRIVACY === 'string') {
    const env = process.env.VOIGHT_PRIVACY.toLowerCase()
    if (isPrivacyLevel(env)) privacy = env
  }

  if (!privacy) {
    if (process.stdin.isTTY) {
      privacy = await askPrivacy()
    } else {
      console.error(
        '  ✗ No --privacy flag supplied (running in non-TTY mode).',
      )
      console.error('')
      console.error('    Re-run with:')
      console.error(
        '      npx -y @voightxyz/sdk init --privacy=standard --key=vk_...',
      )
      process.exit(2)
    }
  }
  console.log(`  ✓ Privacy: ${privacy}`)
  console.log('')

  // ── Key (with validation) ────────────────────────────────────────
  let key = args.key ?? process.env.VOIGHT_KEY
  if (!key) {
    if (process.stdin.isTTY) {
      console.log('  Now we need your Voight API key:')
      console.log('    1. Open  → https://voight.xyz/dashboard')
      console.log('    2. Sign in (Google / X / wallet)')
      console.log(
        '    3. Settings → Generate key → copy the vk_… secret',
      )
      console.log('')
      key = await ask('  Paste it here: ')
      if (!key) {
        console.error('  ✗ No key entered. Aborting.')
        process.exit(1)
      }
    } else {
      console.error(
        '  ✗ No --key flag and no VOIGHT_KEY env var (running in non-TTY mode).',
      )
      process.exit(2)
    }
  }

  if (!key.startsWith('vk_')) {
    console.warn(
      `  ⚠ Heads up — Voight keys usually start with vk_ (got "${key.slice(
        0,
        8,
      )}…"). Continuing anyway.`,
    )
  }

  console.log('  ✓ Validating key with api.voight.xyz…')
  const validation = await validateVoightKey(key)
  if (!validation.ok) {
    console.error(`  ✗ Key validation failed: ${validation.reason}`)
    console.error('    No files written. Fix the key and re-run.')
    process.exit(1)
  }
  console.log('  ✓ Key valid')
  console.log('')

  // ── Agent name ───────────────────────────────────────────────────
  let agentName = args.agent
  if (!agentName) {
    const defaultName = readDefaultAgentName(cwd)
    if (process.stdin.isTTY) {
      const ans = await ask(
        `  Agent name (defaults to "${defaultName}")? `,
      )
      agentName = ans.length > 0 ? ans : defaultName
    } else {
      agentName = defaultName
    }
  }
  console.log(`  ✓ Agent: ${agentName}`)
  console.log('')

  // ── Generate & write module ──────────────────────────────────────
  const { fullPath, display } = resolveVoightModulePath(cwd)

  if (existsSync(fullPath)) {
    console.error(`  ✗ ${display} already exists.`)
    console.error(
      '    Move it aside (or delete it) and re-run if you want it regenerated.',
    )
    process.exit(1)
  }

  const moduleSource = generateAppVoightModule({
    providers,
    agentName,
    privacy,
  })

  // Ensure parent dir exists (e.g. lib/ if cwd has no src/).
  const parentDir = fullPath.slice(0, fullPath.lastIndexOf('/'))
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }
  writeFileSync(fullPath, moduleSource, 'utf-8')
  console.log(`  ✓ Wrote ${display}`)

  // ── .env.local ───────────────────────────────────────────────────
  const envAction = writeEnvLocal(cwd, key)
  if (envAction === 'created') {
    console.log('  ✓ Created .env.local with VOIGHT_KEY')
  } else if (envAction === 'appended') {
    console.log('  ✓ Appended VOIGHT_KEY to .env.local')
  } else {
    console.log(
      '  ✓ .env.local already has a VOIGHT_KEY entry — leaving it alone',
    )
  }
  console.log('')

  // ── Usage snippet + install command ──────────────────────────────
  printUsageSnippet(framework, hasOpenai)

  console.log('  One more step — install the wrappers:')
  console.log(`    ${packageManagerInstallCommand(pm)}`)
  console.log('')
  console.log('  Then open https://voight.xyz/dashboard/ai-apps')
  console.log('')
}
