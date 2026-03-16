import { describe, expect, mock, test } from 'bun:test'
import type { GitLabClient } from '../../src/gitlab/client'
import type {
  GitLabApprovalState,
  GitLabApprovals,
  GitLabCommit,
  GitLabDeployment,
  GitLabMergeRequest,
} from '../../src/gitlab/types'
import {
  buildApprovalSummary,
  buildCommitSummary,
  buildDeploymentSummary,
  resolveMrIid,
  safeEnrich,
} from '../../src/tools/merge-requests'

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function mockClient(overrides: Partial<GitLabClient> = {}): GitLabClient {
  return {
    resolveBranchToMr: mock(async () => null),
    getMergeRequestCommits: mock(async () => []),
    getApprovalState: mock(async () => ({
      data: {
        approved: false,
        approvals_required: 0,
        approvals_left: 0,
        approved_by: [],
        user_has_approved: false,
        user_can_approve: false,
      } as GitLabApprovals,
      source: 'approvals' as const,
    })),
    getDeployments: mock(async () => []),
    ...overrides,
  } as unknown as GitLabClient
}

// ---------------------------------------------------------------------------
// resolveMrIid
// ---------------------------------------------------------------------------

describe('resolveMrIid', () => {
  test('returns mr_iid directly when provided', async () => {
    const client = mockClient()
    const result = await resolveMrIid(client, 'p', 42)
    expect(result).toBe(42)
  })

  test('returns mr_iid even if source_branch is also provided', async () => {
    const client = mockClient()
    const result = await resolveMrIid(client, 'p', 42, 'feat/x')
    expect(result).toBe(42)
    // Should not have called resolveBranchToMr since mr_iid was provided
    expect(client.resolveBranchToMr).not.toHaveBeenCalled()
  })

  test('resolves branch to MR IID when mr_iid is undefined', async () => {
    const client = mockClient({
      resolveBranchToMr: mock(
        async () =>
          ({
            iid: 99,
          }) as GitLabMergeRequest,
      ),
    })

    const result = await resolveMrIid(client, 'p', undefined, 'feat/x')
    expect(result).toBe(99)
    expect(client.resolveBranchToMr).toHaveBeenCalledWith('p', 'feat/x')
  })

  test('throws when neither mr_iid nor source_branch provided', async () => {
    const client = mockClient()
    await expect(resolveMrIid(client, 'p')).rejects.toThrow(
      'Either mr_iid or source_branch must be provided',
    )
  })

  test('throws when no MR found for branch', async () => {
    const client = mockClient({
      resolveBranchToMr: mock(async () => null),
    })

    await expect(
      resolveMrIid(client, 'my/proj', undefined, 'no-mr-branch'),
    ).rejects.toThrow(
      'No open merge request found for branch "no-mr-branch" in project "my/proj"',
    )
  })
})

// ---------------------------------------------------------------------------
// safeEnrich
// ---------------------------------------------------------------------------

describe('safeEnrich', () => {
  test('returns available result on success', async () => {
    const result = await safeEnrich(async () => ({ value: 42 }))
    expect(result).toEqual({ available: true, data: { value: 42 } })
  })

  test('returns unavailable result on Error', async () => {
    const result = await safeEnrich(async () => {
      throw new Error('API down')
    })
    expect(result).toEqual({
      available: false,
      unavailable_reason: 'API down',
    })
  })

  test('handles non-Error throws via String()', async () => {
    const result = await safeEnrich(async () => {
      throw 'string error'
    })
    expect(result).toEqual({
      available: false,
      unavailable_reason: 'string error',
    })
  })

  test('handles numeric throw', async () => {
    const result = await safeEnrich(async () => {
      throw 404
    })
    expect(result).toEqual({
      available: false,
      unavailable_reason: '404',
    })
  })
})

// ---------------------------------------------------------------------------
// buildApprovalSummary
// ---------------------------------------------------------------------------

describe('buildApprovalSummary', () => {
  test('aggregates Premium endpoint rule-based data', async () => {
    const premiumData: GitLabApprovalState = {
      approval_rules_overwritten: false,
      rules: [
        {
          id: 1,
          name: 'Code Review',
          rule_type: 'regular',
          approvals_required: 2,
          approved: true,
          approved_by: [
            {
              user: {
                id: 1,
                username: 'alice',
                name: 'Alice',
                avatar_url: '',
                web_url: '',
              },
            },
            {
              user: {
                id: 2,
                username: 'bob',
                name: 'Bob',
                avatar_url: '',
                web_url: '',
              },
            },
          ],
          contains_hidden_groups: false,
        },
        {
          id: 2,
          name: 'Security Review',
          rule_type: 'regular',
          approvals_required: 1,
          approved: true,
          approved_by: [
            {
              user: {
                id: 1,
                username: 'alice',
                name: 'Alice',
                avatar_url: '',
                web_url: '',
              },
            },
          ],
          contains_hidden_groups: false,
        },
      ],
    }

    const client = mockClient({
      getApprovalState: mock(async () => ({
        data: premiumData,
        source: 'approval_state' as const,
      })),
    })

    const summary = await buildApprovalSummary(client, 'p', 1)
    expect(summary.approved).toBe(true)
    expect(summary.approvals_required).toBe(3) // 2 + 1
    expect(summary.approvals_left).toBe(0)
    // alice appears in both rules but should be deduplicated
    expect(summary.approved_by).toHaveLength(2)
    expect(summary.approved_by_usernames).toEqual(['alice', 'bob'])
    expect(summary.source_endpoint).toBe('approval_state')
  })

  test('reports unapproved when any rule is not satisfied', async () => {
    const premiumData: GitLabApprovalState = {
      approval_rules_overwritten: false,
      rules: [
        {
          id: 1,
          name: 'Code Review',
          rule_type: 'regular',
          approvals_required: 2,
          approved: false,
          approved_by: [
            {
              user: {
                id: 1,
                username: 'alice',
                name: 'Alice',
                avatar_url: '',
                web_url: '',
              },
            },
          ],
          contains_hidden_groups: false,
        },
      ],
    }

    const client = mockClient({
      getApprovalState: mock(async () => ({
        data: premiumData,
        source: 'approval_state' as const,
      })),
    })

    const summary = await buildApprovalSummary(client, 'p', 1)
    expect(summary.approved).toBe(false)
    expect(summary.approvals_required).toBe(2)
    expect(summary.approvals_left).toBe(1) // 2 required - 1 approved
    expect(summary.approved_by).toHaveLength(1)
  })

  test('handles empty rules array', async () => {
    const premiumData: GitLabApprovalState = {
      approval_rules_overwritten: false,
      rules: [],
    }

    const client = mockClient({
      getApprovalState: mock(async () => ({
        data: premiumData,
        source: 'approval_state' as const,
      })),
    })

    const summary = await buildApprovalSummary(client, 'p', 1)
    expect(summary.approved).toBe(false) // No rules = not approved
    expect(summary.approvals_required).toBe(0)
    expect(summary.approvals_left).toBe(0)
    expect(summary.approved_by).toEqual([])
  })

  test('normalizes Free-tier endpoint data', async () => {
    const freeData: GitLabApprovals = {
      approved: false,
      approvals_required: 1,
      approvals_left: 1,
      approved_by: [],
      user_has_approved: false,
      user_can_approve: false,
    }

    const client = mockClient({
      getApprovalState: mock(async () => ({
        data: freeData,
        source: 'approvals' as const,
      })),
    })

    const summary = await buildApprovalSummary(client, 'p', 1)
    expect(summary.approved).toBe(false)
    expect(summary.approvals_required).toBe(1)
    expect(summary.approvals_left).toBe(1)
    expect(summary.user_has_approved).toBe(false)
    expect(summary.user_can_approve).toBe(false)
    expect(summary.source_endpoint).toBe('approvals')
  })

  test('reads user_has_approved and user_can_approve from free-tier endpoint (BUG-007)', async () => {
    const freeData: GitLabApprovals = {
      approved: true,
      approvals_required: 1,
      approvals_left: 0,
      approved_by: [
        {
          user: {
            id: 1,
            username: 'reviewer',
            name: 'Reviewer',
            avatar_url: '',
            web_url: '',
          },
        },
      ],
      user_has_approved: true,
      user_can_approve: true,
    }

    const client = mockClient({
      getApprovalState: mock(async () => ({
        data: freeData,
        source: 'approvals' as const,
      })),
    })

    const summary = await buildApprovalSummary(client, 'p', 1)
    expect(summary.user_has_approved).toBe(true)
    expect(summary.user_can_approve).toBe(true)
    expect(summary.source_endpoint).toBe('approvals')
  })

  test('defaults user_has_approved/user_can_approve to false for premium endpoint (BUG-007)', async () => {
    const premiumData: GitLabApprovalState = {
      approval_rules_overwritten: false,
      rules: [
        {
          id: 1,
          name: 'All Members',
          rule_type: 'any_approver',
          approvals_required: 1,
          approved: true,
          approved_by: [
            {
              user: {
                id: 1,
                username: 'reviewer',
                name: 'Reviewer',
                avatar_url: '',
                web_url: '',
              },
            },
          ],
          contains_hidden_groups: false,
        },
      ],
    }

    const client = mockClient({
      getApprovalState: mock(async () => ({
        data: premiumData,
        source: 'approval_state' as const,
      })),
    })

    const summary = await buildApprovalSummary(client, 'p', 1)
    // Premium path doesn't have per-user fields — should default to false
    expect(summary.user_has_approved).toBe(false)
    expect(summary.user_can_approve).toBe(false)
    expect(summary.source_endpoint).toBe('approval_state')
  })
})

// ---------------------------------------------------------------------------
// buildCommitSummary
// ---------------------------------------------------------------------------

describe('buildCommitSummary', () => {
  test('counts commits and reports merge method', async () => {
    const commits: GitLabCommit[] = [
      {
        id: 'a',
        short_id: 'a',
        title: 'c1',
        author_name: 'x',
        author_email: 'x@x',
        created_at: '',
      },
      {
        id: 'b',
        short_id: 'b',
        title: 'c2',
        author_name: 'x',
        author_email: 'x@x',
        created_at: '',
      },
      {
        id: 'c',
        short_id: 'c',
        title: 'c3',
        author_name: 'x',
        author_email: 'x@x',
        created_at: '',
      },
    ]

    const client = mockClient({
      getMergeRequestCommits: mock(async () => commits),
    })

    const summary = await buildCommitSummary(client, 'p', 1, 'merge')
    expect(summary.source_commit_count).toBe(3)
    expect(summary.merge_method).toBe('merge')
    expect(summary.estimated_merge_commits).toBe(1)
  })

  test('fast-forward merge has 0 estimated merge commits', async () => {
    const client = mockClient({
      getMergeRequestCommits: mock(async () => []),
    })

    const summary = await buildCommitSummary(client, 'p', 1, 'ff')
    expect(summary.estimated_merge_commits).toBe(0)
  })

  test('rebase_merge has 1 estimated merge commit', async () => {
    const client = mockClient({
      getMergeRequestCommits: mock(async () => []),
    })

    const summary = await buildCommitSummary(client, 'p', 1, 'rebase_merge')
    expect(summary.estimated_merge_commits).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// buildDeploymentSummary
// ---------------------------------------------------------------------------

describe('buildDeploymentSummary', () => {
  test('returns all deployments when <= 10', async () => {
    const deployments: GitLabDeployment[] = Array.from(
      { length: 5 },
      (_, i) => ({
        id: i,
        iid: i,
        sha: 'sha123',
        status: 'success',
        environment: { id: 1, name: 'production' },
        created_at: '',
        updated_at: '',
      }),
    )

    const client = mockClient({
      getDeployments: mock(async () => deployments),
    })

    const summary = await buildDeploymentSummary(client, 'p', 'sha123')
    expect(summary.total_count).toBe(5)
    expect(summary.records).toHaveLength(5)
  })

  test('slices to 10 records when more than 10 deployments', async () => {
    const deployments: GitLabDeployment[] = Array.from(
      { length: 15 },
      (_, i) => ({
        id: i,
        iid: i,
        sha: 'sha123',
        status: 'success',
        environment: { id: 1, name: 'staging' },
        created_at: '',
        updated_at: '',
      }),
    )

    const client = mockClient({
      getDeployments: mock(async () => deployments),
    })

    const summary = await buildDeploymentSummary(client, 'p', 'sha123')
    expect(summary.total_count).toBe(15)
    expect(summary.records).toHaveLength(10)
  })

  test('handles empty deployments', async () => {
    const client = mockClient({
      getDeployments: mock(async () => []),
    })

    const summary = await buildDeploymentSummary(client, 'p', 'sha123')
    expect(summary.total_count).toBe(0)
    expect(summary.records).toEqual([])
  })
})
