/**
 * MCP Server configuration and setup
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { initDatabase } from './db'
import { getGitLabClient } from './gitlab/client'
import { logger, setMcpServer } from './logger'
import { registerAllTools } from './tools'

/**
 * Common placeholder patterns found in .env.example, documentation, and
 * CLI setup guides. Matching is case-insensitive.
 */
const PLACEHOLDER_PATTERNS = [
  /^your_.+_here$/i, // "your_personal_access_token_here"
  /^glpat-x+$/i, // "glpat-xxxxxxxxxxxxxxxxxxxx"
  /^<.+>$/, // "<your_token>"
  /^(your[_-])?token$/i, // "your_token", "your-token", "token"
]

/** Returns true if the value looks like an unfilled placeholder. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * Validates that required environment variables are set before the server
 * starts accepting tool calls. Fails fast with clear setup instructions
 * rather than deferring the error to the first API call.
 *
 * Trims whitespace from token values to catch `GITLAB_PAT="  "` and warns
 * when a token looks like an unfilled placeholder from .env.example.
 */
export function validateEnvironment(): void {
  const pat = process.env.GITLAB_PAT?.trim()
  const oauth = process.env.GITLAB_OAUTH_TOKEN?.trim()

  if (!pat && !oauth) {
    console.error(
      [
        'ERROR: GitLab authentication not configured.',
        '',
        'Set one of the following environment variables:',
        '  GITLAB_PAT=glpat-...           (Personal Access Token)',
        '  GITLAB_OAUTH_TOKEN=...         (OAuth token)',
        '',
        'Optional:',
        '  GITLAB_BASE_URL=https://gitlab.example.com  (defaults to https://gitlab.com)',
        '',
        'See .env.example for details.',
      ].join('\n'),
    )
    process.exit(1)
  }

  // Warn about likely placeholder values (don't exit — could be a valid unusual token)
  const activeToken = pat || oauth
  if (activeToken && isPlaceholder(activeToken)) {
    const envVar = pat ? 'GITLAB_PAT' : 'GITLAB_OAUTH_TOKEN'
    console.error(
      [
        `WARNING: ${envVar} value looks like an unfilled placeholder from .env.example.`,
        'If authentication fails, replace it with a real token.',
        '',
        'See: https://docs.gitlab.com/user/profile/personal_access_tokens/#create-a-personal-access-token',
      ].join('\n'),
    )
  }
}

export function createServer(): McpServer {
  // Validate environment before anything else
  validateEnvironment()

  const server = new McpServer(
    {
      name: 'gitlab-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        logging: {},
      },
    },
  )

  // Wire up logger to MCP server for client-visible logging
  setMcpServer(server)

  // Initialize database
  initDatabase()

  // Register all tools
  registerAllTools(server)

  return server
}

export async function runServer(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  const defaultProject = process.env.GITLAB_PROJECT_ID
  logger.info('server_started', {
    transport: 'stdio',
    ...(defaultProject ? { default_project: defaultProject } : {}),
  })

  // Startup auth health check — warn (don't exit) if token is invalid.
  // This catches expired, revoked, or misconfigured tokens early rather
  // than letting every tool call fail silently with a 401.
  try {
    const client = getGitLabClient()
    const user = await client.validateAuth()
    logger.info('auth_validated', {
      username: user.username,
      user_id: user.id,
    })
  } catch (err) {
    logger.error('auth_check_failed', {
      error: err instanceof Error ? err.message : String(err),
      hint: 'The server will continue running, but all GitLab API calls will likely fail. Check your GITLAB_PAT or GITLAB_OAUTH_TOKEN value.',
    })
  }
}
