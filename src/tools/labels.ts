/**
 * Label tools for GitLab MCP
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getGitLabClient } from '../gitlab/client'
import {
  addMrLabelSchema,
  getProjectLabelsSchema,
  removeMrLabelSchema,
  setMrLabelsSchema,
} from '../schemas'
import { resolveProjectId } from './resolve-project-id'

export function registerLabelTools(server: McpServer): void {
  // Get project labels
  server.registerTool(
    'get_project_labels',
    {
      title: 'Get Project Labels',
      description: 'List all available labels for a GitLab project',
      inputSchema: getProjectLabelsSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const labels = await client.getProjectLabels(pid)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(labels, null, 2),
          },
        ],
      }
    },
  )

  // Add label to MR
  server.registerTool(
    'add_mr_label',
    {
      title: 'Add MR Label',
      description:
        'Add a single label to a merge request (keeps existing labels)',
      inputSchema: addMrLabelSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, label }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const mr = await client.addMergeRequestLabels(pid, mr_iid, [label])
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, labels: mr.labels }, null, 2),
          },
        ],
      }
    },
  )

  // Remove label from MR
  server.registerTool(
    'remove_mr_label',
    {
      title: 'Remove MR Label',
      description: 'Remove a single label from a merge request',
      inputSchema: removeMrLabelSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, label }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const mr = await client.removeMergeRequestLabels(pid, mr_iid, [label])
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, labels: mr.labels }, null, 2),
          },
        ],
      }
    },
  )

  // Set all labels on MR
  server.registerTool(
    'set_mr_labels',
    {
      title: 'Set MR Labels',
      description:
        'Set labels on a merge request (replaces all existing labels)',
      inputSchema: setMrLabelsSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ project_id, mr_iid, labels }) => {
      const pid = resolveProjectId(project_id)
      const client = getGitLabClient()
      const mr = await client.updateMergeRequestLabels(pid, mr_iid, labels)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, labels: mr.labels }, null, 2),
          },
        ],
      }
    },
  )
}
