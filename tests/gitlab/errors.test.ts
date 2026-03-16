import { describe, expect, test } from 'bun:test'
import {
  classifyErrorCode,
  GitLabApiError,
  isRetryableStatus,
} from '../../src/gitlab/errors'

describe('classifyErrorCode', () => {
  test('401 -> auth_failed', () => {
    expect(classifyErrorCode(401)).toBe('auth_failed')
  })

  test('403 -> forbidden', () => {
    expect(classifyErrorCode(403)).toBe('forbidden')
  })

  test('404 -> not_found', () => {
    expect(classifyErrorCode(404)).toBe('not_found')
  })

  test('409 -> conflict', () => {
    expect(classifyErrorCode(409)).toBe('conflict')
  })

  test('422 -> validation_error', () => {
    expect(classifyErrorCode(422)).toBe('validation_error')
  })

  test('429 -> rate_limited', () => {
    expect(classifyErrorCode(429)).toBe('rate_limited')
  })

  test('500 -> server_error', () => {
    expect(classifyErrorCode(500)).toBe('server_error')
  })

  test('502 -> server_error', () => {
    expect(classifyErrorCode(502)).toBe('server_error')
  })

  test('503 -> server_error', () => {
    expect(classifyErrorCode(503)).toBe('server_error')
  })

  test('504 -> server_error', () => {
    expect(classifyErrorCode(504)).toBe('server_error')
  })

  test('400 -> unknown', () => {
    expect(classifyErrorCode(400)).toBe('unknown')
  })

  test('418 -> unknown', () => {
    expect(classifyErrorCode(418)).toBe('unknown')
  })
})

describe('isRetryableStatus', () => {
  test('429 is retryable', () => {
    expect(isRetryableStatus(429)).toBe(true)
  })

  test('502 is retryable', () => {
    expect(isRetryableStatus(502)).toBe(true)
  })

  test('503 is retryable', () => {
    expect(isRetryableStatus(503)).toBe(true)
  })

  test('504 is retryable', () => {
    expect(isRetryableStatus(504)).toBe(true)
  })

  test('500 is NOT retryable', () => {
    expect(isRetryableStatus(500)).toBe(false)
  })

  test('400 is NOT retryable', () => {
    expect(isRetryableStatus(400)).toBe(false)
  })

  test('401 is NOT retryable', () => {
    expect(isRetryableStatus(401)).toBe(false)
  })

  test('403 is NOT retryable', () => {
    expect(isRetryableStatus(403)).toBe(false)
  })

  test('404 is NOT retryable', () => {
    expect(isRetryableStatus(404)).toBe(false)
  })

  test('422 is NOT retryable', () => {
    expect(isRetryableStatus(422)).toBe(false)
  })
})

describe('GitLabApiError', () => {
  test('sets all properties correctly for a 404', () => {
    const error = new GitLabApiError(404, 'Not Found')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(GitLabApiError)
    expect(error.name).toBe('GitLabApiError')
    expect(error.statusCode).toBe(404)
    expect(error.errorCode).toBe('not_found')
    expect(error.retryable).toBe(false)
    expect(error.responseBody).toBe('Not Found')
    expect(error.retryAfterSeconds).toBeUndefined()
    expect(error.message).toBe('GitLab API error (404): Not Found')
  })

  test('sets retryable=true for 429', () => {
    const error = new GitLabApiError(429, 'Too Many Requests', 30)
    expect(error.statusCode).toBe(429)
    expect(error.errorCode).toBe('rate_limited')
    expect(error.retryable).toBe(true)
    expect(error.retryAfterSeconds).toBe(30)
  })

  test('sets retryable=true for 502', () => {
    const error = new GitLabApiError(502, 'Bad Gateway')
    expect(error.retryable).toBe(true)
    expect(error.errorCode).toBe('server_error')
  })

  test('preserves raw response body', () => {
    const body = '{"error":"invalid_token","error_description":"Token expired"}'
    const error = new GitLabApiError(401, body)
    expect(error.responseBody).toBe(body)
    expect(error.errorCode).toBe('auth_failed')
  })

  test('retryAfterSeconds is undefined when not provided', () => {
    const error = new GitLabApiError(503, 'Service Unavailable')
    expect(error.retryAfterSeconds).toBeUndefined()
    expect(error.retryable).toBe(true)
  })
})
