/**
 * Review session tools for GitLab MCP
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ReviewQueries } from '../db'
import { getQueries } from '../db'
import type { ReviewItem, ReviewSession } from '../db/schema'
import type { GitLabClient } from '../gitlab/client'
import { getGitLabClient } from '../gitlab/client'
import {
  addReviewCommentSchema,
  completeReviewSchema,
  getReviewStatusSchema,
  startReviewSchema,
} from '../schemas'
import { resolveProjectId } from './resolve-project-id'

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Format review comment body. Wraps content in GitLab suggestion markdown
 * when the type is "suggestion" and a file context (file_path or position
 * new_path) is available.
 */
export function formatReviewBody(
  content: string,
  type: string,
  filePath?: string,
  positionNewPath?: string,
): string {
  if (type === 'suggestion' && (filePath || positionNewPath)) {
    return `\`\`\`suggestion:-0+0\n${content}\n\`\`\``
  }
  return content
}

/**
 * Build a GitLab diff position object from schema-validated position input.
 * Returns undefined if no position is provided.
 */
export function buildGitLabPosition(position?: {
  base_sha: string
  head_sha: string
  start_sha: string
  position_type?: string
  new_path: string
  old_path?: string
  new_line?: number
  old_line?: number
}): import('../gitlab/types').GitLabPosition | undefined {
  if (!position) return undefined

  return {
    base_sha: position.base_sha,
    head_sha: position.head_sha,
    start_sha: position.start_sha,
    position_type:
      (position.position_type as 'text' | 'image' | 'file') || 'text',
    new_path: position.new_path,
    old_path: position.old_path,
    new_line: position.new_line ?? undefined,
    old_line: position.old_line ?? undefined,
  }
}

/** A review item enriched with live GitLab resolution status and replies. */
export interface EnrichedReviewItem extends ReviewItem {
  gitlab_resolved: boolean
  developer_replies: Array<{
    author: string
    body: string
    created_at: string
  }>
}

/** Summary of review item resolution status. */
export interface ReviewStatusSummary {
  items: EnrichedReviewItem[]
  total_items: number
  resolved_items: number
  unresolved_items: number
  all_resolved: boolean
}

/**
 * Enrich review items with live GitLab resolution status and developer replies.
 * Cross-references local review items against GitLab discussions to determine
 * which items have been resolved and extract any replies.
 *
 * Side effect: updates local DB resolution status when GitLab shows resolved.
 */
export async function enrichReviewItems(
  client: GitLabClient,
  queries: ReviewQueries,
  session: ReviewSession,
): Promise<ReviewStatusSummary> {
  const items = queries.getReviewItemsBySession(session.id)

  // Fetch all discussions from GitLab
  const discussions = await client.getMergeRequestDiscussions(
    session.project_id,
    session.mr_iid,
  )

  const enrichedItems: EnrichedReviewItem[] = []

  for (const item of items) {
    const discussion = discussions.find((d) => d.id === item.discussion_id)
    const isResolved =
      discussion?.notes.every((n) => !n.resolvable || n.resolved) ?? false

    if (isResolved && !item.resolved) {
      queries.markItemResolved(item.id)
    }

    // Extract developer replies (notes after the first one, which is the review comment)
    const developerReplies = (discussion?.notes ?? [])
      .slice(1) // Skip the original review comment
      .filter((n) => !n.system) // Skip system notes
      .map((n) => ({
        author: n.author.username,
        body: n.body,
        created_at: n.created_at,
      }))

    enrichedItems.push({
      ...item,
      resolved: isResolved ? 1 : item.resolved,
      gitlab_resolved: isResolved,
      developer_replies: developerReplies,
    })
  }

  const resolvedCount = enrichedItems.filter((i) => i.resolved).length
  const unresolvedCount = enrichedItems.length - resolvedCount

  return {
    items: enrichedItems,
    total_items: enrichedItems.length,
    resolved_items: resolvedCount,
    unresolved_items: unresolvedCount,
    all_resolved: unresolvedCount === 0,
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerReviewTools(server: McpServer): void {
  // Start a review session
  server.registerTool(
    'start_review',
    {
      title: 'Start Review',
      description:
        'Start a new review session for a merge request. If an active session exists, returns the existing session for re-review.',
      inputSchema: startReviewSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid }) => {
      const pid = resolveProjectId(project_id)
      const queries = getQueries()
      const client = getGitLabClient()

      // Always fetch MR to get the current HEAD SHA
      const mr = await client.getMergeRequest(pid, mr_iid)
      const currentHeadSha = mr.diff_refs?.head_sha ?? null

      // Check for existing active session
      const existingSession = queries.getActiveSessionByMR(pid, mr_iid)

      if (existingSession) {
        // Update the session's head SHA (moves old to previous_head_sha)
        if (currentHeadSha) {
          queries.updateSessionHeadSha(existingSession.id, currentHeadSha)
        }

        // Re-fetch session to get updated SHA fields
        const updatedSession = queries.getSessionById(existingSession.id)!

        // Enrich items with live GitLab resolution status and developer replies
        const status = await enrichReviewItems(client, queries, updatedSession)

        const hasNewCommits =
          updatedSession.previous_head_sha !== null &&
          updatedSession.head_sha !== updatedSession.previous_head_sha

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  session: updatedSession,
                  is_rereview: true,
                  has_new_commits: hasNewCommits,
                  ...status,
                  message: `Existing review session found. ${status.resolved_items} of ${status.total_items} issues resolved, ${status.unresolved_items} still open.${hasNewCommits ? ' New commits detected since last review.' : ''}`,
                },
                null,
                2,
              ),
            },
          ],
        }
      }

      // Create new session with HEAD SHA
      const session = queries.createSession({
        mr_iid,
        project_id: pid,
        source_branch: mr.source_branch,
        head_sha: currentHeadSha ?? undefined,
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                session,
                is_rereview: false,
                message: 'New review session started.',
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Add a review comment
  server.registerTool(
    'add_review_comment',
    {
      title: 'Add Review Comment',
      description:
        'Add a comment or suggestion to the merge request and track it locally for resolution checking',
      inputSchema: addReviewCommentSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ session_id, content, type, file_path, line_number, position }) => {
      const queries = getQueries()
      const client = getGitLabClient()

      // Get session to find MR details
      const session = queries.getSessionById(session_id)
      if (!session) {
        throw new Error(`Review session ${session_id} not found`)
      }

      // Format content for suggestions
      const body = formatReviewBody(
        content,
        type,
        file_path,
        position?.new_path,
      )

      // Build the params for the GitLab API
      const noteParams: import('../gitlab/types').CreateDiscussionParams = {
        body,
      }

      const builtPosition = buildGitLabPosition(position)
      if (builtPosition) {
        noteParams.position = builtPosition
      }

      // Create discussion on GitLab
      const discussion = await client.createMergeRequestDiscussion(
        session.project_id,
        session.mr_iid,
        noteParams,
      )

      // Track locally — fall back to position fields when top-level params are absent
      const item = queries.createReviewItem({
        session_id,
        gitlab_note_id: discussion.notes[0]?.id,
        discussion_id: discussion.id,
        type: type || 'comment',
        file_path: file_path ?? position?.new_path,
        line_number: line_number ?? position?.new_line,
        content,
      })

      // Update session status to pending_changes since we've left comments
      queries.updateSessionStatus(session.id, 'pending_changes')

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                item,
                gitlab_discussion_id: discussion.id,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Get review status
  server.registerTool(
    'get_review_status',
    {
      title: 'Get Review Status',
      description:
        'Check the resolution status of all tracked review items for a merge request or branch. Returns full comment content, file paths, line numbers, and discussion IDs — useful for re-reviews to see what was previously flagged and what remains unresolved.',
      inputSchema: getReviewStatusSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, branch }) => {
      if (mr_iid === undefined && !branch) {
        throw new Error('Either mr_iid or branch must be provided')
      }

      const pid = resolveProjectId(project_id)
      const queries = getQueries()
      const client = getGitLabClient()

      // Find session by MR iid or branch
      let session: ReviewSession | null = null

      if (mr_iid) {
        session = queries.getActiveSessionByMR(pid, mr_iid)
      } else if (branch) {
        session = queries.getActiveSessionByBranch(pid, branch)
      }

      if (!session) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  found: false,
                  message:
                    'No active review session found for this merge request or branch.',
                },
                null,
                2,
              ),
            },
          ],
        }
      }

      // Enrich items with live GitLab resolution status and developer replies
      const status = await enrichReviewItems(client, queries, session)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                session,
                ...status,
                message: status.all_resolved
                  ? 'All review items have been resolved!'
                  : `${status.unresolved_items} item(s) still need to be resolved.`,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Complete a review
  server.registerTool(
    'complete_review',
    {
      title: 'Complete Review',
      description:
        'Complete a review session with a final status. Optionally posts a summary comment, sets labels, and approves the MR on GitLab.',
      inputSchema: completeReviewSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true, // May post comments, set labels, and approve on GitLab
      },
    },
    async ({ session_id, status, summary_comment, labels, approve }) => {
      const queries = getQueries()
      const client = getGitLabClient()

      const session = queries.getSessionById(session_id)
      if (!session) {
        throw new Error(`Review session ${session_id} not found`)
      }

      // 1. Update local session status
      queries.updateSessionStatus(session_id, status)

      // Track which GitLab actions were performed
      const actions: string[] = []

      // 2. Post summary comment if provided
      if (summary_comment) {
        await client.createMergeRequestNote(
          session.project_id,
          session.mr_iid,
          {
            body: summary_comment,
          },
        )
        actions.push('summary_comment_posted')
      }

      // 3. Set labels if provided
      if (labels) {
        await client.updateMergeRequestLabels(
          session.project_id,
          session.mr_iid,
          labels,
        )
        actions.push('labels_updated')
      }

      // 4. Approve if requested and status is "approved"
      let approveSkipped = false
      if (approve) {
        if (status === 'approved') {
          await client.approveMergeRequest(session.project_id, session.mr_iid)
          actions.push('mr_approved')
        } else {
          approveSkipped = true
        }
      }

      const result: Record<string, unknown> = {
        success: true,
        session_id,
        status,
        actions,
        message: `Review session marked as ${status}.`,
      }

      if (approveSkipped) {
        result.approve_skipped = true
        result.approve_skipped_reason = `Approval skipped because status is '${status}', not 'approved'.`
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    },
  )
}
