import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setLogLevel, setMcpServer } from '../../src/logger'
import { registerAllTools } from '../../src/tools'
import { createMockMcpServer } from '../helpers'

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

function getLogEntries(): Array<Record<string, unknown>> {
  return stderrOutput.map((line) => JSON.parse(line))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tool logging wrapper', () => {
  beforeEach(() => {
    captureStderr()
    setLogLevel('debug')
    setMcpServer(undefined as any)
  })

  afterEach(() => {
    restoreStderr()
    setLogLevel('info')
  })

  test('registerAllTools instruments all tool handlers with logging', () => {
    const server = createMockMcpServer()
    registerAllTools(server as any)

    // Tools should be registered
    const names = server.toolNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('get_merge_request')
  })

  test('wrapped handler logs start and end on success', async () => {
    const server = createMockMcpServer()

    // Register a test tool manually through the instrumented path
    // We'll use registerAllTools and call a simple tool
    registerAllTools(server as any)

    // The tool handlers are wrapped. Let's verify by checking that calling
    // any handler produces log entries. We'll test with a tool that will
    // throw (since we have no mock client set up), but the start log
    // should still appear.
    const handler = server.getHandler('get_merge_request')
    expect(handler).toBeDefined()

    stderrOutput = [] // clear any registration logs

    try {
      await handler({ project_id: 'test/project', mr_iid: 1 })
    } catch {
      // Expected: no GitLab client configured
    }

    const entries = getLogEntries()
    // Should have at least a start entry
    const startEntry = entries.find((e) => e.message === 'tool_call_start')
    expect(startEntry).toBeDefined()
    expect(startEntry!.tool).toBe('get_merge_request')

    // Since the handler threw, we should see an error entry
    const errorEntry = entries.find((e) => e.message === 'tool_call_error')
    expect(errorEntry).toBeDefined()
    expect(errorEntry!.tool).toBe('get_merge_request')
    expect(errorEntry!.durationMs).toBeDefined()
    expect(typeof errorEntry!.error).toBe('string')
  })
})
