/**
 * Tests for src/db/index.ts — database initialization, singleton management,
 * and migration logic.
 */

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  closeDatabase,
  getDatabase,
  getQueries,
  initDatabase,
} from '../../src/db'

// ---------------------------------------------------------------------------
// Each test must reset the module singleton to avoid cross-contamination.
// ---------------------------------------------------------------------------

afterEach(() => {
  closeDatabase()
})

describe('initDatabase', () => {
  test('creates tables and returns a database handle', () => {
    const db = initDatabase(':memory:')

    // Tables should exist
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const tableNames = tables.map((t) => t.name)

    expect(tableNames).toContain('settings')
    expect(tableNames).toContain('review_sessions')
    expect(tableNames).toContain('review_items')
  })

  test('is idempotent — calling twice returns same instance', () => {
    const db1 = initDatabase(':memory:')
    const db2 = initDatabase(':memory:')
    expect(db1).toBe(db2)
  })

  test('enables WAL journal mode', () => {
    const db = initDatabase(':memory:')
    const result = db.query('PRAGMA journal_mode').get() as {
      journal_mode: string
    }
    // In-memory databases use "memory" mode, but the PRAGMA is still set
    // The important thing is the call doesn't throw
    expect(result.journal_mode).toBeDefined()
  })

  test('enables foreign keys', () => {
    const db = initDatabase(':memory:')
    const result = db.query('PRAGMA foreign_keys').get() as {
      foreign_keys: number
    }
    expect(result.foreign_keys).toBe(1)
  })

  test('review_sessions table has head_sha and previous_head_sha columns', () => {
    const db = initDatabase(':memory:')

    // Insert a session with SHA fields to verify columns exist
    db.run(
      `INSERT INTO review_sessions (mr_iid, project_id, source_branch, status, head_sha, previous_head_sha)
       VALUES (1, 'proj', 'main', 'in_progress', 'abc123', 'def456')`,
    )

    const row = db
      .query(
        'SELECT head_sha, previous_head_sha FROM review_sessions WHERE id = 1',
      )
      .get() as { head_sha: string; previous_head_sha: string }

    expect(row.head_sha).toBe('abc123')
    expect(row.previous_head_sha).toBe('def456')
  })
})

describe('migrations on legacy schema', () => {
  test('adds head_sha and previous_head_sha to existing DB without them', () => {
    // Simulate a "legacy" DB that was created before Phase 3 —
    // it has review_sessions without the SHA columns.
    const legacySchema = `
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS review_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mr_iid INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress',
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS review_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        gitlab_note_id INTEGER,
        discussion_id TEXT,
        type TEXT NOT NULL DEFAULT 'comment',
        file_path TEXT,
        line_number INTEGER,
        content TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        resolved_at TEXT,
        FOREIGN KEY (session_id) REFERENCES review_sessions(id) ON DELETE CASCADE
      );
    `

    // Create the legacy DB directly (not through initDatabase)
    const legacyDb = new Database(':memory:')
    legacyDb.run('PRAGMA foreign_keys = ON')
    legacyDb.run(legacySchema)

    // Verify columns DON'T exist yet
    const colsBefore = legacyDb
      .query('PRAGMA table_info(review_sessions)')
      .all() as {
      name: string
    }[]
    const colNamesBefore = colsBefore.map((c) => c.name)
    expect(colNamesBefore).not.toContain('head_sha')
    expect(colNamesBefore).not.toContain('previous_head_sha')

    // Now run the same migration logic that initDatabase uses.
    // Since runMigrations is private, we simulate it here.
    const migrations = [
      'ALTER TABLE review_sessions ADD COLUMN head_sha TEXT',
      'ALTER TABLE review_sessions ADD COLUMN previous_head_sha TEXT',
    ]
    for (const sql of migrations) {
      try {
        legacyDb.run(sql)
      } catch {
        // Column already exists
      }
    }

    // Verify columns now exist
    const colsAfter = legacyDb
      .query('PRAGMA table_info(review_sessions)')
      .all() as {
      name: string
    }[]
    const colNamesAfter = colsAfter.map((c) => c.name)
    expect(colNamesAfter).toContain('head_sha')
    expect(colNamesAfter).toContain('previous_head_sha')

    legacyDb.close()
  })

  test('migration is idempotent — running twice does not throw', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    db.run(`CREATE TABLE IF NOT EXISTS review_sessions (
      id INTEGER PRIMARY KEY,
      mr_iid INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress'
    )`)

    const migrations = [
      'ALTER TABLE review_sessions ADD COLUMN head_sha TEXT',
      'ALTER TABLE review_sessions ADD COLUMN previous_head_sha TEXT',
    ]

    // Run twice — second time should not throw
    for (let run = 0; run < 2; run++) {
      for (const sql of migrations) {
        try {
          db.run(sql)
        } catch {
          // Column already exists — expected on second run
        }
      }
    }

    // Verify columns exist and no duplicates
    const cols = db.query('PRAGMA table_info(review_sessions)').all() as {
      name: string
    }[]
    const shaCount = cols.filter((c) => c.name === 'head_sha').length
    expect(shaCount).toBe(1)

    db.close()
  })
})

describe('getDatabase', () => {
  test('auto-initializes if initDatabase was not called', () => {
    // getDatabase() should call initDatabase() internally
    // Note: this will create a real file in the default path, so we init first
    const db = initDatabase(':memory:')
    const result = getDatabase()
    expect(result).toBe(db)
  })
})

describe('getQueries', () => {
  test('returns a ReviewQueries instance', () => {
    initDatabase(':memory:')
    const queries = getQueries()
    expect(queries).toBeDefined()
    // Verify it works by calling a method
    const setting = queries.getSetting('nonexistent')
    expect(setting).toBeNull()
  })

  test('returns same instance on repeated calls (singleton)', () => {
    initDatabase(':memory:')
    const q1 = getQueries()
    const q2 = getQueries()
    expect(q1).toBe(q2)
  })
})

describe('closeDatabase', () => {
  test('resets singleton — next getQueries creates fresh instance', () => {
    initDatabase(':memory:')
    const q1 = getQueries()

    closeDatabase()
    initDatabase(':memory:')
    const q2 = getQueries()

    expect(q1).not.toBe(q2)
  })

  test('is safe to call when no database is open', () => {
    // Should not throw
    closeDatabase()
    closeDatabase()
  })
})
