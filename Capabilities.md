# GitLab MCP Server — Capabilities Reference

Comprehensive reference for all 23 tools provided by the `gitlab-mcp` MCP server.
Designed for LLM consumption — use this to understand what tools are available,
what parameters they accept, what they return, and how to orchestrate them into
review workflows.

---

## Quick Start

### Setting the Default Project

Most tools require a `project_id`. Rather than passing it on every call, set a
default once per session:

```json
set_setting({ "key": "default_project_id", "value": "my-group/my-project" })
```

### Project ID Resolution

Every tool that accepts `project_id` resolves it through a 3-level fallback:

1. **Explicit parameter** — the `project_id` value passed in the tool call
2. **Stored setting** — `default_project_id` from the settings DB (via `set_setting`)
3. **Environment variable** — `GITLAB_PROJECT_ID`

If none are found, the tool throws with an actionable error listing all three options.

`project_id` accepts both numeric IDs (`12345`) and path strings (`"group/project"`).

### MR Lookup: `mr_iid` vs `source_branch`

Some tools accept **either** `mr_iid` (the merge request number) or `source_branch`
(the branch name). When `source_branch` is provided, the server queries GitLab for
the open MR with that source branch and resolves the IID automatically.

Tools supporting branch lookup: `get_merge_request`, `get_mr_diff`,
`get_mr_discussions`, `get_mr_commits`.

All other tools require `mr_iid` directly.

### Type Coercion

Parameters are flexible about types to accommodate LLM output:
- `project_id` accepts `string` or `number` (coerced to string)
- `mr_iid` accepts `string` or `number` (coerced to integer)
- `session_id` accepts `string` or `number` (coerced to integer)

---

## Settings Tools

### `set_setting`

Store a configuration value. Creates the key if new, updates if it exists.
Local-only — no GitLab API call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Setting key (e.g., `"default_project_id"`, `"review_labels"`, `"excluded_file_patterns"`) |
| `value` | string | yes | Setting value (use JSON strings for complex values) |

**Response:**
```json
{ "success": true, "key": "default_project_id", "value": "group/project" }
```

### `get_setting`

Read a configuration value. Local-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Setting key to retrieve |

**Response (key exists):**
```json
{ "key": "default_project_id", "value": "group/project" }
```

**Response (key not set):**
```json
{ "key": "default_project_id", "value": null, "message": "Setting \"default_project_id\" is not configured." }
```

---

## Merge Request Tools — Read

### `get_merge_request`

Fetch enriched merge request details. Returns the full MR object plus three
parallel enrichments: approval summary, commit count, and deployment summary.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | no* | MR IID |
| `source_branch` | string | no* | Source branch (resolves to open MR) |

*At least one of `mr_iid` or `source_branch` required.

**Response:** Full `GitLabMergeRequest` object with these additional fields:

```json
{
  "id": 464526581,
  "iid": 1,
  "title": "Edit README.md",
  "state": "opened",
  "source_branch": "test",
  "target_branch": "main",
  "author": { "username": "dan513", "name": "..." },
  "labels": ["mr:review"],
  "web_url": "https://gitlab.com/...",
  "diff_refs": {
    "base_sha": "d191713e...",
    "head_sha": "d3e3752d...",
    "start_sha": "d191713e..."
  },
  "approval_summary": {
    "available": true,
    "data": {
      "approved": false,
      "approvals_required": 0,
      "approvals_left": 0,
      "approved_by": [],
      "approved_by_usernames": [],
      "user_has_approved": false,
      "user_can_approve": false,
      "source_endpoint": "approval_state"
    }
  },
  "commit_addition_summary": {
    "available": true,
    "data": {
      "source_commit_count": 1,
      "estimated_merge_commits": 1,
      "merge_method": "merge"
    }
  },
  "deployment_summary": {
    "available": true,
    "data": { "total_count": 0, "records": [] }
  }
}
```

**Key fields for review workflows:**
- `diff_refs.base_sha`, `head_sha`, `start_sha` — needed for `add_review_comment` position
- `state` — `"opened"`, `"closed"`, `"merged"`, `"locked"`
- `has_conflicts` — whether the MR has merge conflicts
- `detailed_merge_status` — `"mergeable"`, `"not_approved"`, etc.
- `draft` — whether this is a draft/WIP MR

**Enrichment behavior:** Each enrichment is wrapped in `safeEnrich()` — if one
fails (e.g., permissions), the others still succeed. Check `available: false` and
read `unavailable_reason` for failures.

---

### `get_mr_diff`

Get the code diff for a merge request. Supports file exclusion via regex.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | no* | MR IID |
| `source_branch` | string | no* | Source branch |
| `excluded_file_patterns` | string[] | no | Regex patterns to exclude files (e.g., `["package-lock\\.json"]`) |
| `include_generated` | boolean | no | Include generated files (default: `false`) |

**Response:** Array of diff objects:

```json
[
  {
    "diff": "@@ -1,6 +1,6 @@\n # Project\n-\n+New content\n",
    "new_path": "README.md",
    "old_path": "README.md",
    "new_file": false,
    "renamed_file": false,
    "deleted_file": false,
    "generated_file": false
  }
]
```

**Filtering behavior:**
- Generated files (`generated_file: true`) are excluded by default
- Each `excluded_file_patterns` regex is tested against both `new_path` and `old_path`

---

### `get_mr_discussions`

Fetch all discussion threads and comments, including resolved status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | no* | MR IID |
| `source_branch` | string | no* | Source branch |

**Response:** Array of discussion objects:

```json
[
  {
    "id": "3c62c8b8...",
    "individual_note": false,
    "resolvable": true,
    "resolved": true,
    "notes": [
      {
        "id": 3164131011,
        "type": "DiffNote",
        "body": "Comment text...",
        "author": { "username": "reviewer", "name": "..." },
        "created_at": "2026-03-16T19:33:05.332Z",
        "resolvable": true,
        "resolved": true,
        "position": {
          "new_path": "README.md",
          "new_line": 3,
          "old_line": null,
          "position_type": "text"
        }
      }
    ]
  }
]
```

**Note types:** `"DiffNote"` (inline on code), `"DiscussionNote"` (general thread),
`null` (system note like "approved this merge request").

---

### `get_mr_commits`

Fetch all commits in a merge request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | no* | MR IID |
| `source_branch` | string | no* | Source branch |

**Response:** Array of commit objects:

```json
[
  {
    "id": "d3e3752d8cf7aca08ff98ae867dcf44dccf65811",
    "short_id": "d3e3752d",
    "title": "Edit README.md",
    "message": "Edit README.md",
    "author_name": "Dragomir Dan Alexandru",
    "author_email": "dan@dragomirweb.com",
    "created_at": "2026-03-16T18:34:12.000+00:00",
    "web_url": "https://gitlab.com/.../commit/d3e3752d..."
  }
]
```

---

### `get_mr_pipelines`

Fetch all CI/CD pipelines for a merge request. Useful for checking CI status
before approving.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |

**Note:** Does NOT support `source_branch` — requires `mr_iid` directly.

**Response:** Array of pipeline objects:

```json
[
  {
    "id": 12345,
    "sha": "d3e3752d...",
    "ref": "test",
    "status": "success",
    "web_url": "https://gitlab.com/.../pipelines/12345"
  }
]
```

Returns `[]` if no CI is configured.

---

### `get_mr_changes_since`

Get files changed since a specific commit SHA. Designed for re-reviews — shows
what changed since you last looked.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |
| `since_sha` | string | no | Base SHA to compare from. If omitted, auto-uses `previous_head_sha` from the active review session. |

**Response:**

```json
{
  "since_sha": "d191713e...",
  "head_sha": "d3e3752d...",
  "commits": [ { "id": "...", "title": "...", "author_name": "..." } ],
  "diffs": [ { "diff": "...", "new_path": "README.md", "old_path": "README.md" } ],
  "compare_timeout": false,
  "message": "1 commit(s) and 1 file(s) changed since d191713e."
}
```

**Auto-resolve behavior:** When `since_sha` is omitted, the tool looks up the
active review session for this MR and uses `previous_head_sha` — the HEAD SHA
from when the review was last started. This is the key mechanism for incremental
re-reviews.

If `since_sha` equals the current `head_sha`, returns empty commits/diffs with
message `"No changes since the last review."`.

---

### `get_mr_file_content`

Read a file's content from a specific branch, tag, or commit SHA. Use this to
read the full file for accurate line-number context during review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `file_path` | string | yes | File path in the repository (e.g., `"src/index.ts"`) |
| `ref` | string | yes | Branch name, tag, or commit SHA |

**Response:**

```json
{
  "file_path": "README.md",
  "ref": "test",
  "size": 6048,
  "content": "# Project\n\nFull file content here..."
}
```

**Note:** Content is automatically decoded from base64 (the GitLab API's native format).

---

### `list_merge_requests`

List merge requests with filters. Useful for finding MRs to review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `state` | `"opened"` / `"closed"` / `"locked"` / `"merged"` / `"all"` | no | Filter by state |
| `labels` | string[] | no | Filter by labels |
| `scope` | `"created_by_me"` / `"assigned_to_me"` / `"reviews_for_me"` / `"all"` | no | Filter by scope |
| `order_by` | `"created_at"` / `"updated_at"` / `"popularity"` / `"priority"` / etc. | no | Sort field (default: `created_at`) |
| `sort` | `"asc"` / `"desc"` | no | Sort direction (default: `desc`) |
| `search` | string | no | Search title and description |
| `page` | number | no | Page number (default: 1) |
| `per_page` | number | no | Items per page (max 100, default: 20) |

**Response:** Array of `GitLabMergeRequest` objects (same shape as `get_merge_request` but without the enrichments).

---

## Merge Request Tools — Write

### `create_merge_request_note`

Post a standalone comment on a merge request. Not tied to a review session —
use this for general remarks, summaries, or one-off comments.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |
| `body` | string | yes | Comment content (supports GitLab markdown) |

**Response:**
```json
{ "success": true, "note_id": 3164132179, "body": "Your comment text" }
```

---

### `create_mr_discussion_reply`

Reply to an existing discussion thread. Use this to respond to developer
comments or follow up on review feedback.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |
| `discussion_id` | string | yes | Discussion thread ID to reply to |
| `body` | string | yes | Reply content (supports GitLab markdown) |

**Response:**
```json
{ "success": true, "note_id": 3164132360, "discussion_id": "3c62c8b8..." }
```

---

### `resolve_merge_request_thread`

Resolve or unresolve a discussion thread.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |
| `discussion_id` | string | yes | Discussion thread ID |
| `resolved` | boolean | yes | `true` to resolve, `false` to unresolve |

**Response:**
```json
{ "success": true, "discussion_id": "3c62c8b8...", "resolved": true }
```

---

### `approve_merge_request`

Approve a merge request. Optionally provide a SHA safety check.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |
| `sha` | string | no | Expected HEAD SHA — approval fails if MR was updated since this SHA |

**Response:**
```json
{ "success": true, "message": "Merge request !1 approved." }
```

---

### `unapprove_merge_request`

Remove your approval from a merge request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |

**Response:**
```json
{ "success": true, "message": "Approval removed from merge request !1." }
```

---

## Label Tools

### `get_project_labels`

List all labels available in the project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |

**Response:** Array of label objects:

```json
[
  { "id": 49394271, "name": "mr:review", "color": "#6699cc" },
  { "id": 49394276, "name": "mr:suggestions", "color": "#ed9121" }
]
```

---

### `add_mr_label`

Add a single label to a merge request. Keeps existing labels.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |
| `label` | string | yes | Label name to add |

**Response:**
```json
{ "success": true, "labels": ["mr:review", "mr:suggestions"] }
```

---

### `remove_mr_label`

Remove a single label from a merge request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |
| `label` | string | yes | Label name to remove |

**Response:**
```json
{ "success": true, "labels": ["mr:review"] }
```

---

### `set_mr_labels`

Replace all labels on a merge request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |
| `labels` | string[] | yes | Labels to set (replaces all existing) |

**Response:**
```json
{ "success": true, "labels": ["mr:review"] }
```

---

## Review Session Tools

These tools implement a stateful review lifecycle tracked in a local SQLite
database. Review sessions persist across tool calls, enabling re-reviews,
resolution tracking, and incremental diffs.

### `start_review`

Start a new review session, or resume an existing active session for re-review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | yes | MR IID |

**Response (new session):**
```json
{
  "session": {
    "id": 1,
    "mr_iid": 1,
    "project_id": "dan513/gitlab-mcp-test",
    "source_branch": "test",
    "status": "in_progress",
    "head_sha": "d3e3752d...",
    "previous_head_sha": null,
    "started_at": "2026-03-16 19:32:58",
    "updated_at": "2026-03-16 19:32:58"
  },
  "is_rereview": false,
  "message": "New review session started."
}
```

**Response (re-review — existing active session):**
```json
{
  "session": { "id": 1, "status": "pending_changes", "head_sha": "new_sha...", "previous_head_sha": "old_sha..." },
  "is_rereview": true,
  "has_new_commits": true,
  "items": [
    {
      "id": 1, "type": "comment", "file_path": "src/foo.ts", "line_number": 42,
      "content": "Original review comment...",
      "resolved": 1, "gitlab_resolved": true,
      "developer_replies": [
        { "author": "dev-user", "body": "Fixed!", "created_at": "..." }
      ]
    }
  ],
  "total_items": 5,
  "resolved_items": 3,
  "unresolved_items": 2,
  "all_resolved": false,
  "message": "Existing review session found. 3 of 5 issues resolved, 2 still open. New commits detected since last review."
}
```

**Key behavior:**
- If an active session (`in_progress` or `pending_changes`) already exists for
  this MR, it is returned with enriched resolution status — this is the re-review path.
- On re-review, the HEAD SHA rotates: current `head_sha` moves to
  `previous_head_sha`, and the new HEAD from GitLab becomes `head_sha`.
  This enables `get_mr_changes_since` to auto-detect what changed.

---

### `add_review_comment`

Post a comment or suggestion on the merge request and track it locally for
resolution checking.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | number | yes | Review session ID (from `start_review`) |
| `content` | string | yes | Comment content |
| `type` | `"comment"` / `"suggestion"` | no | Comment type (default: `"comment"`) |
| `file_path` | string | no | File path for inline comments (when `position` is not provided) |
| `line_number` | number | no | Line number for inline comments (when `position` is not provided) |
| `position` | object | no | Diff position for precise inline code comments (see below) |

**`position` object (for inline diff comments):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `base_sha` | string | yes | From `diff_refs.base_sha` |
| `head_sha` | string | yes | From `diff_refs.head_sha` |
| `start_sha` | string | yes | From `diff_refs.start_sha` |
| `new_path` | string | yes | File path after changes |
| `old_path` | string | no | File path before changes (for renames) |
| `new_line` | number | no | Line in new version (additions/modifications) |
| `old_line` | number | no | Line in old version (deletions) |
| `position_type` | `"text"` / `"image"` / `"file"` | no | Default: `"text"` |

**Response:**
```json
{
  "success": true,
  "item": {
    "id": 1,
    "session_id": 1,
    "gitlab_note_id": 3164131011,
    "discussion_id": "3c62c8b8...",
    "type": "comment",
    "file_path": "README.md",
    "line_number": 3,
    "content": "Comment text...",
    "resolved": 0,
    "created_at": "2026-03-16 19:33:05"
  },
  "gitlab_discussion_id": "3c62c8b8..."
}
```

**Key behavior:**
- **Suggestion formatting:** When `type` is `"suggestion"` and a file context is
  available, the content is auto-wrapped in GitLab suggestion markdown.
- **Position vs file_path:** Use `position` for precise diff-line comments (requires
  SHAs from `diff_refs`). Use `file_path` + `line_number` for simpler inline comments.
- **Local tracking:** `file_path` and `line_number` are extracted from the `position`
  object when top-level params are not provided.
- **Session status:** Automatically sets session status to `"pending_changes"`.

---

### `get_review_status`

Check resolution status of all tracked review items. Cross-references local
tracking with live GitLab discussion state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string/number | no | GitLab project ID or path |
| `mr_iid` | number | no* | MR IID |
| `branch` | string | no* | Source branch name (alternative to mr_iid) |

*At least one of `mr_iid` or `branch` required.

**Response:**
```json
{
  "session": { "id": 1, "status": "pending_changes", "head_sha": "d3e3752d..." },
  "items": [
    {
      "id": 1,
      "discussion_id": "3c62c8b8...",
      "type": "comment",
      "file_path": "README.md",
      "line_number": 3,
      "content": "Original comment...",
      "resolved": 0,
      "gitlab_resolved": false,
      "developer_replies": []
    },
    {
      "id": 2,
      "discussion_id": "abcdef12...",
      "type": "comment",
      "file_path": "src/index.ts",
      "line_number": 42,
      "content": "Another comment...",
      "resolved": 1,
      "gitlab_resolved": true,
      "developer_replies": [
        { "author": "dev-user", "body": "Fixed this.", "created_at": "..." }
      ]
    }
  ],
  "total_items": 2,
  "resolved_items": 1,
  "unresolved_items": 1,
  "all_resolved": false,
  "message": "1 item(s) still need to be resolved."
}
```

**Enrichment behavior:** Fetches all GitLab discussions for the MR and:
- Sets `gitlab_resolved` based on whether the discussion thread is resolved on GitLab
- Extracts `developer_replies` — all non-system notes after the original review comment
- Updates the local DB when items are found to be resolved on GitLab

---

### `complete_review`

Complete a review session with a final status. Can post a summary, set labels,
and approve the MR in a single call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | number | yes | Review session ID |
| `status` | `"approved"` / `"closed"` | yes | Final review status |
| `summary_comment` | string | no | Summary comment to post on the MR |
| `labels` | string[] | no | Labels to set (replaces all existing) |
| `approve` | boolean | no | Also approve the MR on GitLab (only when `status` is `"approved"`) |

**Response:**
```json
{
  "success": true,
  "session_id": 1,
  "status": "approved",
  "actions": ["summary_comment_posted", "labels_updated", "mr_approved"],
  "message": "Review session marked as approved."
}
```

**Multi-action orchestration:** Performs up to 4 actions in sequence:
1. Updates local session status in SQLite
2. Posts `summary_comment` as a note on GitLab (if provided)
3. Sets `labels` on the MR (if provided)
4. Approves the MR (if `approve: true` AND `status === "approved"`)

The `actions` array reports which GitLab operations were actually performed.
If `approve: true` but `status` is `"closed"`, approval is skipped with
`approve_skipped: true` and `approve_skipped_reason` in the response.

---

## Workflows

### First Review

Complete review workflow from start to finish.

```
Step 1: Set default project
  set_setting({ key: "default_project_id", value: "dan513/gitlab-mcp-test" })

Step 2: Get MR overview
  get_merge_request({ mr_iid: 1 })
  → Read: title, description, author, state, labels, diff_refs, approval status

Step 3: Get the diff
  get_mr_diff({ mr_iid: 1 })
  → Review each file's changes

Step 4: Read full files for context (as needed)
  get_mr_file_content({ file_path: "README.md", ref: "test" })
  → Use ref = source_branch to read the current state of changed files

Step 5: Start a review session
  start_review({ mr_iid: 1 })
  → Returns session_id (e.g., 1) and head_sha

Step 6: Post review comments (repeat as needed)

  Inline diff comment (precise placement):
  add_review_comment({
    session_id: 1,
    content: "This change removes a blank line that served as a visual separator.",
    position: {
      base_sha: "d191713e1a24991c64d19fbe7759663cfdf93fe8",
      head_sha: "d3e3752d8cf7aca08ff98ae867dcf44dccf65811",
      start_sha: "d191713e1a24991c64d19fbe7759663cfdf93fe8",
      new_path: "README.md",
      new_line: 3
    }
  })

  General comment (not tied to a specific line):
  add_review_comment({
    session_id: 1,
    content: "Overall the changes look good but need more descriptive text."
  })

Step 7: Check review status
  get_review_status({ mr_iid: 1 })
  → See all posted comments and their resolution state

Step 8: Complete the review
  complete_review({
    session_id: 1,
    status: "approved",
    summary_comment: "LGTM — minor suggestions posted inline.",
    labels: ["mr:review"],
    approve: true
  })
```

---

### Re-review (After Developer Pushes Fixes)

Incremental review focusing only on what changed since last review.

```
Step 1: Resume the existing session
  start_review({ mr_iid: 1 })
  → Returns is_rereview: true, has_new_commits: true/false
  → Shows resolution status of all previous comments
  → Rotates HEAD SHA: old head_sha → previous_head_sha

Step 2: See what changed since last review
  get_mr_changes_since({ mr_iid: 1 })
  → Automatically uses previous_head_sha as the base
  → Returns only the new commits and diffs since your last review

Step 3: Check resolution of previous comments
  get_review_status({ mr_iid: 1 })
  → See which items are resolved, which have developer replies

Step 4: Resolve fixed threads
  resolve_merge_request_thread({
    mr_iid: 1,
    discussion_id: "3c62c8b8...",
    resolved: true
  })

Step 5: Post new comments on remaining issues (if any)
  add_review_comment({ session_id: 1, content: "..." })

Step 6: Complete
  complete_review({
    session_id: 1,
    status: "approved",
    summary_comment: "All issues addressed. Approved.",
    approve: true
  })
```

---

### Quick Label + Approve (No Review Session)

Lightweight flow when no inline comments are needed.

```
Step 1: Review the MR
  get_merge_request({ mr_iid: 1 })
  get_mr_diff({ mr_iid: 1 })

Step 2: Approve and label directly
  approve_merge_request({ mr_iid: 1, sha: "d3e3752d..." })
  set_mr_labels({ mr_iid: 1, labels: ["mr:approved"] })

Step 3: Post a summary note
  create_merge_request_note({ mr_iid: 1, body: "Reviewed — looks good. Approved." })
```

---

## Review Session Lifecycle

### State Diagram

```
  start_review()
       │
       ▼
  ┌─────────────┐
  │ in_progress  │ ← freshly started, no comments yet
  └──────┬──────┘
         │ add_review_comment()
         ▼
  ┌─────────────────┐
  │ pending_changes  │ ← at least one comment posted
  └──────┬──────────┘
         │ complete_review()
         ▼
  ┌──────────┐   ┌────────┐
  │ approved │   │ closed │
  └──────────┘   └────────┘
```

- `in_progress` and `pending_changes` are "active" — `start_review` returns them
- `approved` and `closed` are "terminal" — a new `start_review` creates a fresh session

### HEAD SHA Rotation (Re-reviews)

```
First review:
  head_sha = "abc123"
  previous_head_sha = null

Developer pushes fixes...

Re-review (start_review called again):
  head_sha = "def456"          ← new HEAD from GitLab
  previous_head_sha = "abc123" ← old HEAD moves here

get_mr_changes_since() auto-uses previous_head_sha → shows only new changes
```

---

## Tool Summary Table

| Tool | Category | Mutates | Needs mr_iid | Branch Lookup |
|------|----------|---------|--------------|---------------|
| `set_setting` | Settings | yes | no | no |
| `get_setting` | Settings | no | no | no |
| `get_merge_request` | MR Read | no | yes* | yes |
| `get_mr_diff` | MR Read | no | yes* | yes |
| `get_mr_discussions` | MR Read | no | yes* | yes |
| `get_mr_commits` | MR Read | no | yes* | yes |
| `get_mr_pipelines` | MR Read | no | yes | no |
| `get_mr_changes_since` | MR Read | no | yes | no |
| `get_mr_file_content` | MR Read | no | no | no |
| `list_merge_requests` | MR Read | no | no | no |
| `create_merge_request_note` | MR Write | yes | yes | no |
| `create_mr_discussion_reply` | MR Write | yes | yes | no |
| `resolve_merge_request_thread` | MR Write | yes | yes | no |
| `approve_merge_request` | MR Write | yes | yes | no |
| `unapprove_merge_request` | MR Write | yes | yes | no |
| `get_project_labels` | Labels | no | no | no |
| `add_mr_label` | Labels | yes | yes | no |
| `remove_mr_label` | Labels | yes | yes | no |
| `set_mr_labels` | Labels | yes | yes | no |
| `start_review` | Review | yes | yes | no |
| `add_review_comment` | Review | yes | no** | no |
| `get_review_status` | Review | no | yes* | no*** |
| `complete_review` | Review | yes | no** | no |

\* Accepts `mr_iid` or `source_branch` — at least one required.
\** Uses `session_id` instead of `mr_iid`.
\*** Supports `branch` parameter for session lookup, but this queries the local
    DB by branch name, not the GitLab API.
