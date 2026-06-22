import { describe, expect, test } from 'bun:test'
import {
  addReviewCommentSchema,
  approveMrSchema,
  completeReviewSchema,
  createMrDiscussionReplySchema,
  createMrNoteSchema,
  getMergeRequestSchema,
  getMrChangesSinceSchema,
  getMrCommitsSchema,
  getMrDiffSchema,
  getMrFileContentSchema,
  getMrPipelinesSchema,
  getReviewStatusSchema,
  getSettingSchema,
  listMergeRequestsSchema,
  MrLookupSchema,
  MrParamsSchema,
  mrIidSchema,
  PaginationSchema,
  ProjectParamsSchema,
  projectIdSchema,
  resolveMrThreadSchema,
  setSettingSchema,
  unapproveMrSchema,
} from '../../src/schemas'

// ---------------------------------------------------------------------------
// Field-level schemas
// ---------------------------------------------------------------------------

describe('projectIdSchema', () => {
  test('accepts a string', () => {
    expect(projectIdSchema.parse('group/project')).toBe('group/project')
  })

  test('coerces a number to string', () => {
    expect(projectIdSchema.parse(12345)).toBe('12345')
  })
})

describe('mrIidSchema', () => {
  test('accepts a positive integer', () => {
    expect(mrIidSchema.parse(42)).toBe(42)
  })

  test('coerces a string to number', () => {
    expect(mrIidSchema.parse('42')).toBe(42)
  })

  test('rejects zero', () => {
    expect(() => mrIidSchema.parse(0)).toThrow()
  })

  test('rejects negative numbers', () => {
    expect(() => mrIidSchema.parse(-1)).toThrow()
  })

  test('rejects non-integer', () => {
    expect(() => mrIidSchema.parse(3.14)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Base composed schemas
// ---------------------------------------------------------------------------

describe('ProjectParamsSchema', () => {
  test('accepts project_id', () => {
    const result = ProjectParamsSchema.parse({ project_id: 'my/project' })
    expect(result.project_id).toBe('my/project')
  })

  test('accepts missing project_id (optional with fallback)', () => {
    const result = ProjectParamsSchema.parse({})
    expect(result.project_id).toBeUndefined()
  })
})

describe('MrParamsSchema', () => {
  test('accepts project_id and mr_iid', () => {
    const result = MrParamsSchema.parse({ project_id: 'p', mr_iid: 1 })
    expect(result).toEqual({ project_id: 'p', mr_iid: 1 })
  })

  test('rejects missing mr_iid', () => {
    expect(() => MrParamsSchema.parse({ project_id: 'p' })).toThrow()
  })
})

describe('MrLookupSchema', () => {
  test('accepts mr_iid only', () => {
    const result = MrLookupSchema.parse({ project_id: 'p', mr_iid: 1 })
    expect(result.mr_iid).toBe(1)
  })

  test('accepts source_branch only', () => {
    const result = MrLookupSchema.parse({
      project_id: 'p',
      source_branch: 'feat/x',
    })
    expect(result.source_branch).toBe('feat/x')
  })

  test('accepts both mr_iid and source_branch', () => {
    const result = MrLookupSchema.parse({
      project_id: 'p',
      mr_iid: 1,
      source_branch: 'feat/x',
    })
    expect(result.mr_iid).toBe(1)
    expect(result.source_branch).toBe('feat/x')
  })

  test('accepts when neither mr_iid nor source_branch provided (runtime validation in handler)', () => {
    // Schema no longer uses .refine() — cross-field validation moved to
    // resolveMrIid() in tool handlers so the schema stays a ZodObject
    // (serializable to JSON Schema by the MCP SDK).
    const result = MrLookupSchema.parse({ project_id: 'p' })
    expect(result.project_id).toBe('p')
    expect(result.mr_iid).toBeUndefined()
    expect(result.source_branch).toBeUndefined()
  })
})

describe('PaginationSchema', () => {
  test('accepts valid page and per_page', () => {
    const result = PaginationSchema.parse({ page: 2, per_page: 50 })
    expect(result).toEqual({ page: 2, per_page: 50 })
  })

  test('both fields are optional', () => {
    const result = PaginationSchema.parse({})
    expect(result.page).toBeUndefined()
    expect(result.per_page).toBeUndefined()
  })

  test('rejects page less than 1', () => {
    expect(() => PaginationSchema.parse({ page: 0 })).toThrow()
  })

  test('rejects per_page greater than 100', () => {
    expect(() => PaginationSchema.parse({ per_page: 101 })).toThrow()
  })

  test('coerces string values', () => {
    const result = PaginationSchema.parse({ page: '3', per_page: '25' })
    expect(result).toEqual({ page: 3, per_page: 25 })
  })
})

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

describe('getMergeRequestSchema (MrLookupSchema)', () => {
  test('validates with mr_iid', () => {
    const result = getMergeRequestSchema.parse({
      project_id: 'group/proj',
      mr_iid: 10,
    })
    expect(result.mr_iid).toBe(10)
  })

  test('validates with source_branch', () => {
    const result = getMergeRequestSchema.parse({
      project_id: 'group/proj',
      source_branch: 'feat/branch',
    })
    expect(result.source_branch).toBe('feat/branch')
  })
})

describe('getMrCommitsSchema (MrLookupSchema)', () => {
  test('validates with mr_iid', () => {
    const result = getMrCommitsSchema.parse({
      project_id: 'group/proj',
      mr_iid: 10,
    })
    expect(result.mr_iid).toBe(10)
  })

  test('validates with source_branch', () => {
    const result = getMrCommitsSchema.parse({
      project_id: 'group/proj',
      source_branch: 'feat/branch',
    })
    expect(result.source_branch).toBe('feat/branch')
  })

  test('accepts when neither mr_iid nor source_branch provided (runtime validation in handler)', () => {
    const result = getMrCommitsSchema.parse({ project_id: 'p' })
    expect(result.project_id).toBe('p')
    expect(result.mr_iid).toBeUndefined()
    expect(result.source_branch).toBeUndefined()
  })
})

describe('getMrPipelinesSchema (MrParamsSchema)', () => {
  test('accepts project_id and mr_iid', () => {
    const result = getMrPipelinesSchema.parse({
      project_id: 'group/proj',
      mr_iid: 10,
    })
    expect(result.project_id).toBe('group/proj')
    expect(result.mr_iid).toBe(10)
  })

  test('rejects missing mr_iid', () => {
    expect(() => getMrPipelinesSchema.parse({ project_id: 'p' })).toThrow()
  })
})

describe('getMrChangesSinceSchema', () => {
  test('accepts project_id and mr_iid without since_sha', () => {
    const result = getMrChangesSinceSchema.parse({
      project_id: 'p',
      mr_iid: 1,
    })
    expect(result.project_id).toBe('p')
    expect(result.mr_iid).toBe(1)
    expect(result.since_sha).toBeUndefined()
  })

  test('accepts optional since_sha', () => {
    const result = getMrChangesSinceSchema.parse({
      project_id: 'p',
      mr_iid: 1,
      since_sha: 'abc123',
    })
    expect(result.since_sha).toBe('abc123')
  })

  test('rejects missing mr_iid', () => {
    expect(() => getMrChangesSinceSchema.parse({ project_id: 'p' })).toThrow()
  })
})

describe('getMrFileContentSchema', () => {
  test('accepts valid input', () => {
    const result = getMrFileContentSchema.parse({
      project_id: 'group/proj',
      file_path: 'src/index.ts',
      ref: 'main',
    })
    expect(result.file_path).toBe('src/index.ts')
    expect(result.ref).toBe('main')
  })

  test('accepts commit SHA as ref', () => {
    const result = getMrFileContentSchema.parse({
      project_id: 'p',
      file_path: 'README.md',
      ref: 'abc123def456',
    })
    expect(result.ref).toBe('abc123def456')
  })

  test('rejects empty file_path', () => {
    expect(() =>
      getMrFileContentSchema.parse({
        project_id: 'p',
        file_path: '',
        ref: 'main',
      }),
    ).toThrow()
  })

  test('rejects empty ref', () => {
    expect(() =>
      getMrFileContentSchema.parse({
        project_id: 'p',
        file_path: 'src/index.ts',
        ref: '',
      }),
    ).toThrow()
  })

  test('rejects missing file_path', () => {
    expect(() =>
      getMrFileContentSchema.parse({ project_id: 'p', ref: 'main' }),
    ).toThrow()
  })

  test('rejects missing ref', () => {
    expect(() =>
      getMrFileContentSchema.parse({
        project_id: 'p',
        file_path: 'src/index.ts',
      }),
    ).toThrow()
  })
})

describe('getMrDiffSchema', () => {
  test('accepts excluded_file_patterns', () => {
    const result = getMrDiffSchema.parse({
      project_id: 'p',
      mr_iid: 1,
      excluded_file_patterns: ['package-lock\\.json', '.*\\.min\\.js'],
    })
    expect(result.excluded_file_patterns).toEqual([
      'package-lock\\.json',
      '.*\\.min\\.js',
    ])
  })

  test('excluded_file_patterns is optional', () => {
    const result = getMrDiffSchema.parse({ project_id: 'p', mr_iid: 1 })
    expect(result.excluded_file_patterns).toBeUndefined()
  })
})

describe('listMergeRequestsSchema', () => {
  test('accepts all state values', () => {
    for (const state of [
      'opened',
      'closed',
      'locked',
      'merged',
      'all',
    ] as const) {
      const result = listMergeRequestsSchema.parse({ project_id: 'p', state })
      expect(result.state).toBe(state)
    }
  })

  test('rejects invalid state', () => {
    expect(() =>
      listMergeRequestsSchema.parse({ project_id: 'p', state: 'invalid' }),
    ).toThrow()
  })

  test('merges pagination fields', () => {
    const result = listMergeRequestsSchema.parse({
      project_id: 'p',
      page: 2,
      per_page: 50,
    })
    expect(result.page).toBe(2)
    expect(result.per_page).toBe(50)
  })
})

describe('resolveMrThreadSchema', () => {
  test('accepts valid input', () => {
    const result = resolveMrThreadSchema.parse({
      project_id: 'p',
      mr_iid: 1,
      discussion_id: 'abc123',
      resolved: true,
    })
    expect(result).toEqual({
      project_id: 'p',
      mr_iid: 1,
      discussion_id: 'abc123',
      resolved: true,
    })
  })

  test('rejects missing discussion_id', () => {
    expect(() =>
      resolveMrThreadSchema.parse({
        project_id: 'p',
        mr_iid: 1,
        resolved: true,
      }),
    ).toThrow()
  })
})

describe('createMrNoteSchema', () => {
  test('accepts valid input', () => {
    const result = createMrNoteSchema.parse({
      project_id: 'p',
      mr_iid: 1,
      body: 'LGTM!',
    })
    expect(result.body).toBe('LGTM!')
  })

  test('rejects empty body', () => {
    expect(() =>
      createMrNoteSchema.parse({ project_id: 'p', mr_iid: 1, body: '' }),
    ).toThrow()
  })
})

describe('approveMrSchema', () => {
  test('accepts project_id and mr_iid without sha', () => {
    const result = approveMrSchema.parse({ project_id: 'p', mr_iid: 1 })
    expect(result.project_id).toBe('p')
    expect(result.mr_iid).toBe(1)
    expect(result.sha).toBeUndefined()
  })

  test('accepts optional sha', () => {
    const result = approveMrSchema.parse({
      project_id: 'p',
      mr_iid: 1,
      sha: 'abc123',
    })
    expect(result.sha).toBe('abc123')
  })

  test('rejects missing mr_iid', () => {
    expect(() => approveMrSchema.parse({ project_id: 'p' })).toThrow()
  })
})

describe('unapproveMrSchema (MrParamsSchema)', () => {
  test('accepts project_id and mr_iid', () => {
    const result = unapproveMrSchema.parse({ project_id: 'p', mr_iid: 1 })
    expect(result.project_id).toBe('p')
    expect(result.mr_iid).toBe(1)
  })
})

describe('createMrDiscussionReplySchema', () => {
  test('accepts valid input', () => {
    const result = createMrDiscussionReplySchema.parse({
      project_id: 'p',
      mr_iid: 1,
      discussion_id: 'abc123',
      body: 'Thanks for the feedback!',
    })
    expect(result.discussion_id).toBe('abc123')
    expect(result.body).toBe('Thanks for the feedback!')
  })

  test('rejects empty body', () => {
    expect(() =>
      createMrDiscussionReplySchema.parse({
        project_id: 'p',
        mr_iid: 1,
        discussion_id: 'abc',
        body: '',
      }),
    ).toThrow()
  })

  test('rejects empty discussion_id', () => {
    expect(() =>
      createMrDiscussionReplySchema.parse({
        project_id: 'p',
        mr_iid: 1,
        discussion_id: '',
        body: 'reply',
      }),
    ).toThrow()
  })

  test('rejects missing discussion_id', () => {
    expect(() =>
      createMrDiscussionReplySchema.parse({
        project_id: 'p',
        mr_iid: 1,
        body: 'reply',
      }),
    ).toThrow()
  })
})

describe('addReviewCommentSchema', () => {
  test("defaults type to 'comment'", () => {
    const result = addReviewCommentSchema.parse({
      session_id: 1,
      content: 'test',
    })
    expect(result.type).toBe('comment')
  })

  test('accepts suggestion type', () => {
    const result = addReviewCommentSchema.parse({
      session_id: 1,
      content: 'fix this',
      type: 'suggestion',
    })
    expect(result.type).toBe('suggestion')
  })

  test('accepts position object', () => {
    const result = addReviewCommentSchema.parse({
      session_id: 1,
      content: 'inline comment',
      position: {
        base_sha: 'abc',
        head_sha: 'def',
        start_sha: 'ghi',
        new_path: 'src/file.ts',
        new_line: 42,
      },
    })
    expect(result.position).toBeDefined()
    expect(result.position!.position_type).toBe('text') // default
    expect(result.position!.new_line).toBe(42)
  })

  test('coerces session_id from string', () => {
    const result = addReviewCommentSchema.parse({
      session_id: '5',
      content: 'test',
    })
    expect(result.session_id).toBe(5)
  })
})

describe('getReviewStatusSchema', () => {
  test('accepts mr_iid', () => {
    const result = getReviewStatusSchema.parse({
      project_id: 'p',
      mr_iid: 1,
    })
    expect(result.mr_iid).toBe(1)
  })

  test('accepts branch', () => {
    const result = getReviewStatusSchema.parse({
      project_id: 'p',
      branch: 'feat/x',
    })
    expect(result.branch).toBe('feat/x')
  })

  test('accepts when neither provided (runtime validation in handler)', () => {
    const result = getReviewStatusSchema.parse({ project_id: 'p' })
    expect(result.project_id).toBe('p')
    expect(result.mr_iid).toBeUndefined()
    expect(result.branch).toBeUndefined()
  })
})

describe('completeReviewSchema', () => {
  test('accepts valid statuses', () => {
    for (const status of ['approved', 'requested_changes', 'closed'] as const) {
      const result = completeReviewSchema.parse({ session_id: 1, status })
      expect(result.status).toBe(status)
    }
  })

  test('rejects invalid status', () => {
    expect(() =>
      completeReviewSchema.parse({ session_id: 1, status: 'rejected' }),
    ).toThrow()
  })

  test('rejects pending_changes as completion status (BUG-009)', () => {
    // pending_changes is set automatically by add_review_comment, not a valid completion status
    expect(() =>
      completeReviewSchema.parse({ session_id: 1, status: 'pending_changes' }),
    ).toThrow()
  })

  test('accepts optional summary_comment', () => {
    const result = completeReviewSchema.parse({
      session_id: 1,
      status: 'approved',
      summary_comment: 'LGTM! Great work.',
    })
    expect(result.summary_comment).toBe('LGTM! Great work.')
  })

  test('rejects empty summary_comment', () => {
    expect(() =>
      completeReviewSchema.parse({
        session_id: 1,
        status: 'approved',
        summary_comment: '',
      }),
    ).toThrow()
  })

  test('accepts optional labels array', () => {
    const result = completeReviewSchema.parse({
      session_id: 1,
      status: 'approved',
      labels: ['reviewed', 'ready-to-merge'],
    })
    expect(result.labels).toEqual(['reviewed', 'ready-to-merge'])
  })

  test('defaults approve to false', () => {
    const result = completeReviewSchema.parse({
      session_id: 1,
      status: 'approved',
    })
    expect(result.approve).toBe(false)
  })

  test('accepts approve flag', () => {
    const result = completeReviewSchema.parse({
      session_id: 1,
      status: 'approved',
      approve: true,
    })
    expect(result.approve).toBe(true)
  })

  test('accepts all optional fields together', () => {
    const result = completeReviewSchema.parse({
      session_id: 1,
      status: 'approved',
      summary_comment: 'All good!',
      labels: ['reviewed'],
      approve: true,
    })
    expect(result.summary_comment).toBe('All good!')
    expect(result.labels).toEqual(['reviewed'])
    expect(result.approve).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Settings schemas
// ---------------------------------------------------------------------------

describe('getSettingSchema', () => {
  test('accepts valid key', () => {
    const result = getSettingSchema.parse({ key: 'default_project_id' })
    expect(result.key).toBe('default_project_id')
  })

  test('rejects empty key', () => {
    expect(() => getSettingSchema.parse({ key: '' })).toThrow()
  })

  test('rejects missing key', () => {
    expect(() => getSettingSchema.parse({})).toThrow()
  })
})

describe('setSettingSchema', () => {
  test('accepts valid key and value', () => {
    const result = setSettingSchema.parse({
      key: 'review_labels',
      value: '["approved"]',
    })
    expect(result.key).toBe('review_labels')
    expect(result.value).toBe('["approved"]')
  })

  test('rejects empty key', () => {
    expect(() => setSettingSchema.parse({ key: '', value: 'v' })).toThrow()
  })

  test('rejects empty value', () => {
    expect(() => setSettingSchema.parse({ key: 'k', value: '' })).toThrow()
  })

  test('rejects missing value', () => {
    expect(() => setSettingSchema.parse({ key: 'k' })).toThrow()
  })
})
