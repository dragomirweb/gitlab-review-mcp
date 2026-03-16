/**
 * Zod schemas for MCP tool inputs
 *
 * Patterns used:
 * - z.coerce.string() / z.coerce.number() for IDs (handles LLM type ambiguity)
 * - .describe() on every field (flows into JSON Schema for LLM tool calling)
 * - Base schemas composed via .extend() and .merge() to reduce duplication
 * - z.enum() for constrained string fields
 * - .refine() for cross-field validation
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

/**
 * Accepts both numeric IDs (123) and path strings ("group/project") from LLMs.
 * Uses z.union instead of z.coerce.string() to avoid silently coercing
 * undefined/null to the string "undefined"/"null".
 */
export const projectIdSchema = z
  .union([z.string(), z.number().transform(String)])
  .pipe(z.string().min(1))
  .describe(
    'GitLab project ID or URL-encoded path (e.g., "group/project" or numeric ID)',
  )

/** Accepts both number (42) and string ("42") from LLMs. */
export const mrIidSchema = z.coerce
  .number()
  .int()
  .positive()
  .describe('Merge request IID (internal ID within the project)')

/** Accepts both number (1) and string ("1") from LLMs. */
const sessionIdSchema = z.coerce
  .number()
  .int()
  .positive()
  .describe('Review session ID')

// ---------------------------------------------------------------------------
// Base composed schemas
// ---------------------------------------------------------------------------

/** Project-scoped parameters — extended by ~70% of tool schemas. */
export const ProjectParamsSchema = z.object({
  project_id: projectIdSchema
    .optional()
    .describe(
      'GitLab project ID or path (e.g., "group/project"). ' +
        'Optional when a default is configured via set_setting or GITLAB_PROJECT_ID env var.',
    ),
})

/** Merge-request-scoped parameters — extends ProjectParamsSchema. */
export const MrParamsSchema = ProjectParamsSchema.extend({
  mr_iid: mrIidSchema,
})

/**
 * MR lookup by IID or source branch.
 * Tools that accept either `mr_iid` or `source_branch` use this base.
 *
 * NOTE: Both fields are optional at the schema level so this stays a ZodObject
 * (serializable to JSON Schema by the MCP SDK). The "at least one required"
 * constraint is enforced at runtime by resolveMrIid() in tool handlers.
 * Using .refine() here would convert to ZodEffects and break serialization.
 */
export const MrLookupSchema = ProjectParamsSchema.extend({
  mr_iid: mrIidSchema
    .optional()
    .describe('Merge request IID (provide this or source_branch)'),
  source_branch: z
    .string()
    .optional()
    .describe(
      'Source branch name (alternative to mr_iid — resolves to the open MR for this branch)',
    ),
})

/** Pagination options — merged into list operations. */
export const PaginationSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Page number for pagination (default: 1)'),
  per_page: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Number of items per page (max 100, default: 20)'),
})

// ---------------------------------------------------------------------------
// Merge Request tools
// ---------------------------------------------------------------------------

export const getMergeRequestSchema = MrLookupSchema

export const getMrDiffSchema = MrLookupSchema.extend({
  excluded_file_patterns: z
    .array(z.string())
    .optional()
    .describe(
      'Regex patterns to exclude files from diff output (e.g., ["package-lock\\\\.json", ".*\\\\.generated\\\\..*"])',
    ),
  include_generated: z
    .boolean()
    .optional()
    .describe(
      'Include generated files in diff output (default: false — generated files are excluded)',
    ),
})

export const getMrDiscussionsSchema = MrLookupSchema

export const getMrCommitsSchema = MrLookupSchema

export const getMrPipelinesSchema = MrParamsSchema

export const getMrChangesSinceSchema = MrParamsSchema.extend({
  since_sha: z
    .string()
    .optional()
    .describe(
      'Base SHA to compare from. If not provided, automatically uses the previous_head_sha from the active review session.',
    ),
})

export const approveMrSchema = MrParamsSchema.extend({
  sha: z
    .string()
    .optional()
    .describe(
      'Expected HEAD SHA for safety check — approval fails if the MR has been updated since this SHA',
    ),
})

export const unapproveMrSchema = MrParamsSchema

export const getMrFileContentSchema = z.object({
  project_id: projectIdSchema
    .optional()
    .describe(
      'GitLab project ID or path (e.g., "group/project"). ' +
        'Optional when a default is configured via set_setting or GITLAB_PROJECT_ID env var.',
    ),
  file_path: z
    .string()
    .min(1)
    .describe('File path in the repository (e.g., src/index.ts)'),
  ref: z
    .string()
    .min(1)
    .describe('Branch name, tag, or commit SHA to read the file from'),
})

export const listMergeRequestsSchema = ProjectParamsSchema.extend({
  state: z
    .enum(['opened', 'closed', 'locked', 'merged', 'all'])
    .optional()
    .describe('Filter by MR state'),
  labels: z.array(z.string()).optional().describe('Filter by labels'),
  scope: z
    .enum(['created_by_me', 'assigned_to_me', 'reviews_for_me', 'all'])
    .optional()
    .describe('Filter by scope relative to the authenticated user'),
  order_by: z
    .enum([
      'created_at',
      'updated_at',
      'label_priority',
      'milestone_due',
      'popularity',
      'priority',
      'title',
      'merged_at',
    ])
    .optional()
    .describe('Field to order results by (default: created_at)'),
  sort: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Sort direction (default: desc)'),
  search: z
    .string()
    .optional()
    .describe('Search against title and description'),
}).merge(PaginationSchema)

// ---------------------------------------------------------------------------
// Discussion / thread tools
// ---------------------------------------------------------------------------

export const resolveMrThreadSchema = MrParamsSchema.extend({
  discussion_id: z.string().describe('ID of the discussion thread to resolve'),
  resolved: z
    .boolean()
    .describe('True to resolve the thread, false to unresolve'),
})

export const createMrNoteSchema = MrParamsSchema.extend({
  body: z.string().min(1).describe('The content of the note/comment'),
})

export const createMrDiscussionReplySchema = MrParamsSchema.extend({
  discussion_id: z.string().min(1).describe('Discussion thread ID to reply to'),
  body: z.string().min(1).describe('Reply body (supports GitLab markdown)'),
})

// ---------------------------------------------------------------------------
// Label tools
// ---------------------------------------------------------------------------

export const getProjectLabelsSchema = ProjectParamsSchema

export const addMrLabelSchema = MrParamsSchema.extend({
  label: z.string().describe('Label name to add'),
})

export const removeMrLabelSchema = MrParamsSchema.extend({
  label: z.string().describe('Label name to remove'),
})

export const setMrLabelsSchema = MrParamsSchema.extend({
  labels: z
    .array(z.string())
    .describe('Labels to set (replaces all existing labels)'),
})

// ---------------------------------------------------------------------------
// Settings tools
// ---------------------------------------------------------------------------

export const getSettingSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      'Setting key to retrieve (e.g., "default_project_id", "review_labels", "excluded_file_patterns")',
    ),
})

export const setSettingSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      'Setting key to store (e.g., "default_project_id", "review_labels", "excluded_file_patterns")',
    ),
  value: z
    .string()
    .min(1)
    .describe(
      'Setting value (stored as a string — use JSON for complex values)',
    ),
})

// ---------------------------------------------------------------------------
// Review tools
// ---------------------------------------------------------------------------

export const startReviewSchema = MrParamsSchema

/** Diff position for inline code comments. */
const DiffPositionSchema = z.object({
  base_sha: z.string().describe('Base commit SHA (from diff_refs.base_sha)'),
  head_sha: z.string().describe('Head commit SHA (from diff_refs.head_sha)'),
  start_sha: z.string().describe('Start commit SHA (from diff_refs.start_sha)'),
  position_type: z
    .enum(['text', 'image', 'file'])
    .optional()
    .default('text')
    .describe('Type of diff position (default: text)'),
  new_path: z.string().describe('File path after changes'),
  old_path: z
    .string()
    .optional()
    .describe('File path before changes (required for renames)'),
  new_line: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Line number in the new version of the file (for additions/modifications)',
    ),
  old_line: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('Line number in the old version of the file (for deletions)'),
})

export const addReviewCommentSchema = z.object({
  session_id: sessionIdSchema,
  content: z.string().min(1).describe('Comment content'),
  type: z
    .enum(['comment', 'suggestion'])
    .optional()
    .default('comment')
    .describe('Type of comment'),
  file_path: z
    .string()
    .optional()
    .describe(
      'File path for inline comments (used when position is not provided)',
    ),
  line_number: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Line number for inline comments (used when position is not provided)',
    ),
  position: DiffPositionSchema.optional().describe(
    'Diff position for precise inline code comments. When provided, creates a comment on a specific line in the diff.',
  ),
})

/**
 * NOTE: Both fields are optional at the schema level so this stays a ZodObject
 * (serializable to JSON Schema by the MCP SDK). The "at least one required"
 * constraint is enforced at runtime in the get_review_status handler.
 */
export const getReviewStatusSchema = ProjectParamsSchema.extend({
  mr_iid: mrIidSchema.optional(),
  branch: z
    .string()
    .optional()
    .describe('Source branch name (alternative to mr_iid)'),
})

export const completeReviewSchema = z.object({
  session_id: sessionIdSchema,
  status: z
    .enum(['approved', 'closed'])
    .describe(
      'Final review status (pending_changes is set automatically by add_review_comment)',
    ),
  summary_comment: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Summary comment to post on the MR. If provided, posts as a note on GitLab.',
    ),
  labels: z
    .array(z.string())
    .optional()
    .describe(
      'Labels to set on the MR after review completion. Replaces all existing labels.',
    ),
  approve: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Whether to also approve the MR on GitLab (only takes effect when status is 'approved').",
    ),
})
