/**
 * Database query helpers for GitLab MCP
 */

import type { Database } from 'bun:sqlite'
import type {
  ReviewItem,
  ReviewItemType,
  ReviewSession,
  ReviewStatus,
  Setting,
} from './schema'

export interface CreateSessionInput {
  mr_iid: number
  project_id: string
  source_branch: string
  head_sha?: string
}

export interface CreateReviewItemInput {
  session_id: number
  gitlab_note_id?: number
  discussion_id?: string
  type: ReviewItemType
  file_path?: string
  line_number?: number
  content: string
}

export class ReviewQueries {
  constructor(private db: Database) {}

  // Settings
  getSetting(key: string): Setting | null {
    return this.db
      .query<Setting, [string]>('SELECT * FROM settings WHERE key = ?')
      .get(key)
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [key, value],
    )
  }

  // Review Sessions
  createSession(input: CreateSessionInput): ReviewSession {
    const result = this.db.run(
      `INSERT INTO review_sessions (mr_iid, project_id, source_branch, head_sha)
       VALUES (?, ?, ?, ?)`,
      [
        input.mr_iid,
        input.project_id,
        input.source_branch,
        input.head_sha ?? null,
      ],
    )
    return this.getSessionById(Number(result.lastInsertRowid))!
  }

  getSessionById(id: number): ReviewSession | null {
    return this.db
      .query<ReviewSession, [number]>(
        'SELECT * FROM review_sessions WHERE id = ?',
      )
      .get(id)
  }

  getActiveSessionByMR(
    project_id: string,
    mr_iid: number,
  ): ReviewSession | null {
    return this.db
      .query<ReviewSession, [string, number]>(
        `SELECT * FROM review_sessions 
       WHERE project_id = ? AND mr_iid = ? AND status IN ('in_progress', 'pending_changes')
       ORDER BY started_at DESC LIMIT 1`,
      )
      .get(project_id, mr_iid)
  }

  getActiveSessionByBranch(
    project_id: string,
    source_branch: string,
  ): ReviewSession | null {
    return this.db
      .query<ReviewSession, [string, string]>(
        `SELECT * FROM review_sessions 
       WHERE project_id = ? AND source_branch = ? AND status IN ('in_progress', 'pending_changes')
       ORDER BY started_at DESC LIMIT 1`,
      )
      .get(project_id, source_branch)
  }

  updateSessionStatus(id: number, status: ReviewStatus): void {
    this.db.run(
      `UPDATE review_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, id],
    )
  }

  /**
   * Update the HEAD SHA tracked by a session.
   * Moves the current head_sha to previous_head_sha before setting the new one.
   */
  updateSessionHeadSha(id: number, newHeadSha: string): void {
    this.db.run(
      `UPDATE review_sessions
       SET previous_head_sha = head_sha,
           head_sha = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newHeadSha, id],
    )
  }

  // Review Items
  createReviewItem(input: CreateReviewItemInput): ReviewItem {
    const result = this.db.run(
      `INSERT INTO review_items (session_id, gitlab_note_id, discussion_id, type, file_path, line_number, content)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.session_id,
        input.gitlab_note_id ?? null,
        input.discussion_id ?? null,
        input.type,
        input.file_path ?? null,
        input.line_number ?? null,
        input.content,
      ],
    )
    return this.getReviewItemById(Number(result.lastInsertRowid))!
  }

  getReviewItemById(id: number): ReviewItem | null {
    return this.db
      .query<ReviewItem, [number]>('SELECT * FROM review_items WHERE id = ?')
      .get(id)
  }

  getReviewItemsBySession(session_id: number): ReviewItem[] {
    return this.db
      .query<ReviewItem, [number]>(
        'SELECT * FROM review_items WHERE session_id = ? ORDER BY created_at ASC',
      )
      .all(session_id)
  }

  getUnresolvedItemsBySession(session_id: number): ReviewItem[] {
    return this.db
      .query<ReviewItem, [number]>(
        'SELECT * FROM review_items WHERE session_id = ? AND resolved = 0 ORDER BY created_at ASC',
      )
      .all(session_id)
  }

  markItemResolved(id: number): void {
    this.db.run(
      `UPDATE review_items SET resolved = 1, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id],
    )
  }

  updateItemGitLabIds(
    id: number,
    gitlab_note_id: number,
    discussion_id: string,
  ): void {
    this.db.run(
      `UPDATE review_items SET gitlab_note_id = ?, discussion_id = ? WHERE id = ?`,
      [gitlab_note_id, discussion_id, id],
    )
  }
}
