# AGENTS.md

## Project

This is a Bun and TypeScript MCP server for GitLab merge request review
workflows. It exposes stdio MCP tools for reading merge requests, posting
comments and suggestions, managing labels, tracking review sessions in SQLite,
and approving or unapproving merge requests.

Keep changes narrow and preserve the server's stdio contract: stdout is for MCP
JSON-RPC only. Use stderr, through `src/logger.ts`, for logs.

## Runtime And Package Manager

- Use Bun. The repo has `bun.lock`; do not switch package managers.
- Install with `bun install --frozen-lockfile`.
- Do not regenerate the lockfile unless explicitly asked.
- The server needs one of `GITLAB_PAT` or `GITLAB_OAUTH_TOKEN` to start.
- Optional runtime env vars are `GITLAB_BASE_URL`, `GITLAB_PROJECT_ID`, and
  `LOG_LEVEL`.
- Never commit `.env`, local database files, logs, `dist/`, or `node_modules/`.

## Verification

Use these non-mutating checks before calling work complete:

```bash
bun run typecheck
bun test
bun run lint
bun run format:check
```

Run the build when the change could affect startup, bundling, imports, or the
published entry point:

```bash
bun run build
```

`bun run check` and `bun run format` write changes. Use them only when you
intend to apply formatting fixes.

A local smoke start can be done without touching a real GitLab instance:

```bash
GITLAB_PAT=test-token GITLAB_BASE_URL=http://127.0.0.1:9 LOG_LEVEL=error bun run start
```

This should reach startup and log an `auth_check_failed` message. Stop the
process after confirming it starts; live GitLab API tool calls still require a
real token and project.

## Architecture

- `src/index.ts` is the process entry point.
- `src/server.ts` validates env vars, creates the MCP server, initializes the
  database, registers tools, connects stdio transport, and performs startup auth
  validation.
- `src/logger.ts` writes JSON lines to stderr and forwards MCP logging messages
  to the client. Do not use `console.log` in runtime code.
- `src/gitlab/client.ts` owns GitLab REST calls, retry/backoff, pagination, and
  API error handling. It also owns the GraphQL call used for GitLab reviewer
  state changes that REST does not expose, such as formally requesting changes.
- `src/gitlab/auth.ts` owns token selection and base URL handling.
- `src/gitlab/errors.ts` classifies GitLab API failures.
- `src/db/index.ts`, `src/db/schema.ts`, and `src/db/queries.ts` own SQLite
  schema, migrations, singleton lifecycle, and typed query helpers.
- `src/schemas/index.ts` owns all MCP tool input schemas. Field descriptions
  are part of the tool interface.
- `src/tools/index.ts` registers all tool groups and wraps `registerTool` for
  invocation logging.
- `src/tools/merge-requests.ts`, `src/tools/labels.ts`, `src/tools/reviews.ts`,
  and `src/tools/settings.ts` own individual MCP tool registrations.

## Tool Implementation Rules

When adding or changing a tool:

1. Add or update the Zod input schema in `src/schemas/index.ts`.
2. Register the tool in the relevant `src/tools/*.ts` file.
3. Add any required GitLab REST method in `src/gitlab/client.ts`.
4. If a new tool group is added, export and register it from `src/tools/index.ts`.
5. Add tests for schema validation and handler behavior.

Schema notes:

- Use `z.coerce.number()` for numeric IDs that LLMs may pass as strings.
- Use the existing `projectIdSchema`, `MrParamsSchema`, and `MrLookupSchema`
  where possible.
- Avoid schema-level `.refine()` on MCP input objects when it would turn a
  schema into `ZodEffects` and break JSON Schema serialization. Enforce those
  cross-field constraints in handlers instead, following `resolveMrIid()`.

Runtime notes:

- Set `readOnlyHint` accurately. Read tools should be read-only; comment,
  label, approval, setting, and review-session write tools should not.
- Use `resolveProjectId()` for project fallback behavior. Priority is explicit
  input, then stored setting, then `GITLAB_PROJECT_ID`.
- Use `getGitLabClient()` and `getQueries()` rather than manually constructing
  singletons in handlers.
- Keep GitLab API failures structured with `GitLabApiError`; do not swallow
  errors that should be visible to the MCP client.
- Keep generated-file filtering and pagination behavior covered by tests when
  touching MR diff or list endpoints.

## Database Guidance

The default SQLite file is `gitlab-mcp.db`, which is ignored by git. Tests should
prefer in-memory databases or the existing database singleton lifecycle helpers.
Call `closeDatabase()` in tests that initialize the singleton.

Migrations in `src/db/index.ts` are intentionally idempotent and currently
implemented as safe `ALTER TABLE` attempts. Preserve compatibility with existing
local review databases when changing schema.

Review sessions track both `head_sha` and `previous_head_sha` for re-review
intelligence. Be careful not to reset those fields accidentally when updating
review workflow behavior.

## Testing Guidance

Tests use `bun:test`. Existing coverage is broad and should stay fast:

- GitLab REST behavior is tested by mocking `globalThis.fetch`.
- Tool handlers are tested through `createMockMcpServer()` in
  `tests/helpers/index.ts`.
- SQLite behavior is tested with in-memory databases and singleton reset tests.
- Startup validation tests intentionally assert error output and `process.exit`
  behavior.

When a change touches a tool, update the matching handler tests under
`tests/tools/` and the relevant schema tests under `tests/schemas/`.
When a change touches `GitLabClient`, update `tests/gitlab/client.test.ts`.
When a change touches DB schema or queries, update `tests/db/`.

## Current Analysis Snapshot

Last verified locally on 2026-06-19 with Bun 1.3.10:

- `bun install --frozen-lockfile` passed.
- `bun run typecheck` passed.
- `bun test` passed: 408 tests, 817 assertions.
- `bun run lint` passed.
- `bun run format:check` passed.
- `bun run build` passed and produced ignored `dist/index.js`.
- Smoke start reached MCP startup and logged expected `auth_check_failed`
  against a dummy local GitLab URL.

Static analysis with Fallow 2.93.0:

- Health score: 85.7, grade A.
- Dead code: 8 findings total, with 7 unused exports and 1 unused type.
- No unused files, unused dependencies, unresolved imports, circular
  dependencies, re-export cycles, or dependency listing issues were reported.
- Duplication: 31 clone groups, 71 clone instances, 793 duplicated lines,
  roughly 7.93 percent duplication.
- The most actionable duplication is in `tests/gitlab/client.test.ts` and shared
  setup across `tests/tools/mr-handlers.test.ts` and
  `tests/tools/review-handlers.test.ts`. There is also repeated read-only MR
  handler boilerplate in `src/tools/merge-requests.ts`.

Known cleanup candidates, not applied:

- `src/server.ts` exports `createServer`, but current project imports do not use
  that export.
- `src/tools/index.ts` re-exports individual register functions that current
  project imports do not use.
- `tests/helpers/index.ts` exports `mockResponseWithHeaders`,
  `TestableClient`, and `CapturedTool` without current imports.

Treat these as review prompts, not automatic removals. Some exports may be
intentional public or test helper API.
