import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeDatabase, getQueries, initDatabase } from '../../src/db'
import { resolveProjectId } from '../../src/tools/resolve-project-id'

describe('resolveProjectId', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    closeDatabase()
    initDatabase(':memory:')
    originalEnv = process.env.GITLAB_PROJECT_ID
    delete process.env.GITLAB_PROJECT_ID
  })

  afterEach(() => {
    closeDatabase()
    if (originalEnv !== undefined) {
      process.env.GITLAB_PROJECT_ID = originalEnv
    } else {
      delete process.env.GITLAB_PROJECT_ID
    }
  })

  // -------------------------------------------------------------------------
  // Priority 1: Explicit value
  // -------------------------------------------------------------------------

  test('returns explicit value when provided', () => {
    expect(resolveProjectId('my-group/my-project')).toBe('my-group/my-project')
  })

  test('explicit value wins over DB setting', () => {
    const queries = getQueries()
    queries.setSetting('default_project_id', 'db-project')
    expect(resolveProjectId('explicit-project')).toBe('explicit-project')
  })

  test('explicit value wins over env var', () => {
    process.env.GITLAB_PROJECT_ID = 'env-project'
    expect(resolveProjectId('explicit-project')).toBe('explicit-project')
  })

  test('explicit value wins over both DB setting and env var', () => {
    const queries = getQueries()
    queries.setSetting('default_project_id', 'db-project')
    process.env.GITLAB_PROJECT_ID = 'env-project'
    expect(resolveProjectId('explicit-project')).toBe('explicit-project')
  })

  // -------------------------------------------------------------------------
  // Priority 2: DB setting
  // -------------------------------------------------------------------------

  test('falls back to DB setting when no explicit value', () => {
    const queries = getQueries()
    queries.setSetting('default_project_id', 'db-project')
    expect(resolveProjectId(undefined)).toBe('db-project')
  })

  test('DB setting wins over env var', () => {
    const queries = getQueries()
    queries.setSetting('default_project_id', 'db-project')
    process.env.GITLAB_PROJECT_ID = 'env-project'
    expect(resolveProjectId(undefined)).toBe('db-project')
  })

  // -------------------------------------------------------------------------
  // Priority 3: Environment variable
  // -------------------------------------------------------------------------

  test('falls back to env var when no explicit value and no DB setting', () => {
    process.env.GITLAB_PROJECT_ID = 'env-project'
    expect(resolveProjectId(undefined)).toBe('env-project')
  })

  test('falls back to env var when explicit is undefined and DB setting absent', () => {
    process.env.GITLAB_PROJECT_ID = 'env-fallback'
    expect(resolveProjectId()).toBe('env-fallback')
  })

  // -------------------------------------------------------------------------
  // No default: throws
  // -------------------------------------------------------------------------

  test('throws when no value from any source', () => {
    expect(() => resolveProjectId(undefined)).toThrow('project_id is required')
  })

  test('throws with actionable message mentioning set_setting', () => {
    expect(() => resolveProjectId()).toThrow('set_setting')
  })

  test('throws with actionable message mentioning GITLAB_PROJECT_ID', () => {
    expect(() => resolveProjectId()).toThrow('GITLAB_PROJECT_ID')
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  test('empty string explicit value falls through to DB setting', () => {
    const queries = getQueries()
    queries.setSetting('default_project_id', 'db-project')
    // empty string is falsy, should fallback
    expect(resolveProjectId('')).toBe('db-project')
  })

  test('empty string explicit value falls through to env var', () => {
    process.env.GITLAB_PROJECT_ID = 'env-project'
    expect(resolveProjectId('')).toBe('env-project')
  })
})
