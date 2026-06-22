/**
 * GitLab REST API client
 */

import { logger } from '../logger'
import type { AuthHeader } from './auth'
import { getAuthConfig, getAuthHeader, getBaseUrl } from './auth'
import { GitLabApiError } from './errors'
import type {
  CreateDiscussionParams,
  CreateNoteParams,
  GitLabApprovalState,
  GitLabApprovals,
  GitLabCommit,
  GitLabCompareResult,
  GitLabDeployment,
  GitLabDiff,
  GitLabDiscussion,
  GitLabLabel,
  GitLabMergeRequest,
  GitLabNote,
  GitLabPipeline,
  GitLabProject,
  GitLabRequestChangesResult,
  GitLabRepositoryFile,
  ListMergeRequestsParams,
} from './types'

/** Default maximum number of retries for transient errors. */
const DEFAULT_MAX_RETRIES = 3

/** Base delay in milliseconds for exponential backoff (1s, 2s, 4s). */
const BASE_RETRY_DELAY_MS = 1000

interface GitLabGraphQLError {
  message: string
}

interface GitLabGraphQLResponse<TData> {
  data?: TData
  errors?: GitLabGraphQLError[]
}

interface RequestChangesMutationData {
  mergeRequestRequestChanges: GitLabRequestChangesResult | null
}

export class GitLabClient {
  private baseUrl: string
  private authHeader: AuthHeader

  constructor() {
    this.baseUrl = getBaseUrl()
    const authConfig = getAuthConfig()
    this.authHeader = getAuthHeader(authConfig)
  }

  /**
   * Low-level HTTP request. Handles auth headers, JSON serialization,
   * and throws {@link GitLabApiError} on non-OK responses.
   *
   * Callers should prefer {@link requestWithRetry} for automatic retry
   * of transient failures.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v4${path}`
    const start = performance.now()

    const response = await fetch(url, {
      method,
      headers: {
        [this.authHeader.name]: this.authHeader.value,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    const durationMs = Math.round(performance.now() - start)

    if (!response.ok) {
      const errorBody = await response.text()
      let retryAfter: number | undefined
      if (response.status === 429) {
        const header = response.headers.get('Retry-After')
        if (header) {
          const parsed = Number(header)
          if (!Number.isNaN(parsed) && parsed > 0) {
            retryAfter = parsed
          }
        }
      }
      logger.debug('http_request', {
        method,
        path,
        statusCode: response.status,
        durationMs,
      })
      throw new GitLabApiError(response.status, errorBody, retryAfter)
    }

    logger.debug('http_request', {
      method,
      path,
      statusCode: response.status,
      durationMs,
    })
    return response.json() as Promise<T>
  }

  /**
   * Low-level GraphQL request helper. GitLab exposes review state mutations
   * such as "request changes" only through GraphQL, not the REST approvals API.
   */
  private async graphqlRequest<TData>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<TData> {
    const url = `${this.baseUrl}/api/graphql`
    const start = performance.now()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        [this.authHeader.name]: this.authHeader.value,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })

    const durationMs = Math.round(performance.now() - start)

    if (!response.ok) {
      const errorBody = await response.text()
      logger.debug('graphql_request', {
        statusCode: response.status,
        durationMs,
      })
      throw new GitLabApiError(response.status, errorBody)
    }

    logger.debug('graphql_request', {
      statusCode: response.status,
      durationMs,
    })

    const payload = (await response.json()) as GitLabGraphQLResponse<TData>
    if (payload.errors?.length) {
      throw new Error(
        `GitLab GraphQL error: ${payload.errors
          .map((error) => error.message)
          .join('; ')}`,
      )
    }

    if (!payload.data) {
      throw new Error('GitLab GraphQL response did not include data')
    }

    return payload.data
  }

  /**
   * Retry wrapper around {@link request}. Automatically retries on transient
   * errors (429, 502, 503, 504) with exponential backoff. Respects the
   * `Retry-After` header on 429 responses.
   *
   * Non-retryable errors (4xx client errors except 429) are thrown immediately.
   */
  private async requestWithRetry<T>(
    method: string,
    path: string,
    body?: unknown,
    maxRetries = DEFAULT_MAX_RETRIES,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.request<T>(method, path, body)
      } catch (error) {
        const isLastAttempt = attempt === maxRetries
        if (
          !(error instanceof GitLabApiError) ||
          !error.retryable ||
          isLastAttempt
        ) {
          throw error
        }

        const delay = this.getRetryDelay(error, attempt)
        logger.warn('http_retry', {
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          method,
          path,
          statusCode: error.statusCode,
        })
        await this.sleep(delay)
      }
    }

    // Unreachable – the loop always returns or throws – but satisfies TypeScript.
    throw new Error('Retry loop exited unexpectedly')
  }

  /**
   * Computes the delay before the next retry attempt.
   * Uses the `Retry-After` header value (in seconds) when available,
   * otherwise falls back to exponential backoff: 1s, 2s, 4s, ...
   */
  private getRetryDelay(error: GitLabApiError, attempt: number): number {
    if (error.retryAfterSeconds !== undefined) {
      return error.retryAfterSeconds * 1000
    }
    return 2 ** attempt * BASE_RETRY_DELAY_MS
  }

  /**
   * Sleep for the given number of milliseconds.
   * Protected so tests can override to avoid real delays.
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private encodeProjectId(projectId: string): string {
    return encodeURIComponent(projectId)
  }

  /**
   * Paginated GET helper. Fetches all pages of a list endpoint by
   * incrementing `page` until an empty array is returned or `maxPages`
   * is reached. Uses `per_page=100` for efficiency.
   *
   * Each page request goes through {@link requestWithRetry} for automatic
   * retry of transient failures.
   */
  private async paginatedGet<T>(path: string, maxPages = 10): Promise<T[]> {
    const results: T[] = []
    const separator = path.includes('?') ? '&' : '?'

    for (let page = 1; page <= maxPages; page++) {
      const pagePath = `${path}${separator}per_page=100&page=${page}`
      const items = await this.requestWithRetry<T[]>('GET', pagePath)
      results.push(...items)

      if (items.length < 100) break // Last page

      if (page === maxPages) {
        // Last page was full — more data likely exists but we've hit the cap
        logger.warn('Paginated results may be truncated', {
          path,
          maxPages,
          totalFetched: results.length,
        })
      }
    }

    return results
  }

  // Auth validation

  /**
   * Validates the configured auth token by calling GET /api/v4/user.
   * Returns basic user info on success. Throws {@link GitLabApiError} on failure.
   *
   * Uses {@link requestWithRetry} so transient server errors (502/503/504)
   * during startup don't produce false auth-failure warnings.
   */
  async validateAuth(): Promise<{ id: number; username: string }> {
    return this.requestWithRetry<{ id: number; username: string }>(
      'GET',
      '/user',
    )
  }

  // Merge Request endpoints
  async getMergeRequest(
    projectId: string,
    mrIid: number,
  ): Promise<GitLabMergeRequest> {
    return this.requestWithRetry<GitLabMergeRequest>(
      'GET',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}?include_diverged_commits_count=true`,
    )
  }

  async listMergeRequests(
    projectId: string,
    params: ListMergeRequestsParams = {},
  ): Promise<GitLabMergeRequest[]> {
    const query = new URLSearchParams()
    if (params.state) query.set('state', params.state)
    if (params.labels?.length) query.set('labels', params.labels.join(','))
    if (params.source_branch) query.set('source_branch', params.source_branch)
    if (params.author_id) query.set('author_id', params.author_id.toString())
    if (params.assignee_id)
      query.set('assignee_id', params.assignee_id.toString())
    if (params.reviewer_id)
      query.set('reviewer_id', params.reviewer_id.toString())
    if (params.scope) query.set('scope', params.scope)
    if (params.order_by) query.set('order_by', params.order_by)
    if (params.sort) query.set('sort', params.sort)
    if (params.search) query.set('search', params.search)
    if (params.per_page) query.set('per_page', params.per_page.toString())
    if (params.page) query.set('page', params.page.toString())

    const queryString = query.toString()
    const path = `/projects/${this.encodeProjectId(projectId)}/merge_requests${queryString ? `?${queryString}` : ''}`

    return this.requestWithRetry<GitLabMergeRequest[]>('GET', path)
  }

  async getMergeRequestDiffs(
    projectId: string,
    mrIid: number,
  ): Promise<GitLabDiff[]> {
    return this.paginatedGet<GitLabDiff>(
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/diffs`,
    )
  }

  async getMergeRequestDiscussions(
    projectId: string,
    mrIid: number,
  ): Promise<GitLabDiscussion[]> {
    return this.paginatedGet<GitLabDiscussion>(
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/discussions`,
    )
  }

  // Notes/Comments endpoints
  async createMergeRequestNote(
    projectId: string,
    mrIid: number,
    params: CreateNoteParams,
  ): Promise<GitLabNote> {
    return this.requestWithRetry<GitLabNote>(
      'POST',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/notes`,
      params,
    )
  }

  async createMergeRequestDiscussion(
    projectId: string,
    mrIid: number,
    params: CreateDiscussionParams,
  ): Promise<GitLabDiscussion> {
    return this.requestWithRetry<GitLabDiscussion>(
      'POST',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/discussions`,
      params,
    )
  }

  // Discussion reply endpoint
  async createMergeRequestDiscussionNote(
    projectId: string,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<GitLabNote> {
    return this.requestWithRetry<GitLabNote>(
      'POST',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
      { body },
    )
  }

  // Enrichment endpoints (for enriched get_merge_request)

  async getMergeRequestCommits(
    projectId: string,
    mrIid: number,
  ): Promise<GitLabCommit[]> {
    return this.paginatedGet<GitLabCommit>(
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/commits`,
    )
  }

  // Pipeline endpoints
  async getMergeRequestPipelines(
    projectId: string,
    mrIid: number,
  ): Promise<GitLabPipeline[]> {
    return this.paginatedGet<GitLabPipeline>(
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/pipelines`,
    )
  }

  // Repository file endpoint
  async getRepositoryFile(
    projectId: string,
    filePath: string,
    ref: string,
  ): Promise<GitLabRepositoryFile> {
    const encodedPath = encodeURIComponent(filePath)
    return this.requestWithRetry<GitLabRepositoryFile>(
      'GET',
      `/projects/${this.encodeProjectId(projectId)}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    )
  }

  // Repository compare endpoint
  async compareCommits(
    projectId: string,
    from: string,
    to: string,
  ): Promise<GitLabCompareResult> {
    const query = new URLSearchParams({ from, to })
    return this.requestWithRetry<GitLabCompareResult>(
      'GET',
      `/projects/${this.encodeProjectId(projectId)}/repository/compare?${query}`,
    )
  }

  async getProject(projectId: string): Promise<GitLabProject> {
    return this.requestWithRetry<GitLabProject>(
      'GET',
      `/projects/${this.encodeProjectId(projectId)}`,
    )
  }

  /**
   * Get deployments for a project, filtered by commit SHA.
   *
   * Note: The `sha` query parameter is NOT in the official GitLab OpenAPI v2
   * spec but is documented in GitLab's API docs and works in practice. As a
   * safety net, results are also filtered client-side by SHA.
   */
  async getDeployments(
    projectId: string,
    sha: string,
    perPage = 100,
  ): Promise<GitLabDeployment[]> {
    const query = new URLSearchParams({
      sha,
      order_by: 'created_at',
      sort: 'desc',
      per_page: perPage.toString(),
    })
    const deployments = await this.requestWithRetry<GitLabDeployment[]>(
      'GET',
      `/projects/${this.encodeProjectId(projectId)}/deployments?${query}`,
    )
    // Client-side fallback filter in case server ignores the sha param
    return deployments.filter((d) => d.sha === sha)
  }

  /**
   * Get approval state. Tries Premium endpoint first, falls back to free-tier.
   * Returns { data, source } to indicate which endpoint was used.
   */
  async getApprovalState(
    projectId: string,
    mrIid: number,
  ): Promise<{
    data: GitLabApprovalState | GitLabApprovals
    source: 'approval_state' | 'approvals'
  }> {
    const encodedId = this.encodeProjectId(projectId)
    try {
      const data = await this.requestWithRetry<GitLabApprovalState>(
        'GET',
        `/projects/${encodedId}/merge_requests/${mrIid}/approval_state`,
      )
      return { data, source: 'approval_state' }
    } catch {
      // Fall back to free-tier endpoint
      const data = await this.requestWithRetry<GitLabApprovals>(
        'GET',
        `/projects/${encodedId}/merge_requests/${mrIid}/approvals`,
      )
      return { data, source: 'approvals' }
    }
  }

  // Approval endpoints
  async approveMergeRequest(
    projectId: string,
    mrIid: number,
    sha?: string,
  ): Promise<void> {
    const body = sha ? { sha } : undefined
    await this.requestWithRetry<unknown>(
      'POST',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/approve`,
      body,
    )
  }

  async unapproveMergeRequest(projectId: string, mrIid: number): Promise<void> {
    await this.requestWithRetry<unknown>(
      'POST',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/unapprove`,
    )
  }

  /**
   * Formally request changes on a merge request by updating the authenticated
   * reviewer's GitLab review state. The caller must be a reviewer on the MR.
   */
  async requestMergeRequestChanges(
    projectId: string,
    mrIid: number,
  ): Promise<GitLabRequestChangesResult> {
    const project = await this.getProject(projectId)
    const query = `
      mutation RequestMergeRequestChanges($projectPath: ID!, $iid: String!) {
        mergeRequestRequestChanges(input: { projectPath: $projectPath, iid: $iid }) {
          errors
          mergeRequest {
            id
            iid
            webUrl
          }
        }
      }
    `

    const data = await this.graphqlRequest<RequestChangesMutationData>(query, {
      projectPath: project.path_with_namespace,
      iid: mrIid.toString(),
    })
    const result = data.mergeRequestRequestChanges

    if (!result) {
      throw new Error('GitLab did not return a request-changes result')
    }

    if (result.errors.length > 0) {
      throw new Error(
        `GitLab request changes failed: ${result.errors.join('; ')}`,
      )
    }

    return result
  }

  // Discussion management endpoints

  async resolveMergeRequestThread(
    projectId: string,
    mrIid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<GitLabDiscussion> {
    return this.requestWithRetry<GitLabDiscussion>(
      'PUT',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}/discussions/${discussionId}`,
      { resolved },
    )
  }

  /**
   * Resolve a branch name to a merge request IID.
   * Lists MRs filtered by source_branch and returns the first opened match.
   */
  async resolveBranchToMr(
    projectId: string,
    sourceBranch: string,
  ): Promise<GitLabMergeRequest | null> {
    const mrs = await this.listMergeRequests(projectId, {
      source_branch: sourceBranch,
      state: 'opened',
      per_page: 1,
    })
    return mrs[0] ?? null
  }

  // Label endpoints
  async getProjectLabels(projectId: string): Promise<GitLabLabel[]> {
    return this.requestWithRetry<GitLabLabel[]>(
      'GET',
      `/projects/${this.encodeProjectId(projectId)}/labels`,
    )
  }

  async updateMergeRequestLabels(
    projectId: string,
    mrIid: number,
    labels: string[],
  ): Promise<GitLabMergeRequest> {
    return this.requestWithRetry<GitLabMergeRequest>(
      'PUT',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}`,
      { labels },
    )
  }

  async addMergeRequestLabels(
    projectId: string,
    mrIid: number,
    labelsToAdd: string[],
  ): Promise<GitLabMergeRequest> {
    return this.requestWithRetry<GitLabMergeRequest>(
      'PUT',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}`,
      { add_labels: labelsToAdd },
    )
  }

  async removeMergeRequestLabels(
    projectId: string,
    mrIid: number,
    labelsToRemove: string[],
  ): Promise<GitLabMergeRequest> {
    return this.requestWithRetry<GitLabMergeRequest>(
      'PUT',
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${mrIid}`,
      { remove_labels: labelsToRemove },
    )
  }
}

// Singleton instance
let client: GitLabClient | null = null

export function getGitLabClient(): GitLabClient {
  if (!client) {
    client = new GitLabClient()
  }
  return client
}

/**
 * Reset the singleton GitLabClient instance.
 * Useful for testing and token rotation — the next call to
 * `getGitLabClient()` will create a fresh client with current auth config.
 */
export function resetGitLabClient(): void {
  client = null
}
