import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ReviewQueries } from '../../src/db/queries'
import { createTestDb } from '../helpers'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('Settings', () => {
  let db: Database
  let queries: ReviewQueries

  beforeEach(() => {
    ;({ db, queries } = createTestDb())
  })

  afterEach(() => {
    db.close()
  })

  test('getSetting returns null for missing key', () => {
    expect(queries.getSetting('nonexistent')).toBeNull()
  })

  test('setSetting creates a new setting', () => {
    queries.setSetting('theme', 'dark')
    const setting = queries.getSetting('theme')
    expect(setting).not.toBeNull()
    expect(setting!.key).toBe('theme')
    expect(setting!.value).toBe('dark')
  })

  test('setSetting upserts an existing setting', () => {
    queries.setSetting('theme', 'dark')
    queries.setSetting('theme', 'light')
    const setting = queries.getSetting('theme')
    expect(setting!.value).toBe('light')
  })
})

// ---------------------------------------------------------------------------
// Review Sessions
// ---------------------------------------------------------------------------

describe('Review Sessions', () => {
  let db: Database
  let queries: ReviewQueries

  beforeEach(() => {
    ;({ db, queries } = createTestDb())
  })

  afterEach(() => {
    db.close()
  })

  test('createSession returns the created session', () => {
    const session = queries.createSession({
      mr_iid: 42,
      project_id: 'group/project',
      source_branch: 'feat/thing',
    })

    expect(session.id).toBe(1)
    expect(session.mr_iid).toBe(42)
    expect(session.project_id).toBe('group/project')
    expect(session.source_branch).toBe('feat/thing')
    expect(session.status).toBe('in_progress')
    expect(session.head_sha).toBeNull()
    expect(session.previous_head_sha).toBeNull()
    expect(session.started_at).toBeDefined()
  })

  test('createSession stores head_sha when provided', () => {
    const session = queries.createSession({
      mr_iid: 42,
      project_id: 'p',
      source_branch: 'b',
      head_sha: 'abc123',
    })

    expect(session.head_sha).toBe('abc123')
    expect(session.previous_head_sha).toBeNull()
  })

  test('getSessionById returns session by ID', () => {
    const created = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
    })
    const fetched = queries.getSessionById(created.id)
    expect(fetched).toEqual(created)
  })

  test('getSessionById returns null for missing ID', () => {
    expect(queries.getSessionById(999)).toBeNull()
  })

  test('getActiveSessionByMR finds in_progress session', () => {
    queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
    })
    const found = queries.getActiveSessionByMR('p', 1)
    expect(found).not.toBeNull()
    expect(found!.status).toBe('in_progress')
  })

  test('getActiveSessionByMR finds pending_changes session', () => {
    const session = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
    })
    queries.updateSessionStatus(session.id, 'pending_changes')
    const found = queries.getActiveSessionByMR('p', 1)
    expect(found).not.toBeNull()
    expect(found!.status).toBe('pending_changes')
  })

  test('getActiveSessionByMR ignores approved sessions', () => {
    const session = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
    })
    queries.updateSessionStatus(session.id, 'approved')
    const found = queries.getActiveSessionByMR('p', 1)
    expect(found).toBeNull()
  })

  test('getActiveSessionByMR ignores closed sessions', () => {
    const session = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
    })
    queries.updateSessionStatus(session.id, 'closed')
    const found = queries.getActiveSessionByMR('p', 1)
    expect(found).toBeNull()
  })

  test('getActiveSessionByBranch finds session by branch', () => {
    queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'feat/branch',
    })
    const found = queries.getActiveSessionByBranch('p', 'feat/branch')
    expect(found).not.toBeNull()
    expect(found!.source_branch).toBe('feat/branch')
  })

  test('getActiveSessionByBranch returns null for wrong branch', () => {
    queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'feat/a',
    })
    expect(queries.getActiveSessionByBranch('p', 'feat/b')).toBeNull()
  })

  test('updateSessionStatus changes status', () => {
    const session = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
    })
    queries.updateSessionStatus(session.id, 'approved')
    const updated = queries.getSessionById(session.id)
    expect(updated!.status).toBe('approved')
  })

  test('updateSessionHeadSha sets head_sha on first call', () => {
    const session = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
    })

    queries.updateSessionHeadSha(session.id, 'sha-v1')
    const updated = queries.getSessionById(session.id)
    expect(updated!.head_sha).toBe('sha-v1')
    expect(updated!.previous_head_sha).toBeNull()
  })

  test('updateSessionHeadSha moves old head_sha to previous_head_sha', () => {
    const session = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
      head_sha: 'sha-v1',
    })

    queries.updateSessionHeadSha(session.id, 'sha-v2')
    const updated = queries.getSessionById(session.id)
    expect(updated!.head_sha).toBe('sha-v2')
    expect(updated!.previous_head_sha).toBe('sha-v1')
  })

  test('updateSessionHeadSha tracks three revisions correctly', () => {
    const session = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
      head_sha: 'sha-v1',
    })

    queries.updateSessionHeadSha(session.id, 'sha-v2')
    queries.updateSessionHeadSha(session.id, 'sha-v3')

    const updated = queries.getSessionById(session.id)
    expect(updated!.head_sha).toBe('sha-v3')
    // previous_head_sha is always the SHA from the last update
    expect(updated!.previous_head_sha).toBe('sha-v2')
  })
})

// ---------------------------------------------------------------------------
// Review Items
// ---------------------------------------------------------------------------

describe('Review Items', () => {
  let db: Database
  let queries: ReviewQueries
  let sessionId: number

  beforeEach(() => {
    ;({ db, queries } = createTestDb())
    const session = queries.createSession({
      mr_iid: 1,
      project_id: 'p',
      source_branch: 'b',
    })
    sessionId = session.id
  })

  afterEach(() => {
    db.close()
  })

  test('createReviewItem with all fields', () => {
    const item = queries.createReviewItem({
      session_id: sessionId,
      gitlab_note_id: 100,
      discussion_id: 'disc-1',
      type: 'comment',
      file_path: 'src/main.ts',
      line_number: 42,
      content: 'This needs a fix',
    })

    expect(item.id).toBe(1)
    expect(item.session_id).toBe(sessionId)
    expect(item.gitlab_note_id).toBe(100)
    expect(item.discussion_id).toBe('disc-1')
    expect(item.type).toBe('comment')
    expect(item.file_path).toBe('src/main.ts')
    expect(item.line_number).toBe(42)
    expect(item.content).toBe('This needs a fix')
    expect(item.resolved).toBe(0)
  })

  test('createReviewItem with nullable fields as null', () => {
    const item = queries.createReviewItem({
      session_id: sessionId,
      type: 'suggestion',
      content: 'use const',
    })

    expect(item.gitlab_note_id).toBeNull()
    expect(item.discussion_id).toBeNull()
    expect(item.file_path).toBeNull()
    expect(item.line_number).toBeNull()
  })

  test('getReviewItemById returns null for missing ID', () => {
    expect(queries.getReviewItemById(999)).toBeNull()
  })

  test('getReviewItemsBySession returns items in created_at order', () => {
    queries.createReviewItem({
      session_id: sessionId,
      type: 'comment',
      content: 'first',
    })
    queries.createReviewItem({
      session_id: sessionId,
      type: 'comment',
      content: 'second',
    })
    queries.createReviewItem({
      session_id: sessionId,
      type: 'suggestion',
      content: 'third',
    })

    const items = queries.getReviewItemsBySession(sessionId)
    expect(items).toHaveLength(3)
    expect(items[0].content).toBe('first')
    expect(items[1].content).toBe('second')
    expect(items[2].content).toBe('third')
  })

  test('getReviewItemsBySession returns empty for unknown session', () => {
    expect(queries.getReviewItemsBySession(999)).toEqual([])
  })

  test('getUnresolvedItemsBySession filters resolved items', () => {
    const _item1 = queries.createReviewItem({
      session_id: sessionId,
      type: 'comment',
      content: 'unresolved',
    })
    const item2 = queries.createReviewItem({
      session_id: sessionId,
      type: 'comment',
      content: 'resolved',
    })

    queries.markItemResolved(item2.id)

    const unresolved = queries.getUnresolvedItemsBySession(sessionId)
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0].content).toBe('unresolved')
  })

  test('markItemResolved sets resolved and resolved_at', () => {
    const item = queries.createReviewItem({
      session_id: sessionId,
      type: 'comment',
      content: 'test',
    })

    expect(item.resolved).toBe(0)
    expect(item.resolved_at).toBeNull()

    queries.markItemResolved(item.id)
    const updated = queries.getReviewItemById(item.id)
    expect(updated!.resolved).toBe(1)
    expect(updated!.resolved_at).not.toBeNull()
  })

  test('updateItemGitLabIds updates external IDs', () => {
    const item = queries.createReviewItem({
      session_id: sessionId,
      type: 'comment',
      content: 'test',
    })

    queries.updateItemGitLabIds(item.id, 200, 'disc-200')
    const updated = queries.getReviewItemById(item.id)
    expect(updated!.gitlab_note_id).toBe(200)
    expect(updated!.discussion_id).toBe('disc-200')
  })

  test('items are cascade-deleted when session is deleted', () => {
    queries.createReviewItem({
      session_id: sessionId,
      type: 'comment',
      content: 'will be deleted',
    })

    // Manually delete session to test cascade
    db.run('DELETE FROM review_sessions WHERE id = ?', [sessionId])

    const items = queries.getReviewItemsBySession(sessionId)
    expect(items).toEqual([])
  })
})
