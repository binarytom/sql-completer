import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCompletionEdit } from '../src/completion/edits.ts';

const item = {
  id: 'email', kind: 'column', label: 'email', insertText: 'email',
  detail: '', popularity: 0, score: 0, reason: '',
};

test('pure editing preserves UTF-16 offsets and does not mutate its inputs', () => {
  const sql = 'SELECT /* 😀 */ u.email FROM demo.users u';
  const start = sql.indexOf('email');
  const document = Object.freeze({ sql, cursor: start + 2 });
  const range = Object.freeze({ start, end: start + 'email'.length });
  const candidate = Object.freeze({ ...item, insertText: 'email_address' });
  const applied = applyCompletionEdit(document, range, candidate);
  assert.equal(applied.sql, 'SELECT /* 😀 */ u.email_address FROM demo.users u');
  assert.equal(applied.cursor, start + 'email_address'.length);
  assert.deepEqual(applied.edit, { range, text: 'email_address' });
  assert.notEqual(applied.edit.range, range);
});

test('pure editing rejects reversed, fractional and out-of-document replacement ranges', () => {
  const document = { sql: 'SELECT em', cursor: 9 };
  for (const range of [
    { start: -1, end: 2 }, { start: 5, end: 4 }, { start: 7, end: 10 },
    { start: 7.5, end: 9 }, { start: 7, end: NaN }, { start: Infinity, end: 9 },
  ]) assert.throws(() => applyCompletionEdit(document, range, item), RangeError);
});
