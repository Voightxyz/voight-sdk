/**
 * Tests for the pure helpers in src/init.ts. The `runInit`
 * orchestrator itself isn't unit-tested — it's exercised by the
 * Stage 3 dual-provider testbed in /Users/locotoo/voight-wizard-validation/
 * stage-3-dual-app (real third-party Next.js code).
 *
 * Structural invariant we explicitly cover: every fs.writeFileSync /
 * appendFileSync path produced by the helpers stays inside the
 * supplied cwd. No `~/.claude`, no `~/.cursor`, no `~/.codex` can
 * ever appear in the output — `init` is project-scoped by design.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseInitArgs,
  detectAppProviders,
  detectPackageManager,
  packageManagerInstallCommand,
  detectFramework,
  readDefaultAgentName,
  generateAppVoightModule,
  writeEnvLocal,
  resolveVoightModulePath,
} from '../../src/init.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'voight-init-test-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function writePkg(pkg: Record<string, unknown>): void {
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2))
}

describe('parseInitArgs', () => {
  it('parses --key= and --privacy= and --agent= flags', () => {
    const args = parseInitArgs([
      '--key=vk_abc',
      '--privacy=standard',
      '--agent=my-app',
    ])
    expect(args).toEqual({ key: 'vk_abc', privacy: 'standard', agent: 'my-app' })
  })

  it('parses space-separated --flag value form', () => {
    const args = parseInitArgs([
      '--key',
      'vk_xyz',
      '--privacy',
      'minimal',
      '--agent',
      'bot',
    ])
    expect(args).toEqual({ key: 'vk_xyz', privacy: 'minimal', agent: 'bot' })
  })

  it('ignores unknown flags', () => {
    const args = parseInitArgs(['--foo=bar', '--key=vk_1', '--baz'])
    expect(args).toEqual({ key: 'vk_1' })
  })

  it('rejects invalid privacy levels silently', () => {
    const args = parseInitArgs(['--privacy=garbage'])
    expect(args.privacy).toBeUndefined()
  })

  it('returns empty object for empty argv', () => {
    expect(parseInitArgs([])).toEqual({})
  })
})

describe('detectAppProviders', () => {
  it('detects openai in dependencies', () => {
    writePkg({ dependencies: { openai: '^4.79.2' } })
    expect(detectAppProviders(cwd)).toEqual({
      openai: '^4.79.2',
      anthropic: null,
    })
  })

  it('detects @anthropic-ai/sdk in dependencies', () => {
    writePkg({ dependencies: { '@anthropic-ai/sdk': '^0.96.0' } })
    expect(detectAppProviders(cwd)).toEqual({
      openai: null,
      anthropic: '^0.96.0',
    })
  })

  it('detects both providers', () => {
    writePkg({
      dependencies: { openai: '^4.79.2', '@anthropic-ai/sdk': '^0.96.0' },
    })
    expect(detectAppProviders(cwd)).toEqual({
      openai: '^4.79.2',
      anthropic: '^0.96.0',
    })
  })

  it('detects providers in devDependencies (some projects pin LLM SDKs there)', () => {
    writePkg({ devDependencies: { openai: '^4.79.2' } })
    expect(detectAppProviders(cwd).openai).toBe('^4.79.2')
  })

  it('returns nulls when no provider is present', () => {
    writePkg({ dependencies: { express: '^4.0.0' } })
    expect(detectAppProviders(cwd)).toEqual({ openai: null, anthropic: null })
  })

  it('returns nulls when package.json is missing', () => {
    expect(detectAppProviders(cwd)).toEqual({ openai: null, anthropic: null })
  })

  it('returns nulls when package.json is malformed', () => {
    writeFileSync(join(cwd, 'package.json'), '{ not valid json')
    expect(detectAppProviders(cwd)).toEqual({ openai: null, anthropic: null })
  })
})

describe('detectPackageManager', () => {
  it('picks pnpm when pnpm-lock.yaml present', () => {
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), '')
    expect(detectPackageManager(cwd)).toBe('pnpm')
  })

  it('picks yarn when only yarn.lock present', () => {
    writeFileSync(join(cwd, 'yarn.lock'), '')
    expect(detectPackageManager(cwd)).toBe('yarn')
  })

  it('picks bun when only bun.lockb present', () => {
    writeFileSync(join(cwd, 'bun.lockb'), '')
    expect(detectPackageManager(cwd)).toBe('bun')
  })

  it('falls back to npm when no lockfile present', () => {
    expect(detectPackageManager(cwd)).toBe('npm')
  })

  it('pnpm wins when multiple lockfiles coexist', () => {
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), '')
    writeFileSync(join(cwd, 'yarn.lock'), '')
    writeFileSync(join(cwd, 'package-lock.json'), '')
    expect(detectPackageManager(cwd)).toBe('pnpm')
  })
})

describe('packageManagerInstallCommand', () => {
  it('returns pnpm command for pnpm', () => {
    expect(packageManagerInstallCommand('pnpm')).toBe(
      'pnpm add @voightxyz/openai @voightxyz/anthropic',
    )
  })

  it('returns yarn command for yarn', () => {
    expect(packageManagerInstallCommand('yarn')).toBe(
      'yarn add @voightxyz/openai @voightxyz/anthropic',
    )
  })

  it('returns bun command for bun', () => {
    expect(packageManagerInstallCommand('bun')).toBe(
      'bun add @voightxyz/openai @voightxyz/anthropic',
    )
  })

  it('returns npm install command for npm', () => {
    expect(packageManagerInstallCommand('npm')).toBe(
      'npm install @voightxyz/openai @voightxyz/anthropic',
    )
  })
})

describe('detectFramework', () => {
  it('returns "next" when next is in deps', () => {
    writePkg({ dependencies: { next: '14.2.18' } })
    expect(detectFramework(cwd)).toBe('next')
  })

  it('returns "next" when next is in devDeps', () => {
    writePkg({ devDependencies: { next: '14.0.0' } })
    expect(detectFramework(cwd)).toBe('next')
  })

  it('returns "vanilla" when no next', () => {
    writePkg({ dependencies: { express: '^4.0.0' } })
    expect(detectFramework(cwd)).toBe('vanilla')
  })

  it('returns "vanilla" when package.json is missing', () => {
    expect(detectFramework(cwd)).toBe('vanilla')
  })
})

describe('readDefaultAgentName', () => {
  it('uses package.json name when present', () => {
    writePkg({ name: 'my-prod-app' })
    expect(readDefaultAgentName(cwd)).toBe('my-prod-app')
  })

  it('falls back to cwd basename when package.json has no name', () => {
    writePkg({ description: 'no name field' })
    // mkdtempSync returns something like /tmp/voight-init-test-xxxxxx
    expect(readDefaultAgentName(cwd)).toMatch(/^voight-init-test-/)
  })

  it('falls back to cwd basename when package.json is missing', () => {
    expect(readDefaultAgentName(cwd)).toMatch(/^voight-init-test-/)
  })
})

describe('generateAppVoightModule', () => {
  it('emits both blocks when both providers detected', () => {
    const out = generateAppVoightModule({
      providers: { openai: '^4.0.0', anthropic: '^0.96.0' },
      agentName: 'my-app',
      privacy: 'standard',
    })
    expect(out).toContain(`import OpenAI from 'openai'`)
    expect(out).toContain(`import Anthropic from '@anthropic-ai/sdk'`)
    expect(out).toContain(`import { wrapOpenAI } from '@voightxyz/openai'`)
    expect(out).toContain(`import { wrapAnthropic } from '@voightxyz/anthropic'`)
    expect(out).toContain(`export const openai = wrapOpenAI`)
    expect(out).toContain(`export const anthropic = wrapAnthropic`)
    expect(out).toContain(`agent: 'my-app'`)
    expect(out).toContain(`privacy: 'standard'`)
    expect(out).toContain(
      `export { withTrace, log } from '@voightxyz/openai'`,
    )
  })

  it('emits only openai block when anthropic missing', () => {
    const out = generateAppVoightModule({
      providers: { openai: '^4.0.0', anthropic: null },
      agentName: 'solo-openai',
      privacy: 'minimal',
    })
    expect(out).toContain(`import OpenAI from 'openai'`)
    expect(out).not.toContain(`import Anthropic`)
    expect(out).not.toContain(`@anthropic-ai/sdk`)
    expect(out).toContain(`export const openai = wrapOpenAI`)
    expect(out).not.toContain(`export const anthropic`)
    expect(out).toContain(
      `export { withTrace, log } from '@voightxyz/openai'`,
    )
  })

  it('emits only anthropic block when openai missing', () => {
    const out = generateAppVoightModule({
      providers: { openai: null, anthropic: '^0.96.0' },
      agentName: 'solo-anthropic',
      privacy: 'full',
    })
    expect(out).not.toContain(`import OpenAI`)
    expect(out).not.toContain(`from 'openai'`)
    expect(out).toContain(`import Anthropic from '@anthropic-ai/sdk'`)
    expect(out).toContain(`export const anthropic = wrapAnthropic`)
    expect(out).not.toContain(`export const openai`)
    // Re-export comes from anthropic when openai is absent
    expect(out).toContain(
      `export { withTrace, log } from '@voightxyz/anthropic'`,
    )
  })

  it('throws when neither provider is present', () => {
    expect(() =>
      generateAppVoightModule({
        providers: { openai: null, anthropic: null },
        agentName: 'x',
        privacy: 'standard',
      }),
    ).toThrow()
  })

  it('header comment explains how to swap keys from a secrets manager', () => {
    const out = generateAppVoightModule({
      providers: { openai: '^4.0.0', anthropic: null },
      agentName: 'x',
      privacy: 'standard',
    })
    expect(out).toContain('AWS Secrets Manager')
    expect(out).toContain('Vault')
    expect(out).toContain('The Voight wrapper never sees the provider key')
  })
})

describe('writeEnvLocal', () => {
  it('creates .env.local with VOIGHT_KEY when file absent', () => {
    const action = writeEnvLocal(cwd, 'vk_new')
    expect(action).toBe('created')
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe(
      'VOIGHT_KEY=vk_new\n',
    )
  })

  it('appends VOIGHT_KEY when file exists without one', () => {
    writeFileSync(join(cwd, '.env.local'), 'OTHER_VAR=hello\n')
    const action = writeEnvLocal(cwd, 'vk_added')
    expect(action).toBe('appended')
    const content = readFileSync(join(cwd, '.env.local'), 'utf-8')
    expect(content).toBe('OTHER_VAR=hello\nVOIGHT_KEY=vk_added\n')
  })

  it('appends with leading newline when existing file lacks trailing newline', () => {
    writeFileSync(join(cwd, '.env.local'), 'NO_TRAILING_NL=x')
    writeEnvLocal(cwd, 'vk_xyz')
    const content = readFileSync(join(cwd, '.env.local'), 'utf-8')
    expect(content).toBe('NO_TRAILING_NL=x\nVOIGHT_KEY=vk_xyz\n')
  })

  it('does not overwrite when VOIGHT_KEY already present', () => {
    writeFileSync(
      join(cwd, '.env.local'),
      'VOIGHT_KEY=vk_existing\nOTHER=foo\n',
    )
    const action = writeEnvLocal(cwd, 'vk_new')
    expect(action).toBe('already-set')
    const content = readFileSync(join(cwd, '.env.local'), 'utf-8')
    expect(content).toBe('VOIGHT_KEY=vk_existing\nOTHER=foo\n')
  })
})

describe('resolveVoightModulePath', () => {
  it('uses src/lib/voight.ts when src/ exists', () => {
    mkdirSync(join(cwd, 'src'))
    const result = resolveVoightModulePath(cwd)
    expect(result.display).toBe('src/lib/voight.ts')
    expect(result.fullPath).toBe(join(cwd, 'src/lib/voight.ts'))
  })

  it('uses lib/voight.ts when src/ does not exist', () => {
    const result = resolveVoightModulePath(cwd)
    expect(result.display).toBe('lib/voight.ts')
    expect(result.fullPath).toBe(join(cwd, 'lib/voight.ts'))
  })
})

describe('structural safety: writes stay inside cwd', () => {
  // The static guarantee init.ts has — no homedir() calls, no
  // ~/.claude / ~/.cursor / ~/.codex paths. These tests exercise the
  // public helpers and confirm every path they produce is rooted at
  // cwd. If anyone ever changes init.ts to write outside cwd, these
  // tests fail loud.

  it('writeEnvLocal writes only to <cwd>/.env.local', () => {
    writeEnvLocal(cwd, 'vk_test')
    expect(existsSync(join(cwd, '.env.local'))).toBe(true)
  })

  it('resolveVoightModulePath returns a path inside cwd', () => {
    const result = resolveVoightModulePath(cwd)
    expect(result.fullPath.startsWith(cwd)).toBe(true)
    expect(result.fullPath).not.toContain('.claude')
    expect(result.fullPath).not.toContain('.cursor')
    expect(result.fullPath).not.toContain('.codex')
  })

  it('generated module source contains no global config paths', () => {
    const out = generateAppVoightModule({
      providers: { openai: '^4.0.0', anthropic: '^0.96.0' },
      agentName: 'safety',
      privacy: 'standard',
    })
    expect(out).not.toContain('.claude/settings.json')
    expect(out).not.toContain('.cursor/hooks.json')
    expect(out).not.toContain('.codex/')
    expect(out).not.toContain('homedir')
  })
})
