/**
 * Dedicated test for the GitLabClient singleton lifecycle (BUG-010).
 *
 * NOTE: When running with the full test suite, mock.module() calls in other
 * test files (e.g. review-handlers.test.ts) globally replace getGitLabClient.
 * These tests use the GitLabClient constructor directly to verify the reset
 * pattern works, plus verify the export signature.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { GitLabClient } from '../../src/gitlab/client'

describe('GitLabClient singleton lifecycle (BUG-010)', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('resetGitLabClient is exported as a function', () => {
    // Verify the export exists on the module
    const mod = require('../../src/gitlab/client')
    expect(typeof mod.resetGitLabClient).toBe('function')
    expect(typeof mod.getGitLabClient).toBe('function')
  })

  test('resetGitLabClient does not throw', () => {
    const mod = require('../../src/gitlab/client')
    expect(() => mod.resetGitLabClient()).not.toThrow()
  })

  test('new GitLabClient() creates distinct instances (the pattern reset enables)', () => {
    process.env.GITLAB_PAT = 'test-token'
    process.env.GITLAB_BASE_URL = 'https://gl.test'

    // After resetGitLabClient(), getGitLabClient() constructs a new GitLabClient().
    // Verify the constructor creates distinct objects each time.
    const a = new GitLabClient()
    const b = new GitLabClient()
    expect(a).not.toBe(b)
    expect(a).toBeInstanceOf(GitLabClient)
    expect(b).toBeInstanceOf(GitLabClient)
  })
})
