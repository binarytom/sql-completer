import type { AppliedCompletion, CompletionItem, SqlDocument, TextRange } from './types';

/** Pure document edit; parser-specific quoting was resolved when ranking items. */
export function applyCompletionEdit(
  document: SqlDocument,
  range: TextRange,
  item: CompletionItem,
): AppliedCompletion {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
    || range.start < 0 || range.end < range.start || range.end > document.sql.length) {
    throw new RangeError('补全替换范围不合法');
  }
  const text = item.insertText;
  const sql = document.sql.slice(0, range.start) + text + document.sql.slice(range.end);
  let cursor = range.start + text.length;
  if (item.kind === 'function') {
    if (text.endsWith('()')) cursor--;
    else {
      // Reuse an existing call and place the caret after its opening parenthesis.
      const opening = /^\s*\(/.exec(document.sql.slice(range.end));
      if (opening) cursor += opening[0].length;
    }
  }
  return { sql, cursor, edit: { range: { ...range }, text } };
}
