import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeDatabase, initDatabase } from '../../src/db'
import { registerSettingsTools } from '../../src/tools/settings'
import { createMockMcpServer } from '../helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createMockMcpServer>

function getHandler(name: string) {
  return server.getHandler(name)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settings tools', () => {
  beforeEach(() => {
    closeDatabase()
    initDatabase(':memory:')
    server = createMockMcpServer()
    registerSettingsTools(server as any)
  })

  afterEach(() => {
    closeDatabase()
  })

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe('registration', () => {
    test('registers get_setting and set_setting tools', () => {
      const names = server.toolNames()
      expect(names).toContain('get_setting')
      expect(names).toContain('set_setting')
    })

    test('get_setting has readOnlyHint: true', () => {
      const config = server.getConfig('get_setting')
      expect((config?.annotations as any)?.readOnlyHint).toBe(true)
    })

    test('set_setting has readOnlyHint: false', () => {
      const config = server.getConfig('set_setting')
      expect((config?.annotations as any)?.readOnlyHint).toBe(false)
    })

    test('both tools have openWorldHint: false', () => {
      const getConfig = server.getConfig('get_setting')
      const setConfig = server.getConfig('set_setting')
      expect((getConfig?.annotations as any)?.openWorldHint).toBe(false)
      expect((setConfig?.annotations as any)?.openWorldHint).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // get_setting
  // -------------------------------------------------------------------------

  describe('get_setting', () => {
    test('returns null for non-existent key', async () => {
      const handler = getHandler('get_setting')
      const result = await handler({ key: 'nonexistent' })
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.key).toBe('nonexistent')
      expect(parsed.value).toBeNull()
      expect(parsed.message).toContain('not configured')
    })

    test('returns value for existing key', async () => {
      // Set a value first
      const setHandler = getHandler('set_setting')
      await setHandler({
        key: 'default_project_id',
        value: 'my-group/my-project',
      })

      const getHandlerFn = getHandler('get_setting')
      const result = await getHandlerFn({ key: 'default_project_id' })
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.key).toBe('default_project_id')
      expect(parsed.value).toBe('my-group/my-project')
      expect(parsed.message).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // set_setting
  // -------------------------------------------------------------------------

  describe('set_setting', () => {
    test('creates a new setting', async () => {
      const handler = getHandler('set_setting')
      const result = await handler({
        key: 'review_labels',
        value: '["needs-review","approved"]',
      })
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.key).toBe('review_labels')
      expect(parsed.value).toBe('["needs-review","approved"]')
    })

    test('updates an existing setting', async () => {
      const handler = getHandler('set_setting')
      await handler({ key: 'project', value: 'old-value' })
      await handler({ key: 'project', value: 'new-value' })

      const getHandlerFn = getHandler('get_setting')
      const result = await getHandlerFn({ key: 'project' })
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.value).toBe('new-value')
    })

    test('set and get roundtrip with JSON value', async () => {
      const setHandler = getHandler('set_setting')
      const jsonValue = JSON.stringify({ patterns: ['*.lock', 'dist/**'] })
      await setHandler({ key: 'excluded_file_patterns', value: jsonValue })

      const getHandlerFn = getHandler('get_setting')
      const result = await getHandlerFn({ key: 'excluded_file_patterns' })
      const parsed = JSON.parse(result.content[0].text)
      const innerParsed = JSON.parse(parsed.value)
      expect(innerParsed.patterns).toEqual(['*.lock', 'dist/**'])
    })

    test('multiple keys are independent', async () => {
      const handler = getHandler('set_setting')
      await handler({ key: 'key1', value: 'value1' })
      await handler({ key: 'key2', value: 'value2' })

      const getHandlerFn = getHandler('get_setting')
      const r1 = JSON.parse(
        (await getHandlerFn({ key: 'key1' })).content[0].text,
      )
      const r2 = JSON.parse(
        (await getHandlerFn({ key: 'key2' })).content[0].text,
      )
      expect(r1.value).toBe('value1')
      expect(r2.value).toBe('value2')
    })
  })
})
