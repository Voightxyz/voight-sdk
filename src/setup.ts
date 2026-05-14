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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { execSync } from 'node:child_process'
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

/**
 * Infer which coding agent is invoking the SDK from environment
 * variables inherited from the parent process. Returns `undefined`
 * when no strong signal is present; callers fall back to a default
 * (today: `claude`) so the existing behaviour stays unchanged when
 * detection can't be sure.
 *
 * Heuristics:
 *   - `CURSOR_TRACE_ID`           → Cursor spawns agent processes
 *                                   with this trace id in env.
 *   - `TERM_PROGRAM === 'cursor'` → Cursor's integrated terminal
 *                                   (overrides VS Code's default).
 *   - `CLAUDECODE === '1'`        → Claude Code's documented marker.
 *   - `CLAUDE_CODE_SSE_PORT`      → Claude Code SSE bridge port.
 *   - `CODEX_SESSION_ID`          → speculative; refined when the
 *                                   real Codex adapter ships.
 *
 * Order is most-specific-first: Cursor's signals win over Claude's
 * when both are present (e.g. user has Claude Code session active
 * but is currently in Cursor's terminal — the actual caller is
 * Cursor).
 */
export function detectTarget(
  env: NodeJS.ProcessEnv = process.env,
): Target | undefined {
  if (env.CURSOR_TRACE_ID) return 'cursor'
  if (env.TERM_PROGRAM === 'cursor') return 'cursor'
  if (env.CLAUDECODE === '1') return 'claude'
  if (env.CLAUDE_CODE_SSE_PORT) return 'claude'
  // Codex Desktop sets CODEX_THREAD_ID on every spawned subprocess
  // (unique per thread). Fallback to CODEX_SHELL or the macOS
  // bundle identifier for older builds that might not include
  // THREAD_ID. Strings extracted from /Applications/Codex.app
  // binary 2026-05-14.
  if (env.CODEX_THREAD_ID) return 'codex'
  if (env.CODEX_SHELL === '1') return 'codex'
  if (env.__CFBundleIdentifier === 'com.openai.codex') return 'codex'
  return undefined
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
      // Cursor uses a dedicated hooks.json (not settings.json) with
      // a different schema; see writeCursorHooks() below.
      return join(homedir(), '.cursor', 'hooks.json')
    case 'codex':
      // Codex uses a marketplace plugin model. The wizard header
      // displays the marketplace manifest path; the actual files
      // written are scattered across the marketplace tree (see
      // writeCodexPlugin below).
      return join(
        homedir(),
        '.codex',
        'plugins',
        'voight-marketplace',
        '.agents',
        'plugins',
        'marketplace.json',
      )
  }
}

// ─── Cursor adapter ──────────────────────────────────────────────
//
// Cursor's hook system differs from Claude Code's in three ways the
// SDK must respect:
//   1. Config file is ~/.cursor/hooks.json (not settings.json).
//   2. Event names are camelCase (preToolUse, not PreToolUse).
//   3. The schema has no `env` block — we cannot push VOIGHT_KEY /
//      VOIGHT_PRIVACY to hook subprocesses through it. Instead we
//      write a small wrapper script (~/.cursor/hooks/voight.sh)
//      that exports the env vars then execs into the hook handler.
//
// Spec source: ~/.cursor/skills-cursor/create-hook/SKILL.md (Cursor's
// own documentation skill, version 3.4+).

const CURSOR_HOOK_EVENTS = [
  // Core agent lifecycle (validated via probe of Cursor 3.4.17).
  'preToolUse',
  'postToolUse',
  'beforeSubmitPrompt',
  'stop',
  'afterAgentResponse',
  'sessionStart',
  // Extended coverage — added 2026-05-14. Payload shapes inferred
  // from create-hook SKILL.md; refined when probe data arrives.
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'afterAgentThought',
] as const
type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number]

/**
 * The command Cursor invokes for each hook event. Relative to
 * ~/.cursor/ (Cursor's documented working dir for user hooks).
 */
const CURSOR_HOOK_RELATIVE_COMMAND = './hooks/voight.sh'

function cursorHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

function cursorHookScriptPath(): string {
  return join(homedir(), '.cursor', 'hooks', 'voight.sh')
}

/**
 * Render the wrapper script that Cursor invokes. Exports the env
 * vars Voight's hook handler needs and execs into the npx command.
 *
 * Re-generated from scratch every setup run so the user can rotate
 * keys or switch privacy levels without manual edits.
 */
export function generateCursorHookScript(
  key: string,
  privacy: PrivacyLevel,
): string {
  return `#!/usr/bin/env bash
# Voight observability hook wrapper for Cursor.
#
# Cursor's hooks.json schema has no env block, so we set the env
# vars Voight's hook subprocess needs here and exec into it.
# VOIGHT_SOURCE is set for parity with other adapters, even though
# Cursor events also carry a distinct cursor_version field in
# their stdin payload that the hook handler can use as a fallback.
#
# This file is regenerated by 'npx -y @voightxyz/sdk setup';
# hand-edits will be overwritten on the next run.

export VOIGHT_KEY="${key}"
export VOIGHT_PRIVACY="${privacy}"
export VOIGHT_SOURCE="cursor"
exec npx -y @voightxyz/sdk hook
`
}

function writeCursorHookScript(key: string, privacy: PrivacyLevel): string {
  const scriptPath = cursorHookScriptPath()
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, generateCursorHookScript(key, privacy), 'utf-8')
  try {
    chmodSync(scriptPath, 0o755)
  } catch {
    // chmod may not apply on non-POSIX filesystems; the script will
    // still be readable, and Windows isn't a supported Cursor target.
  }
  return scriptPath
}

/**
 * Pure parser: extract the env vars Voight previously stamped into
 * a wrapper script. Used on re-runs so the wizard can show the
 * current value (parallels readExistingPrivacy for Claude flow).
 */
export function parseCursorScriptEnv(content: string): {
  key?: string
  privacy?: PrivacyLevel
} {
  const keyMatch = content.match(/VOIGHT_KEY="([^"]+)"/)
  const privMatch = content.match(/VOIGHT_PRIVACY="(\w+)"/)
  const key = keyMatch ? keyMatch[1] : undefined
  const privRaw = privMatch ? privMatch[1] : undefined
  const privacy =
    privRaw && isPrivacyLevel(privRaw) ? (privRaw as PrivacyLevel) : undefined
  return { key, privacy }
}

function readExistingCursorState(): { key?: string; privacy?: PrivacyLevel } {
  const scriptPath = cursorHookScriptPath()
  if (!existsSync(scriptPath)) return {}
  try {
    return parseCursorScriptEnv(readFileSync(scriptPath, 'utf-8'))
  } catch {
    return {}
  }
}

type CursorHooksConfig = {
  version: number
  hooks: Record<string, unknown[]>
}

function readCursorHooksConfig(path: string): CursorHooksConfig {
  if (!existsSync(path)) return { version: 1, hooks: {} }
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) return { version: 1, hooks: {} }
    const parsed = JSON.parse(raw) as Partial<CursorHooksConfig>
    return {
      version: parsed.version ?? 1,
      hooks: (parsed.hooks as Record<string, unknown[]>) ?? {},
    }
  } catch (err) {
    throw new Error(
      `Could not parse ${path}: ${(err as Error).message}. Move it aside and re-run.`,
    )
  }
}

/**
 * Make sure the hooks config has a Voight entry for the given event,
 * idempotently. Returns whether the entry was added, updated, or
 * already correct.
 *
 * Detects existing Voight entries by looking for our wrapper-script
 * path *or* a legacy direct-npx command from older SDK versions, so
 * upgrades don't leave duplicates.
 */
export function ensureCursorHook(
  hooks: Record<string, unknown[]>,
  eventName: CursorHookEvent,
): 'added' | 'unchanged' | 'updated' {
  if (!hooks[eventName] || !Array.isArray(hooks[eventName])) {
    hooks[eventName] = []
  }
  const list = hooks[eventName] as Array<Record<string, unknown>>

  const idx = list.findIndex(
    (entry) =>
      typeof entry?.command === 'string' &&
      ((entry.command as string).includes('voight.sh') ||
        (entry.command as string).includes('@voightxyz/sdk')),
  )

  const newEntry = {
    command: CURSOR_HOOK_RELATIVE_COMMAND,
    failClosed: false,
  }

  if (idx >= 0) {
    const existing = list[idx]
    if (
      existing &&
      existing.command === newEntry.command &&
      existing.failClosed === newEntry.failClosed
    ) {
      return 'unchanged'
    }
    list[idx] = newEntry
    return 'updated'
  }

  list.push(newEntry)
  return 'added'
}

function writeCursorHooksConfig(path: string, config: CursorHooksConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

/**
 * Wire Voight into Cursor — writes both the wrapper script and the
 * hooks.json entries. Preserves any non-Voight hooks the user has
 * configured. Returns the count of NEW entries so the wizard can
 * report it (matches Claude Code's ensureHook counting semantics).
 */
function writeCursorHooks(
  key: string,
  privacy: PrivacyLevel,
): { configPath: string; scriptPath: string; added: number } {
  const scriptPath = writeCursorHookScript(key, privacy)
  const configPath = cursorHooksPath()
  const config = readCursorHooksConfig(configPath)

  let added = 0
  for (const eventName of CURSOR_HOOK_EVENTS) {
    if (ensureCursorHook(config.hooks, eventName) === 'added') added++
  }

  writeCursorHooksConfig(configPath, config)
  return { configPath, scriptPath, added }
}

// ─── End Cursor adapter ──────────────────────────────────────────

// ─── Codex adapter ───────────────────────────────────────────────
//
// Codex (OpenAI's desktop coding agent, model gpt-5.5 as of
// 2026-05) exposes hooks the same way Claude Code does
// (PascalCase: PreToolUse / PostToolUse / UserPromptSubmit / Stop
// / SubagentStop / PreCompact / PostCompact). The SDK's existing
// hook.ts dispatcher processes those events already — no new
// mapper needed.
//
// The difference is *where* hooks are registered. Codex requires
// a plugin under a marketplace; user-level hooks.json is not
// supported. Local marketplaces with `source_type = "local"` ARE
// supported (verified in the bundled openai-bundled marketplace),
// so the setup wizard writes the entire marketplace + plugin
// scaffold under ~/.codex/plugins/voight-marketplace/ and edits
// ~/.codex/config.toml to enable it. No external repo needed.
//
// Spec source: /Applications/Codex.app binary strings + figma
// plugin reference at ~/.codex/.tmp/plugins/plugins/figma/.

const CODEX_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
] as const

const CODEX_PLUGIN_NAME = 'voight'
const CODEX_MARKETPLACE_NAME = 'voight'
const CODEX_PLUGIN_ID = 'xyz.voight.observability'

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

function codexMarketplaceRoot(): string {
  return join(codexHome(), 'plugins', `${CODEX_MARKETPLACE_NAME}-marketplace`)
}

function codexPluginRoot(): string {
  return join(codexMarketplaceRoot(), 'plugins', CODEX_PLUGIN_NAME)
}

function codexMarketplaceManifestPath(): string {
  return join(codexMarketplaceRoot(), '.agents', 'plugins', 'marketplace.json')
}

function codexPluginManifestPath(): string {
  return join(codexPluginRoot(), 'plugin.lock.json')
}

function codexPluginHooksPath(): string {
  return join(codexPluginRoot(), 'hooks.json')
}

function codexPluginScriptPath(): string {
  return join(codexPluginRoot(), 'scripts', 'voight-hook.sh')
}

function codexConfigPath(): string {
  return join(codexHome(), 'config.toml')
}

/**
 * Render the marketplace manifest. Declares one plugin (Voight)
 * with a local source. Codex's plugin engine reads this when the
 * marketplace is registered via [marketplaces.voight] in
 * config.toml.
 */
export function generateCodexMarketplaceManifest(): string {
  const body = {
    name: CODEX_MARKETPLACE_NAME,
    interface: {
      displayName: 'Voight',
    },
    plugins: [
      {
        name: CODEX_PLUGIN_NAME,
        source: {
          source: 'local',
          path: `./plugins/${CODEX_PLUGIN_NAME}`,
        },
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
        category: 'Engineering',
      },
    ],
  }
  return JSON.stringify(body, null, 2) + '\n'
}

/**
 * Render the plugin lock manifest. Minimal — just identification
 * + a timestamp so Codex can fingerprint the install.
 */
export function generateCodexPluginManifest(
  generatedAt: string = new Date().toISOString(),
): string {
  const body = {
    lockVersion: 1,
    pluginId: CODEX_PLUGIN_ID,
    pluginVersion: '0.6.0',
    generatedBy: '@voightxyz/sdk setup',
    generatedAt,
  }
  return JSON.stringify(body, null, 2) + '\n'
}

/**
 * Render the hooks.json that wires our wrapper script to each of
 * the events the hook handler can map. Same PascalCase shape Claude
 * Code uses — `hook.ts` processes these without changes.
 *
 * Matchers: tool-firing events (`Pre/PostToolUse`) take a `*` so we
 * see every tool; lifecycle events don't need a matcher.
 */
export function generateCodexHooksJson(): string {
  const command = `./scripts/voight-hook.sh`
  const hooks: Record<string, unknown[]> = {}
  for (const event of CODEX_HOOK_EVENTS) {
    const entry: Record<string, unknown> = {
      hooks: [{ type: 'command', command }],
    }
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      entry.matcher = '*'
    }
    hooks[event] = [entry]
  }
  return JSON.stringify({ hooks }, null, 2) + '\n'
}

/**
 * Render the wrapper script that Codex invokes for each hook.
 * Mirrors the Cursor wrapper: env vars set here (Codex's hook
 * runtime inherits, but having an explicit export keeps the
 * subprocess self-contained against future runtime changes).
 */
export function generateCodexHookScript(
  key: string,
  privacy: PrivacyLevel,
  /**
   * When `true`, the wrapper invokes a locally-installed SDK
   * resolved relative to the script itself (no network at hook
   * fire time). Required for Codex Desktop which runs hooks in a
   * sandbox that blocks npm registry access.
   *
   * When `false`, falls back to `npx -y @voightxyz/sdk hook` —
   * works in unsandboxed environments and preserves the pre-0.6.2
   * behaviour as a graceful degrade path when the local install
   * step couldn't run during setup.
   */
  useLocalInstall: boolean = false,
): string {
  const execLine = useLocalInstall
    ? // Resolve the SDK install relative to the script itself so the
      // wrapper stays portable across machines, even if the user moves
      // their Codex home folder.
      `SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../node_modules/@voightxyz/sdk/dist/cli.js" hook`
    : `exec npx -y @voightxyz/sdk hook`

  return `#!/usr/bin/env bash
# Voight observability hook wrapper for Codex.
#
# Codex's plugin hooks invoke this script for each registered
# event. We export the SDK's env vars here and exec into the
# hook handler, which translates Codex's PascalCase events into
# Voight's LogInput shape.
#
# VOIGHT_SOURCE tells the hook handler which framework invoked it
# — Codex events use the same PascalCase as Claude Code, so the
# handler can't distinguish them from the payload alone.
#
# 0.6.2+ resolves the SDK from a local install in the plugin's
# own node_modules to avoid network at hook fire time (Codex's
# default sandbox blocks the npm registry). The local path is
# resolved relative to this script so the wrapper is portable.
#
# Regenerated by 'npx -y @voightxyz/sdk setup'; hand-edits will
# be overwritten on the next run.

export VOIGHT_KEY="${key}"
export VOIGHT_PRIVACY="${privacy}"
export VOIGHT_SOURCE="codex"
${execLine}
`
}

/**
 * Pure: parse our env vars back out of an existing wrapper script
 * so re-runs can show the current values. Mirrors Cursor's
 * parseCursorScriptEnv for symmetry across adapters.
 */
export function parseCodexScriptEnv(content: string): {
  key?: string
  privacy?: PrivacyLevel
} {
  const keyMatch = content.match(/VOIGHT_KEY="([^"]+)"/)
  const privMatch = content.match(/VOIGHT_PRIVACY="(\w+)"/)
  const key = keyMatch ? keyMatch[1] : undefined
  const privRaw = privMatch ? privMatch[1] : undefined
  const privacy =
    privRaw && isPrivacyLevel(privRaw) ? (privRaw as PrivacyLevel) : undefined
  return { key, privacy }
}

function readExistingCodexState(): { key?: string; privacy?: PrivacyLevel } {
  const scriptPath = codexPluginScriptPath()
  if (!existsSync(scriptPath)) return {}
  try {
    return parseCodexScriptEnv(readFileSync(scriptPath, 'utf-8'))
  } catch {
    return {}
  }
}

/**
 * Append our marketplace + plugin registration to ~/.codex/config.toml,
 * idempotently. We *only* append — existing entries are detected
 * by section header presence and skipped to preserve user edits
 * and avoid TOML parse complications.
 *
 * Backup written to config.toml.voight-backup before any change
 * so the user can revert if Codex complains.
 *
 * Returns true if config was modified, false if no changes were
 * needed (already registered).
 */
export function appendCodexConfigRegistration(
  existing: string,
  marketplaceSourceAbsPath: string,
  nowIso: string = new Date().toISOString(),
): { content: string; changed: boolean } {
  const hasMarketplace = /\[marketplaces\.voight\][\s\S]/.test(existing)
  const hasPlugin = /\[plugins\."voight@voight"\][\s\S]/.test(existing)

  if (hasMarketplace && hasPlugin) {
    return { content: existing, changed: false }
  }

  const lines: string[] = []
  // Ensure the file ends with a newline before our additions.
  let content = existing
  if (content.length > 0 && !content.endsWith('\n')) content += '\n'
  // Blank line separator unless the file is empty.
  if (content.trim().length > 0) lines.push('')

  if (!hasMarketplace) {
    lines.push('[marketplaces.voight]')
    lines.push(`last_updated = "${nowIso}"`)
    lines.push('source_type = "local"')
    lines.push(`source = "${marketplaceSourceAbsPath}"`)
    lines.push('')
  }

  if (!hasPlugin) {
    lines.push('[plugins."voight@voight"]')
    lines.push('enabled = true')
    lines.push('')
  }

  return { content: content + lines.join('\n'), changed: true }
}

/**
 * Write the Codex plugin scaffold + edit config.toml. Idempotent:
 * re-running regenerates files in place and skips already-present
 * config sections.
 */
/**
 * Pre-install the SDK into the plugin's own node_modules. Codex
 * Desktop runs hook subprocesses inside a sandbox that blocks the
 * npm registry by default — `npx -y @voightxyz/sdk hook` would
 * stall trying to resolve the package. Having a local copy makes
 * the wrapper self-contained.
 *
 * Returns true on success, false if install failed (caller falls
 * back to the npx-based wrapper).
 */
function tryInstallSdkForCodex(pluginRoot: string): boolean {
  try {
    execSync(
      `npm install --prefix "${pluginRoot}" --no-save --no-audit --no-fund --silent @voightxyz/sdk@latest`,
      { stdio: 'pipe', timeout: 60_000 },
    )
    // Sanity check the expected output exists before claiming success.
    const cliPath = join(
      pluginRoot,
      'node_modules',
      '@voightxyz',
      'sdk',
      'dist',
      'cli.js',
    )
    return existsSync(cliPath)
  } catch {
    return false
  }
}

function writeCodexPlugin(
  key: string,
  privacy: PrivacyLevel,
): {
  pluginRoot: string
  configChanged: boolean
  localInstallOk: boolean
} {
  const root = codexMarketplaceRoot()
  const pluginRoot = codexPluginRoot()
  const scriptPath = codexPluginScriptPath()

  // 1. Marketplace manifest
  const mpPath = codexMarketplaceManifestPath()
  mkdirSync(dirname(mpPath), { recursive: true })
  writeFileSync(mpPath, generateCodexMarketplaceManifest(), 'utf-8')

  // 2. Plugin manifest
  const pluginPath = codexPluginManifestPath()
  mkdirSync(dirname(pluginPath), { recursive: true })
  writeFileSync(pluginPath, generateCodexPluginManifest(), 'utf-8')

  // 3. hooks.json
  writeFileSync(codexPluginHooksPath(), generateCodexHooksJson(), 'utf-8')

  // 4. Pre-install SDK locally (network OK here, setup runs with
  // user-approved network). If this fails — corp proxy, offline
  // setup, weird npm config — fall back to a wrapper that still
  // uses npx so the install completes; the user will see a warning
  // and hooks won't fire in sandboxed Codex sessions, same state
  // as pre-0.6.2.
  mkdirSync(pluginRoot, { recursive: true })
  const localInstallOk = tryInstallSdkForCodex(pluginRoot)

  // 5. wrapper script + chmod +x. Path resolution is relative to
  // the script itself, so the plugin folder can be moved without
  // breaking the hook.
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeFileSync(
    scriptPath,
    generateCodexHookScript(key, privacy, localInstallOk),
    'utf-8',
  )
  try {
    chmodSync(scriptPath, 0o755)
  } catch {
    /* non-POSIX filesystem — Codex is Mac/Linux today, harmless */
  }

  // 6. config.toml — append marketplace + plugin registration
  const configPath = codexConfigPath()
  const existing = existsSync(configPath)
    ? readFileSync(configPath, 'utf-8')
    : ''
  const { content, changed } = appendCodexConfigRegistration(existing, root)
  if (changed) {
    // Backup before writing so the user can revert if Codex
    // complains about the new sections.
    if (existing.length > 0) {
      writeFileSync(`${configPath}.voight-backup`, existing, 'utf-8')
    }
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, content, 'utf-8')
  }

  return { pluginRoot, configChanged: changed, localInstallOk }
}

// ─── End Codex adapter ───────────────────────────────────────────

/**
 * Parse the CLI flags. Returns only the values the user explicitly
 * provided — defaults are resolved by the caller (`runSetup`) so it
 * can layer auto-detection (`detectTarget`) on top before falling
 * back to the historical `claude` default.
 *
 * Note the `target` field: as of 0.4.3 it can be `undefined` when no
 * `--target` flag was passed (so `runSetup` can call `detectTarget`
 * first). Pre-0.4.3 this always returned `'claude'`; tests updated
 * accordingly.
 */
export function parseArgs(argv: string[]): {
  key?: string
  target?: Target
  privacy?: PrivacyLevel
} {
  let key: string | undefined
  let target: Target | undefined
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
  const { key: keyArg, target: targetArg, privacy: privacyArg } = parseArgs(argv)

  // Resolve target: explicit --target flag > env auto-detection >
  // historical fallback to 'claude' (preserves pre-0.4.3 behaviour
  // when neither flag nor signal is present).
  const detected = detectTarget(process.env)
  const target: Target = targetArg ?? detected ?? 'claude'
  const isAutoDetected = !targetArg && detected !== undefined

  const settingsPath = targetSettingsPath(target)

  console.log('')
  console.log(
    `  Voight · setup → ${target}${isAutoDetected ? ' (auto-detected)' : ''}`,
  )
  console.log(`  ${settingsPath}`)
  console.log('')

  // Read existing state target-aware. Claude / Codex use the JSON
  // settings.json shape; Cursor stores its env in the wrapper script
  // we write at ~/.cursor/hooks/voight.sh.
  let claudeSettings: Record<string, any> = {}
  let existingPrivacy: PrivacyLevel | undefined
  let existingKey: string | undefined

  if (target === 'cursor') {
    const state = readExistingCursorState()
    existingPrivacy = state.privacy
    existingKey = state.key
  } else if (target === 'codex') {
    const state = readExistingCodexState()
    existingPrivacy = state.privacy
    existingKey = state.key
  } else {
    claudeSettings = readSettings(settingsPath)
    existingPrivacy = readExistingPrivacy(claudeSettings)
    existingKey = readExistingKey(claudeSettings)
  }

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

  // ── Step 3: write config — target-aware ─────────────────────────
  let added = 0
  if (target === 'cursor') {
    // Cursor: dedicated hooks.json schema + wrapper script for env.
    const result = writeCursorHooks(key, privacy)
    added = result.added
  } else if (target === 'codex') {
    // Codex: local marketplace + plugin scaffold + config.toml
    // edit. Same 7 PascalCase events Claude Code uses, so hook.ts
    // processes them unchanged.
    const result = writeCodexPlugin(key, privacy)
    added = CODEX_HOOK_EVENTS.length
    if (!result.localInstallOk) {
      console.log('')
      console.log(
        '  ⚠ Could not pre-install the SDK to the plugin folder.',
      )
      console.log(
        '    The wrapper will fall back to `npx`, which Codex Desktop',
      )
      console.log(
        "    may block inside its sandbox. Re-run setup once you've",
      )
      console.log('    restored npm registry access if hooks don\'t fire.')
    }
  } else {
    // Claude Code.
    if (!claudeSettings.env || typeof claudeSettings.env !== 'object') {
      claudeSettings.env = {}
    }
    claudeSettings.env.VOIGHT_KEY = key
    claudeSettings.env.VOIGHT_PRIVACY = privacy
    for (const h of SUPPORTED_HOOKS) {
      if (ensureHook(claudeSettings, h)) added++
    }
    writeSettings(settingsPath, claudeSettings)
  }

  printDoneMessage(privacy, added, target)
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s
}
