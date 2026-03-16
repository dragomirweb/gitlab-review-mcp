/**
 * Database initialization and connection for GitLab MCP
 */

import { Database } from 'bun:sqlite'
import { ReviewQueries } from './queries'
import { SCHEMA } from './schema'

/**
 * Run safe ALTER TABLE migrations for existing databases.
 * Each migration is wrapped in try/catch so it's safe to run on both
 * new databases (columns already exist) and old ones (columns added).
 */
function runMigrations(db: Database): void {
  const migrations = [
    'ALTER TABLE review_sessions ADD COLUMN head_sha TEXT',
    'ALTER TABLE review_sessions ADD COLUMN previous_head_sha TEXT',
  ]

  for (const sql of migrations) {
    try {
      db.run(sql)
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

let db: Database | null = null
let queries: ReviewQueries | null = null

export function initDatabase(dbPath: string = 'gitlab-mcp.db'): Database {
  if (db) {
    return db
  }

  db = new Database(dbPath)

  // Enable WAL mode for better concurrent access
  db.run('PRAGMA journal_mode = WAL')

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON')

  // Run schema migrations
  db.run(SCHEMA)

  // Safe migrations for existing databases (idempotent)
  runMigrations(db)

  return db
}

export function getDatabase(): Database {
  if (!db) {
    return initDatabase()
  }
  return db
}

export function getQueries(): ReviewQueries {
  if (!queries) {
    queries = new ReviewQueries(getDatabase())
  }
  return queries
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    queries = null
  }
}

export * from './queries'
export * from './schema'
