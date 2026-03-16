/**
 * Structured error types for the GitLab API client.
 *
 * Provides typed error classification so callers (retry logic, tool handlers)
 * can make intelligent decisions based on error category rather than parsing
 * raw status codes or message strings.
 */

export type GitLabErrorCode =
  | 'auth_failed'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'conflict'
  | 'validation_error'
  | 'server_error'
  | 'unknown'

/**
 * Maps an HTTP status code to a semantic error code.
 */
export function classifyErrorCode(status: number): GitLabErrorCode {
  switch (status) {
    case 401:
      return 'auth_failed'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 422:
      return 'validation_error'
    case 429:
      return 'rate_limited'
    default:
      if (status >= 500) return 'server_error'
      return 'unknown'
  }
}

/**
 * Determines whether a given HTTP status code is safe to retry.
 * Retryable: 429 (rate limit), 502, 503, 504 (transient server errors).
 * NOT retryable: all 4xx client errors (except 429), 500 (likely a bug).
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/**
 * Structured error thrown by the GitLab API client.
 *
 * Carries the HTTP status code, a semantic error code, the raw response body,
 * and whether the request is safe to retry.  For 429 responses, the parsed
 * `Retry-After` value (in seconds) is available when the header was present.
 */
export class GitLabApiError extends Error {
  readonly statusCode: number
  readonly errorCode: GitLabErrorCode
  readonly retryable: boolean
  readonly responseBody: string
  readonly retryAfterSeconds: number | undefined

  constructor(
    statusCode: number,
    responseBody: string,
    retryAfterSeconds?: number,
  ) {
    super(`GitLab API error (${statusCode}): ${responseBody}`)
    this.name = 'GitLabApiError'
    this.statusCode = statusCode
    this.responseBody = responseBody
    this.errorCode = classifyErrorCode(statusCode)
    this.retryable = isRetryableStatus(statusCode)
    this.retryAfterSeconds = retryAfterSeconds
  }
}
