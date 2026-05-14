/**
 * `voight setup` — wires Voight observability into Claude Code.
 *
 * Targets `~/.claude/settings.json` by default. Adds:
 *   - env.VOIGHT_KEY            (your Voight API key)
 *   - env.VOIGHT_PRIVACY        (capture level: minimal | standard | full)
 *   - hooks.PreToolUse          (fires before any tool the agent runs)
 *   - hooks.PostToolUse         (fires after, with result)
 *   - hooks.UserPromptSubmit    (every prompt the user sends)
 *   - hooks.Stop                (run finished)
 *
 * Each hook just shells out to `npx -y @voightxyz/sdk hook`, which
 * reads the JSON event from stdin and POSTs it to /v1/events.
 *
 * Idempotent — running twice doesn't duplicate hook entries; running
 * with a new key updates the env var. The privacy prompt shows the
 * current value when re-running so the user can keep or change it.
 */

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { isPrivacyLevel, type PrivacyLevel } from './privacy.js'

type Target = 'claude' | 'cursor' | 'codex'

/**
 * Friendly display name for a target. Used in user-facing wizard
 * output so the success message says "Cursor" when the user is
 * setting up Cursor, not the hardcoded "Claude Code" of v0.4.2.
 *
 * Keep in sync with the Target type union. Adding a new target
 * requires a branch here; TypeScript exhaustiveness keeps that honest.
 */
export function frameworkName(target: Target): string {
  switch (target) {
    case 'claude':
      return 'Claude Code'
    case 'cursor':
      return 'Cursor'
    case 'codex':
      return 'Codex'
  }
}

const SETUP_DEFAULT_PRIVACY: PrivacyLevel = 'standard'

const SUPPORTED_HOOKS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'Notification',
  'PreCompact',
] as const
type HookName = (typeof SUPPORTED_HOOKS)[number]

const HOOK_COMMAND = 'npx -y @voightxyz/sdk hook'

function targetSettingsPath(target: Target): string {
  switch (target) {
    case 'claude':
      return join(homedir(), '.claude', 'settings.json')
    case 'cursor':
      return join(homedir(), '.cursor', 'settings.json')
    case 'codex':
      return join(homedir(), '.codex', 'settings.json')
  }
}

export function parseArgs(argv: string[]): {
  key?: string
  target: Target
  privacy?: PrivacyLevel
} {
  let key: string | undefined
  let target: Target = 'claude'
  let privacy: PrivacyLevel | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--key' && argv[i + 1]) {
      key = argv[++i]
    } else if (a?.startsWith('--key=')) {
      key = a.slice('--key='.length)
    } else if (a === '--target' && argv[i + 1]) {
      const t = argv[++i] as Target
      if (t === 'claude' || t === 'cursor' || t === 'codex') target = t
    } else if (a?.startsWith('--target=')) {
      const t = a.slice('--target='.length) as Target
      if (t === 'claude' || t === 'cursor' || t === 'codex') target = t
    } else if (a === '--privacy' && argv[i + 1]) {
      const parsed = parsePrivacyChoice(argv[++i] ?? '', null)
      if (parsed) privacy = parsed
    } else if (a?.startsWith('--privacy=')) {
      const parsed = parsePrivacyChoice(a.slice('--privacy='.length), null)
      if (parsed) privacy = parsed
    }
  }
  return { key, target, privacy }
}

/**
 * Translate a wizard answer to a PrivacyLevel.
 *
 * Accepts `1` / `2` / `3` (the numeric menu shortcuts shown to the
 * user) and `minimal` / `standard` / `full` (case-insensitive). An
 * empty string falls back to `defaultLevel`. Anything else returns
 * `null` so the caller can re-prompt without crashing.
 *
 * Pure function: no readline, no I/O. The wizard loops over it
 * until a non-null value comes back.
 */
export function parsePrivacyChoice(
  input: string,
  defaultLevel: PrivacyLevel | null = SETUP_DEFAULT_PRIVACY,
): PrivacyLevel | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return defaultLevel
  if (trimmed === '1') return 'minimal'
  if (trimmed === '2') return 'standard'
  if (trimmed === '3') return 'full'
  const lower = trimmed.toLowerCase()
  if (isPrivacyLevel(lower)) return lower
  return null
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

function readSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) return {}
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Could not parse ${path}: ${(err as Error).message}. Move it aside and re-run.`,
    )
  }
}

function ensureHook(
  settings: Record<string, any>,
  hookName: HookName,
): boolean {
  if (!settings.hooks) settings.hooks = {}
  const list = (settings.hooks[hookName] = settings.hooks[hookName] ?? [])
  if (!Array.isArray(list)) return false

  // Look for our command anywhere in the existing matchers.
  const alreadyWired = list.some((entry: any) =>
    Array.isArray(entry?.hooks)
      ? entry.hooks.some(
          (h: any) =>
            h?.type === 'command' &&
            typeof h.command === 'string' &&
            h.command.includes('@voightxyz/sdk'),
        )
      : false,
  )
  if (alreadyWired) return false

  // Add a new top-level entry that matches everything.
  const entry: any = {
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  }
  // Tool-firing hooks support a matcher; lifecycle hooks don't.
  if (hookName === 'PreToolUse' || hookName === 'PostToolUse') {
    entry.matcher = '*'
  }
  list.push(entry)
  return true
}

function writeSettings(path: string, settings: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}

function readExistingPrivacy(
  settings: Record<string, any>,
): PrivacyLevel | undefined {
  const env = settings?.env
  if (!env || typeof env !== 'object') return undefined
  const raw = env.VOIGHT_PRIVACY
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().toLowerCase()
  return isPrivacyLevel(trimmed) ? trimmed : undefined
}

function printPrivacyMenu(currentValue?: PrivacyLevel): void {
  console.log('')
  console.log('  👋 Welcome to Voight. We capture telemetry from your AI agents')
  console.log('  to help you debug, monitor, and audit. First, pick how much')
  console.log('  to share:')
  console.log('')
  console.log('    1) Minimal   — metadata only (tool names, timing, outcomes).')
  console.log('                   No prompts, responses, or file paths leave')
  console.log('                   your machine.')
  console.log('                   Best for regulated work or maximum privacy.')
  console.log('')
  console.log('    2) Standard  — full content + local PII scrubbing             ★')
  console.log('                   We capture what your agent does and says, but')
  console.log('                   anything that looks private (credentials, personal')
  console.log('                   info, etc.) is redacted on your machine before')
  console.log('                   leaving it.')
  console.log('                   Best for most developers.')
  console.log('')
  console.log('    3) Full      — everything captured as-is. No filtering.')
  console.log('                   You trust the operator with raw output.')
  console.log('                   Best for solo dev / maximum debug detail.')
  console.log('')
  if (currentValue) {
    console.log(`  Current setting: ${currentValue}. Press Enter to keep it,`)
    console.log('  or pick a new level.')
  }
}

/**
 * Step 1 — non-TTY welcome / privacy menu.
 *
 * Shown when the user runs `npx setup` from inside a non-interactive
 * shell (Claude Code's bash tool, CI, SSH script, …) without yet
 * having picked a privacy level. The reader either pastes their
 * choice into the chat (Claude figures out the re-invocation) or
 * re-runs in their own terminal.
 */
function printNonTtyWelcome(): void {
  printPrivacyMenu()
  console.log('  Pick a number (1, 2, or 3) or a name (minimal / standard / full),')
  console.log('  then re-run with that choice as a flag. For example, to pick Standard:')
  console.log('')
  console.log('      npx -y @voightxyz/sdk setup --privacy=2')
  console.log('')
}

/**
 * Step 2 — non-TTY API-key instructions, after a privacy level was
 * supplied but no key.
 */
function printNonTtyApiKeyInstructions(privacy: PrivacyLevel): void {
  console.log('')
  console.log(`  ✓ ${capitalize(privacy)} mode selected.`)
  console.log('')
  console.log('  Now we need your API key:')
  console.log('')
  console.log('    1. Open  → https://voight.xyz/dashboard')
  console.log('    2. Sign in (Google / X / wallet — one click)')
  console.log('    3. Settings → Generate key → copy the vk_… secret')
  console.log('    4. Paste it here.')
  console.log('')
}

/**
 * Step 3 — final celebration. Used by both TTY and non-TTY flows
 * once setup completes.
 */
function printDoneMessage(
  privacy: PrivacyLevel,
  addedHooks: number,
  target: Target,
): void {
  const hookWord = addedHooks === 1 ? 'hook' : 'hooks'
  console.log('')
  console.log("  🎉 You're all set!")
  console.log('')
  console.log(`    ✓ ${capitalize(privacy)} mode enabled`)
  console.log(`    ✓ ${addedHooks} ${hookWord} wired into ${frameworkName(target)}`)
  console.log('    ✓ API key configured')
  console.log('')
  console.log('    → See your agent live: https://voight.xyz/dashboard')
  console.log('')
}

/**
 * Resolve an existing API key from a settings.json blob. When the
 * user re-runs setup to update only the privacy level (or other
 * field), we keep the existing key rather than asking again.
 */
function readExistingKey(settings: Record<string, any>): string | undefined {
  const v = settings?.env?.VOIGHT_KEY
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

async function askPrivacyLevel(
  currentValue: PrivacyLevel | undefined,
): Promise<PrivacyLevel> {
  printPrivacyMenu(currentValue)
  // If we have a current value re-runs default to it; otherwise the
  // wizard's recommended default.
  const defaultLevel = currentValue ?? SETUP_DEFAULT_PRIVACY
  for (let attempts = 0; attempts < 5; attempts++) {
    const prompt = `  Choose [1/2/3] (default: ${defaultLevel === 'minimal' ? '1' : defaultLevel === 'full' ? '3' : '2'}): `
    const answer = await ask(prompt)
    const parsed = parsePrivacyChoice(answer, defaultLevel)
    if (parsed) return parsed
    console.log('  Please answer 1, 2, 3, or press Enter for the default.')
  }
  // Five strikes: bail to default rather than loop forever.
  console.log(`  Sticking with default: ${defaultLevel}.`)
  return defaultLevel
}

export async function runSetup(argv: string[]): Promise<void> {
  const { key: keyArg, target, privacy: privacyArg } = parseArgs(argv)
  const settingsPath = targetSettingsPath(target)

  console.log('')
  console.log(`  Voight · setup → ${target}`)
  console.log(`  ${settingsPath}`)
  console.log('')

  // Read settings once so the privacy step can show the current value
  // and the key step can layer on top of the same object.
  const settings = readSettings(settingsPath)
  const existingPrivacy = readExistingPrivacy(settings)
  const existingKey = readExistingKey(settings)

  // Resolve privacy: flag → env → existing settings.json. If none,
  // we'll either prompt (TTY) or exit at step 1 (non-TTY).
  let privacy: PrivacyLevel | undefined = privacyArg
  if (!privacy && typeof process.env.VOIGHT_PRIVACY === 'string') {
    const fromEnv = parsePrivacyChoice(process.env.VOIGHT_PRIVACY, null)
    if (fromEnv) privacy = fromEnv
  }
  if (!privacy) privacy = existingPrivacy

  // Resolve key: flag → env → existing settings.json. Existing key
  // is reused so re-runs that only update privacy don't force a
  // re-paste of the secret.
  let key = keyArg ?? process.env.VOIGHT_KEY ?? existingKey

  if (!process.stdin.isTTY) {
    // Non-TTY (Claude Code chat, CI, SSH, …): drive the same 3-step
    // flow as TTY but via discrete CLI invocations. Each step prints
    // an instruction and exits; the user (or the AI agent reading
    // the output) supplies the next piece and re-invokes.
    if (!privacy) {
      // Step 1 — Welcome + privacy menu.
      printNonTtyWelcome()
      process.exit(2)
    }
    if (!key) {
      // Step 2 — API key instructions for the chosen level.
      printNonTtyApiKeyInstructions(privacy)
      process.exit(2)
    }
    // Both supplied → fall through to step 3 (actual setup).
  } else {
    // TTY interactive flow.
    if (!privacy) {
      privacy = await askPrivacyLevel(existingPrivacy)
    }
    if (!key) {
      console.log('')
      console.log(`  ✓ ${capitalize(privacy)} mode selected.`)
      console.log('')
      console.log('  Now we need your API key:')
      console.log('')
      console.log('    1. Open  → https://voight.xyz/dashboard')
      console.log('    2. Sign in (Google / X / wallet — one click)')
      console.log('    3. Settings → Generate key → copy the vk_… secret')
      console.log('')
      key = await ask('  Paste it here: ')
      if (!key) {
        console.error('  No key entered. Aborting.')
        process.exit(1)
      }
    }
  }

  if (!key.startsWith('vk_')) {
    console.warn(`  Heads up: keys usually start with vk_ — got "${key.slice(0, 8)}…"`)
  }

  // ── Step 3: write settings.json + hooks ─────────────────────────
  if (!settings.env || typeof settings.env !== 'object') settings.env = {}
  settings.env.VOIGHT_KEY = key
  settings.env.VOIGHT_PRIVACY = privacy

  let added = 0
  for (const h of SUPPORTED_HOOKS) {
    if (ensureHook(settings, h)) added++
  }
  writeSettings(settingsPath, settings)

  printDoneMessage(privacy, added, target)
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s
}
