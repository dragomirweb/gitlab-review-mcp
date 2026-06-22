/**
 * Merge Request tools for GitLab MCP
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getQueries } from '../db'
import type { GitLabClient } from '../gitlab/client'
import { getGitLabClient } from '../gitlab/client'
import type {
  ApprovalSummary,
  CommitAdditionSummary,
  DeploymentSummary,
  EnrichmentResult,
  GitLabApprovalState,
  GitLabApprovals,
} from '../gitlab/types'
import {
  approveMrSchema,
  createMrDiscussionReplySchema,
  createMrNoteSchema,
  getMergeRequestSchema,
  getMrChangesSinceSchema,
  getMrCommitsSchema,
  getMrDiffSchema,
  getMrDiscussionsSchema,
  getMrFileContentSchema,
  getMrPipelinesSchema,
  listMergeRequestsSchema,
  resolveMrThreadSchema,
  unapproveMrSchema,
} from '../schemas'
import { resolveProjectId } from './resolve-project-id'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a merge request IID from either a direct IID or a source branch name.
 * Throws if neither is provided or if no MR is found for the branch.
 */
export async function resolveMrIid(
  client: GitLabClient,
  projectId: string,
  mrIid?: number,
  sourceBranch?: string,
): Promise<number> {
  if (mrIid !== undefined) return mrIid

  if (!sourceBranch) {
    throw new Error('Either mr_iid or source_branch must be provided')
  }

  const mr = await client.resolveBranchToMr(projectId, sourceBranch)
  if (!mr) {
    throw new Error(
      `No open merge request found for branch "${sourceBranch}" in project "${projectId}"`,
    )
  }
  return mr.iid
}

/**
 * Safely run an enrichment function. Returns the data on success, or an
 * unavailable_reason on failure. This ensures the main response is always
 * returned even if individual enrichments fail.
 */
export async function safeEnrich<T>(
  fn: () => Promise<T>,
): Promise<EnrichmentResult<T>> {
  try {
    const data = await fn()
    return { available: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { available: false, unavailable_reason: message }
  }
}

/**
 * Build an approval summary from either the Premium or Free-tier endpoint.
 *
 * Premium endpoint returns rule-based data — we aggregate across all rules:
 *   - approved = every rule's `approved` is true
 *   - approvals_required = sum of all rules' `approvals_required`
 *   - approvals_left = sum of unapproved rules' remaining approvals
 *   - approved_by = deduplicated union of all rule approvers
 *
 * Free-tier endpoint returns a flat summary which is used directly.
 */
export async function buildApprovalSummary(
  client: GitLabClient,
  projectId: string,
  mrIid: number,
): Promise<ApprovalSummary> {
  const { data, source } = await client.getApprovalState(projectId, mrIid)

  if (source === 'approval_state') {
    const state = data as GitLabApprovalState
    const rules = state.rules

    const approved = rules.length > 0 && rules.every((r) => r.approved)
    const approvalsRequired = rules.reduce(
      (sum, r) => sum + r.approvals_required,
      0,
    )
    const approvalsLeft = rules.reduce(
      (sum, r) =>
        sum + Math.max(0, r.approvals_required - r.approved_by.length),
      0,
    )

    // Deduplicate approvers across rules by user ID
    const seenIds = new Set<number>()
    const approvedByUsers = rules
      .flatMap((r) => r.approved_by)
      .filter((a) => {
        if (seenIds.has(a.user.id)) return false
        seenIds.add(a.user.id)
        return true
      })
      .map((a) => a.user)

    return {
      approved,
      approvals_required: approvalsRequired,
      approvals_left: approvalsLeft,
      approved_by: approvedByUsers,
      approved_by_usernames: approvedByUsers.map((u) => u.username),
      // The approval_state endpoint doesn't expose per-user flags directly;
      // determining them would require knowing the authenticated user's ID
      // and scanning each rule's approved_by list. Left as false for now.
      user_has_approved: false,
      user_can_approve: false,
      source_endpoint: source,
    }
  }

  // Free-tier /approvals endpoint — flat structure
  const approvals = data as GitLabApprovals
  const approvedByUsers = approvals.approved_by.map((a) => a.user)

  return {
    approved: approvals.approved ?? null,
    approvals_required: approvals.approvals_required,
    approvals_left: approvals.approvals_left,
    approved_by: approvedByUsers,
    approved_by_usernames: approvedByUsers.map((u) => u.username),
    user_has_approved: approvals.user_has_approved ?? false,
    user_can_approve: approvals.user_can_approve ?? false,
    source_endpoint: source,
  }
}

/**
 * Build a commit addition summary.
 */
export async function buildCommitSummary(
  client: GitLabClient,
  projectId: string,
  mrIid: number,
  mergeMethod: 'merge' | 'rebase_merge' | 'ff',
): Promise<CommitAdditionSummary> {
  const commits = await client.getMergeRequestCommits(projectId, mrIid)
  const estimatedMergeCommits =
    mergeMethod === 'ff' ? 0 : mergeMethod === 'rebase_merge' ? 1 : 1

  return {
    source_commit_count: commits.length,
    estimated_merge_commits: estimatedMergeCommits,
    merge_method: mergeMethod,
  }
}

/**
 * Build a deployment summary.
 */
export async function buildDeploymentSummary(
  client: GitLabClient,
  projectId: string,
  headSha: string,
): Promise<DeploymentSummary> {
  const deployments = await client.getDeployments(projectId, headSha)
  return {
    total_count: deployments.length,
    records: deployments.slice(0, 10), // Most recent 10
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerMergeRequestTools(server: McpServer): void {
  // Get merge request details (enriched)
  server.registerTool(
    'get_merge_request',
    {
      title: 'Get Merge Request',
      description:
        'Fetch enriched merge request details including title, description, author, state, labels, approval summary, commit count, and deployment summary. Accepts either mr_iid or source_branch.',
      inputSchema: getMergeRequestSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, source_branch }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const iid = await resolveMrIid(client, pid, mr_iid, source_branch)
      const mr = await client.getMergeRequest(pid, iid)

      // Run enrichments in parallel, each failing independently
      const [approvalResult, commitResult, deploymentResult] =
        await Promise.all([
          safeEnrich(() => buildApprovalSummary(client, pid, iid)),
          safeEnrich(async () => {
            const project = await client.getProject(pid)
            return buildCommitSummary(client, pid, iid, project.merge_method)
          }),
          safeEnrich(() => {
            const headSha = mr.diff_refs?.head_sha
            if (!headSha) {
              throw new Error('No head_sha available in diff_refs')
            }
            return buildDeploymentSummary(client, pid, headSha)
          }),
        ])

      const enrichedMr = {
        ...mr,
        approval_summary: approvalResult,
        commit_addition_summary: commitResult,
        deployment_summary: deploymentResult,
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(enrichedMr, null, 2),
          },
        ],
      }
    },
  )

  // Get merge request diff
  server.registerTool(
    'get_mr_diff',
    {
      title: 'Get MR Diff',
      description:
        'Get the code diff/changes for a merge request. Supports file exclusion via regex patterns. Accepts either mr_iid or source_branch.',
      inputSchema: getMrDiffSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({
      project_id,
      mr_iid,
      source_branch,
      excluded_file_patterns,
      include_generated,
    }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const iid = await resolveMrIid(client, pid, mr_iid, source_branch)
      let diffs = await client.getMergeRequestDiffs(pid, iid)

      // Filter out generated files by default
      if (!include_generated) {
        diffs = diffs.filter((diff) => !diff.generated_file)
      }

      // Filter out files matching exclusion patterns
      if (excluded_file_patterns?.length) {
        const regexes = excluded_file_patterns.map(
          (pattern: string) => new RegExp(pattern),
        )
        diffs = diffs.filter(
          (diff) =>
            !regexes.some(
              (re: RegExp) => re.test(diff.new_path) || re.test(diff.old_path),
            ),
        )
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(diffs, null, 2),
          },
        ],
      }
    },
  )

  // Get merge request discussions
  server.registerTool(
    'get_mr_discussions',
    {
      title: 'Get MR Discussions',
      description:
        'Fetch all discussion threads and comments on a merge request, including resolved status. Accepts either mr_iid or source_branch.',
      inputSchema: getMrDiscussionsSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, source_branch }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const iid = await resolveMrIid(client, pid, mr_iid, source_branch)
      const discussions = await client.getMergeRequestDiscussions(pid, iid)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(discussions, null, 2),
          },
        ],
      }
    },
  )

  // Get merge request commits
  server.registerTool(
    'get_mr_commits',
    {
      title: 'Get MR Commits',
      description:
        'Fetch all commits in a merge request. Returns commit SHAs, titles, authors, and timestamps. Accepts either mr_iid or source_branch.',
      inputSchema: getMrCommitsSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, source_branch }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const iid = await resolveMrIid(client, pid, mr_iid, source_branch)
      const commits = await client.getMergeRequestCommits(pid, iid)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(commits, null, 2),
          },
        ],
      }
    },
  )

  // Get changes since a specific commit (for re-reviews)
  server.registerTool(
    'get_mr_changes_since',
    {
      title: 'Get MR Changes Since',
      description:
        "Get files changed since a specific commit SHA. For re-reviews, automatically uses the previous review's HEAD SHA if since_sha is not provided. Returns diffs and commits between the two points.",
      inputSchema: getMrChangesSinceSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, since_sha }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()

      // Get current MR to find the HEAD SHA
      const mr = await client.getMergeRequest(pid, mr_iid)
      const currentHeadSha = mr.diff_refs?.head_sha
      if (!currentHeadSha) {
        throw new Error(
          'Cannot determine current HEAD SHA from merge request diff_refs',
        )
      }

      // Resolve the base SHA to compare from
      let baseSha = since_sha
      if (!baseSha) {
        // Auto-resolve from the active review session first. If no active
        // review exists, fall back to the latest completed session's HEAD.
        const queries = getQueries()
        const activeSession = queries.getActiveSessionByMR(pid, mr_iid)
        if (activeSession) {
          baseSha = activeSession.previous_head_sha ?? undefined
        } else {
          const latestSession = queries.getLatestSessionByMR(pid, mr_iid)
          baseSha = latestSession?.head_sha ?? undefined
        }
      }

      if (!baseSha) {
        throw new Error(
          'No since_sha provided and no previous review SHA found. Provide since_sha explicitly or ensure a review session with a previous HEAD SHA exists.',
        )
      }

      // If base and head are the same, no changes
      if (baseSha === currentHeadSha) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  since_sha: baseSha,
                  head_sha: currentHeadSha,
                  commits: [],
                  diffs: [],
                  message: 'No changes since the last review.',
                },
                null,
                2,
              ),
            },
          ],
        }
      }

      const result = await client.compareCommits(pid, baseSha, currentHeadSha)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                since_sha: baseSha,
                head_sha: currentHeadSha,
                commits: result.commits,
                diffs: result.diffs,
                compare_timeout: result.compare_timeout,
                message: `${result.commits.length} commit(s) and ${result.diffs.length} file(s) changed since ${baseSha.substring(0, 8)}.`,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Get file content from repository
  server.registerTool(
    'get_mr_file_content',
    {
      title: 'Get MR File Content',
      description:
        'Read file content from a specific branch, tag, or commit SHA. Use this to read the current file state for accurate line numbers during code review.',
      inputSchema: getMrFileContentSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, file_path, ref }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const file = await client.getRepositoryFile(pid, file_path, ref)

      // Decode base64 content
      const content =
        file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64').toString('utf-8')
          : file.content

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                file_path: file.file_path,
                ref: file.ref,
                size: file.size,
                content,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Get merge request pipelines
  server.registerTool(
    'get_mr_pipelines',
    {
      title: 'Get MR Pipelines',
      description:
        'Fetch all CI/CD pipelines for a merge request. Returns pipeline status, SHA, ref, and web URL. Useful for checking if CI passes before approving.',
      inputSchema: getMrPipelinesSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const pipelines = await client.getMergeRequestPipelines(pid, mr_iid)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(pipelines, null, 2),
          },
        ],
      }
    },
  )

  // List merge requests
  server.registerTool(
    'list_merge_requests',
    {
      title: 'List Merge Requests',
      description:
        'List merge requests for a project with optional filters for state, labels, scope, ordering, and text search',
      inputSchema: listMergeRequestsSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({
      project_id,
      state,
      labels,
      scope,
      order_by,
      sort,
      search,
      per_page,
      page,
    }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const mrs = await client.listMergeRequests(pid, {
        state,
        labels,
        scope,
        order_by,
        sort,
        search,
        per_page,
        page,
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(mrs, null, 2),
          },
        ],
      }
    },
  )

  // Resolve / unresolve a merge request discussion thread
  server.registerTool(
    'resolve_merge_request_thread',
    {
      title: 'Resolve MR Thread',
      description:
        'Resolve or unresolve a discussion thread on a merge request',
      inputSchema: resolveMrThreadSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, discussion_id, resolved }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const discussion = await client.resolveMergeRequestThread(
        pid,
        mr_iid,
        discussion_id,
        resolved,
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                discussion_id: discussion.id,
                resolved,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Create a general note/comment on a merge request
  server.registerTool(
    'create_merge_request_note',
    {
      title: 'Create MR Note',
      description:
        'Post a general comment on a merge request (not tied to a review session)',
      inputSchema: createMrNoteSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, body }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const note = await client.createMergeRequestNote(pid, mr_iid, {
        body,
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                note_id: note.id,
                body: note.body,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Reply to an existing discussion thread
  server.registerTool(
    'create_mr_discussion_reply',
    {
      title: 'Reply to MR Discussion',
      description:
        'Post a reply to an existing discussion thread on a merge request. Use this to respond to developer comments or follow up on review feedback.',
      inputSchema: createMrDiscussionReplySchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, discussion_id, body }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const note = await client.createMergeRequestDiscussionNote(
        pid,
        mr_iid,
        discussion_id,
        body,
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                note_id: note.id,
                discussion_id,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Approve a merge request
  server.registerTool(
    'approve_merge_request',
    {
      title: 'Approve MR',
      description:
        "Approve a merge request. Optionally provide a SHA to ensure the MR hasn't been updated since you last reviewed it.",
      inputSchema: approveMrSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, sha }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      await client.approveMergeRequest(pid, mr_iid, sha)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: `Merge request !${mr_iid} approved.`,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Unapprove a merge request
  server.registerTool(
    'unapprove_merge_request',
    {
      title: 'Unapprove MR',
      description: 'Remove your approval from a merge request.',
      inputSchema: unapproveMrSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      await client.unapproveMergeRequest(pid, mr_iid)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: `Approval removed from merge request !${mr_iid}.`,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
