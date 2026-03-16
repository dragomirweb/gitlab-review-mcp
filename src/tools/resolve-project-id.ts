/**
 * Resolves the project ID from the fallback chain:
 *   1. Explicit value (passed by the user in the tool call)
 *   2. DB setting "default_project_id" (set via set_setting tool)
 *   3. Environment variable GITLAB_PROJECT_ID
 *
 * Throws with a helpful message when no value can be found.
 */

import { getQueries } from '../db'

/**
 * Resolve a project ID from the standard fallback chain.
 *
 * @param explicitId - Value provided directly in the tool call (may be undefined)
 * @returns The resolved project ID string (never empty)
 * @throws {Error} When no project ID can be determined from any source
 */
export function resolveProjectId(explicitId?: string): string {
  // 1. Explicit value always wins
  if (explicitId) return explicitId

  // 2. Check DB settings store
  const queries = getQueries()
  const setting = queries.getSetting('default_project_id')
  if (setting?.value) return setting.value

  // 3. Check environment variable
  const envId = process.env.GITLAB_PROJECT_ID
  if (envId) return envId

  // 4. No default configured — fail with actionable message
  throw new Error(
    'project_id is required. Provide it directly, or set a default via:\n' +
      '  \u2022 set_setting(key: "default_project_id", value: "group/project")\n' +
      '  \u2022 GITLAB_PROJECT_ID environment variable',
  )
}
