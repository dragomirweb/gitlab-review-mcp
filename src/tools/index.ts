/**
 * Tool registry - registers all MCP tools with the server.
 *
 * Wraps the server's `registerTool` method to automatically log every
 * tool invocation (name, duration, success/error) without requiring
 * changes inside individual tool handlers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { logger } from '../logger'
import { registerLabelTools } from './labels'
import { registerMergeRequestTools } from './merge-requests'
import { registerReviewTools } from './reviews'
import { registerSettingsTools } from './settings'

// ---------------------------------------------------------------------------
// Logging wrapper
// ---------------------------------------------------------------------------

/**
 * Monkey-patches `server.registerTool` so that every handler callback
 * is automatically instrumented with timing and logging.
 *
 * All register functions call `server.registerTool(name, config, handler)`
 * as usual and get logging for free.
 */
function withToolLogging(server: McpServer): McpServer {
  const original = server.registerTool.bind(server)

  // Override registerTool to wrap the handler with logging.
  // All tool registrations in this project use the 3-arg form:
  //   registerTool(name, config, handler)
  // biome-ignore lint/suspicious/noExplicitAny: wrapping MCP SDK generic overloads
  ;(server as any).registerTool = (name: string, config: any, handler: any) => {
    // biome-ignore lint/suspicious/noExplicitAny: forwarding arbitrary handler args
    const wrappedHandler = async (...handlerArgs: any[]) => {
      const start = performance.now()
      logger.info('tool_call_start', { tool: name })
      try {
        const result = await handler(...handlerArgs)
        const durationMs = Math.round(performance.now() - start)
        logger.info('tool_call_end', { tool: name, durationMs, success: true })
        return result
      } catch (error) {
        const durationMs = Math.round(performance.now() - start)
        logger.error('tool_call_error', {
          tool: name,
          durationMs,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }

    return original(name, config, wrappedHandler)
  }

  return server
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers all GitLab MCP tools with the server, with automatic logging.
 */
export function registerAllTools(server: McpServer): void {
  const instrumented = withToolLogging(server)
  registerMergeRequestTools(instrumented)
  registerLabelTools(instrumented)
  registerReviewTools(instrumented)
  registerSettingsTools(instrumented)
}

export {
  registerLabelTools,
  registerMergeRequestTools,
  registerReviewTools,
  registerSettingsTools,
}
