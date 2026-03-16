/**
 * Integration tests for MR tool handlers in src/tools/merge-requests.ts.
 *
 * Uses a mock McpServer to capture handler callbacks and mocks
 * getGitLabClient() / getQueries() to control dependencies.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { closeDatabase, getQueries, initDatabase } from '../../src/db'
import type { MockMcpServer } from '../helpers'
import { createMockMcpServer } from '../helpers'

// ---------------------------------------------------------------------------
// Mock the GitLab client and DB modules
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
        labels: ['bug'],
      }),
    ),
    getMergeRequestDiffs: mock(() =>
      Promise.resolve([
        {
          diff: '--- a/src/app.ts\n+++ b/src/app.ts',
          new_path: 'src/app.ts',
          old_path: 'src/app.ts',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
          generated_file: false,
          collapsed: false,
          too_large: false,
        },
        {
          diff: '--- a/package-lock.json\n+++ b/package-lock.json',
          new_path: 'package-lock.json',
          old_path: 'package-lock.json',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
          generated_file: true,
          collapsed: false,
          too_large: false,
        },
        {
          diff: '--- a/test/spec.ts\n+++ b/test/spec.ts',
          new_path: 'test/spec.ts',
          old_path: 'test/spec.ts',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
          generated_file: false,
          collapsed: false,
          too_large: false,
        },
      ]),
    ),
    getMergeRequestDiscussions: mock(() =>
      Promise.resolve([{ id: 'disc-1', individual_note: false, notes: [] }]),
    ),
    getMergeRequestCommits: mock(() =>
      Promise.resolve([
        { id: 'abc123', short_id: 'abc1', title: 'commit 1' },
        { id: 'def456', short_id: 'def4', title: 'commit 2' },
      ]),
    ),
    getMergeRequestPipelines: mock(() =>
      Promise.resolve([
        {
          id: 10,
          sha: 'head111',
          ref: 'feature',
          status: 'success',
          web_url: 'https://gitlab.example.com/pipelines/10',
        },
      ]),
    ),
    getRepositoryFile: mock(() =>
      Promise.resolve({
        file_path: 'src/app.ts',
        ref: 'feature',
        size: 100,
        encoding: 'base64',
        content: Buffer.from("console.log('hello')").toString('base64'),
      }),
    ),
    compareCommits: mock(() =>
      Promise.resolve({
        commits: [{ id: 'new123', short_id: 'new1', title: 'new commit' }],
        diffs: [{ new_path: 'src/changed.ts', old_path: 'src/changed.ts' }],
        compare_timeout: false,
      }),
    ),
    resolveMergeRequestThread: mock(() =>
      Promise.resolve({ id: 'disc-1', notes: [] }),
    ),
    createMergeRequestNote: mock(() =>
      Promise.resolve({ id: 200, body: 'note body' }),
    ),
    createMergeRequestDiscussionNote: mock(() =>
      Promise.resolve({ id: 201, body: 'reply body' }),
    ),
    approveMergeRequest: mock(() => Promise.resolve({})),
    unapproveMergeRequest: mock(() => Promise.resolve({})),
    resolveBranchToMr: mock(() =>
      Promise.resolve({ iid: 42, source_branch: 'feature' }),
    ),
    getApprovalState: mock(() =>
      Promise.resolve({
        data: { rules: [] },
        source: 'approval_state',
      }),
    ),
    getProject: mock(() =>
      Promise.resolve({
        id: 10,
        name: 'project',
        path_with_namespace: 'group/project',
        merge_method: 'merge' as const,
        web_url: 'https://gitlab.example.com/group/project',
      }),
    ),
    getDeployments: mock(() => Promise.resolve([])),
  }
}

mock.module('../../src/gitlab/client', () => ({
  getGitLabClient: () => mockClient,
}))

// Note: We don't mock ../../src/db — we use the real module's initDatabase/closeDatabase
// and createTestDb for isolated DB instances where needed.

// Import AFTER mocking
const { registerMergeRequestTools } = await import(
  '../../src/tools/merge-requests'
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MR tool handlers', () => {
  let server: MockMcpServer

  beforeEach(() => {
    resetMockClient()
    // Use the real DB module singleton so get_mr_changes_since can call getQueries()
    closeDatabase()
    initDatabase(':memory:')
    server = createMockMcpServer()
    registerMergeRequestTools(server as any)
  })

  afterEach(() => {
    closeDatabase()
  })

  test('registerMergeRequestTools registers all 13 tools', () => {
    const names = server.toolNames()
    expect(names).toContain('get_merge_request')
    expect(names).toContain('get_mr_diff')
    expect(names).toContain('get_mr_discussions')
    expect(names).toContain('get_mr_commits')
    expect(names).toContain('get_mr_changes_since')
    expect(names).toContain('get_mr_file_content')
    expect(names).toContain('get_mr_pipelines')
    expect(names).toContain('list_merge_requests')
    expect(names).toContain('resolve_merge_request_thread')
    expect(names).toContain('create_merge_request_note')
    expect(names).toContain('create_mr_discussion_reply')
    expect(names).toContain('approve_merge_request')
    expect(names).toContain('unapprove_merge_request')
    expect(names).toHaveLength(13)
  })

  // -----------------------------------------------------------------------
  // get_merge_request — enrichments
  // -----------------------------------------------------------------------

  describe('get_merge_request', () => {
    test('returns enriched MR with approval, commit, and deployment summaries', async () => {
      const handler = server.getHandler('get_merge_request')
      const result = await handler({
        project_id: 'group/project',
        mr_iid: 42,
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.iid).toBe(42)
      expect(parsed.title).toBe('Test MR')
      expect(parsed.approval_summary).toBeDefined()
      expect(parsed.approval_summary.available).toBe(true)
      expect(parsed.commit_addition_summary).toBeDefined()
      expect(parsed.commit_addition_summary.available).toBe(true)
      expect(parsed.deployment_summary).toBeDefined()
      expect(parsed.deployment_summary.available).toBe(true)
    })

    test('gracefully handles enrichment failures', async () => {
      // Make approval fail
      mockClient.getApprovalState = mock(() =>
        Promise.reject(new Error('Premium only')),
      )

      const handler = server.getHandler('get_merge_request')
      const result = await handler({
        project_id: 'group/project',
        mr_iid: 42,
      })

      const parsed = JSON.parse(result.content[0].text)
      // MR itself should still be returned
      expect(parsed.iid).toBe(42)
      // Failed enrichment should show unavailable
      expect(parsed.approval_summary.available).toBe(false)
      expect(parsed.approval_summary.unavailable_reason).toContain(
        'Premium only',
      )
      // Other enrichments should still succeed
      expect(parsed.commit_addition_summary.available).toBe(true)
    })

    test('resolves branch to MR iid via resolveBranchToMr', async () => {
      const handler = server.getHandler('get_merge_request')
      await handler({
        project_id: 'group/project',
        source_branch: 'feature',
      })

      expect(mockClient.resolveBranchToMr).toHaveBeenCalledWith(
        'group/project',
        'feature',
      )
    })
  })

  // -----------------------------------------------------------------------
  // get_mr_diff — filtering logic
  // -----------------------------------------------------------------------

  describe('get_mr_diff', () => {
    test('filters out generated files by default', async () => {
      const handler = server.getHandler('get_mr_diff')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveLength(2) // package-lock.json excluded
      expect(parsed.every((d: any) => !d.generated_file)).toBe(true)
    })

    test('includes generated files when include_generated=true', async () => {
      const handler = server.getHandler('get_mr_diff')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        include_generated: true,
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveLength(3)
    })

    test('filters files matching excluded_file_patterns', async () => {
      const handler = server.getHandler('get_mr_diff')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        include_generated: true,
        excluded_file_patterns: ['^test/', 'package-lock'],
      })

      const parsed = JSON.parse(result.content[0].text)
      // test/spec.ts and package-lock.json should be excluded
      expect(parsed).toHaveLength(1)
      expect(parsed[0].new_path).toBe('src/app.ts')
    })

    test('matches exclusion pattern against both new_path and old_path', async () => {
      // Add a renamed file to test old_path matching
      mockClient.getMergeRequestDiffs = mock(() =>
        Promise.resolve([
          {
            diff: 'rename',
            new_path: 'src/new-name.ts',
            old_path: 'legacy/old-name.ts',
            new_file: false,
            renamed_file: true,
            deleted_file: false,
            generated_file: false,
            collapsed: false,
            too_large: false,
          },
        ]),
      )

      const handler = server.getHandler('get_mr_diff')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        include_generated: true,
        excluded_file_patterns: ['^legacy/'],
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveLength(0) // old_path matches pattern
    })
  })

  // -----------------------------------------------------------------------
  // get_mr_discussions
  // -----------------------------------------------------------------------

  describe('get_mr_discussions', () => {
    test('returns discussions from client', async () => {
      const handler = server.getHandler('get_mr_discussions')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].id).toBe('disc-1')
    })
  })

  // -----------------------------------------------------------------------
  // get_mr_commits
  // -----------------------------------------------------------------------

  describe('get_mr_commits', () => {
    test('returns commits from client', async () => {
      const handler = server.getHandler('get_mr_commits')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveLength(2)
      expect(parsed[0].title).toBe('commit 1')
    })
  })

  // -----------------------------------------------------------------------
  // get_mr_file_content — base64 decoding
  // -----------------------------------------------------------------------

  describe('get_mr_file_content', () => {
    test('decodes base64 content', async () => {
      const handler = server.getHandler('get_mr_file_content')
      const result = await handler({
        project_id: 'p',
        file_path: 'src/app.ts',
        ref: 'feature',
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.content).toBe("console.log('hello')")
      expect(parsed.file_path).toBe('src/app.ts')
      expect(parsed.ref).toBe('feature')
      expect(parsed.size).toBe(100)
    })

    test('passes through non-base64 content unchanged', async () => {
      mockClient.getRepositoryFile = mock(() =>
        Promise.resolve({
          file_path: 'readme.md',
          ref: 'main',
          size: 5,
          encoding: 'text',
          content: 'hello',
        }),
      )

      const handler = server.getHandler('get_mr_file_content')
      const result = await handler({
        project_id: 'p',
        file_path: 'readme.md',
        ref: 'main',
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.content).toBe('hello')
    })
  })

  // -----------------------------------------------------------------------
  // get_mr_pipelines
  // -----------------------------------------------------------------------

  describe('get_mr_pipelines', () => {
    test('returns pipelines from client', async () => {
      const handler = server.getHandler('get_mr_pipelines')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].status).toBe('success')
    })
  })

  // -----------------------------------------------------------------------
  // get_mr_changes_since — complex control flow
  // -----------------------------------------------------------------------

  describe('get_mr_changes_since', () => {
    test('uses explicit since_sha to compare', async () => {
      const handler = server.getHandler('get_mr_changes_since')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        since_sha: 'oldsha111',
      })

      expect(mockClient.compareCommits).toHaveBeenCalledWith(
        'p',
        'oldsha111',
        'head111',
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.since_sha).toBe('oldsha111')
      expect(parsed.head_sha).toBe('head111')
      expect(parsed.commits).toHaveLength(1)
      expect(parsed.diffs).toHaveLength(1)
    })

    test('auto-resolves since_sha from active review session', async () => {
      // Create a session with previous_head_sha set
      const q = getQueries()
      const session = q.createSession({
        mr_iid: 42,
        project_id: 'p',
        source_branch: 'feature',
        head_sha: 'old-head',
      })
      q.updateSessionHeadSha(session.id, 'head111')
      // Now previous_head_sha = "old-head"

      const handler = server.getHandler('get_mr_changes_since')
      await handler({
        project_id: 'p',
        mr_iid: 42,
        // no since_sha — should auto-resolve
      })

      expect(mockClient.compareCommits).toHaveBeenCalledWith(
        'p',
        'old-head',
        'head111',
      )
    })

    test('early-exits when since_sha equals current head', async () => {
      const handler = server.getHandler('get_mr_changes_since')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        since_sha: 'head111', // Same as current head
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.commits).toHaveLength(0)
      expect(parsed.diffs).toHaveLength(0)
      expect(parsed.message).toContain('No changes')
      // compareCommits should NOT have been called
      expect(mockClient.compareCommits).not.toHaveBeenCalled()
    })

    test('throws when no since_sha and no session with previous SHA', async () => {
      const handler = server.getHandler('get_mr_changes_since')
      await expect(handler({ project_id: 'p', mr_iid: 42 })).rejects.toThrow(
        'No since_sha provided',
      )
    })

    test('throws when MR has no head_sha in diff_refs', async () => {
      mockClient.getMergeRequest = mock(() =>
        Promise.resolve({
          id: 1,
          iid: 42,
          diff_refs: null,
        }),
      )

      const handler = server.getHandler('get_mr_changes_since')
      await expect(
        handler({ project_id: 'p', mr_iid: 42, since_sha: 'abc' }),
      ).rejects.toThrow('Cannot determine current HEAD SHA')
    })
  })

  // -----------------------------------------------------------------------
  // resolve_merge_request_thread
  // -----------------------------------------------------------------------

  describe('resolve_merge_request_thread', () => {
    test('calls client and returns success', async () => {
      const handler = server.getHandler('resolve_merge_request_thread')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        discussion_id: 'disc-1',
        resolved: true,
      })

      expect(mockClient.resolveMergeRequestThread).toHaveBeenCalledWith(
        'p',
        42,
        'disc-1',
        true,
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.resolved).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // create_merge_request_note
  // -----------------------------------------------------------------------

  describe('create_merge_request_note', () => {
    test('posts note and returns note_id', async () => {
      const handler = server.getHandler('create_merge_request_note')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        body: 'LGTM!',
      })

      expect(mockClient.createMergeRequestNote).toHaveBeenCalledWith('p', 42, {
        body: 'LGTM!',
      })
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.note_id).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // create_mr_discussion_reply
  // -----------------------------------------------------------------------

  describe('create_mr_discussion_reply', () => {
    test('posts reply with correct params', async () => {
      const handler = server.getHandler('create_mr_discussion_reply')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        discussion_id: 'disc-1',
        body: 'Thanks for the feedback!',
      })

      expect(mockClient.createMergeRequestDiscussionNote).toHaveBeenCalledWith(
        'p',
        42,
        'disc-1',
        'Thanks for the feedback!',
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.note_id).toBe(201)
      expect(parsed.discussion_id).toBe('disc-1')
    })
  })

  // -----------------------------------------------------------------------
  // approve / unapprove
  // -----------------------------------------------------------------------

  describe('approve_merge_request', () => {
    test('calls client.approveMergeRequest without sha', async () => {
      const handler = server.getHandler('approve_merge_request')
      const result = await handler({ project_id: 'p', mr_iid: 42 })

      expect(mockClient.approveMergeRequest).toHaveBeenCalledWith(
        'p',
        42,
        undefined,
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.message).toContain('!42 approved')
    })

    test('passes sha when provided', async () => {
      const handler = server.getHandler('approve_merge_request')
      await handler({ project_id: 'p', mr_iid: 42, sha: 'abc123' })

      expect(mockClient.approveMergeRequest).toHaveBeenCalledWith(
        'p',
        42,
        'abc123',
      )
    })
  })

  describe('unapprove_merge_request', () => {
    test('calls client.unapproveMergeRequest', async () => {
      const handler = server.getHandler('unapprove_merge_request')
      const result = await handler({ project_id: 'p', mr_iid: 42 })

      expect(mockClient.unapproveMergeRequest).toHaveBeenCalledWith('p', 42)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.message).toContain('!42')
    })
  })
})
