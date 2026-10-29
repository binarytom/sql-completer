import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockMetadataIndex, MOCK_DATABASES } from '../examples/demo/mock-metadata.ts';

function params(overrides = {}) {
  return {
    requestId: 'test-request',
    connectionId: 'demo-local',
    dialect: 'mysql',
    query: '',
    matchMode: 'prefix',
    limit: 100,
    ...overrides,
  };
}

function fixture(t) {
  const consoleLog = t.mock.method(console, 'info', () => {});
  const logs = [];
  return { index: createMockMetadataIndex((entry) => logs.push(entry)), logs, consoleLog };
}

test('database search prints the full request and reports its lifecycle', async (t) => {
  const { index, logs, consoleLog } = fixture(t);
  const request = params({ query: 'DE', limit: 5 });
  const result = await index.searchDatabases(request);

  assert.deepEqual(result.items.map((item) => item.label), ['demo']);
  assert.equal(result.requestId, request.requestId);
  assert.ok(result.elapsedMs >= 0);
  assert.deepEqual(logs.map((entry) => entry.status), ['pending', 'success']);
  assert.deepEqual(logs[0].params, request);
  assert.equal(logs[1].count, 1);
  assert.deepEqual(consoleLog.mock.calls[0].arguments, [
    '[metadata-index]', 'POST /api/completion/databases/search', request,
  ]);
});

test('prefix and contains searches are distinct and case insensitive', async (t) => {
  const { index } = fixture(t);
  const query = params({ database: 'demo', query: 'SERS' });
  const prefix = await index.searchTables(query);
  const contains = await index.searchTables({ ...query, matchMode: 'contains' });

  assert.deepEqual(prefix.items, []);
  assert.deepEqual(contains.items.map((item) => item.label), ['users']);
});

test('pagination enumerates each database once and preserves the total', async (t) => {
  const { index } = fixture(t);
  const found = [];
  let cursor;
  do {
    const page = await index.searchDatabases(params({ limit: 1, cursor }));
    assert.equal(page.total, MOCK_DATABASES.length);
    assert.equal(page.items.length, 1);
    found.push(page.items[0].label);
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual([...found].sort(), [...MOCK_DATABASES].sort());
  assert.equal(new Set(found).size, found.length);
});

test('a pagination cursor cannot be reused with a different query or endpoint', async (t) => {
  const { index } = fixture(t);
  const first = await index.searchDatabases(params({ limit: 1 }));
  assert.ok(first.nextCursor);
  await assert.rejects(index.searchDatabases(params({ query: 'd', cursor: first.nextCursor })), /cursor/);
  await assert.rejects(index.searchTables(params({ cursor: first.nextCursor })), /cursor/);
});

test('table and column searches remain within the requested database and tables', async (t) => {
  const { index } = fixture(t);
  const tables = await index.searchTables(params({ database: 'analytics' }));
  assert.ok(tables.items.length > 0);
  assert.ok(tables.items.every((item) => item.database === 'analytics'));

  const scoped = await index.searchColumns(params({
    tables: [{ database: 'demo', table: 'users', alias: 'u' }],
    query: 'em',
  }));
  assert.deepEqual(scoped.items.map((item) => item.label), ['email']);
  assert.ok(scoped.items.every((item) => item.database === 'demo' && item.table === 'users'));
  assert.deepEqual((await index.searchColumns(params({ tables: [] }))).items, []);
  assert.deepEqual((await index.searchColumns(params({ tables: [{ database: 'missing', table: 'users' }] }))).items, []);
});

test('repeated table scopes do not duplicate column candidates', async (t) => {
  const { index } = fixture(t);
  const reference = { database: 'demo', table: 'users' };
  const result = await index.searchColumns(params({ tables: [reference, { ...reference, alias: 'u' }] }));
  assert.ok(result.items.length > 0);
  assert.equal(new Set(result.items.map((item) => item.id)).size, result.items.length);
});

test('function searches respect SQL dialect and database scope', async (t) => {
  const { index } = fixture(t);
  const mysql = await index.searchFunctions(params());
  const postgres = await index.searchFunctions(params({ dialect: 'postgresql' }));
  const generic = await index.searchFunctions(params({ dialect: 'generic' }));
  const names = (result) => result.items.map((item) => item.label);

  assert.ok(names(mysql).includes('IFNULL'));
  assert.ok(!names(mysql).includes('DATE_TRUNC'));
  assert.ok(names(postgres).includes('DATE_TRUNC'));
  assert.ok(!names(postgres).includes('IFNULL'));
  assert.ok(names(generic).includes('COUNT'));
  assert.ok(!names(generic).includes('IFNULL'));
  assert.ok(!names(generic).includes('DATE_TRUNC'));
  assert.deepEqual((await index.searchFunctions(params({ database: 'missing' }))).items, []);
});

test('keyword search returns suggestions for the current clause', async (t) => {
  const { index } = fixture(t);
  const start = await index.searchKeywords(params({ clause: 'start', query: 'sel' }));
  const order = await index.searchKeywords(params({ clause: 'order' }));

  assert.deepEqual(start.items.map((item) => item.label), ['SELECT']);
  assert.ok(order.items.some((item) => item.label === 'DESC'));
  assert.ok(!order.items.some((item) => item.label === 'SELECT'));
  for (const clause of ['group', 'order']) {
    const by = await index.searchKeywords(params({ clause, query: 'B' }));
    assert.deepEqual(by.items.map((item) => item.label), ['BY']);
  }
});

test('request parameters are snapshotted before asynchronous work', async (t) => {
  const { index, logs } = fixture(t);
  const request = params({ database: 'demo', query: 'us' });
  const pending = index.searchTables(request);
  request.database = 'analytics';
  request.query = 'events';
  const result = await pending;

  assert.deepEqual(result.items.map((item) => item.label), ['users']);
  assert.equal(logs[0].params.database, 'demo');
  assert.equal(logs[1].params.query, 'us');
});

test('aborted requests reject and do not publish successful responses', async (t) => {
  const { index, logs, consoleLog } = fixture(t);
  const beforeStart = new AbortController();
  beforeStart.abort();
  await assert.rejects(index.searchDatabases(params(), { signal: beforeStart.signal }), { name: 'AbortError' });
  assert.deepEqual(logs, []);
  assert.equal(consoleLog.mock.calls.length, 0);

  const inFlight = new AbortController();
  const pending = index.searchDatabases(params(), { signal: inFlight.signal });
  inFlight.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(logs.map((entry) => entry.status), ['pending', 'cancelled']);
});

test('invalid connection and pagination parameters produce observable errors', async (t) => {
  const { index, logs } = fixture(t);
  await assert.rejects(index.searchDatabases(params({ connectionId: 'unknown' })), /连接/);
  await assert.rejects(index.searchDatabases(params({ limit: Number.NaN })), /limit/);
  assert.deepEqual(logs.map((entry) => entry.status), ['pending', 'error', 'pending', 'error']);
});
