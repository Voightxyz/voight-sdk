/**
 * `voight setup` — wires Voight observability into Claude Code.
 *
 * Targets `~/.claude/settings.json` by default. Adds:
 *   - env.VOIGHT_KEY            (your Voight API key)
 *   - hooks.PreToolUse          (fires before any tool the agent runs)
 *   - hooks.PostToolUse         (fires after, with result)
 *   - hooks.UserPromptSubmit    (every prompt the user sends)
 *   - hooks.Stop                (run finished)
 *
 * Each hook just shells out to `npx -y @voightxyz/sdk hook`, which
 * reads the JSON event from stdin and POSTs it to /v1/events.
 *
 * Idempotent — running twice doesn't duplicate hook entries; running
 * with a new key updates the env var.
 */

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

type Target = 'claude' | 'cursor' | 'codex'

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

function parseArgs(argv: string[]): { key?: string; target: Target } {
  let key: string | undefined
  let target: Target = 'claude'
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
    }
  }
  return { key, target }
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

export async function runSetup(argv: string[]): Promise<void> {
  const { key: keyArg, target } = parseArgs(argv)
  const settingsPath = targetSettingsPath(target)

  console.log('')
  console.log(`  Voight · setup → ${target}`)
  console.log(`  ${settingsPath}`)
  console.log('')

  let key = keyArg ?? process.env.VOIGHT_KEY
  if (!key) {
    // We can't prompt when stdin isn't a TTY (e.g. when running inside
    // Claude Code's bash tool, an SSH script, or any other agent). Bail
    // with a message that's friendly for both the human reading their
    // terminal AND the AI assistant orchestrating the install.
    if (!process.stdin.isTTY) {
      console.log('')
      console.log('  ────────────────────────────────────────────────')
      console.log('  Voight setup needs your API key to continue.')
      console.log('  ────────────────────────────────────────────────')
      console.log('')
      console.log('    1. Open  → https://voight.xyz/dashboard')
      console.log('    2. Sign in (Google / X / wallet — one click)')
      console.log('    3. Settings → Generate key → copy the vk_… secret')
      console.log('    4. Re-run:')
      console.log('')
      console.log('       npx -y @voightxyz/sdk setup --key=YOUR_KEY')
      console.log('')
      console.log('  (or set the VOIGHT_KEY env var and re-run.)')
      console.log('')
      process.exit(2)
    }

    console.log('  Need an API key — generate one at https://voight.xyz/dashboard')
    key = await ask('  Paste your VOIGHT_KEY (vk_…): ')
    if (!key) {
      console.error('  No key entered. Aborting.')
      process.exit(1)
    }
  }
  if (!key.startsWith('vk_')) {
    console.warn(`  Heads up: keys usually start with vk_ — got "${key.slice(0, 8)}…"`)
  }

  const settings = readSettings(settingsPath)

  // env.VOIGHT_KEY
  if (!settings.env || typeof settings.env !== 'object') settings.env = {}
  settings.env.VOIGHT_KEY = key

  // Hooks (idempotent)
  let added = 0
  for (const h of SUPPORTED_HOOKS) {
    if (ensureHook(settings, h)) added++
  }

  writeSettings(settingsPath, settings)

  console.log('')
  console.log(`  ✓ wired up — ${added} new hook${added === 1 ? '' : 's'} added`)
  console.log('')
  if (target === 'claude') {
    console.log('  Restart Claude Code (or open a new chat) to start streaming events.')
  } else {
    console.log(`  Restart ${target} to start streaming events.`)
  }
  console.log('  Watch them roll in: https://voight.xyz/dashboard')
  console.log('')
}
