import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  getLogLevel,
  log,
  logger,
  setLogLevel,
  setMcpServer,
} from '../src/logger'

// ---------------------------------------------------------------------------
// Helpers — capture stderr output
// ---------------------------------------------------------------------------

let stderrOutput: string[]
let originalWrite: typeof process.stderr.write

function captureStderr(): void {
  stderrOutput = []
  originalWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput.push(
      typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk),
    )
    return true
  }) as typeof process.stderr.write
}

function restoreStderr(): void {
  process.stderr.write = originalWrite
}

function lastEntry(): Record<string, unknown> {
  const last = stderrOutput[stderrOutput.length - 1]
  return JSON.parse(last)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('logger', () => {
  beforeEach(() => {
    captureStderr()
    setLogLevel('debug') // allow all levels by default
    setMcpServer(undefined as any) // clear MCP server
  })

  afterEach(() => {
    restoreStderr()
    setLogLevel('info') // reset to default
  })

  // -------------------------------------------------------------------------
  // Basic JSON output
  // -------------------------------------------------------------------------

  describe('JSON output to stderr', () => {
    test('writes valid JSON line to stderr', () => {
      log('info', 'test_message')
      expect(stderrOutput).toHaveLength(1)
      const entry = lastEntry()
      expect(entry.level).toBe('info')
      expect(entry.message).toBe('test_message')
      expect(entry.timestamp).toBeDefined()
    })

    test('includes extra data fields', () => {
      log('info', 'with_data', { tool: 'get_mr', durationMs: 42 })
      const entry = lastEntry()
      expect(entry.tool).toBe('get_mr')
      expect(entry.durationMs).toBe(42)
    })

    test('timestamp is ISO 8601 format', () => {
      log('info', 'ts_check')
      const entry = lastEntry()
      const ts = entry.timestamp as string
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    test('output ends with newline', () => {
      log('info', 'newline_check')
      expect(stderrOutput[0]).toEndWith('\n')
    })
  })

  // -------------------------------------------------------------------------
  // Level filtering
  // -------------------------------------------------------------------------

  describe('level filtering', () => {
    test('debug is suppressed at info level', () => {
      setLogLevel('info')
      log('debug', 'should_not_appear')
      expect(stderrOutput).toHaveLength(0)
    })

    test('info passes at info level', () => {
      setLogLevel('info')
      log('info', 'should_appear')
      expect(stderrOutput).toHaveLength(1)
    })

    test('warning passes at info level', () => {
      setLogLevel('info')
      log('warning', 'should_appear')
      expect(stderrOutput).toHaveLength(1)
    })

    test('error passes at info level', () => {
      setLogLevel('info')
      log('error', 'should_appear')
      expect(stderrOutput).toHaveLength(1)
    })

    test('all levels suppressed at error level except error', () => {
      setLogLevel('error')
      log('debug', 'no')
      log('info', 'no')
      log('warning', 'no')
      expect(stderrOutput).toHaveLength(0)
      log('error', 'yes')
      expect(stderrOutput).toHaveLength(1)
    })

    test('debug level shows everything', () => {
      setLogLevel('debug')
      log('debug', 'd')
      log('info', 'i')
      log('warning', 'w')
      log('error', 'e')
      expect(stderrOutput).toHaveLength(4)
    })
  })

  // -------------------------------------------------------------------------
  // getLogLevel / setLogLevel
  // -------------------------------------------------------------------------

  describe('getLogLevel / setLogLevel', () => {
    test('returns current level', () => {
      setLogLevel('warning')
      expect(getLogLevel()).toBe('warning')
    })

    test('defaults to info (when reset)', () => {
      setLogLevel('info')
      expect(getLogLevel()).toBe('info')
    })
  })

  // -------------------------------------------------------------------------
  // Convenience helpers (logger.debug/info/warn/error)
  // -------------------------------------------------------------------------

  describe('convenience helpers', () => {
    test('logger.debug writes at debug level', () => {
      logger.debug('dbg_msg')
      const entry = lastEntry()
      expect(entry.level).toBe('debug')
      expect(entry.message).toBe('dbg_msg')
    })

    test('logger.info writes at info level', () => {
      logger.info('info_msg', { key: 'val' })
      const entry = lastEntry()
      expect(entry.level).toBe('info')
      expect(entry.key).toBe('val')
    })

    test('logger.warn writes at warning level', () => {
      logger.warn('warn_msg')
      const entry = lastEntry()
      expect(entry.level).toBe('warning')
    })

    test('logger.error writes at error level', () => {
      logger.error('err_msg')
      const entry = lastEntry()
      expect(entry.level).toBe('error')
    })
  })

  // -------------------------------------------------------------------------
  // MCP server integration
  // -------------------------------------------------------------------------

  describe('MCP server integration', () => {
    test('sends logging message to MCP server when set', () => {
      const sendLoggingMessage = mock(() => Promise.resolve())
      const mockServer = { sendLoggingMessage } as any
      setMcpServer(mockServer)

      log('info', 'mcp_test', { extra: true })

      expect(sendLoggingMessage).toHaveBeenCalledTimes(1)
      const call = sendLoggingMessage.mock.calls[0] as any[]
      expect(call[0].level).toBe('info')
      expect(call[0].data.message).toBe('mcp_test')
      expect(call[0].data.extra).toBe(true)
    })

    test('does not send to MCP when no server is set', () => {
      setMcpServer(undefined as any)
      // Should not throw
      log('info', 'no_server')
      expect(stderrOutput).toHaveLength(1)
    })

    test('MCP send errors are swallowed silently', () => {
      const sendLoggingMessage = mock(() =>
        Promise.reject(new Error('connection lost')),
      )
      const mockServer = { sendLoggingMessage } as any
      setMcpServer(mockServer)

      // Should not throw
      log('error', 'will_fail_mcp')
      expect(stderrOutput).toHaveLength(1)
    })

    test('level filtering applies before MCP send', () => {
      setLogLevel('error')
      const sendLoggingMessage = mock(() => Promise.resolve())
      const mockServer = { sendLoggingMessage } as any
      setMcpServer(mockServer)

      log('debug', 'filtered_out')
      expect(sendLoggingMessage).not.toHaveBeenCalled()
      expect(stderrOutput).toHaveLength(0)
    })
  })
})
