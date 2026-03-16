# gitlab-mcp

<!-- CI badge: update the URL once the repo is pushed to GitHub -->
<!-- ![CI](https://github.com/<owner>/gitlab-mcp/actions/workflows/ci.yml/badge.svg) -->

An MCP (Model Context Protocol) server for AI-powered GitLab merge request code reviews.

Provides 23 tools that give an AI agent everything it needs to perform thorough, structured code reviews: fetch MR details, read diffs and files, post inline comments and suggestions, manage labels, track review sessions with re-review intelligence, and approve/unapprove merge requests.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- A GitLab Personal Access Token (PAT) or OAuth token with `api` scope

## Quick Start

```bash
# Clone and install
git clone <your-repo-url>
cd gitlab-mcp
bun install

# Configure authentication
cp .env.example .env
# Edit .env with your GitLab PAT (see "Creating Tokens" below)

# Run the server (stdio transport)
bun run start
```

> **Note:** The `.env` file is automatically loaded when you run `bun run start` or `bun run dev` directly. When the server is spawned as a subprocess by an MCP client (Claude Code, OpenCode, etc.), environment variables must be passed through the client's configuration — see the setup examples below.

## MCP Client Setup

Connect this server to your AI coding agent. The server uses **stdio transport** — it communicates over stdin/stdout.

### Claude Code

Add via the CLI:

```bash
claude mcp add gitlab-mr-review --transport stdio \
  --env GITLAB_PAT=glpat-xxxxxxxxxxxxxxxxxxxx \
  --env GITLAB_BASE_URL=https://gitlab.com \
  --env GITLAB_PROJECT_ID=my-group/my-project \
  -- bun run start
```

Or to share with your team, add a `.mcp.json` file to the project root (use `--scope project`):

```bash
claude mcp add gitlab-mr-review --transport stdio --scope project \
  --env GITLAB_PAT=glpat-xxxxxxxxxxxxxxxxxxxx \
  --env GITLAB_BASE_URL=https://gitlab.com \
  --env GITLAB_PROJECT_ID=my-group/my-project \
  -- bun run start
```

This creates a `.mcp.json` that can be committed to version control:

```json
{
  "mcpServers": {
    "gitlab-mr-review": {
      "command": "bun",
      "args": ["run", "start"],
      "env": {
        "GITLAB_PAT": "${GITLAB_PAT}",
        "GITLAB_BASE_URL": "${GITLAB_BASE_URL:-https://gitlab.com}",
        "GITLAB_PROJECT_ID": "${GITLAB_PROJECT_ID}"
      }
    }
  }
}
```

> **Tip:** Claude Code supports `${VAR}` and `${VAR:-default}` syntax in `.mcp.json`, so you can reference environment variables instead of hardcoding secrets.

### OpenCode

Add the server to your `opencode.json` (or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gitlab-mr-review": {
      "type": "local",
      "command": ["bun", "run", "start"],
      "enabled": true,
      "environment": {
        "GITLAB_PAT": "{env:GITLAB_PAT}",
        "GITLAB_BASE_URL": "{env:GITLAB_BASE_URL}",
        "GITLAB_PROJECT_ID": "{env:GITLAB_PROJECT_ID}"
      }
    }
  }
}
```

> **Tip:** OpenCode uses `{env:VAR}` syntax to reference environment variables. Set `GITLAB_PAT`, `GITLAB_BASE_URL`, and `GITLAB_PROJECT_ID` in your shell environment or `.env` file.

### Environment Variables

Both clients need these environment variables to be available:

| Variable | Required | Description |
|---|---|---|
| `GITLAB_PAT` | Yes* | GitLab Personal Access Token (`glpat-...`) |
| `GITLAB_OAUTH_TOKEN` | Yes* | OAuth token (alternative to PAT) |
| `GITLAB_BASE_URL` | No | GitLab instance URL (defaults to `https://gitlab.com`) |
| `GITLAB_PROJECT_ID` | No | Default project ID or path (e.g., `my-group/my-project`) |
| `LOG_LEVEL` | No | Minimum log level: `debug`, `info`, `warning`, `error` (default: `info`) |

\* One of `GITLAB_PAT` or `GITLAB_OAUTH_TOKEN` is required.

> **Important:** When the server is launched as an MCP subprocess (by Claude Code, OpenCode, etc.), the `.env` file is **not** loaded automatically. Configure environment variables through your MCP client's config (see the Claude Code and OpenCode examples above). The `.env` file is only used when running the server directly via `bun run start` or `bun run dev`.

### Creating Tokens

#### Personal Access Token (PAT) — Recommended

1. Go to your GitLab instance → click your **Avatar** (top-right) → **Edit profile**
2. In the left sidebar, select **Access** → **Personal access tokens**
3. Select **Add new token**
4. Fill in:
   - **Token name**: e.g., `mcp-code-review`
   - **Expiration date**: set an appropriate date (max 365 days)
   - **Scopes**: select **`api`** (required for full read/write access to MRs, discussions, labels, approvals)
5. Select **Create personal access token**
6. **Copy the token immediately** — it won't be shown again
7. Set it as `GITLAB_PAT` in your environment or MCP client config

The token will look like `glpat-xxxxxxxxxxxxxxxxxxxx`.

For full details, see the [GitLab PAT documentation](https://docs.gitlab.com/user/profile/personal_access_tokens/#create-a-personal-access-token).

#### OAuth 2.0 Token (Alternative)

If you have an OAuth 2.0 access token obtained through an [OAuth2 authorization flow](https://docs.gitlab.com/api/oauth2/), set it as `GITLAB_OAUTH_TOKEN`. The server sends it via the `Authorization: Bearer` header.

Note: OAuth tokens expire after 2 hours and require external refresh. For MCP server use, **PATs are recommended** as they have longer lifetimes and don't require a refresh flow.

### Default Project ID

Most tools require a `project_id` parameter. You can skip passing it explicitly by configuring a default:

1. **Environment variable:** Set `GITLAB_PROJECT_ID` in your `.env`
2. **Runtime setting:** Call `set_setting(key: "default_project_id", value: "group/project")`
3. **Explicit parameter:** Always wins when provided

Priority: explicit param > runtime setting > env var.

## Available Tools

### Merge Request Tools (13)

| Tool | Description |
|---|---|
| `get_merge_request` | Fetch enriched MR details (approvals, commits, deployments) |
| `get_mr_diff` | Get MR diff with file filtering and generated-file exclusion |
| `get_mr_discussions` | List all discussion threads on an MR |
| `get_mr_commits` | List commits in an MR |
| `get_mr_file_content` | Read a file from the MR branch (base64 decoded) |
| `get_mr_pipelines` | Get CI/CD pipeline status for an MR |
| `get_mr_changes_since` | Diff changes since a previous review SHA |
| `list_merge_requests` | List MRs with filtering (state, labels, scope, search) |
| `create_merge_request_note` | Post a comment on an MR |
| `create_mr_discussion_reply` | Reply to an existing discussion thread |
| `resolve_merge_request_thread` | Resolve or unresolve a discussion thread |
| `approve_merge_request` | Approve an MR (with optional SHA safety check) |
| `unapprove_merge_request` | Remove approval from an MR |

### Label Tools (4)

| Tool | Description |
|---|---|
| `get_project_labels` | List all labels in a project |
| `add_mr_label` | Add a label to an MR |
| `remove_mr_label` | Remove a label from an MR |
| `set_mr_labels` | Replace all labels on an MR |

### Review Session Tools (4)

| Tool | Description |
|---|---|
| `start_review` | Start or resume a review session (detects re-reviews, tracks SHA) |
| `add_review_comment` | Add a comment or suggestion to the review (posts to GitLab inline) |
| `get_review_status` | Get review progress with item details and resolution status |
| `complete_review` | Finalize review: update status, post summary, set labels, approve |

### Settings Tools (2)

| Tool | Description |
|---|---|
| `get_setting` | Read a configuration value |
| `set_setting` | Store a configuration value |

## Usage with AI Code Reviewer

The typical review workflow:

```
1. start_review        -- Start a session, detect re-reviews
2. get_merge_request   -- Fetch MR details, approvals, CI status
3. get_mr_diff         -- Read the diff (auto-filters generated files)
4. get_mr_file_content -- Read full files for context
5. add_review_comment  -- Post inline comments and suggestions
6. complete_review     -- Post summary, set labels, approve/request changes
```

On re-review, `start_review` automatically detects previous sessions and provides:
- Resolution status of prior comments
- Whether new commits have been pushed since last review
- A diff of changes since the last review via `get_mr_changes_since`

## Architecture

```
MCP Client (AI Agent)
       |
       | stdio (JSON-RPC)
       |
  MCP Server (Bun)
   /        \
GitLab API   SQLite
 (REST)     (bun:sqlite)
```

- **Transport:** stdio (stdin/stdout for JSON-RPC, stderr for logs)
- **GitLab Client:** HTTP with retry/backoff, pagination, structured errors
- **Database:** SQLite for review sessions, review items, and settings
- **Logging:** Dual-mode -- JSON to stderr + MCP logging messages to client

## Development

```bash
bun run dev          # Start with hot reload
bun run start        # Start server (stdio transport)
bun run typecheck    # TypeScript type checking
bun test             # Run all tests
bun run lint         # Lint with Biome
bun run format       # Format with Biome
bun run check        # Lint + format with Biome
bun run build        # Build to dist/
```

### Project Structure

```
src/
  index.ts              Entry point
  server.ts             MCP server setup, environment validation
  logger.ts             Structured logging (stderr JSON + MCP)
  tools/
    index.ts            Tool registry with auto-logging wrapper
    merge-requests.ts   13 MR tools
    labels.ts           4 label tools
    reviews.ts          4 review session tools
    settings.ts         2 settings tools
  gitlab/
    client.ts           REST client (22 methods, retry, pagination)
    auth.ts             PAT/OAuth token handling
    errors.ts           GitLabApiError with classification
    types.ts            GitLab API response types
  db/
    index.ts            SQLite init, migrations, singleton
    schema.ts           Table DDL + TypeScript interfaces
    queries.ts          Typed query helpers
  schemas/
    index.ts            Zod schemas for all tool inputs
tests/
  16 test files, 351 tests, 698 expect() calls
```

### Adding a New Tool

1. Add Zod schema to `src/schemas/index.ts`
2. Add tool registration in the appropriate `src/tools/*.ts` file
3. If new file, export register function and add to `src/tools/index.ts`
4. Add tests
5. Run `bun run typecheck && bun test && bun run check`

## License

ISC
