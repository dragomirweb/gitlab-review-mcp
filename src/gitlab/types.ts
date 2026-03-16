/**
 * GitLab API response types
 */

export interface GitLabUser {
  id: number
  username: string
  name: string
  avatar_url: string
  web_url: string
}

export interface GitLabCommit {
  id: string
  short_id: string
  title: string
  author_name: string
  author_email: string
  created_at: string
}

export interface GitLabProject {
  id: number
  name: string
  path_with_namespace: string
  merge_method: 'merge' | 'rebase_merge' | 'ff'
  web_url: string
}

export interface GitLabDeployment {
  id: number
  iid: number
  sha: string
  status: string
  environment: {
    id: number
    name: string
  }
  created_at: string
  updated_at: string
}

export interface GitLabApprovalUser {
  user: GitLabUser
}

/** A single approval rule from the Premium /approval_state endpoint */
export interface GitLabApprovalRule {
  id: number
  name: string
  rule_type: string
  approvals_required: number
  approved: boolean
  approved_by: GitLabApprovalUser[]
  contains_hidden_groups: boolean
}

/**
 * Premium endpoint: GET /merge_requests/:iid/approval_state
 * Returns rule-based approval data per the OpenAPI spec.
 */
export interface GitLabApprovalState {
  approval_rules_overwritten: boolean
  rules: GitLabApprovalRule[]
}

/**
 * Free-tier endpoint: GET /merge_requests/:iid/approvals
 * Returns a flat approval summary without rule details.
 */
export interface GitLabApprovals {
  approved: boolean
  approvals_required: number
  approvals_left: number
  approved_by: GitLabApprovalUser[]
  user_has_approved: boolean
  user_can_approve: boolean
}

/** Normalized approval summary returned by enriched get_merge_request */
export interface ApprovalSummary {
  approved: boolean | null
  approvals_required: number
  approvals_left: number
  approved_by: GitLabUser[]
  approved_by_usernames: string[]
  user_has_approved: boolean
  user_can_approve: boolean
  source_endpoint: 'approval_state' | 'approvals'
}

/** Commit summary for enriched get_merge_request */
export interface CommitAdditionSummary {
  source_commit_count: number
  estimated_merge_commits: number
  merge_method: 'merge' | 'rebase_merge' | 'ff'
}

/** Deployment summary for enriched get_merge_request */
export interface DeploymentSummary {
  total_count: number
  records: GitLabDeployment[]
}

/** Wrapper for enrichment data that may fail independently */
export type EnrichmentResult<T> =
  | { available: true; data: T }
  | { available: false; unavailable_reason: string }

export interface GitLabLabel {
  id: number
  name: string
  color: string
  description: string | null
  text_color: string
}

export interface GitLabMergeRequest {
  id: number
  iid: number
  project_id: number
  title: string
  description: string | null
  state: 'opened' | 'closed' | 'merged' | 'locked'
  source_branch: string
  target_branch: string
  author: GitLabUser
  assignees: GitLabUser[]
  reviewers: GitLabUser[]
  labels: string[]
  web_url: string
  created_at: string
  updated_at: string
  merged_at: string | null
  closed_at: string | null
  draft: boolean
  work_in_progress: boolean
  merge_status: string
  has_conflicts: boolean
  diverged_commits_count?: number
  diff_refs: {
    base_sha: string
    head_sha: string
    start_sha: string
  } | null
}

export interface GitLabDiff {
  diff: string
  new_path: string
  old_path: string
  a_mode: string
  b_mode: string
  new_file: boolean
  renamed_file: boolean
  deleted_file: boolean
  generated_file: boolean
  collapsed: boolean
  too_large: boolean
}

export interface GitLabNote {
  id: number
  type: string | null
  body: string
  author: GitLabUser
  created_at: string
  updated_at: string
  system: boolean
  noteable_id: number
  noteable_type: string
  resolvable: boolean
  resolved: boolean
  resolved_by: GitLabUser | null
  confidential: boolean
}

export interface GitLabDiscussion {
  id: string
  individual_note: boolean
  notes: GitLabNote[]
}

export interface GitLabPosition {
  base_sha: string
  start_sha: string
  head_sha: string
  old_path?: string
  new_path: string
  position_type: 'text' | 'image' | 'file'
  old_line?: number | null
  new_line?: number | null
  line_range?: {
    start: { line_code: string; type: 'new' | 'old' }
    end: { line_code: string; type: 'new' | 'old' }
  }
}

/** Params for creating a simple note/comment (no inline positioning). */
export interface CreateNoteParams {
  body: string
}

/** Params for creating a discussion (supports inline diff comments via position). */
export interface CreateDiscussionParams {
  body: string
  position?: GitLabPosition
}

/** Pipeline from GET /projects/:id/merge_requests/:iid/pipelines */
export interface GitLabPipeline {
  id: number
  iid: number
  sha: string
  ref: string
  status: string
  source: string
  web_url: string
  created_at: string
  updated_at: string
}

/** Response from GET /projects/:id/repository/compare */
export interface GitLabCompareResult {
  commit: GitLabCommit | null
  commits: GitLabCommit[]
  diffs: GitLabDiff[]
  compare_timeout: boolean
  compare_same_ref: boolean
}

/** Response from GET /projects/:id/repository/files/:file_path */
export interface GitLabRepositoryFile {
  file_name: string
  file_path: string
  size: number
  encoding: string
  content: string
  ref: string
  blob_id: string
  commit_id: string
}

export interface ListMergeRequestsParams {
  state?: 'opened' | 'closed' | 'locked' | 'merged' | 'all'
  labels?: string[]
  source_branch?: string
  author_id?: number
  assignee_id?: number
  reviewer_id?: number
  scope?: 'created_by_me' | 'assigned_to_me' | 'reviews_for_me' | 'all'
  order_by?:
    | 'created_at'
    | 'updated_at'
    | 'label_priority'
    | 'milestone_due'
    | 'popularity'
    | 'priority'
    | 'title'
    | 'merged_at'
  sort?: 'asc' | 'desc'
  search?: string
  per_page?: number
  page?: number
}
