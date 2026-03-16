/**
 * Settings tools — expose the key/value settings table via MCP
 *
 * Use cases:
 *   - default_project_id: avoid passing project_id on every tool call
 *   - review_labels: configurable label names per team
 *   - excluded_file_patterns: global file patterns to ignore in diffs
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getQueries } from '../db'
import { getSettingSchema, setSettingSchema } from '../schemas'

export function registerSettingsTools(server: McpServer): void {
  server.registerTool(
    'get_setting',
    {
      title: 'Get Setting',
      description:
        'Read a configuration value from the settings store. Returns the value for the given key, or a message indicating the key is not set.',
      inputSchema: getSettingSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ key }) => {
      const queries = getQueries()
      const setting = queries.getSetting(key)

      if (!setting) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                key,
                value: null,
                message: `Setting "${key}" is not configured.`,
              }),
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ key: setting.key, value: setting.value }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'set_setting',
    {
      title: 'Set Setting',
      description:
        'Store a configuration value in the settings store. Creates the key if it does not exist, or updates it if it does.',
      inputSchema: setSettingSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async ({ key, value }) => {
      const queries = getQueries()
      queries.setSetting(key, value)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, key, value }),
          },
        ],
      }
    },
  )
}
