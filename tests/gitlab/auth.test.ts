import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AuthConfig } from '../../src/gitlab/auth'
import { getAuthConfig, getAuthHeader, getBaseUrl } from '../../src/gitlab/auth'

describe('getAuthConfig', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.GITLAB_PAT
    delete process.env.GITLAB_OAUTH_TOKEN
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('returns PAT config when GITLAB_PAT is set', () => {
    process.env.GITLAB_PAT = 'glpat-test-token'
    const config = getAuthConfig()
    expect(config).toEqual({ type: 'pat', token: 'glpat-test-token' })
  })

  test('returns OAuth config when GITLAB_OAUTH_TOKEN is set', () => {
    process.env.GITLAB_OAUTH_TOKEN = 'oauth-test-token'
    const config = getAuthConfig()
    expect(config).toEqual({ type: 'oauth', token: 'oauth-test-token' })
  })

  test('prefers PAT over OAuth when both are set', () => {
    process.env.GITLAB_PAT = 'glpat-preferred'
    process.env.GITLAB_OAUTH_TOKEN = 'oauth-ignored'
    const config = getAuthConfig()
    expect(config).toEqual({ type: 'pat', token: 'glpat-preferred' })
  })

  test('throws when neither token is set', () => {
    expect(() => getAuthConfig()).toThrow(
      'GitLab authentication not configured',
    )
  })

  test('throws when GITLAB_PAT is whitespace-only', () => {
    process.env.GITLAB_PAT = '   '
    expect(() => getAuthConfig()).toThrow(
      'GitLab authentication not configured',
    )
  })

  test('throws when both tokens are whitespace-only', () => {
    process.env.GITLAB_PAT = '  '
    process.env.GITLAB_OAUTH_TOKEN = '\t'
    expect(() => getAuthConfig()).toThrow(
      'GitLab authentication not configured',
    )
  })

  test('trims whitespace from PAT value', () => {
    process.env.GITLAB_PAT = '  glpat-real-token  '
    const config = getAuthConfig()
    expect(config).toEqual({ type: 'pat', token: 'glpat-real-token' })
  })

  test('trims whitespace from OAuth value', () => {
    process.env.GITLAB_OAUTH_TOKEN = '  oauth-real-token  '
    const config = getAuthConfig()
    expect(config).toEqual({ type: 'oauth', token: 'oauth-real-token' })
  })
})

describe('getAuthHeader', () => {
  test('returns PRIVATE-TOKEN header for PAT', () => {
    const config: AuthConfig = { type: 'pat', token: 'my-pat-token' }
    expect(getAuthHeader(config)).toEqual({
      name: 'PRIVATE-TOKEN',
      value: 'my-pat-token',
    })
  })

  test('returns Authorization Bearer header for OAuth', () => {
    const config: AuthConfig = { type: 'oauth', token: 'my-oauth-token' }
    expect(getAuthHeader(config)).toEqual({
      name: 'Authorization',
      value: 'Bearer my-oauth-token',
    })
  })

  test('throws for unknown auth type', () => {
    const config = { type: 'unknown', token: 'token' } as unknown as AuthConfig
    expect(() => getAuthHeader(config)).toThrow('Unknown auth type')
  })
})

describe('getBaseUrl', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('returns GITLAB_BASE_URL when set', () => {
    process.env.GITLAB_BASE_URL = 'https://gitlab.example.com'
    expect(getBaseUrl()).toBe('https://gitlab.example.com')
  })

  test('returns default gitlab.com when not set', () => {
    delete process.env.GITLAB_BASE_URL
    expect(getBaseUrl()).toBe('https://gitlab.com')
  })
})
