import assert from 'node:assert/strict';
import test from 'node:test';
import { complete } from '../src/completion/service.ts';

function request(markedSql, overrides = {}) {
  const cursor = markedSql.indexOf('|');
  assert.notEqual(cursor, -1, 'fixture must include a cursor marker');
  return {
    sql: markedSql.replace('|', ''), cursor, database: 'demo', dialect: 'mysql',
    connectionId: 'demo-local', requestId: 'service-test', ...overrides,
  };
}

function column(name, table = 'users', popularity = 50) {
  return {
    id: `column:demo.${table}.${name}`, kind: 'column', label: name, insertText: name,
    database: 'demo', table, detail: `demo.${table}`, dataType: 'VARCHAR', popularity,
  };
}

function indexFixture(overrides = {}) {
  const calls = [];
  const index = {};
  for (const name of ['Databases', 'Tables', 'Columns', 'Functions', 'Keywords']) {
    const method = `search${name}`;
    index[method] = async (params, options) => {
      calls.push({ method, params: structuredClone(params), options });
      if (overrides[method]) return overrides[method](params, options);
      return { requestId: params.requestId, items: [], total: 0, elapsedMs: 0 };
    };
  }
  return { index, calls };
}

function result(params, items) {
  return { requestId: params.requestId, items, total: items.length, elapsedMs: 0 };
}

test('qualified field completion sends the original prefix and exact alias scope', async () => {
  const { index, calls } = indexFixture({
    searchColumns: (params) => result(params, [column('email')]),
  });
  const input = request('SELECT u.em|ail FROM demo.users u');
  const response = await complete(input, index);

  assert.deepEqual(calls.map((entry) => entry.method), ['searchColumns']);
  assert.equal(calls[0].params.query, 'em');
  assert.equal(calls[0].params.matchMode, 'prefix');
  assert.equal(calls[0].params.limit, 30);
  assert.deepEqual(calls[0].params.tables, [{ database: 'demo', table: 'users', alias: 'u' }]);
  assert.equal(response.items[0].insertText, 'email');
  const { start, end } = response.context.replaceRange;
  assert.equal(input.sql.slice(0, start) + response.items[0].insertText + input.sql.slice(end), 'SELECT u.email FROM demo.users u');
});

test('completion search options configure recall without leaking into transport options', async () => {
  const controller = new AbortController();
  const { index, calls } = indexFixture();
  await complete(request('SELECT | FROM demo.users'), index, {
    limit: 7, matchMode: 'contains', signal: controller.signal,
  });
  assert.ok(calls.length > 1, 'exercise parallel provider calls');
  for (const call of calls) {
    assert.equal(call.params.limit, 7);
    assert.equal(call.params.matchMode, 'contains');
    assert.deepEqual(call.options, { signal: controller.signal });
  }

  const withoutSignal = indexFixture();
  await complete(request('SELECT * FROM us|'), withoutSignal.index, { limit: 1 });
  assert.equal(withoutSignal.calls[0].params.limit, 1);
  assert.equal(withoutSignal.calls[0].params.matchMode, 'prefix');
  assert.equal(withoutSignal.calls[0].options, undefined);
});

test('invalid recall configuration rejects before querying providers', async () => {
  for (const limit of [0, 101, 1.5, NaN, Infinity, '30', null]) {
    const { index, calls } = indexFixture();
    await assert.rejects(complete(request('SELECT |'), index, { limit }), { name: 'RangeError' });
    assert.deepEqual(calls, []);
  }
  for (const matchMode of ['', 'fuzzy', null]) {
    const { index, calls } = indexFixture();
    await assert.rejects(complete(request('SELECT |'), index, { matchMode }), { name: 'TypeError' });
    assert.deepEqual(calls, []);
  }
});

test('database-qualified FROM completion narrows the table endpoint', async () => {
  const { index, calls } = indexFixture();
  await complete(request('SELECT * FROM analytics.ev|'), index);
  assert.deepEqual(calls.map((entry) => entry.method), ['searchTables']);
  assert.equal(calls[0].params.database, 'analytics');
  assert.equal(calls[0].params.query, 'ev');
});

test('an unknown qualifier cannot trigger unrelated column retrieval', async () => {
  const { index, calls } = indexFixture({
    searchColumns: (params) => result(params, [column('email')]),
  });
  const response = await complete(request('SELECT missing.em| FROM demo.users u'), index);
  assert.deepEqual(response.items, []);
  assert.equal(calls.some((entry) => entry.method === 'searchColumns'), false);
});

test('ambiguous column names retain each source alias', async () => {
  const { index } = indexFixture({
    searchColumns: (params) => result(params, [column('status'), column('status', 'orders')]),
  });
  const response = await complete(request('SELECT sta| FROM demo.users u JOIN demo.orders o ON u.id = o.user_id'), index);
  const fields = response.items.filter((item) => item.kind === 'column');
  assert.deepEqual(fields.map((item) => item.insertText).sort(), ['o.status', 'u.status']);
});

test('self joins expand one physical field into both alias suggestions', async () => {
  const { index } = indexFixture({
    searchColumns: (params) => result(params, [column('email')]),
  });
  const response = await complete(request('SELECT em| FROM demo.users u JOIN demo.users manager ON u.id = manager.id'), index);
  const fields = response.items.filter((item) => item.kind === 'column');
  assert.deepEqual(fields.map((item) => item.insertText).sort(), ['manager.email', 'u.email']);
  assert.equal(new Set(fields.map((item) => item.id)).size, 2);
});

test('exact matches outrank popularity and duplicate candidates disappear', async () => {
  const { index } = indexFixture({
    searchColumns: (params) => result(params, [column('email_address', 'users', 100), column('email', 'users', 1), column('email', 'users', 1)]),
  });
  const response = await complete(request('SELECT u.email| FROM demo.users u'), index);
  assert.deepEqual(response.items.map((item) => item.label), ['email', 'email_address']);
  assert.ok(response.items[0].score > response.items[1].score);
  assert.match(response.items[0].reason, /精确匹配/);
});

test('one failed provider does not discard successful parallel providers', async () => {
  const { index, calls } = indexFixture({
    searchColumns: () => { throw new Error('catalog unavailable'); },
    searchFunctions: (params) => result(params, [{
      id: 'function:COUNT', kind: 'function', label: 'COUNT', insertText: 'COUNT()',
      detail: 'count rows', signature: 'COUNT(expression)', popularity: 100,
    }]),
  });
  const response = await complete(request('SELECT | FROM demo.users'), index);
  assert.ok(calls.some((entry) => entry.method === 'searchColumns'));
  assert.ok(calls.some((entry) => entry.method === 'searchFunctions'));
  assert.ok(response.items.some((item) => item.label === 'COUNT'));
  assert.ok(response.errors.some((message) => message.includes('catalog unavailable')));
});

test('function completion keeps existing parentheses', async () => {
  const { index } = indexFixture({
    searchFunctions: (params) => result(params, [{
      id: 'function:COUNT', kind: 'function', label: 'COUNT', insertText: 'COUNT()',
      detail: 'count rows', signature: 'COUNT(expression)', popularity: 100,
    }]),
  });
  const response = await complete(request('SELECT CO|UNT(*) FROM demo.users'), index);
  assert.ok(response.items.some((item) => item.label === 'COUNT' && item.insertText === 'COUNT'));
});

test('quoted field completion preserves the existing quote delimiters', async () => {
  const { index } = indexFixture({
    searchColumns: (params) => result(params, [column('email')]),
  });
  const input = request('SELECT u.`em|ail` FROM demo.users u');
  const response = await complete(input, index);
  const { start, end } = response.context.replaceRange;
  assert.equal(input.sql.slice(0, start) + response.items[0].insertText + input.sql.slice(end), 'SELECT u.`email` FROM demo.users u');
});

test('ambiguous quoted fields quote each qualification component separately', async () => {
  const { index } = indexFixture({
    searchColumns: (params) => result(params, [column('status'), column('status', 'orders')]),
  });
  const input = request('SELECT `sta|` FROM demo.users u JOIN demo.orders o ON u.id = o.user_id');
  const response = await complete(input, index);
  const field = response.items.find((item) => item.label === 'u.status');
  assert.ok(field);
  const { start, end } = response.context.replaceRange;
  assert.equal(input.sql.slice(0, start) + field.insertText + input.sql.slice(end), 'SELECT `u`.`status` FROM demo.users u JOIN demo.orders o ON u.id = o.user_id');
});

test('same-name tables in different databases use fully qualified ambiguous fields', async () => {
  const { index } = indexFixture({
    searchColumns: (params) => result(params, [
      column('email'),
      { ...column('email'), id: 'column:analytics.users.email', database: 'analytics' },
    ]),
  });
  const response = await complete(request('SELECT em| FROM demo.users JOIN analytics.users ON demo.users.id = analytics.users.id'), index);
  assert.deepEqual(response.items.filter((item) => item.kind === 'column').map((item) => item.insertText).sort(), ['analytics.users.email', 'demo.users.email']);
});

test('accepting a suggestion closes an unfinished identifier quote', async () => {
  for (const [markedSql, dialect, expected, expectedKind] of [
    ['SELECT * FROM `us|', 'mysql', 'SELECT * FROM `users`', 'table'],
    ['SELECT * FROM "us|', 'postgresql', 'SELECT * FROM "users"', 'table'],
    ['SELECT * FROM demo.users u WHERE u.`em|', 'mysql', 'SELECT * FROM demo.users u WHERE u.`email`', 'column'],
    ['SELECT * FROM demo.users u WHERE u."em|', 'postgresql', 'SELECT * FROM demo.users u WHERE u."email"', 'column'],
  ]) {
    const { index } = indexFixture({
      searchTables: (params) => result(params, [{
        id: 'table:demo.users', kind: 'table', label: 'users', insertText: 'users',
        database: 'demo', table: 'users', detail: 'users', popularity: 100,
      }]),
      searchColumns: (params) => result(params, [column('email')]),
    });
    const input = request(markedSql, { dialect });
    const response = await complete(input, index);
    const item = response.items.find((candidate) => candidate.kind === expectedKind);
    assert.ok(item, markedSql);
    const { start, end } = response.context.replaceRange;
    assert.equal(input.sql.slice(0, start) + item.insertText + input.sql.slice(end), expected, markedSql);
  }
});

test('reserved table and field identifiers are quoted for the current dialect', async () => {
  for (const [dialect, delimiter] of [['mysql', '`'], ['postgresql', '"']]) {
    const { index } = indexFixture({
      searchColumns: (params) => result(params, [column('order')]),
      searchTables: (params) => result(params, [{
        id: 'table:demo.order', kind: 'table', label: 'order', insertText: 'order',
        database: 'demo', table: 'order', detail: 'reserved identifier', popularity: 100,
      }]),
    });
    const fieldResult = await complete(request('SELECT u.or| FROM demo.users u', { dialect }), index);
    assert.equal(fieldResult.items[0].insertText, `${delimiter}order${delimiter}`);
    const tableResult = await complete(request('SELECT * FROM or|', { dialect }), index);
    assert.equal(tableResult.items[0].insertText, `${delimiter}order${delimiter}`);
  }
});

test('pre-aborted and in-flight completion requests reject with AbortError', async () => {
  const before = new AbortController();
  before.abort();
  const first = indexFixture();
  await assert.rejects(complete(request('SELECT |'), first.index, { signal: before.signal }), { name: 'AbortError' });
  assert.deepEqual(first.calls, []);

  const during = new AbortController();
  const second = indexFixture({
    searchColumns: (params) => {
      during.abort();
      return result(params, [column('email')]);
    },
  });
  await assert.rejects(complete(request('SELECT u.em| FROM demo.users u'), second.index, { signal: during.signal }), { name: 'AbortError' });
  assert.equal(second.calls[0].options.signal, during.signal);
});

test('mismatched response request IDs are discarded', async () => {
  const { index } = indexFixture({
    searchColumns: (params) => ({ ...result(params, [column('email')]), requestId: 'older-request' }),
  });
  const response = await complete(request('SELECT u.em| FROM demo.users u'), index);
  assert.deepEqual(response.items, []);
  assert.match(response.errors[0], /requestId/);
});

test('strings and comments do not query the metadata index', async () => {
  for (const marked of ["SELECT 'em|' FROM demo.users", 'SELECT * FROM demo.users -- em|']) {
    const { index, calls } = indexFixture();
    const response = await complete(request(marked), index);
    assert.deepEqual(response.items, []);
    assert.deepEqual(calls, []);
  }
});
