/**
 * Tests for enrichReviewItems() — the most complex shared function in
 * src/tools/reviews.ts.  It cross-references local DB review items against
 * live GitLab discussions to determine resolution status and extract replies.
 */

import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ReviewQueries } from '../../src/db/queries'
import type { ReviewSession } from '../../src/db/schema'
import type { GitLabClient } from '../../src/gitlab/client'
import type { GitLabDiscussion, GitLabNote } from '../../src/gitlab/types'
import { enrichReviewItems } from '../../src/tools/reviews'
import { createTestDb } from '../helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal GitLabNote for testing. */
function makeNote(overrides: Partial<GitLabNote> = {}): GitLabNote {
  return {
    id: 1,
    type: null,
    body: 'note body',
    author: {
      id: 1,
      username: 'reviewer',
      name: 'Reviewer',
      avatar_url: '',
      web_url: '',
    },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    system: false,
    noteable_id: 1,
    noteable_type: 'MergeRequest',
    resolvable: true,
    resolved: false,
    resolved_by: null,
    confidential: false,
    ...overrides,
  }
}

/** Builds a GitLabDiscussion with provided notes. */
function makeDiscussion(
  id: string,
  notes: Partial<GitLabNote>[],
): GitLabDiscussion {
  return {
    id,
    individual_note: false,
    notes: notes.map((n, i) => makeNote({ id: 100 + i, ...n })),
  }
}

/** Creates a mock GitLabClient that returns the given discussions. */
function mockClient(discussions: GitLabDiscussion[]): GitLabClient {
  return {
    getMergeRequestDiscussions: async () => discussions,
  } as unknown as GitLabClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichReviewItems', () => {
  let db: Database
  let queries: ReviewQueries
  let session: ReviewSession

  beforeEach(() => {
    ;({ db, queries } = createTestDb())
    session = queries.createSession({
      mr_iid: 42,
      project_id: 'group/project',
      source_branch: 'feature',
    })
  })

  afterEach(() => {
    db.close()
  })

  test('returns empty summary when no review items exist', async () => {
    const result = await enrichReviewItems(mockClient([]), queries, session)

    expect(result.items).toHaveLength(0)
    expect(result.total_items).toBe(0)
    expect(result.resolved_items).toBe(0)
    expect(result.unresolved_items).toBe(0)
    expect(result.all_resolved).toBe(true)
  })

  test('marks item as resolved when matching discussion is fully resolved', async () => {
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-1',
      type: 'comment',
      content: 'Fix this bug',
    })

    const client = mockClient([
      makeDiscussion('disc-1', [{ resolvable: true, resolved: true }]),
    ])

    const result = await enrichReviewItems(client, queries, session)

    expect(result.items).toHaveLength(1)
    expect(result.items[0].gitlab_resolved).toBe(true)
    expect(result.items[0].resolved).toBe(1)
    expect(result.resolved_items).toBe(1)
    expect(result.unresolved_items).toBe(0)
    expect(result.all_resolved).toBe(true)
  })

  test('keeps item unresolved when matching discussion has unresolved notes', async () => {
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-2',
      type: 'comment',
      content: 'This needs work',
    })

    const client = mockClient([
      makeDiscussion('disc-2', [{ resolvable: true, resolved: false }]),
    ])

    const result = await enrichReviewItems(client, queries, session)

    expect(result.items[0].gitlab_resolved).toBe(false)
    expect(result.items[0].resolved).toBe(0)
    expect(result.unresolved_items).toBe(1)
    expect(result.all_resolved).toBe(false)
  })

  test('treats item as unresolved when no matching discussion found', async () => {
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-missing',
      type: 'comment',
      content: 'Orphaned comment',
    })

    const client = mockClient([
      makeDiscussion('disc-other', [{ resolvable: true, resolved: true }]),
    ])

    const result = await enrichReviewItems(client, queries, session)

    expect(result.items[0].gitlab_resolved).toBe(false)
    expect(result.unresolved_items).toBe(1)
  })

  test('treats item as unresolved when discussion_id is null', async () => {
    queries.createReviewItem({
      session_id: session.id,
      type: 'comment',
      content: 'No discussion ID',
      // discussion_id not set → null
    })

    const client = mockClient([])
    const result = await enrichReviewItems(client, queries, session)

    expect(result.items[0].gitlab_resolved).toBe(false)
    expect(result.unresolved_items).toBe(1)
  })

  test('updates DB when GitLab shows resolved but local DB shows unresolved', async () => {
    const item = queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-sync',
      type: 'comment',
      content: 'To be resolved',
    })
    expect(item.resolved).toBe(0) // Not yet resolved in DB

    const client = mockClient([
      makeDiscussion('disc-sync', [{ resolvable: true, resolved: true }]),
    ])

    await enrichReviewItems(client, queries, session)

    // Verify DB was updated
    const dbItem = queries.getReviewItemById(item.id)
    expect(dbItem!.resolved).toBe(1)
    expect(dbItem!.resolved_at).not.toBeNull()
  })

  test('does NOT update DB when item is already resolved locally', async () => {
    const item = queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-already',
      type: 'comment',
      content: 'Already resolved',
    })
    // Mark as resolved in DB first
    queries.markItemResolved(item.id)
    const resolvedAt = queries.getReviewItemById(item.id)!.resolved_at

    const client = mockClient([
      makeDiscussion('disc-already', [{ resolvable: true, resolved: true }]),
    ])

    await enrichReviewItems(client, queries, session)

    // resolved_at should be unchanged (no extra markItemResolved call)
    const dbItem = queries.getReviewItemById(item.id)
    expect(dbItem!.resolved_at).toBe(resolvedAt)
  })

  test('extracts developer replies, skipping the first note and system notes', async () => {
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-replies',
      type: 'comment',
      content: 'Review comment',
    })

    const client = mockClient([
      makeDiscussion('disc-replies', [
        // First note = the review comment (skipped in replies)
        {
          body: 'Review comment',
          author: {
            id: 1,
            username: 'reviewer',
            name: 'Reviewer',
            avatar_url: '',
            web_url: '',
          },
          resolvable: true,
          resolved: false,
        },
        // System note (should be filtered out)
        {
          body: 'resolved all threads',
          system: true,
          author: {
            id: 99,
            username: 'system',
            name: 'System',
            avatar_url: '',
            web_url: '',
          },
          resolvable: false,
          resolved: false,
        },
        // Developer reply (should be included)
        {
          body: 'Good catch, will fix!',
          author: {
            id: 2,
            username: 'developer',
            name: 'Developer',
            avatar_url: '',
            web_url: '',
          },
          created_at: '2024-01-02T10:00:00Z',
          resolvable: true,
          resolved: false,
        },
      ]),
    ])

    const result = await enrichReviewItems(client, queries, session)

    expect(result.items[0].developer_replies).toHaveLength(1)
    expect(result.items[0].developer_replies[0]).toEqual({
      author: 'developer',
      body: 'Good catch, will fix!',
      created_at: '2024-01-02T10:00:00Z',
    })
  })

  test('returns empty developer_replies when discussion has only the review note', async () => {
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-no-reply',
      type: 'comment',
      content: 'No replies yet',
    })

    const client = mockClient([
      makeDiscussion('disc-no-reply', [{ resolvable: true, resolved: false }]),
    ])

    const result = await enrichReviewItems(client, queries, session)
    expect(result.items[0].developer_replies).toHaveLength(0)
  })

  test('returns empty developer_replies when no matching discussion', async () => {
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-orphan',
      type: 'comment',
      content: 'Orphan',
    })

    const client = mockClient([])
    const result = await enrichReviewItems(client, queries, session)
    expect(result.items[0].developer_replies).toHaveLength(0)
  })

  test('handles multiple items with mixed resolution states', async () => {
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-a',
      type: 'comment',
      content: 'Issue A (resolved)',
    })
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-b',
      type: 'suggestion',
      content: 'Issue B (unresolved)',
    })
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-c',
      type: 'comment',
      content: 'Issue C (no matching discussion)',
    })

    const client = mockClient([
      makeDiscussion('disc-a', [{ resolvable: true, resolved: true }]),
      makeDiscussion('disc-b', [{ resolvable: true, resolved: false }]),
      // disc-c has no matching discussion
    ])

    const result = await enrichReviewItems(client, queries, session)

    expect(result.total_items).toBe(3)
    expect(result.resolved_items).toBe(1)
    expect(result.unresolved_items).toBe(2)
    expect(result.all_resolved).toBe(false)

    expect(result.items[0].gitlab_resolved).toBe(true)
    expect(result.items[1].gitlab_resolved).toBe(false)
    expect(result.items[2].gitlab_resolved).toBe(false)
  })

  test('non-resolvable notes do not block resolution', async () => {
    // A discussion with a non-resolvable note (e.g. system note) and a
    // resolved resolvable note should be considered resolved.
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-mixed',
      type: 'comment',
      content: 'Mixed note types',
    })

    const client = mockClient([
      makeDiscussion('disc-mixed', [
        { resolvable: true, resolved: true },
        { resolvable: false, resolved: false }, // non-resolvable, doesn't block
      ]),
    ])

    const result = await enrichReviewItems(client, queries, session)
    expect(result.items[0].gitlab_resolved).toBe(true)
    expect(result.resolved_items).toBe(1)
  })

  test('discussion with all non-resolvable notes is considered resolved', async () => {
    queries.createReviewItem({
      session_id: session.id,
      discussion_id: 'disc-nonres',
      type: 'comment',
      content: 'All non-resolvable',
    })

    const client = mockClient([
      makeDiscussion('disc-nonres', [
        { resolvable: false, resolved: false },
        { resolvable: false, resolved: false },
      ]),
    ])

    const result = await enrichReviewItems(client, queries, session)
    // every(n => !n.resolvable || n.resolved) is true when all are non-resolvable
    expect(result.items[0].gitlab_resolved).toBe(true)
  })
})
