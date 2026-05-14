/**
 * Voight CLI — `npx -y @voightxyz/sdk <command>`
 *
 * Two subcommands:
 *   setup  → wizard that wires Voight observability into Claude Code
 *            (and other AI editors) by editing their settings.json.
 *   hook   → handler invoked by those settings.json hooks. Reads the
 *            event JSON from stdin and ships it to /v1/events.
 *
 * Both reuse the same `Voight` class that lives in src/index.ts so we
 * never duplicate logic between the library, the CLI, and the hook.
 */

import { runSetup } from './setup.js'
import { runHook } from './hook.js'

const HELP = `
voight — observability for AI agents on Solana

Usage:
  npx -y @voightxyz/sdk setup           Wire Voight into your coding agent
  npx -y @voightxyz/sdk hook            Hook handler (invoked by the agent)

Options:
  --key <vk_...>                        Pass your Voight API key non-interactively
  --target claude|cursor|codex          Editor to wire up (auto-detected by default)
  --help, -h                            Show this message

Need a key? Generate one at https://voight.xyz/dashboard
`.trim()

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP)
    return
  }

  if (cmd === 'setup') {
    await runSetup(argv.slice(1))
    return
  }

  if (cmd === 'hook') {
    await runHook()
    return
  }

  console.error(`Unknown command: ${cmd}\n`)
  console.error(HELP)
  process.exit(1)
}

main().catch((err) => {
  console.error('voight cli failed:', err?.message ?? err)
  process.exit(1)
})
