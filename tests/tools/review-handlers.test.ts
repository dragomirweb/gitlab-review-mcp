/**
 * Integration tests for review tool handlers in src/tools/reviews.ts.
 *
 * Uses a mock McpServer to capture handler callbacks, mocks getGitLabClient()
 * for API calls, and uses the REAL DB module singleton for accurate DB
 * interaction testing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { closeDatabase, getQueries, initDatabase } from '../../src/db'
import type { MockMcpServer } from '../helpers'
import { createMockMcpServer } from '../helpers'

// ---------------------------------------------------------------------------
// Mock the GitLab client module
// ---------------------------------------------------------------------------

let mockClient: Record<string, ReturnType<typeof mock>>

function resetMockClient() {
  mockClient = {
    getMergeRequest: mock(() =>
      Promise.resolve({
        id: 1,
        iid: 42,
        title: 'Test MR',
        source_branch: 'feature',
        diff_refs: {
          base_sha: 'base000',
          head_sha: 'head111',
          start_sha: 'start000',
        },
      }),
    ),
    getMergeRequestDiscussions: mock(() => Promise.resolve([])),
    createMergeRequestDiscussion: mock(() =>
      Promise.resolve({
        id: 'disc-new-1',
        individual_note: false,
        notes: [{ id: 500, body: 'review comment' }],
      }),
    ),
    createMergeRequestNote: mock(() =>
      Promise.resolve({ id: 600, body: 'summary' }),
    ),
    updateMergeRequestLabels: mock(() =>
      Promise.resolve({ labels: ['reviewed'] }),
    ),
    approveMergeRequest: mock(() => Promise.resolve({})),
    requestMergeRequestChanges: mock(() =>
      Promise.resolve({
        mergeRequest: {
          id: 'gid://gitlab/MergeRequest/1',
          iid: '42',
          webUrl:
            'https://gitlab.example.com/group/project/-/merge_requests/42',
        },
        errors: [],
      }),
    ),
  }
}

mock.module('../../src/gitlab/client', () => ({
  getGitLabClient: () => mockClient,
}))

// Import AFTER mocking
const { registerReviewTools } = await import('../../src/tools/reviews')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Review tool handlers', () => {
  let server: MockMcpServer

  beforeEach(() => {
    resetMockClient()
    closeDatabase()
    initDatabase(':memory:')
    server = createMockMcpServer()
    registerReviewTools(server as any)
  })

  afterEach(() => {
    closeDatabase()
  })

  test('registerReviewTools registers all 4 review tools', () => {
    const names = server.toolNames()
    expect(names).toContain('start_review')
    expect(names).toContain('add_review_comment')
    expect(names).toContain('get_review_status')
    expect(names).toContain('complete_review')
    expect(names).toHaveLength(4)
  })

  // -----------------------------------------------------------------------
  // start_review
  // -----------------------------------------------------------------------

  describe('start_review', () => {
    test('creates new session and captures head_sha', async () => {
      const handler = server.getHandler('start_review')
      const result = await handler({ project_id: 'p', mr_iid: 42 })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.is_rereview).toBe(false)
      expect(parsed.message).toContain('New review session started')
      expect(parsed.session.mr_iid).toBe(42)
      expect(parsed.session.project_id).toBe('p')
      expect(parsed.session.head_sha).toBe('head111')
      expect(parsed.session.status).toBe('in_progress')
    })

    test('returns existing session on re-review', async () => {
      const handler = server.getHandler('start_review')

      // First call creates session
      await handler({ project_id: 'p', mr_iid: 42 })

      // Second call should detect re-review
      const result = await handler({ project_id: 'p', mr_iid: 42 })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.is_rereview).toBe(true)
      expect(parsed.message).toContain('Existing review session found')
      expect(parsed.total_items).toBe(0)
      expect(parsed.resolved_items).toBe(0)
      expect(parsed.unresolved_items).toBe(0)
    })

    test('detects new commits on re-review', async () => {
      const handler = server.getHandler('start_review')

      // First review
      await handler({ project_id: 'p', mr_iid: 42 })

      // Developer pushes new commits — HEAD changes
      mockClient.getMergeRequest = mock(() =>
        Promise.resolve({
          id: 1,
          iid: 42,
          source_branch: 'feature',
          diff_refs: {
            head_sha: 'head222',
            base_sha: 'base',
            start_sha: 'start',
          },
        }),
      )

      // Re-review
      const result = await handler({ project_id: 'p', mr_iid: 42 })
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.is_rereview).toBe(true)
      expect(parsed.has_new_commits).toBe(true)
      expect(parsed.session.head_sha).toBe('head222')
      expect(parsed.session.previous_head_sha).toBe('head111')
    })

    test('re-review with same SHA shows no new commits', async () => {
      const handler = server.getHandler('start_review')

      // First review
      await handler({ project_id: 'p', mr_iid: 42 })

      // Re-review with same HEAD
      const result = await handler({ project_id: 'p', mr_iid: 42 })
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.is_rereview).toBe(true)
      expect(parsed.has_new_commits).toBe(false)
    })

    test('re-review enriches items with GitLab resolution status', async () => {
      const handler = server.getHandler('start_review')

      // Start review
      await handler({ project_id: 'p', mr_iid: 42 })

      // Add a comment to the session
      const addHandler = server.getHandler('add_review_comment')
      await addHandler({
        session_id: 1,
        content: 'Bug found here',
        type: 'comment',
      })

      // Set up discussions mock for the re-review enrichment
      mockClient.getMergeRequestDiscussions = mock(() =>
        Promise.resolve([
          {
            id: 'disc-new-1',
            individual_note: false,
            notes: [
              {
                id: 500,
                body: 'Bug found here',
                author: {
                  id: 1,
                  username: 'bot',
                  name: 'Bot',
                  avatar_url: '',
                  web_url: '',
                },
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z',
                system: false,
                noteable_id: 42,
                noteable_type: 'MergeRequest',
                resolvable: true,
                resolved: true,
                resolved_by: null,
                confidential: false,
              },
            ],
          },
        ]),
      )

      // Re-review
      const result = await handler({ project_id: 'p', mr_iid: 42 })
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.is_rereview).toBe(true)
      expect(parsed.total_items).toBe(1)
      expect(parsed.resolved_items).toBe(1)
      expect(parsed.unresolved_items).toBe(0)
      expect(parsed.all_resolved).toBe(true)
      expect(parsed.items[0].gitlab_resolved).toBe(true)
    })

    test('starts a fresh session with previous review context after completion', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const addHandler = server.getHandler('add_review_comment')
      await addHandler({
        session_id: 1,
        content: 'Bug found here',
        type: 'comment',
      })

      const completeHandler = server.getHandler('complete_review')
      await completeHandler({
        session_id: 1,
        status: 'requested_changes',
      })

      mockClient.getMergeRequest = mock(() =>
        Promise.resolve({
          id: 1,
          iid: 42,
          source_branch: 'feature',
          diff_refs: {
            head_sha: 'head222',
            base_sha: 'base',
            start_sha: 'start',
          },
        }),
      )

      const result = await startHandler({ project_id: 'p', mr_iid: 42 })
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.is_rereview).toBe(true)
      expect(parsed.resumed_existing_session).toBe(false)
      expect(parsed.has_new_commits).toBe(true)
      expect(parsed.session.id).toBe(2)
      expect(parsed.session.status).toBe('in_progress')
      expect(parsed.session.head_sha).toBe('head222')
      expect(parsed.session.previous_head_sha).toBe('head111')
      expect(parsed.previous_session.id).toBe(1)
      expect(parsed.previous_session.status).toBe('requested_changes')
      expect(parsed.previous_review.total_items).toBe(1)
      expect(parsed.previous_review.unresolved_items).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // add_review_comment
  // -----------------------------------------------------------------------

  describe('add_review_comment', () => {
    test('creates discussion on GitLab and tracks in DB', async () => {
      // Start a session first
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('add_review_comment')
      const result = await handler({
        session_id: 1,
        content: 'This variable is unused',
        type: 'comment',
        file_path: 'src/app.ts',
        line_number: 10,
      })

      // Verify GitLab API was called
      expect(mockClient.createMergeRequestDiscussion).toHaveBeenCalled()

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.item.content).toBe('This variable is unused')
      expect(parsed.item.file_path).toBe('src/app.ts')
      expect(parsed.item.type).toBe('comment')
      expect(parsed.gitlab_discussion_id).toBe('disc-new-1')

      // Verify session status changed to pending_changes
      const q = getQueries()
      const session = q.getSessionById(1)
      expect(session!.status).toBe('pending_changes')
    })

    test('formats suggestion with markdown wrapper', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      let capturedBody: string | undefined
      mockClient.createMergeRequestDiscussion = mock(
        async (_pid: string, _iid: number, params: { body: string }) => {
          capturedBody = params.body
          return {
            id: 'disc-sug-1',
            individual_note: false,
            notes: [{ id: 501, body: params.body }],
          }
        },
      )

      const handler = server.getHandler('add_review_comment')
      await handler({
        session_id: 1,
        content: 'const x = 1;',
        type: 'suggestion',
        file_path: 'src/app.ts',
      })

      expect(capturedBody).toContain('```suggestion:-0+0')
      expect(capturedBody).toContain('const x = 1;')
    })

    test('extracts file_path/line_number from position when top-level params absent (BUG-011)', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('add_review_comment')
      const result = await handler({
        session_id: 1,
        content: 'Inline comment via position',
        type: 'comment',
        position: {
          base_sha: 'base000',
          head_sha: 'head111',
          start_sha: 'start000',
          new_path: 'src/index.ts',
          new_line: 7,
        },
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.item.file_path).toBe('src/index.ts')
      expect(parsed.item.line_number).toBe(7)
    })

    test('prefers top-level file_path/line_number over position fields (BUG-011)', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('add_review_comment')
      const result = await handler({
        session_id: 1,
        content: 'Both provided',
        type: 'comment',
        file_path: 'top-level.ts',
        line_number: 99,
        position: {
          base_sha: 'base000',
          head_sha: 'head111',
          start_sha: 'start000',
          new_path: 'position-path.ts',
          new_line: 1,
        },
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.item.file_path).toBe('top-level.ts')
      expect(parsed.item.line_number).toBe(99)
    })

    test('throws when session not found', async () => {
      const handler = server.getHandler('add_review_comment')
      await expect(
        handler({
          session_id: 999,
          content: 'test',
          type: 'comment',
        }),
      ).rejects.toThrow('Review session 999 not found')
    })

    test('throws when session is already completed', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const q = getQueries()
      q.updateSessionStatus(1, 'requested_changes')

      const handler = server.getHandler('add_review_comment')
      await expect(
        handler({
          session_id: 1,
          content: 'new comment',
          type: 'comment',
        }),
      ).rejects.toThrow(
        'Cannot add review comments for review session 1 because it is requested_changes',
      )
    })

    test('builds GitLab position when provided', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      let capturedParams: any
      mockClient.createMergeRequestDiscussion = mock(
        async (_pid: string, _iid: number, params: any) => {
          capturedParams = params
          return {
            id: 'disc-pos-1',
            individual_note: false,
            notes: [{ id: 502, body: params.body }],
          }
        },
      )

      const handler = server.getHandler('add_review_comment')
      await handler({
        session_id: 1,
        content: 'Fix this',
        type: 'comment',
        position: {
          base_sha: 'base000',
          head_sha: 'head111',
          start_sha: 'start000',
          new_path: 'src/app.ts',
          new_line: 42,
        },
      })

      expect(capturedParams.position).toBeDefined()
      expect(capturedParams.position.base_sha).toBe('base000')
      expect(capturedParams.position.new_path).toBe('src/app.ts')
      expect(capturedParams.position.new_line).toBe(42)
      expect(capturedParams.position.position_type).toBe('text')
    })
  })

  // -----------------------------------------------------------------------
  // get_review_status
  // -----------------------------------------------------------------------

  describe('get_review_status', () => {
    test('returns status for active session by mr_iid', async () => {
      // Start a session
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('get_review_status')
      const result = await handler({ project_id: 'p', mr_iid: 42 })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.session).toBeDefined()
      expect(parsed.session.mr_iid).toBe(42)
      expect(parsed.total_items).toBe(0)
      expect(parsed.all_resolved).toBe(true)
    })

    test('returns status for active session by branch', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('get_review_status')
      const result = await handler({
        project_id: 'p',
        branch: 'feature',
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.session).toBeDefined()
      expect(parsed.session.source_branch).toBe('feature')
    })

    test('throws when neither mr_iid nor branch provided', async () => {
      const handler = server.getHandler('get_review_status')
      await expect(handler({ project_id: 'p' })).rejects.toThrow(
        'Either mr_iid or branch must be provided',
      )
    })

    test('returns found=false when no active session', async () => {
      const handler = server.getHandler('get_review_status')
      const result = await handler({ project_id: 'p', mr_iid: 99 })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.found).toBe(false)
    })

    test('falls back to latest completed session by mr_iid', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const addHandler = server.getHandler('add_review_comment')
      await addHandler({
        session_id: 1,
        content: 'Fix this bug',
        type: 'comment',
      })

      const completeHandler = server.getHandler('complete_review')
      await completeHandler({
        session_id: 1,
        status: 'requested_changes',
      })

      const handler = server.getHandler('get_review_status')
      const result = await handler({ project_id: 'p', mr_iid: 42 })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.found).toBe(true)
      expect(parsed.is_active_session).toBe(false)
      expect(parsed.session.status).toBe('requested_changes')
      expect(parsed.total_items).toBe(1)
      expect(parsed.message).toContain('showing latest requested_changes')
    })

    test('includes item details with resolution status', async () => {
      // Start session + add comment
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })
      const addHandler = server.getHandler('add_review_comment')
      await addHandler({
        session_id: 1,
        content: 'Fix this bug',
        type: 'comment',
        file_path: 'src/app.ts',
      })

      const handler = server.getHandler('get_review_status')
      const result = await handler({ project_id: 'p', mr_iid: 42 })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.total_items).toBe(1)
      expect(parsed.items[0].content).toBe('Fix this bug')
      expect(parsed.items[0].file_path).toBe('src/app.ts')
      expect(parsed.items[0].discussion_id).toBe('disc-new-1')
    })
  })

  // -----------------------------------------------------------------------
  // complete_review
  // -----------------------------------------------------------------------

  describe('complete_review', () => {
    test('updates session status (local only, no GitLab actions)', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('complete_review')
      const result = await handler({
        session_id: 1,
        status: 'approved',
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.status).toBe('approved')
      expect(parsed.actions).toEqual([])

      // Verify DB
      const q = getQueries()
      const session = q.getSessionById(1)
      expect(session!.status).toBe('approved')
    })

    test('posts summary comment when provided', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('complete_review')
      const result = await handler({
        session_id: 1,
        status: 'approved',
        summary_comment: 'LGTM, great work!',
      })

      expect(mockClient.createMergeRequestNote).toHaveBeenCalledWith('p', 42, {
        body: 'LGTM, great work!',
      })
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.actions).toContain('summary_comment_posted')
    })

    test('sets labels when provided', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('complete_review')
      const result = await handler({
        session_id: 1,
        status: 'approved',
        labels: ['reviewed', 'ready-to-merge'],
      })

      expect(mockClient.updateMergeRequestLabels).toHaveBeenCalledWith(
        'p',
        42,
        ['reviewed', 'ready-to-merge'],
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.actions).toContain('labels_updated')
    })

    test('approves MR when approve=true and status=approved', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('complete_review')
      const result = await handler({
        session_id: 1,
        status: 'approved',
        approve: true,
      })

      expect(mockClient.approveMergeRequest).toHaveBeenCalledWith('p', 42)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.actions).toContain('mr_approved')
    })

    test('skips approval when approve=true but status is not approved', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('complete_review')
      const result = await handler({
        session_id: 1,
        status: 'closed',
        approve: true,
      })

      expect(mockClient.approveMergeRequest).not.toHaveBeenCalled()
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.approve_skipped).toBe(true)
      expect(parsed.approve_skipped_reason).toContain('closed')
      expect(parsed.actions).not.toContain('mr_approved')
    })

    test('requests changes on GitLab when status=requested_changes', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('complete_review')
      const result = await handler({
        session_id: 1,
        status: 'requested_changes',
        summary_comment: 'Please address the suggested changes.',
      })

      expect(mockClient.requestMergeRequestChanges).toHaveBeenCalledWith(
        'p',
        42,
      )
      expect(mockClient.createMergeRequestNote).toHaveBeenCalledWith('p', 42, {
        body: 'Please address the suggested changes.',
      })
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.status).toBe('requested_changes')
      expect(parsed.actions).toContain('changes_requested')
      expect(parsed.actions).toContain('summary_comment_posted')

      const q = getQueries()
      const session = q.getSessionById(1)
      expect(session!.status).toBe('requested_changes')
    })

    test('keeps local status unchanged when GitLab request changes fails', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })
      mockClient.requestMergeRequestChanges = mock(() =>
        Promise.reject(
          new Error('GitLab request changes failed: Reviewer not found'),
        ),
      )

      const handler = server.getHandler('complete_review')
      await expect(
        handler({
          session_id: 1,
          status: 'requested_changes',
        }),
      ).rejects.toThrow('GitLab request changes failed: Reviewer not found')

      const q = getQueries()
      const session = q.getSessionById(1)
      expect(session!.status).toBe('in_progress')
    })

    test('throws when completing an already completed session', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const q = getQueries()
      q.updateSessionStatus(1, 'requested_changes')

      const handler = server.getHandler('complete_review')
      await expect(
        handler({
          session_id: 1,
          status: 'approved',
        }),
      ).rejects.toThrow(
        'Cannot complete the review for review session 1 because it is requested_changes',
      )
    })

    test('performs all actions together (summary + labels + approve)', async () => {
      const startHandler = server.getHandler('start_review')
      await startHandler({ project_id: 'p', mr_iid: 42 })

      const handler = server.getHandler('complete_review')
      const result = await handler({
        session_id: 1,
        status: 'approved',
        summary_comment: 'All issues resolved. Ship it!',
        labels: ['reviewed'],
        approve: true,
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.actions).toEqual([
        'summary_comment_posted',
        'labels_updated',
        'mr_approved',
      ])
    })

    test('throws when session not found', async () => {
      const handler = server.getHandler('complete_review')
      await expect(
        handler({ session_id: 999, status: 'approved' }),
      ).rejects.toThrow('Review session 999 not found')
    })
  })

  // -----------------------------------------------------------------------
  // Full workflow integration test
  // -----------------------------------------------------------------------

  describe('full review workflow', () => {
    test('start → comment x2 → status → complete — verifies DB state throughout', async () => {
      const start = server.getHandler('start_review')
      const addComment = server.getHandler('add_review_comment')
      const getStatus = server.getHandler('get_review_status')
      const complete = server.getHandler('complete_review')

      // 1. Start review
      const startResult = await start({ project_id: 'p', mr_iid: 42 })
      const startParsed = JSON.parse(startResult.content[0].text)
      expect(startParsed.is_rereview).toBe(false)
      const sessionId = startParsed.session.id

      // 2. Add two comments
      let commentCounter = 0
      mockClient.createMergeRequestDiscussion = mock(async () => {
        commentCounter++
        return {
          id: `disc-wf-${commentCounter}`,
          individual_note: false,
          notes: [{ id: 700 + commentCounter, body: 'comment' }],
        }
      })

      await addComment({
        session_id: sessionId,
        content: 'Bug: null dereference on line 15',
        type: 'comment',
        file_path: 'src/utils.ts',
        line_number: 15,
      })

      await addComment({
        session_id: sessionId,
        content: 'const result = value ?? fallback;',
        type: 'suggestion',
        file_path: 'src/utils.ts',
        line_number: 20,
      })

      // 3. Check status
      const statusResult = await getStatus({ project_id: 'p', mr_iid: 42 })
      const statusParsed = JSON.parse(statusResult.content[0].text)

      expect(statusParsed.total_items).toBe(2)
      expect(statusParsed.unresolved_items).toBe(2)
      expect(statusParsed.items[0].content).toBe(
        'Bug: null dereference on line 15',
      )
      expect(statusParsed.items[1].type).toBe('suggestion')

      // Verify session is pending_changes (set by add_review_comment)
      expect(statusParsed.session.status).toBe('pending_changes')

      // 4. Complete review by formally requesting changes
      const completeResult = await complete({
        session_id: sessionId,
        status: 'requested_changes',
        summary_comment: 'Found 2 issues. Please address before merge.',
        labels: ['needs-changes'],
      })

      const completeParsed = JSON.parse(completeResult.content[0].text)
      expect(completeParsed.success).toBe(true)
      expect(completeParsed.actions).toContain('summary_comment_posted')
      expect(completeParsed.actions).toContain('labels_updated')

      // Verify final DB state
      const q = getQueries()
      const finalSession = q.getSessionById(sessionId)
      expect(finalSession!.status).toBe('requested_changes')
      const items = q.getReviewItemsBySession(sessionId)
      expect(items).toHaveLength(2)
    })
  })
})
