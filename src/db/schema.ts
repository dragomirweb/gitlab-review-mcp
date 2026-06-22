/**
 * Database schema definitions for GitLab MCP
 */

export const SCHEMA = `
-- Key/value config storage
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Review sessions - one per review cycle on an MR
CREATE TABLE IF NOT EXISTS review_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mr_iid INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  head_sha TEXT,
  previous_head_sha TEXT,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for looking up sessions by MR or branch
CREATE INDEX IF NOT EXISTS idx_sessions_mr ON review_sessions(project_id, mr_iid);
CREATE INDEX IF NOT EXISTS idx_sessions_branch ON review_sessions(project_id, source_branch);

-- Review items - comments/suggestions we posted during a review
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

-- Index for looking up items by session
CREATE INDEX IF NOT EXISTS idx_items_session ON review_items(session_id);
`

export type ReviewStatus =
  | 'in_progress'
  | 'pending_changes'
  | 'approved'
  | 'requested_changes'
  | 'closed'
export type ReviewItemType = 'comment' | 'suggestion'

export interface Setting {
  id: number
  key: string
  value: string
  created_at: string
  updated_at: string
}

export interface ReviewSession {
  id: number
  mr_iid: number
  project_id: string
  source_branch: string
  status: ReviewStatus
  head_sha: string | null
  previous_head_sha: string | null
  started_at: string
  updated_at: string
}

export interface ReviewItem {
  id: number
  session_id: number
  gitlab_note_id: number | null
  discussion_id: string | null
  type: ReviewItemType
  file_path: string | null
  line_number: number | null
  content: string
  resolved: number // 0 or 1 (SQLite boolean)
  created_at: string
  resolved_at: string | null
}
