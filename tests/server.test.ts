import { afterEach, describe, expect, mock, test } from 'bun:test'
import { isPlaceholder, validateEnvironment } from '../src/server'

describe('validateEnvironment', () => {
  const originalEnv = { ...process.env }
  const originalExit = process.exit

  afterEach(() => {
    process.env = { ...originalEnv }
    process.exit = originalExit
  })

  test('passes when GITLAB_PAT is set', () => {
    process.env.GITLAB_PAT = 'test-pat-value'
    delete process.env.GITLAB_OAUTH_TOKEN

    // Should not throw or exit
    expect(() => validateEnvironment()).not.toThrow()
  })

  test('passes when GITLAB_OAUTH_TOKEN is set', () => {
    delete process.env.GITLAB_PAT
    process.env.GITLAB_OAUTH_TOKEN = 'test-oauth-value'

    expect(() => validateEnvironment()).not.toThrow()
  })

  test('passes when both tokens are set', () => {
    process.env.GITLAB_PAT = 'test-pat-value'
    process.env.GITLAB_OAUTH_TOKEN = 'test-oauth-value'

    expect(() => validateEnvironment()).not.toThrow()
  })

  test('calls process.exit(1) when neither token is set', () => {
    delete process.env.GITLAB_PAT
    delete process.env.GITLAB_OAUTH_TOKEN

    let exitCode: number | undefined
    process.exit = mock((code?: number) => {
      exitCode = code as number
      throw new Error('process.exit called')
    }) as unknown as typeof process.exit

    expect(() => validateEnvironment()).toThrow('process.exit called')
    expect(exitCode).toBe(1)
  })

  test('treats empty string as not set', () => {
    process.env.GITLAB_PAT = ''
    process.env.GITLAB_OAUTH_TOKEN = ''

    let exitCode: number | undefined
    process.exit = mock((code?: number) => {
      exitCode = code as number
      throw new Error('process.exit called')
    }) as unknown as typeof process.exit

    expect(() => validateEnvironment()).toThrow('process.exit called')
    expect(exitCode).toBe(1)
  })

  test('treats whitespace-only PAT as not set', () => {
    process.env.GITLAB_PAT = '   '
    delete process.env.GITLAB_OAUTH_TOKEN

    let exitCode: number | undefined
    process.exit = mock((code?: number) => {
      exitCode = code as number
      throw new Error('process.exit called')
    }) as unknown as typeof process.exit

    expect(() => validateEnvironment()).toThrow('process.exit called')
    expect(exitCode).toBe(1)
  })

  test('treats whitespace-only OAuth token as not set', () => {
    delete process.env.GITLAB_PAT
    process.env.GITLAB_OAUTH_TOKEN = '  \t  '

    let exitCode: number | undefined
    process.exit = mock((code?: number) => {
      exitCode = code as number
      throw new Error('process.exit called')
    }) as unknown as typeof process.exit

    expect(() => validateEnvironment()).toThrow('process.exit called')
    expect(exitCode).toBe(1)
  })

  test('warns on placeholder PAT value (does not exit)', () => {
    process.env.GITLAB_PAT = 'your_personal_access_token_here'
    delete process.env.GITLAB_OAUTH_TOKEN

    const stderrMessages: string[] = []
    const originalError = console.error
    console.error = mock((...args: unknown[]) => {
      stderrMessages.push(args.map(String).join(' '))
    }) as typeof console.error

    try {
      // Should NOT throw or exit — just warn
      expect(() => validateEnvironment()).not.toThrow()
      expect(stderrMessages.some((msg) => msg.includes('placeholder'))).toBe(
        true,
      )
    } finally {
      console.error = originalError
    }
  })

  test('passes with trimmed valid token', () => {
    process.env.GITLAB_PAT = '  test-pat-value  '
    delete process.env.GITLAB_OAUTH_TOKEN

    expect(() => validateEnvironment()).not.toThrow()
  })
})

describe('isPlaceholder', () => {
  test('detects .env.example PAT placeholder', () => {
    expect(isPlaceholder('your_personal_access_token_here')).toBe(true)
  })

  test('detects .env.example OAuth placeholder', () => {
    expect(isPlaceholder('your_oauth_token_here')).toBe(true)
  })

  test('detects angle-bracket placeholder', () => {
    expect(isPlaceholder('<your_token>')).toBe(true)
  })

  test("detects bare 'token' and 'your_token'", () => {
    expect(isPlaceholder('token')).toBe(true)
    expect(isPlaceholder('your_token')).toBe(true)
    expect(isPlaceholder('your-token')).toBe(true)
  })

  test('does not flag real PAT values', () => {
    expect(isPlaceholder('real-pat-value-not-a-placeholder')).toBe(false)
  })
})
