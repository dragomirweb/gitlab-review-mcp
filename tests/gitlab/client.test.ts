import { afterEach, describe, expect, test } from 'bun:test'
import { GitLabClient } from '../../src/gitlab/client'
import { GitLabApiError } from '../../src/gitlab/errors'
import { createTestClient, mockFetchWith, mockResponse } from '../helpers'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitLabClient', () => {
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch

  afterEach(() => {
    process.env = { ...originalEnv }
    globalThis.fetch = originalFetch
  })

  describe('request method (via getMergeRequest)', () => {
    test('builds correct URL with encoded project ID', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse({ id: 1, iid: 42 })
      })

      await client.getMergeRequest('group/project', 42)
      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests/42?include_diverged_commits_count=true',
      )
    })

    test('sends correct auth header (PRIVATE-TOKEN for PAT)', async () => {
      process.env.GITLAB_PAT = 'glpat-secret'
      process.env.GITLAB_BASE_URL = 'https://gl.test'
      const client = new GitLabClient()
      let capturedHeaders: Record<string, string> = {}

      mockFetchWith(async (_url: string, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init?.headers as Record<string, string>) || {}),
        )
        return mockResponse({ id: 1 })
      })

      await client.getMergeRequest('p', 1)
      expect(capturedHeaders['PRIVATE-TOKEN']).toBe('glpat-secret')
      expect(capturedHeaders.Authorization).toBeUndefined()
      expect(capturedHeaders['Content-Type']).toBe('application/json')
    })

    test('throws GitLabApiError on non-OK response', async () => {
      const client = createTestClient()
      mockFetchWith(async () => mockResponse('Not Found', 404, false))

      try {
        await client.getMergeRequest('p', 1)
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(GitLabApiError)
        const apiError = error as GitLabApiError
        expect(apiError.statusCode).toBe(404)
        expect(apiError.errorCode).toBe('not_found')
        expect(apiError.retryable).toBe(false)
        expect(apiError.message).toBe('GitLab API error (404): Not Found')
      }
    })

    test('parses Retry-After header on 429 responses', async () => {
      const client = createTestClient()
      mockFetchWith(async () => {
        return {
          ok: false,
          status: 429,
          headers: new Headers({ 'Retry-After': '60' }),
          text: () => Promise.resolve('Too Many Requests'),
        } as unknown as Response
      })

      try {
        await client.getMergeRequest('p', 1)
        expect(true).toBe(false)
      } catch (error) {
        expect(error).toBeInstanceOf(GitLabApiError)
        const apiError = error as GitLabApiError
        expect(apiError.statusCode).toBe(429)
        expect(apiError.errorCode).toBe('rate_limited')
        expect(apiError.retryable).toBe(true)
        expect(apiError.retryAfterSeconds).toBe(60)
      }
    })

    test('sends JSON body for POST requests', async () => {
      const client = createTestClient()
      let capturedBody: string | undefined

      mockFetchWith(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string
        return mockResponse({ id: 1, body: 'test', notes: [] })
      })

      await client.createMergeRequestDiscussion('p', 1, {
        body: 'test comment',
      })
      expect(capturedBody).toBe(JSON.stringify({ body: 'test comment' }))
    })

    test('does not send body for GET requests', async () => {
      const client = createTestClient()
      let capturedBody: string | undefined | null

      mockFetchWith(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string | undefined
        return mockResponse({ id: 1 })
      })

      await client.getMergeRequest('p', 1)
      expect(capturedBody).toBeUndefined()
    })
  })

  describe('listMergeRequests query building', () => {
    test('builds no query string when no params', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.listMergeRequests('p')
      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/p/merge_requests',
      )
    })

    test('includes state in query string', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.listMergeRequests('p', { state: 'opened' })
      expect(capturedUrl).toContain('state=opened')
    })

    test('joins labels with comma', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.listMergeRequests('p', { labels: ['bug', 'critical'] })
      // URL-encoded comma is %2C
      expect(capturedUrl).toContain('labels=bug%2Ccritical')
    })

    test('includes source_branch in query string', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.listMergeRequests('p', { source_branch: 'feat/new' })
      expect(capturedUrl).toContain('source_branch=feat%2Fnew')
    })

    test('includes pagination params', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.listMergeRequests('p', { page: 3, per_page: 25 })
      expect(capturedUrl).toContain('page=3')
      expect(capturedUrl).toContain('per_page=25')
    })
  })

  describe('getApprovalState (dual-endpoint fallback)', () => {
    test('returns approval_state source on premium success', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        return mockResponse({
          approval_rules_overwritten: false,
          rules: [
            {
              id: 1,
              name: 'Default',
              rule_type: 'regular',
              approvals_required: 1,
              approved: true,
              approved_by: [],
              contains_hidden_groups: false,
            },
          ],
        })
      })

      const result = await client.getApprovalState('p', 1)
      expect(result.source).toBe('approval_state')
      expect((result.data as any).rules).toHaveLength(1)
      expect(callCount).toBe(1)
    })

    test('falls back to approvals on premium failure', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount === 1) {
          return mockResponse('Not Found', 404, false)
        }
        return mockResponse({
          approved: false,
          approvals_required: 2,
          approvals_left: 2,
          approved_by: [],
        })
      })

      const result = await client.getApprovalState('p', 1)
      expect(result.source).toBe('approvals')
      expect((result.data as any).approved).toBe(false)
      expect(callCount).toBe(2)
    })
  })

  describe('resolveBranchToMr', () => {
    test('returns first MR when found', async () => {
      const client = createTestClient()
      const mrData = {
        id: 1,
        iid: 42,
        source_branch: 'feat/x',
        state: 'opened',
      }

      mockFetchWith(async () => mockResponse([mrData]))

      const result = await client.resolveBranchToMr('p', 'feat/x')
      expect(result).not.toBeNull()
      expect(result!.iid).toBe(42)
    })

    test('returns null when no MR found', async () => {
      const client = createTestClient()
      mockFetchWith(async () => mockResponse([]))

      const result = await client.resolveBranchToMr('p', 'no-mr')
      expect(result).toBeNull()
    })
  })

  describe('resolveMergeRequestThread', () => {
    test('sends PUT with resolved flag', async () => {
      const client = createTestClient()
      let capturedUrl = ''
      let capturedMethod = ''
      let capturedBody = ''

      mockFetchWith(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedMethod = init?.method || ''
        capturedBody = init?.body as string
        return mockResponse({ id: 'disc-1', notes: [] })
      })

      await client.resolveMergeRequestThread('p', 1, 'disc-1', true)
      expect(capturedMethod).toBe('PUT')
      expect(capturedUrl).toContain('/discussions/disc-1')
      expect(JSON.parse(capturedBody)).toEqual({ resolved: true })
    })
  })

  describe('getMergeRequestDiffs (paginated)', () => {
    test('returns all diffs from a single page', async () => {
      const client = createTestClient()
      const diffs = [
        {
          diff: '@@ ...',
          new_path: 'a.ts',
          old_path: 'a.ts',
          a_mode: '100644',
          b_mode: '100644',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
          generated_file: false,
          collapsed: false,
          too_large: false,
        },
      ]

      mockFetchWith(async () => mockResponse(diffs))

      const result = await client.getMergeRequestDiffs('p', 1)
      expect(result).toHaveLength(1)
      expect(result[0].new_path).toBe('a.ts')
    })

    test('paginates across multiple pages', async () => {
      const client = createTestClient()
      let callCount = 0

      // First page returns 100 items (full page), second page returns 5 items (last page)
      mockFetchWith(async () => {
        callCount++
        if (callCount === 1) {
          return mockResponse(
            Array.from({ length: 100 }, (_, i) => ({
              diff: `diff-${i}`,
              new_path: `file-${i}.ts`,
              old_path: `file-${i}.ts`,
              a_mode: '100644',
              b_mode: '100644',
              new_file: false,
              renamed_file: false,
              deleted_file: false,
              generated_file: false,
              collapsed: false,
              too_large: false,
            })),
          )
        }
        return mockResponse(
          Array.from({ length: 5 }, (_, i) => ({
            diff: `diff-${100 + i}`,
            new_path: `file-${100 + i}.ts`,
            old_path: `file-${100 + i}.ts`,
            a_mode: '100644',
            b_mode: '100644',
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            generated_file: false,
            collapsed: false,
            too_large: false,
          })),
        )
      })

      const result = await client.getMergeRequestDiffs('p', 1)
      expect(result).toHaveLength(105)
      expect(callCount).toBe(2)
    })

    test('stops at max pages limit', async () => {
      const client = createTestClient()
      let callCount = 0

      // Always return full pages to test the max limit
      mockFetchWith(async () => {
        callCount++
        return mockResponse(
          Array.from({ length: 100 }, (_, i) => ({
            diff: `diff-${i}`,
            new_path: `file-${i}.ts`,
            old_path: `file-${i}.ts`,
            a_mode: '100644',
            b_mode: '100644',
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            generated_file: false,
            collapsed: false,
            too_large: false,
          })),
        )
      })

      const result = await client.getMergeRequestDiffs('p', 1)
      // Default maxPages is 10, so 10 * 100 = 1000 items
      expect(result).toHaveLength(1000)
      expect(callCount).toBe(10)
    })
  })

  describe('label methods send arrays (not comma-separated strings)', () => {
    test('updateMergeRequestLabels sends labels as array', async () => {
      const client = createTestClient()
      let capturedBody = ''

      mockFetchWith(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string
        return mockResponse({ id: 1, iid: 1, labels: ['bug', 'critical'] })
      })

      await client.updateMergeRequestLabels('p', 1, ['bug', 'critical'])
      expect(JSON.parse(capturedBody)).toEqual({ labels: ['bug', 'critical'] })
    })

    test('addMergeRequestLabels sends add_labels as array', async () => {
      const client = createTestClient()
      let capturedBody = ''

      mockFetchWith(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string
        return mockResponse({ id: 1, iid: 1, labels: ['new-label'] })
      })

      await client.addMergeRequestLabels('p', 1, ['new-label'])
      expect(JSON.parse(capturedBody)).toEqual({ add_labels: ['new-label'] })
    })

    test('removeMergeRequestLabels sends remove_labels as array', async () => {
      const client = createTestClient()
      let capturedBody = ''

      mockFetchWith(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string
        return mockResponse({ id: 1, iid: 1, labels: [] })
      })

      await client.removeMergeRequestLabels('p', 1, ['old-label'])
      expect(JSON.parse(capturedBody)).toEqual({
        remove_labels: ['old-label'],
      })
    })
  })

  describe('getMergeRequestDiscussions (paginated)', () => {
    test('paginates across multiple pages', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount === 1) {
          // Full page of 100 discussions
          return mockResponse(
            Array.from({ length: 100 }, (_, i) => ({
              id: `disc-${i}`,
              individual_note: false,
              notes: [{ id: i, body: `note-${i}` }],
            })),
          )
        }
        // Second page with fewer items (last page)
        return mockResponse(
          Array.from({ length: 15 }, (_, i) => ({
            id: `disc-${100 + i}`,
            individual_note: false,
            notes: [{ id: 100 + i, body: `note-${100 + i}` }],
          })),
        )
      })

      const result = await client.getMergeRequestDiscussions('p', 1)
      expect(result).toHaveLength(115)
      expect(callCount).toBe(2)
    })

    test('returns single page when fewer than 100 discussions', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        return mockResponse([
          { id: 'disc-1', individual_note: false, notes: [] },
          { id: 'disc-2', individual_note: true, notes: [] },
        ])
      })

      const result = await client.getMergeRequestDiscussions('p', 1)
      expect(result).toHaveLength(2)
      expect(callCount).toBe(1)
    })

    test('sends per_page=100 in URL', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.getMergeRequestDiscussions('p', 1)
      expect(capturedUrl).toContain('per_page=100')
      expect(capturedUrl).toContain('page=1')
    })
  })

  describe('getMergeRequestDiffs URL verification', () => {
    test('sends per_page=100 and page=1 in first request URL', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.getMergeRequestDiffs('p', 1)
      expect(capturedUrl).toContain('per_page=100')
      expect(capturedUrl).toContain('page=1')
      expect(capturedUrl).toContain('/diffs')
    })
  })

  describe('approveMergeRequest', () => {
    test('sends POST to approve endpoint without body when no sha', async () => {
      const client = createTestClient()
      let capturedUrl = ''
      let capturedMethod = ''
      let capturedBody: string | undefined

      mockFetchWith(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedMethod = init?.method || ''
        capturedBody = init?.body as string | undefined
        return mockResponse({})
      })

      await client.approveMergeRequest('group/project', 42)
      expect(capturedMethod).toBe('POST')
      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests/42/approve',
      )
      expect(capturedBody).toBeUndefined()
    })

    test('sends sha in body when provided', async () => {
      const client = createTestClient()
      let capturedBody = ''

      mockFetchWith(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string
        return mockResponse({})
      })

      await client.approveMergeRequest('p', 1, 'abc123')
      expect(JSON.parse(capturedBody)).toEqual({ sha: 'abc123' })
    })
  })

  describe('unapproveMergeRequest', () => {
    test('sends POST to unapprove endpoint', async () => {
      const client = createTestClient()
      let capturedUrl = ''
      let capturedMethod = ''

      mockFetchWith(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedMethod = init?.method || ''
        return mockResponse({})
      })

      await client.unapproveMergeRequest('group/project', 42)
      expect(capturedMethod).toBe('POST')
      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests/42/unapprove',
      )
    })
  })

  describe('getMergeRequestPipelines', () => {
    test('builds correct paginated URL', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.getMergeRequestPipelines('group/project', 42)
      expect(capturedUrl).toContain(
        '/projects/group%2Fproject/merge_requests/42/pipelines',
      )
      expect(capturedUrl).toContain('per_page=100')
      expect(capturedUrl).toContain('page=1')
    })

    test('returns pipeline objects', async () => {
      const client = createTestClient()
      const pipelineData = [
        {
          id: 1,
          iid: 1,
          sha: 'abc123',
          ref: 'feat/branch',
          status: 'success',
          source: 'push',
          web_url: 'https://gitlab.com/p/-/pipelines/1',
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
        {
          id: 2,
          iid: 2,
          sha: 'def456',
          ref: 'feat/branch',
          status: 'failed',
          source: 'push',
          web_url: 'https://gitlab.com/p/-/pipelines/2',
          created_at: '2024-01-02',
          updated_at: '2024-01-02',
        },
      ]

      mockFetchWith(async () => mockResponse(pipelineData))

      const result = await client.getMergeRequestPipelines('p', 1)
      expect(result).toHaveLength(2)
      expect(result[0].status).toBe('success')
      expect(result[1].status).toBe('failed')
    })
  })

  describe('createMergeRequestDiscussionNote', () => {
    test('sends POST with correct URL and body', async () => {
      const client = createTestClient()
      let capturedUrl = ''
      let capturedMethod = ''
      let capturedBody = ''

      mockFetchWith(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedMethod = init?.method || ''
        capturedBody = init?.body as string
        return mockResponse({
          id: 99,
          type: 'DiscussionNote',
          body: 'My reply',
          author: { id: 1, username: 'bot' },
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
          system: false,
          noteable_id: 1,
          noteable_type: 'MergeRequest',
          resolvable: true,
          resolved: false,
          resolved_by: null,
          confidential: false,
        })
      })

      const result = await client.createMergeRequestDiscussionNote(
        'group/project',
        42,
        'disc-abc',
        'My reply',
      )
      expect(capturedMethod).toBe('POST')
      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests/42/discussions/disc-abc/notes',
      )
      expect(JSON.parse(capturedBody)).toEqual({ body: 'My reply' })
      expect(result.id).toBe(99)
      expect(result.body).toBe('My reply')
    })
  })

  describe('compareCommits', () => {
    test('builds correct URL with from and to params', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse({
          commit: null,
          commits: [],
          diffs: [],
          compare_timeout: false,
          compare_same_ref: false,
        })
      })

      await client.compareCommits('group/project', 'sha-old', 'sha-new')
      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fproject/repository/compare?from=sha-old&to=sha-new',
      )
    })

    test('returns compare result with commits and diffs', async () => {
      const client = createTestClient()
      const compareData = {
        commit: {
          id: 'sha-new',
          short_id: 'sha-ne',
          title: 'latest',
          author_name: 'dev',
          author_email: 'd@e.v',
          created_at: '2024-01-01',
        },
        commits: [
          {
            id: 'sha-new',
            short_id: 'sha-ne',
            title: 'latest',
            author_name: 'dev',
            author_email: 'd@e.v',
            created_at: '2024-01-01',
          },
        ],
        diffs: [
          {
            diff: '@@ ...',
            new_path: 'a.ts',
            old_path: 'a.ts',
            a_mode: '100644',
            b_mode: '100644',
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            generated_file: false,
            collapsed: false,
            too_large: false,
          },
        ],
        compare_timeout: false,
        compare_same_ref: false,
      }

      mockFetchWith(async () => mockResponse(compareData))

      const result = await client.compareCommits('p', 'sha-old', 'sha-new')
      expect(result.commits).toHaveLength(1)
      expect(result.diffs).toHaveLength(1)
      expect(result.compare_timeout).toBe(false)
      expect(result.compare_same_ref).toBe(false)
    })

    test('handles compare_timeout flag', async () => {
      const client = createTestClient()

      mockFetchWith(async () =>
        mockResponse({
          commit: null,
          commits: [],
          diffs: [],
          compare_timeout: true,
          compare_same_ref: false,
        }),
      )

      const result = await client.compareCommits('p', 'a', 'b')
      expect(result.compare_timeout).toBe(true)
    })
  })

  describe('getRepositoryFile', () => {
    test('builds correct URL with encoded file path and ref', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse({
          file_name: 'index.ts',
          file_path: 'src/index.ts',
          size: 100,
          encoding: 'base64',
          content: btoa("console.log('hello')"),
          ref: 'main',
          blob_id: 'abc123',
          commit_id: 'def456',
        })
      })

      await client.getRepositoryFile('group/project', 'src/index.ts', 'main')
      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fproject/repository/files/src%2Findex.ts?ref=main',
      )
    })

    test('encodes special characters in ref', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse({
          file_name: 'file.ts',
          file_path: 'file.ts',
          size: 50,
          encoding: 'base64',
          content: btoa('test'),
          ref: 'feat/my-branch',
          blob_id: 'a',
          commit_id: 'b',
        })
      })

      await client.getRepositoryFile('p', 'file.ts', 'feat/my-branch')
      expect(capturedUrl).toContain('ref=feat%2Fmy-branch')
    })

    test('returns GitLabRepositoryFile object', async () => {
      const client = createTestClient()
      const fileData = {
        file_name: 'index.ts',
        file_path: 'src/index.ts',
        size: 42,
        encoding: 'base64',
        content: btoa('hello world'),
        ref: 'main',
        blob_id: 'abc',
        commit_id: 'def',
      }

      mockFetchWith(async () => mockResponse(fileData))

      const result = await client.getRepositoryFile('p', 'src/index.ts', 'main')
      expect(result.file_name).toBe('index.ts')
      expect(result.file_path).toBe('src/index.ts')
      expect(result.size).toBe(42)
      expect(result.encoding).toBe('base64')
    })
  })

  describe('encodeProjectId', () => {
    test('encodes slashes in project paths', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.getProjectLabels('my-group/my-project')
      expect(capturedUrl).toContain('my-group%2Fmy-project')
    })

    test('handles already numeric project IDs', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.getProjectLabels('12345')
      expect(capturedUrl).toContain('/projects/12345/')
    })
  })

  describe('validateAuth', () => {
    test('returns user info on success', async () => {
      const client = createTestClient()
      mockFetchWith(async () =>
        mockResponse({ id: 42, username: 'review-bot' }),
      )

      const user = await client.validateAuth()
      expect(user.id).toBe(42)
      expect(user.username).toBe('review-bot')
    })

    test('calls GET /user endpoint', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse({ id: 1, username: 'bot' })
      })

      await client.validateAuth()
      expect(capturedUrl).toBe('https://gitlab.example.com/api/v4/user')
    })

    test('throws GitLabApiError on 401 (invalid token)', async () => {
      const client = createTestClient()
      mockFetchWith(async () =>
        mockResponse('{"message":"401 Unauthorized"}', 401, false),
      )

      try {
        await client.validateAuth()
        expect(true).toBe(false) // Should not reach
      } catch (error) {
        expect(error).toBeInstanceOf(GitLabApiError)
        const apiError = error as GitLabApiError
        expect(apiError.statusCode).toBe(401)
        expect(apiError.errorCode).toBe('auth_failed')
        expect(apiError.retryable).toBe(false)
      }
    })

    test('retries on transient 502 then succeeds', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount === 1) {
          return {
            ok: false,
            status: 502,
            headers: new Headers(),
            text: () => Promise.resolve('Bad Gateway'),
          } as unknown as Response
        }
        return mockResponse({ id: 1, username: 'bot' })
      })

      const user = await client.validateAuth()
      expect(user.username).toBe('bot')
      expect(callCount).toBe(2)
    })
  })

  describe('retry behavior', () => {
    test('retries on 429 and succeeds on second attempt', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            headers: new Headers(),
            text: () => Promise.resolve('Too Many Requests'),
          } as unknown as Response
        }
        return mockResponse({ id: 1, iid: 42 })
      })

      const result = await client.getMergeRequest('p', 42)
      expect(result.id).toBe(1)
      expect(result.iid).toBe(42)
      expect(callCount).toBe(2)
      expect(client.sleepCalls).toHaveLength(1)
      // First retry: 2^0 * 1000 = 1000ms
      expect(client.sleepCalls[0]).toBe(1000)
    })

    test('retries on 502 and succeeds on third attempt', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount <= 2) {
          return {
            ok: false,
            status: 502,
            headers: new Headers(),
            text: () => Promise.resolve('Bad Gateway'),
          } as unknown as Response
        }
        return mockResponse({ id: 1 })
      })

      const result = await client.getMergeRequest('p', 1)
      expect(result.id).toBe(1)
      expect(callCount).toBe(3)
      expect(client.sleepCalls).toEqual([1000, 2000]) // 2^0*1000, 2^1*1000
    })

    test('retries on 503', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount === 1) {
          return {
            ok: false,
            status: 503,
            headers: new Headers(),
            text: () => Promise.resolve('Service Unavailable'),
          } as unknown as Response
        }
        return mockResponse({ id: 1 })
      })

      await client.getMergeRequest('p', 1)
      expect(callCount).toBe(2)
    })

    test('retries on 504', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount === 1) {
          return {
            ok: false,
            status: 504,
            headers: new Headers(),
            text: () => Promise.resolve('Gateway Timeout'),
          } as unknown as Response
        }
        return mockResponse({ id: 1 })
      })

      await client.getMergeRequest('p', 1)
      expect(callCount).toBe(2)
    })

    test('respects Retry-After header on 429', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            headers: new Headers({ 'Retry-After': '5' }),
            text: () => Promise.resolve('Too Many Requests'),
          } as unknown as Response
        }
        return mockResponse({ id: 1 })
      })

      await client.getMergeRequest('p', 1)
      expect(callCount).toBe(2)
      // Should use Retry-After value (5s = 5000ms) instead of exponential backoff
      expect(client.sleepCalls[0]).toBe(5000)
    })

    test('does NOT retry on 404', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          text: () => Promise.resolve('Not Found'),
        } as unknown as Response
      })

      await expect(client.getMergeRequest('p', 1)).rejects.toThrow(
        GitLabApiError,
      )
      expect(callCount).toBe(1)
      expect(client.sleepCalls).toHaveLength(0)
    })

    test('does NOT retry on 401', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        return {
          ok: false,
          status: 401,
          headers: new Headers(),
          text: () => Promise.resolve('Unauthorized'),
        } as unknown as Response
      })

      await expect(client.getMergeRequest('p', 1)).rejects.toThrow(
        GitLabApiError,
      )
      expect(callCount).toBe(1)
    })

    test('does NOT retry on 422', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        return {
          ok: false,
          status: 422,
          headers: new Headers(),
          text: () => Promise.resolve('Unprocessable Entity'),
        } as unknown as Response
      })

      await expect(client.getMergeRequest('p', 1)).rejects.toThrow(
        GitLabApiError,
      )
      expect(callCount).toBe(1)
    })

    test('gives up after max retries and throws the last error', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        return {
          ok: false,
          status: 502,
          headers: new Headers(),
          text: () => Promise.resolve('Bad Gateway'),
        } as unknown as Response
      })

      try {
        await client.getMergeRequest('p', 1)
        expect(true).toBe(false) // Should not reach
      } catch (error) {
        expect(error).toBeInstanceOf(GitLabApiError)
        const apiError = error as GitLabApiError
        expect(apiError.statusCode).toBe(502)
      }
      // 1 initial + 3 retries = 4 total calls
      expect(callCount).toBe(4)
      // 3 sleep calls (before each retry)
      expect(client.sleepCalls).toEqual([1000, 2000, 4000])
    })

    test('uses exponential backoff delays: 1s, 2s, 4s', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        if (callCount <= 3) {
          return {
            ok: false,
            status: 503,
            headers: new Headers(),
            text: () => Promise.resolve('Service Unavailable'),
          } as unknown as Response
        }
        return mockResponse({ id: 1 })
      })

      await client.getMergeRequest('p', 1)
      expect(client.sleepCalls).toEqual([1000, 2000, 4000])
    })

    test('retries work within paginated requests', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        // First call (page 1) returns 502, second call (page 1 retry) succeeds
        if (callCount === 1) {
          return {
            ok: false,
            status: 502,
            headers: new Headers(),
            text: () => Promise.resolve('Bad Gateway'),
          } as unknown as Response
        }
        // Return a partial page to stop pagination
        return mockResponse([
          {
            diff: 'diff',
            new_path: 'a.ts',
            old_path: 'a.ts',
            a_mode: '100644',
            b_mode: '100644',
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            generated_file: false,
            collapsed: false,
            too_large: false,
          },
        ])
      })

      const result = await client.getMergeRequestDiffs('p', 1)
      expect(result).toHaveLength(1)
      expect(callCount).toBe(2)
      expect(client.sleepCalls).toHaveLength(1)
    })

    test('does not retry non-GitLabApiError errors (e.g. network failures)', async () => {
      const client = createTestClient()
      let callCount = 0

      mockFetchWith(async () => {
        callCount++
        throw new TypeError('Failed to fetch')
      })

      await expect(client.getMergeRequest('p', 1)).rejects.toThrow(TypeError)
      expect(callCount).toBe(1)
      expect(client.sleepCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // createMergeRequestNote
  // -------------------------------------------------------------------------

  describe('createMergeRequestNote', () => {
    test('sends POST to notes endpoint with body', async () => {
      const client = createTestClient()
      let capturedUrl = ''
      let capturedBody: unknown

      mockFetchWith(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined
        return mockResponse({
          id: 100,
          body: 'Great work!',
          author: { id: 1, username: 'bot' },
        })
      })

      const result = await client.createMergeRequestNote('group/project', 42, {
        body: 'Great work!',
      })

      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests/42/notes',
      )
      expect(capturedBody).toEqual({ body: 'Great work!' })
      expect(result.id).toBe(100)
      expect(result.body).toBe('Great work!')
    })

    test('encodes project ID in URL', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse({ id: 1, body: 'note' })
      })

      await client.createMergeRequestNote('my/nested/project', 5, {
        body: 'note',
      })

      expect(capturedUrl).toContain('my%2Fnested%2Fproject')
    })
  })

  // -------------------------------------------------------------------------
  // getProject
  // -------------------------------------------------------------------------

  describe('getProject', () => {
    test('builds correct URL with encoded project ID', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse({
          id: 10,
          name: 'my-project',
          path_with_namespace: 'group/my-project',
          merge_method: 'merge',
          web_url: 'https://gitlab.example.com/group/my-project',
        })
      })

      const result = await client.getProject('group/my-project')

      expect(capturedUrl).toBe(
        'https://gitlab.example.com/api/v4/projects/group%2Fmy-project',
      )
      expect(result.id).toBe(10)
      expect(result.name).toBe('my-project')
      expect(result.merge_method).toBe('merge')
    })

    test('returns project object with merge_method field', async () => {
      const client = createTestClient()

      mockFetchWith(async () =>
        mockResponse({
          id: 20,
          name: 'rebase-proj',
          path_with_namespace: 'org/rebase-proj',
          merge_method: 'rebase_merge',
          web_url: 'https://gitlab.example.com/org/rebase-proj',
        }),
      )

      const result = await client.getProject('org/rebase-proj')
      expect(result.merge_method).toBe('rebase_merge')
    })
  })

  // -------------------------------------------------------------------------
  // getDeployments
  // -------------------------------------------------------------------------

  describe('getDeployments', () => {
    test('builds correct URL with sha and query params', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([
          {
            id: 1,
            iid: 1,
            sha: 'abc123',
            status: 'success',
            environment: { id: 1, name: 'production' },
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ])
      })

      await client.getDeployments('group/project', 'abc123')

      expect(capturedUrl).toContain('group%2Fproject/deployments')
      expect(capturedUrl).toContain('sha=abc123')
      expect(capturedUrl).toContain('order_by=created_at')
      expect(capturedUrl).toContain('sort=desc')
      expect(capturedUrl).toContain('per_page=100')
    })

    test('returns deployment objects matching sha', async () => {
      const client = createTestClient()
      const deployment = {
        id: 5,
        iid: 5,
        sha: 'def456',
        status: 'success',
        environment: { id: 2, name: 'staging' },
        created_at: '2024-01-02T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }

      mockFetchWith(async () => mockResponse([deployment]))

      const result = await client.getDeployments('p', 'def456')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(5)
      expect(result[0].environment.name).toBe('staging')
    })

    test('filters out deployments with non-matching sha client-side', async () => {
      const client = createTestClient()

      mockFetchWith(async () =>
        mockResponse([
          {
            id: 1,
            iid: 1,
            sha: 'abc123',
            status: 'success',
            environment: { id: 1, name: 'prod' },
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
          {
            id: 2,
            iid: 2,
            sha: 'wrong-sha',
            status: 'success',
            environment: { id: 1, name: 'prod' },
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ]),
      )

      const result = await client.getDeployments('p', 'abc123')
      expect(result).toHaveLength(1)
      expect(result[0].sha).toBe('abc123')
    })

    test('returns empty array when no deployments match sha', async () => {
      const client = createTestClient()
      mockFetchWith(async () => mockResponse([]))

      const result = await client.getDeployments('p', 'no-match')
      expect(result).toHaveLength(0)
    })

    test('accepts custom perPage parameter', async () => {
      const client = createTestClient()
      let capturedUrl = ''

      mockFetchWith(async (url: string) => {
        capturedUrl = url
        return mockResponse([])
      })

      await client.getDeployments('p', 'abc123', 25)
      expect(capturedUrl).toContain('per_page=25')
    })
  })

  // -------------------------------------------------------------------------
  // paginatedGet truncation warning (BUG-008)
  // -------------------------------------------------------------------------

  describe('paginatedGet truncation warning (BUG-008)', () => {
    test('logs warning when maxPages is reached and last page is full', async () => {
      const client = createTestClient()

      // Capture stderr to detect logger.warn output
      const stderrChunks: string[] = []
      const originalWrite = process.stderr.write
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk),
        )
        return true
      }) as typeof process.stderr.write

      try {
        // Always return full pages (100 items) — triggers truncation
        mockFetchWith(async () =>
          mockResponse(
            Array.from({ length: 100 }, (_, i) => ({
              diff: `diff-${i}`,
              new_path: `file-${i}.ts`,
              old_path: `file-${i}.ts`,
              a_mode: '100644',
              b_mode: '100644',
              new_file: false,
              renamed_file: false,
              deleted_file: false,
              generated_file: false,
              collapsed: false,
              too_large: false,
            })),
          ),
        )

        await client.getMergeRequestDiffs('p', 1)

        // Check that a truncation warning was logged
        const warningLine = stderrChunks.find((line) =>
          line.includes('truncated'),
        )
        expect(warningLine).toBeDefined()
        const parsed = JSON.parse(warningLine!)
        expect(parsed.level).toBe('warning')
        expect(parsed.message).toContain('truncated')
        expect(parsed.maxPages).toBe(10)
        expect(parsed.totalFetched).toBe(1000)
      } finally {
        process.stderr.write = originalWrite
      }
    })

    test('does not log warning when last page is partial (no truncation)', async () => {
      const client = createTestClient()

      const stderrChunks: string[] = []
      const originalWrite = process.stderr.write
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk),
        )
        return true
      }) as typeof process.stderr.write

      try {
        // Return a single partial page — no truncation
        mockFetchWith(async () =>
          mockResponse(
            Array.from({ length: 5 }, (_, i) => ({
              diff: `diff-${i}`,
              new_path: `file-${i}.ts`,
              old_path: `file-${i}.ts`,
              a_mode: '100644',
              b_mode: '100644',
              new_file: false,
              renamed_file: false,
              deleted_file: false,
              generated_file: false,
              collapsed: false,
              too_large: false,
            })),
          ),
        )

        await client.getMergeRequestDiffs('p', 1)

        const warningLine = stderrChunks.find((line) =>
          line.includes('truncated'),
        )
        expect(warningLine).toBeUndefined()
      } finally {
        process.stderr.write = originalWrite
      }
    })
  })

  // -------------------------------------------------------------------------
  // resetGitLabClient (BUG-010)
  // -------------------------------------------------------------------------

  describe('resetGitLabClient (BUG-010)', () => {
    test('resetGitLabClient is exported as a function', () => {
      // Verify the export exists (actual singleton behavior tested in dedicated file)
      const mod = require('../../src/gitlab/client')
      expect(typeof mod.resetGitLabClient).toBe('function')
    })
  })
})
