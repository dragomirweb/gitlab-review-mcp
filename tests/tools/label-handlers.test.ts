/**
 * Tests for label tool handlers and label schemas.
 *
 * Uses a mock McpServer to capture handler callbacks from registerLabelTools(),
 * and mocks getGitLabClient() to return a fake client.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  addMrLabelSchema,
  getProjectLabelsSchema,
  removeMrLabelSchema,
  setMrLabelsSchema,
} from '../../src/schemas'
import type { MockMcpServer } from '../helpers'
import { createMockMcpServer } from '../helpers'

// ---------------------------------------------------------------------------
// Mock the GitLab client module
// ---------------------------------------------------------------------------

let mockClientInstance: Record<string, ReturnType<typeof mock>>

function resetMockClient() {
  mockClientInstance = {
    getProjectLabels: mock(() =>
      Promise.resolve([
        { id: 1, name: 'bug', color: '#d9534f' },
        { id: 2, name: 'feature', color: '#5cb85c' },
      ]),
    ),
    addMergeRequestLabels: mock(() =>
      Promise.resolve({ labels: ['bug', 'feature', 'new-label'] }),
    ),
    removeMergeRequestLabels: mock(() =>
      Promise.resolve({ labels: ['feature'] }),
    ),
    updateMergeRequestLabels: mock(() =>
      Promise.resolve({ labels: ['ready', 'reviewed'] }),
    ),
  }
}

mock.module('../../src/gitlab/client', () => ({
  getGitLabClient: () => mockClientInstance,
}))

// Import AFTER mocking so the mock is applied
const { registerLabelTools } = await import('../../src/tools/labels')

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('Label schemas', () => {
  describe('getProjectLabelsSchema', () => {
    test('accepts project_id', () => {
      const result = getProjectLabelsSchema.safeParse({
        project_id: 'group/proj',
      })
      expect(result.success).toBe(true)
    })

    test('accepts missing project_id (optional with fallback)', () => {
      const result = getProjectLabelsSchema.safeParse({})
      expect(result.success).toBe(true)
    })
  })

  describe('addMrLabelSchema', () => {
    test('accepts project_id, mr_iid, and label', () => {
      const result = addMrLabelSchema.safeParse({
        project_id: 'p',
        mr_iid: 1,
        label: 'bug',
      })
      expect(result.success).toBe(true)
    })

    test('rejects missing label', () => {
      const result = addMrLabelSchema.safeParse({
        project_id: 'p',
        mr_iid: 1,
      })
      expect(result.success).toBe(false)
    })
  })

  describe('removeMrLabelSchema', () => {
    test('accepts project_id, mr_iid, and label', () => {
      const result = removeMrLabelSchema.safeParse({
        project_id: 'p',
        mr_iid: 1,
        label: 'bug',
      })
      expect(result.success).toBe(true)
    })

    test('rejects missing label', () => {
      const result = removeMrLabelSchema.safeParse({
        project_id: 'p',
        mr_iid: 1,
      })
      expect(result.success).toBe(false)
    })
  })

  describe('setMrLabelsSchema', () => {
    test('accepts project_id, mr_iid, and labels array', () => {
      const result = setMrLabelsSchema.safeParse({
        project_id: 'p',
        mr_iid: 1,
        labels: ['bug', 'feature'],
      })
      expect(result.success).toBe(true)
    })

    test('rejects missing labels', () => {
      const result = setMrLabelsSchema.safeParse({
        project_id: 'p',
        mr_iid: 1,
      })
      expect(result.success).toBe(false)
    })

    test('accepts empty labels array', () => {
      const result = setMrLabelsSchema.safeParse({
        project_id: 'p',
        mr_iid: 1,
        labels: [],
      })
      expect(result.success).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('Label tool handlers', () => {
  let server: MockMcpServer

  beforeEach(() => {
    resetMockClient()
    server = createMockMcpServer()
    registerLabelTools(server as any)
  })

  test('registerLabelTools registers all 4 label tools', () => {
    const names = server.toolNames()
    expect(names).toContain('get_project_labels')
    expect(names).toContain('add_mr_label')
    expect(names).toContain('remove_mr_label')
    expect(names).toContain('set_mr_labels')
  })

  describe('get_project_labels', () => {
    test('calls client.getProjectLabels and returns labels', async () => {
      const handler = server.getHandler('get_project_labels')
      const result = await handler({ project_id: 'group/project' })

      expect(mockClientInstance.getProjectLabels).toHaveBeenCalledWith(
        'group/project',
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveLength(2)
      expect(parsed[0].name).toBe('bug')
    })
  })

  describe('add_mr_label', () => {
    test('calls client.addMergeRequestLabels with label in array', async () => {
      const handler = server.getHandler('add_mr_label')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        label: 'new-label',
      })

      expect(mockClientInstance.addMergeRequestLabels).toHaveBeenCalledWith(
        'p',
        42,
        ['new-label'],
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.labels).toContain('new-label')
    })
  })

  describe('remove_mr_label', () => {
    test('calls client.removeMergeRequestLabels with label in array', async () => {
      const handler = server.getHandler('remove_mr_label')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        label: 'bug',
      })

      expect(mockClientInstance.removeMergeRequestLabels).toHaveBeenCalledWith(
        'p',
        42,
        ['bug'],
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
    })
  })

  describe('set_mr_labels', () => {
    test('calls client.updateMergeRequestLabels with labels array', async () => {
      const handler = server.getHandler('set_mr_labels')
      const result = await handler({
        project_id: 'p',
        mr_iid: 42,
        labels: ['ready', 'reviewed'],
      })

      expect(mockClientInstance.updateMergeRequestLabels).toHaveBeenCalledWith(
        'p',
        42,
        ['ready', 'reviewed'],
      )
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.labels).toEqual(['ready', 'reviewed'])
    })
  })
})
