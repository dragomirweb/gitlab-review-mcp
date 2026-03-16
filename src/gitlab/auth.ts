/**
 * GitLab authentication helpers
 */

export type AuthType = 'pat' | 'oauth'

export interface AuthConfig {
  type: AuthType
  token: string
}

export interface AuthHeader {
  name: string
  value: string
}

/**
 * Resolves authentication configuration from environment variables.
 * Prefers PAT over OAuth if both are present.
 *
 * Trims whitespace from token values so that `GITLAB_PAT="  "` is treated
 * as unset rather than sent to GitLab as a whitespace-only token.
 */
export function getAuthConfig(): AuthConfig {
  const pat = process.env.GITLAB_PAT?.trim()
  const oauth = process.env.GITLAB_OAUTH_TOKEN?.trim()

  if (pat) {
    return { type: 'pat', token: pat }
  }

  if (oauth) {
    return { type: 'oauth', token: oauth }
  }

  throw new Error(
    'GitLab authentication not configured. Set GITLAB_PAT or GITLAB_OAUTH_TOKEN environment variable.',
  )
}

/**
 * Returns the authentication header for GitLab API requests.
 * PATs use the `PRIVATE-TOKEN` header per the OpenAPI spec.
 * OAuth tokens use the standard `Authorization: Bearer` header.
 */
export function getAuthHeader(config: AuthConfig): AuthHeader {
  switch (config.type) {
    case 'pat':
      return { name: 'PRIVATE-TOKEN', value: config.token }
    case 'oauth':
      return { name: 'Authorization', value: `Bearer ${config.token}` }
    default:
      throw new Error(`Unknown auth type: ${config.type}`)
  }
}

/**
 * Gets the GitLab base URL from environment or returns default.
 */
export function getBaseUrl(): string {
  return process.env.GITLAB_BASE_URL || 'https://gitlab.com'
}
