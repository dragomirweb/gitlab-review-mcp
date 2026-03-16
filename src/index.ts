/**
 * GitLab MCP Server - Entry Point
 *
 * A Model Context Protocol server for GitLab merge request reviews.
 */

import { logger } from './logger'
import { runServer } from './server'

runServer().catch((error) => {
  logger.error('server_fatal', {
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
