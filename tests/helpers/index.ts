/**
 * Shared test helpers for GitLab MCP tests.
 *
 * Centralises common mock patterns so individual test files stay concise.
 */

import { Database } from 'bun:sqlite'
import { mock } from 'bun:test'
import { ReviewQueries } from '../../src/db/queries'
import { SCHEMA } from '../../src/db/schema'
import { GitLabClient } from '../../src/gitlab/client'

// ---------------------------------------------------------------------------
// Fetch mocking
// ---------------------------------------------------------------------------

/**
 * Build a minimal Response object for mocking fetch.
 */
export function mockResponse(body: unknown, status = 200, ok = true): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () =>
      Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

/**
 * Build a Response with custom headers (e.g. for Retry-After, Link).
 */
export function mockResponseWithHeaders(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () =>
      Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

/**
 * Replace globalThis.fetch with a Bun mock function.
 * Cast through `unknown` to satisfy Bun's stricter `typeof fetch` which
 * includes a `preconnect` property.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mockFetchWith(fn: (...args: any[]) => Promise<Response>): void {
  globalThis.fetch = mock(fn) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// GitLab client helpers
// ---------------------------------------------------------------------------

/**
 * Subclass that overrides sleep() to avoid real delays in tests.
 * Also tracks sleep calls for verification.
 */
export class TestableClient extends GitLabClient {
  sleepCalls: number[] = []

  protected override sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms)
    return Promise.resolve()
  }
}

/**
 * Create a TestableClient with env vars pre-configured.
 */
export function createTestClient(
  baseUrl = 'https://gitlab.example.com',
): TestableClient {
  process.env.GITLAB_PAT = 'test-token'
  process.env.GITLAB_BASE_URL = baseUrl
  return new TestableClient()
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh in-memory SQLite database with the full schema applied.
 * Returns both the raw Database handle and a ReviewQueries instance.
 */
export function createTestDb(): { db: Database; queries: ReviewQueries } {
  const db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  db.run(SCHEMA)
  return { db, queries: new ReviewQueries(db) }
}

// ---------------------------------------------------------------------------
// Mock McpServer for tool handler testing
// ---------------------------------------------------------------------------

/** Shape captured when registerTool() is called. */
export interface CapturedTool {
  config: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Promise<any>
}

/**
 * Fake McpServer that records registerTool() calls so tests can retrieve
 * and invoke handler callbacks by tool name.
 */
export function createMockMcpServer() {
  const tools = new Map<string, CapturedTool>()

  return {
    /** Mimics McpServer.registerTool(). */
    registerTool(
      name: string,
      config: Record<string, unknown>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (...args: any[]) => Promise<any>,
    ) {
      tools.set(name, { config, handler })
    },

    /** Get a handler by tool name. Throws if not found. */
    getHandler(name: string) {
      const tool = tools.get(name)
      if (!tool)
        throw new Error(
          `Tool "${name}" not registered. Available: ${[...tools.keys()].join(', ')}`,
        )
      return tool.handler
    },

    /** Get tool config by name. */
    getConfig(name: string) {
      return tools.get(name)?.config
    },

    /** All registered tool names. */
    toolNames(): string[] {
      return [...tools.keys()]
    },
  }
}

export type MockMcpServer = ReturnType<typeof createMockMcpServer>
