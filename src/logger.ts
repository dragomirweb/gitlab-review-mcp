/**
 * Structured logging module.
 *
 * Provides dual-mode logging:
 *   1. JSON lines to stderr — for operators, debugging, and log aggregation
 *   2. MCP logging messages to the connected client — for AI agent visibility
 *
 * stdout is reserved for MCP stdio transport and must never be written to.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

/** Numeric severity used for level filtering (higher = more severe). */
const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
}

/** MCP protocol level type. */
type McpLogLevel =
  | 'debug'
  | 'info'
  | 'warning'
  | 'error'
  | 'notice'
  | 'critical'
  | 'alert'
  | 'emergency'

/** Maps our level names to the MCP protocol level names. */
const MCP_LEVEL: Record<LogLevel, McpLogLevel> = {
  debug: 'debug',
  info: 'info',
  warning: 'warning',
  error: 'error',
}

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let mcpServer: McpServer | undefined
let minLevel: LogLevel = parseLogLevel(process.env.LOG_LEVEL)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the MCP server reference so log messages can also be sent to the
 * connected client via `server.sendLoggingMessage()`.
 */
export function setMcpServer(server: McpServer): void {
  mcpServer = server
}

/** Update the minimum log level at runtime. */
export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

/** Returns the current minimum log level. */
export function getLogLevel(): LogLevel {
  return minLevel
}

/**
 * Core logging function.
 *
 * Writes a JSON line to stderr and, if an MCP server is connected,
 * also sends a `notifications/logging/message` to the client.
 */
export function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[minLevel]) {
    return
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  }

  // 1. Always write to stderr (JSON line)
  process.stderr.write(`${JSON.stringify(entry)}\n`)

  // 2. Optionally forward to MCP client
  if (mcpServer) {
    // Fire-and-forget — logging should never block or throw
    mcpServer
      .sendLoggingMessage({ level: MCP_LEVEL[level], data: entry })
      .catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

export const logger = {
  debug: (message: string, data?: Record<string, unknown>) =>
    log('debug', message, data),
  info: (message: string, data?: Record<string, unknown>) =>
    log('info', message, data),
  warn: (message: string, data?: Record<string, unknown>) =>
    log('warning', message, data),
  error: (message: string, data?: Record<string, unknown>) =>
    log('error', message, data),
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.toLowerCase()
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warning' ||
    normalized === 'error'
  ) {
    return normalized
  }
  // Also accept "warn" as shorthand for "warning"
  if (normalized === 'warn') {
    return 'warning'
  }
  return 'info' // default
}
