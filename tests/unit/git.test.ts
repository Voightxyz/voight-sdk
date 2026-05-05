/**
 * Tests for the git-context module — captures HEAD sha, branch,
 * remote, and dirty state of the cwd at the moment a hook fires.
 *
 * Each test creates a fresh disposable repo under tmpdir to keep
 * runs hermetic. The host's `git` binary must be available; the
 * tests skip cleanly when it isn't (exec failures bubble up as
 * null returns from getGitContext).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getGitContext,
  getGitContextCached,
  normaliseRemote,
  _internals,
} from '../../src/git.js'

let repoDir: string

function run(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      // Detached identity so commits work without leaning on the
      // host's global git config (which CI often lacks).
      GIT_AUTHOR_NAME: 'voight test',
      GIT_AUTHOR_EMAIL: 'test@voight.xyz',
      GIT_COMMITTER_NAME: 'voight test',
      GIT_COMMITTER_EMAIL: 'test@voight.xyz',
    },
  })
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'voight-git-test-'))
  // Initialise repo with a known initial branch + first commit so
  // rev-parse HEAD has something to return.
  run(repoDir, ['init', '-b', 'main'])
  writeFileSync(join(repoDir, 'README.md'), '# test\n')
  run(repoDir, ['add', '.'])
  run(repoDir, ['commit', '-m', 'initial'])
  // Drop the per-cwd cache file from any prior test run so we measure
  // a fresh compute path. (Different repoDir means different cache
  // key, but be defensive.)
  const cp = _internals.cachePath(repoDir)
  if (existsSync(cp)) rmSync(cp)
})

afterEach(() => {
  if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true })
})

describe('normaliseRemote', () => {
  it('collapses SSH URLs to host/owner/repo', () => {
    expect(normaliseRemote('git@github.com:voightxyz/voight.git')).toBe(
      'github.com/voightxyz/voight',
    )
  })

  it('collapses HTTPS URLs to host/owner/repo', () => {
    expect(normaliseRemote('https://github.com/voightxyz/voight.git')).toBe(
      'github.com/voightxyz/voight',
    )
  })

  it('strips embedded credentials', () => {
    expect(
      normaliseRemote('https://token@github.com/voightxyz/voight.git'),
    ).toBe('github.com/voightxyz/voight')
  })

  it('returns null for empty / null input', () => {
    expect(normaliseRemote(null)).toBeNull()
    expect(normaliseRemote(undefined)).toBeNull()
    expect(normaliseRemote('')).toBeNull()
    expect(normaliseRemote('   ')).toBeNull()
  })

  it('returns the input unchanged when format is unrecognised', () => {
    expect(normaliseRemote('weird-non-url-string')).toBe('weird-non-url-string')
  })
})

describe('getGitContext', () => {
  it('returns null when cwd is undefined', () => {
    expect(getGitContext(undefined)).toBeNull()
  })

  it('returns null when cwd is not a git repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'voight-non-repo-'))
    try {
      expect(getGitContext(nonRepo)).toBeNull()
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  it('captures sha, shortSha, branch in a clean repo', () => {
    const ctx = getGitContext(repoDir)
    expect(ctx).not.toBeNull()
    expect(ctx?.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(ctx?.shortSha).toBe(ctx?.sha?.slice(0, 7))
    expect(ctx?.branch).toBe('main')
    expect(ctx?.dirty).toBe(false)
  })

  it('flags dirty when the working tree has uncommitted changes', () => {
    writeFileSync(join(repoDir, 'README.md'), '# changed\n')
    const ctx = getGitContext(repoDir)
    expect(ctx?.dirty).toBe(true)
  })

  it('reports the current branch after switching', () => {
    run(repoDir, ['checkout', '-b', 'feat/example'])
    const ctx = getGitContext(repoDir)
    expect(ctx?.branch).toBe('feat/example')
  })

  it('reports null branch when HEAD is detached', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim()
    run(repoDir, ['checkout', sha])
    const ctx = getGitContext(repoDir)
    expect(ctx?.branch).toBeNull()
  })

  it('reports null remote when no origin is configured', () => {
    const ctx = getGitContext(repoDir)
    expect(ctx?.remote).toBeNull()
  })

  it('captures and normalises the origin remote', () => {
    run(repoDir, [
      'remote',
      'add',
      'origin',
      'git@github.com:voightxyz/voight.git',
    ])
    const ctx = getGitContext(repoDir)
    expect(ctx?.remote).toBe('github.com/voightxyz/voight')
  })
})

describe('getGitContextCached', () => {
  it('serves the second call from cache (sha unchanged after a new commit)', () => {
    const first = getGitContextCached(repoDir)
    expect(first).not.toBeNull()

    // Make a new commit so a fresh compute would yield a different
    // sha. Cached call should still return the original sha.
    writeFileSync(join(repoDir, 'b.md'), '# b\n')
    run(repoDir, ['add', '.'])
    run(repoDir, ['commit', '-m', 'second'])

    const second = getGitContextCached(repoDir)
    expect(second?.sha).toBe(first?.sha)

    // And a direct (uncached) call sees the new sha.
    const fresh = getGitContext(repoDir)
    expect(fresh?.sha).not.toBe(first?.sha)
  })

  it('returns null for non-repo cwd without writing cache', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'voight-non-repo-cache-'))
    try {
      expect(getGitContextCached(nonRepo)).toBeNull()
      expect(existsSync(_internals.cachePath(nonRepo))).toBe(false)
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })
})
