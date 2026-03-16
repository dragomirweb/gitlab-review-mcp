import { describe, expect, test } from 'bun:test'
import { buildGitLabPosition, formatReviewBody } from '../../src/tools/reviews'

// ---------------------------------------------------------------------------
// formatReviewBody
// ---------------------------------------------------------------------------

describe('formatReviewBody', () => {
  test("returns plain content for type 'comment'", () => {
    expect(formatReviewBody('fix this bug', 'comment')).toBe('fix this bug')
  })

  test("wraps content in suggestion markdown when type is 'suggestion' and file_path is provided", () => {
    const result = formatReviewBody('const x = 1;', 'suggestion', 'src/main.ts')
    expect(result).toBe('```suggestion:-0+0\nconst x = 1;\n```')
  })

  test("wraps content in suggestion markdown when type is 'suggestion' and positionNewPath is provided", () => {
    const result = formatReviewBody(
      'const y = 2;',
      'suggestion',
      undefined,
      'src/other.ts',
    )
    expect(result).toBe('```suggestion:-0+0\nconst y = 2;\n```')
  })

  test('does NOT wrap suggestion when neither file_path nor positionNewPath is provided', () => {
    const result = formatReviewBody('use const', 'suggestion')
    expect(result).toBe('use const')
  })

  test("does NOT wrap when type is 'comment' even with file_path", () => {
    const result = formatReviewBody('looks fine', 'comment', 'src/main.ts')
    expect(result).toBe('looks fine')
  })

  test('handles multiline suggestion content', () => {
    const content = 'line1\nline2\nline3'
    const result = formatReviewBody(content, 'suggestion', 'file.ts')
    expect(result).toBe('```suggestion:-0+0\nline1\nline2\nline3\n```')
  })
})

// ---------------------------------------------------------------------------
// buildGitLabPosition
// ---------------------------------------------------------------------------

describe('buildGitLabPosition', () => {
  test('returns undefined when no position provided', () => {
    expect(buildGitLabPosition(undefined)).toBeUndefined()
  })

  test('builds position with all fields', () => {
    const result = buildGitLabPosition({
      base_sha: 'abc',
      head_sha: 'def',
      start_sha: 'ghi',
      position_type: 'text',
      new_path: 'src/file.ts',
      old_path: 'src/old-file.ts',
      new_line: 42,
      old_line: 40,
    })

    expect(result).toEqual({
      base_sha: 'abc',
      head_sha: 'def',
      start_sha: 'ghi',
      position_type: 'text',
      new_path: 'src/file.ts',
      old_path: 'src/old-file.ts',
      new_line: 42,
      old_line: 40,
    })
  })

  test("defaults position_type to 'text' when not provided", () => {
    const result = buildGitLabPosition({
      base_sha: 'a',
      head_sha: 'b',
      start_sha: 'c',
      new_path: 'file.ts',
    })

    expect(result!.position_type).toBe('text')
  })

  test('handles undefined new_line and old_line', () => {
    const result = buildGitLabPosition({
      base_sha: 'a',
      head_sha: 'b',
      start_sha: 'c',
      new_path: 'file.ts',
    })

    expect(result!.new_line).toBeUndefined()
    expect(result!.old_line).toBeUndefined()
  })

  test("handles 'image' position type", () => {
    const result = buildGitLabPosition({
      base_sha: 'a',
      head_sha: 'b',
      start_sha: 'c',
      position_type: 'image',
      new_path: 'image.png',
    })

    expect(result!.position_type).toBe('image')
  })

  test('old_path is optional', () => {
    const result = buildGitLabPosition({
      base_sha: 'a',
      head_sha: 'b',
      start_sha: 'c',
      new_path: 'new-file.ts',
    })

    expect(result!.old_path).toBeUndefined()
    expect(result!.new_path).toBe('new-file.ts')
  })
})
