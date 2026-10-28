import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqlCompletion, SqlCompletionError } from '../src/completion/index.ts';

function document(markedSql, overrides = {}) {
  const cursor = markedSql.indexOf('|');
  assert.notEqual(cursor, -1, 'fixture must include a cursor marker');
  return { sql: markedSql.replace('|', ''), cursor, ...overrides };
}

function column(name = 'email') {
  return {
    id: `column:demo.users.${name}`, kind: 'column', label: name, insertText: name,
    database: 'demo', table: 'users', detail: 'user field', popularity: 80,
  };
}

function table(name = 'users') {
  return {
    id: `table:demo.${name}`, kind: 'table', label: name, insertText: name,
    database: 'demo', table: name, detail: 'demo table', popularity: 80,
  };
}

const countFunction = {
  id: 'function:COUNT', kind: 'function', label: 'COUNT', insertText: 'COUNT()',
  detail: 'count rows', signature: 'COUNT(expression)', popularity: 80,
};

function response(params, items = []) {
  return { requestId: params.requestId, items, total: items.length, elapsedMs: 0 };
}

function fixture(overrides = {}, configOverrides = {}) {
  const calls = [];
  const index = {};
  for (const name of ['Databases', 'Tables', 'Columns', 'Functions', 'Keywords']) {
    const method = `search${name}`;
    index[method] = async (params, options) => {
      calls.push({ method, params: structuredClone(params), options });
      return overrides[method]?.(params, options) ?? response(params);
    };
  }
  const config = { index, connectionId: 'test-connection', database: 'demo', ...configOverrides };
  return { engine: createSqlCompletion(config), config, index, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation did not settle promptly')), 500); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('public facade warms up without querying and supplies default index parameters', async () => {
  const { engine, calls } = fixture();
  await Promise.all([engine.ready(), engine.ready()]);
  assert.deepEqual(calls, []);
  const result = await engine.complete(document('SELECT * FROM us|'));
  assert.ok(result.requestId);
  assert.ok(calls.some((call) => call.method === 'searchTables'));
  for (const { params, options } of calls) {
    assert.equal(params.connectionId, 'test-connection');
    assert.equal(params.dialect, 'mysql');
    assert.equal(params.matchMode, 'prefix');
    assert.equal(params.limit, 30);
    assert.equal(params.requestId, result.requestId);
    assert.deepEqual(Object.keys(options), ['signal']);
  }
  engine.dispose();
});

test('configured recall and per-request database or dialect reach the appropriate providers', async () => {
  const { engine, calls } = fixture({}, { limit: 9, matchMode: 'contains', dialect: 'postgresql' });
  await engine.complete(document('SELECT * FROM ev|', { database: 'analytics', dialect: 'generic' }));
  const tables = calls.find((call) => call.method === 'searchTables');
  assert.equal(tables.params.database, 'analytics');
  for (const { params, options } of calls) {
    assert.equal(params.dialect, 'generic');
    assert.equal(params.limit, 9);
    assert.equal(params.matchMode, 'contains');
    assert.deepEqual(Object.keys(options), ['signal']);
  }
  calls.length = 0;
  await engine.complete(document('SELECT * FROM us|'));
  assert.equal(calls.find((call) => call.method === 'searchTables').params.database, 'demo');
  assert.equal(calls[0].params.dialect, 'postgresql');
  engine.dispose();
});

test('middle-token completion searches the original prefix and applies the entire token once', async () => {
  const { engine, calls } = fixture({ searchColumns: (params) => response(params, [column()]) });
  const input = document('SELECT u.em|ail FROM demo.users u');
  const result = await engine.complete(input);
  assert.equal(calls[0].params.query, 'em');
  assert.deepEqual(calls[0].params.tables, [{ database: 'demo', table: 'users', alias: 'u' }]);
  const applied = engine.apply({ document: input, result, itemId: result.items[0].id });
  assert.equal(applied.sql, 'SELECT u.email FROM demo.users u');
  assert.equal(applied.cursor, 'SELECT u.email'.length);
  assert.equal(applied.edit.text, 'email');
  assert.equal(input.sql.slice(applied.edit.range.start, applied.edit.range.end), 'email');
  assert.throws(() => engine.apply({ document: input, result, itemId: result.items[0].id }), { code: 'STALE_RESULT' });
  engine.dispose();
});

test('facade acceptance preserves identifier quotes and quotes reserved names', async () => {
  const cases = [
    ['SELECT u.`em|ail` FROM demo.users u', 'mysql', 'column', 'email', 'SELECT u.`email` FROM demo.users u'],
    ['SELECT * FROM demo.users u WHERE u.`em|', 'mysql', 'column', 'email', 'SELECT * FROM demo.users u WHERE u.`email`'],
    ['SELECT * FROM "us|', 'postgresql', 'table', 'users', 'SELECT * FROM "users"'],
    ['SELECT * FROM or|', 'mysql', 'table', 'order', 'SELECT * FROM `order`'],
    ['SELECT u.or| FROM demo.users u', 'postgresql', 'column', 'order', 'SELECT u."order" FROM demo.users u'],
  ];
  for (const [markedSql, dialect, kind, name, expected] of cases) {
    const { engine } = fixture({
      searchColumns: (params) => response(params, [column(name)]),
      searchTables: (params) => response(params, [table(name)]),
    }, { dialect });
    const input = document(markedSql);
    const result = await engine.complete(input);
    const item = result.items.find((candidate) => candidate.kind === kind);
    assert.ok(item, markedSql);
    assert.equal(engine.apply({ document: input, result, itemId: item.id }).sql, expected, markedSql);
    engine.dispose();
  }
});

test('function acceptance puts the caret inside new or existing call parentheses', async () => {
  for (const [markedSql, expected] of [
    ['SELECT CO| FROM demo.users', 'SELECT COUNT() FROM demo.users'],
    ['SELECT CO|UNT(*) FROM demo.users', 'SELECT COUNT(*) FROM demo.users'],
    ['SELECT CO|UNT  (*) FROM demo.users', 'SELECT COUNT  (*) FROM demo.users'],
  ]) {
    const { engine } = fixture({ searchFunctions: (params) => response(params, [countFunction]) });
    const input = document(markedSql);
    const result = await engine.complete(input);
    const applied = engine.apply({ document: input, result, itemId: countFunction.id });
    assert.equal(applied.sql, expected);
    assert.equal(applied.cursor, expected.indexOf('(') + 1);
    engine.dispose();
  }
});

test('a newer completion promptly cancels an adapter that ignores its signal', async () => {
  const firstStarted = deferred();
  const firstResponse = deferred();
  let firstParams;
  const { engine, calls } = fixture({ searchColumns: (params) => {
    if (params.query === 'em') {
      firstParams = params;
      firstStarted.resolve();
      return firstResponse.promise;
    }
    return response(params, [column('name')]);
  } });
  const old = engine.complete(document('SELECT u.em| FROM demo.users u'));
  const oldRejected = assert.rejects(old, { name: 'AbortError' });
  try {
    await promptly(firstStarted.promise);
    const input = document('SELECT u.na| FROM demo.users u');
    const current = await engine.complete(input);
    await promptly(oldRejected);
    assert.equal(calls[0].options.signal.aborted, true);
    assert.notEqual(current.requestId, firstParams.requestId);
    firstResponse.resolve(response(firstParams, [column()]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(engine.apply({ document: input, result: current, itemId: current.items[0].id }).sql,
      'SELECT u.name FROM demo.users u');
  } finally {
    firstResponse.resolve(response(firstParams ?? { requestId: 'cleanup' }));
    engine.dispose();
  }
});

test('independent editors do not cancel one another and use distinct request identities', async () => {
  const started = deferred();
  const replies = [deferred(), deferred()];
  const captured = [];
  const shared = fixture({ searchColumns: (params, options) => {
    const position = captured.length;
    captured.push({ params, options });
    if (captured.length === 2) started.resolve();
    return replies[position].promise;
  } });
  const second = createSqlCompletion(shared.config);
  const input = document('SELECT u.em| FROM demo.users u');
  const one = shared.engine.complete(input);
  const oneRejected = assert.rejects(one, { name: 'AbortError' });
  const two = second.complete(input);
  try {
    await promptly(started.promise);
    shared.engine.cancel();
    await promptly(oneRejected);
    assert.equal(captured[1].options.signal.aborted, false);
    assert.notEqual(captured[0].params.requestId, captured[1].params.requestId);
    replies[1].resolve(response(captured[1].params, [column()]));
    const result = await promptly(two);
    assert.equal(second.apply({ document: input, result, itemId: column().id }).sql, 'SELECT u.email FROM demo.users u');
  } finally {
    replies.forEach((reply, position) => reply.resolve(response(captured[position]?.params ?? { requestId: 'cleanup' })));
    shared.engine.dispose();
    second.dispose();
  }
});

test('pre-aborted callers never query and in-flight abort settles without adapter cooperation', async () => {
  const before = new AbortController();
  before.abort();
  const untouched = fixture();
  await assert.rejects(untouched.engine.complete(document('SELECT |'), { signal: before.signal }), { name: 'AbortError' });
  assert.deepEqual(untouched.calls, []);
  untouched.engine.dispose();

  const started = deferred();
  const reply = deferred();
  let params;
  const active = fixture({ searchColumns: (input) => { params = input; started.resolve(); return reply.promise; } });
  const during = new AbortController();
  const pending = active.engine.complete(document('SELECT u.em| FROM demo.users u'), { signal: during.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  try {
    await promptly(started.promise);
    during.abort();
    await promptly(rejected);
    assert.equal(active.calls[0].options.signal.aborted, true);
  } finally {
    reply.resolve(response(params ?? { requestId: 'cleanup' }));
    active.engine.dispose();
  }
});

test('cancel and dispose invalidate completed and pending operations', async () => {
  const input = document('SELECT u.em| FROM demo.users u');
  for (const method of ['cancel', 'dispose']) {
    const { engine } = fixture({ searchColumns: (params) => response(params, [column()]) });
    const result = await engine.complete(input);
    engine[method]();
    assert.throws(() => engine.apply({ document: input, result, itemId: column().id }), {
      code: method === 'dispose' ? 'DISPOSED' : 'STALE_RESULT',
    });
    if (method === 'dispose') {
      await assert.rejects(engine.complete(input), { code: 'DISPOSED' });
      await assert.rejects(engine.ready(), { code: 'DISPOSED' });
    }
    engine.dispose();

    const started = deferred();
    const reply = deferred();
    let params;
    const pendingEngine = fixture({ searchColumns: (value) => { params = value; started.resolve(); return reply.promise; } }).engine;
    const pending = pendingEngine.complete(input);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    try {
      await promptly(started.promise);
      pendingEngine[method]();
      await promptly(rejected);
    } finally {
      reply.resolve(response(params ?? { requestId: 'cleanup' }));
      pendingEngine.dispose();
    }
  }
});

test('acceptance rejects foreign, replaced, unknown and document-mismatched results', async () => {
  const input = document('SELECT u.em| FROM demo.users u');
  const { engine } = fixture({ searchColumns: (params) => response(params, [column()]) });
  const result = await engine.complete(input);
  assert.throws(() => engine.apply({ document: input, result: { ...result }, itemId: column().id }), { code: 'STALE_RESULT' });
  assert.throws(() => engine.apply({ document: input, result, itemId: 'unknown' }), { code: 'UNKNOWN_ITEM' });
  assert.throws(() => engine.apply({ document: { ...input, sql: input.sql + ' ' }, result, itemId: column().id }), { code: 'DOCUMENT_CHANGED' });
  assert.throws(() => engine.apply({ document: { ...input, cursor: input.cursor - 1 }, result, itemId: column().id }), { code: 'DOCUMENT_CHANGED' });

  const foreign = fixture({ searchColumns: (params) => response(params, [column()]) });
  const otherResult = await foreign.engine.complete(input);
  assert.throws(() => engine.apply({ document: input, result: otherResult, itemId: column().id }), { code: 'STALE_RESULT' });
  const newer = await engine.complete(input);
  assert.throws(() => engine.apply({ document: input, result, itemId: column().id }), { code: 'STALE_RESULT' });
  assert.equal(engine.apply({ document: input, result: newer, itemId: column().id }).sql, 'SELECT u.email FROM demo.users u');
  foreign.engine.dispose();
  engine.dispose();
});

test('input, config and display-result mutation cannot alter captured requests or accepted edits', async () => {
  const started = deferred();
  const reply = deferred();
  let params;
  const { engine, config, calls } = fixture({ searchColumns: (value) => { params = value; started.resolve(); return reply.promise; } });
  const input = document('SELECT u.em|ail FROM demo.users u');
  const original = { ...input };
  const pending = engine.complete(input);
  try {
    input.sql = 'SELECT changed';
    input.cursor = 0;
    config.database = 'analytics';
    config.connectionId = 'changed-connection';
    config.dialect = 'generic';
    config.limit = 1;
    config.matchMode = 'contains';
    await promptly(started.promise);
    assert.equal(params.query, 'em');
    assert.equal(params.connectionId, 'test-connection');
    assert.equal(params.dialect, 'mysql');
    assert.equal(params.limit, 30);
    assert.equal(params.matchMode, 'prefix');
    reply.resolve(response(params, [column()]));
    const result = await pending;
    const itemId = result.items[0].id;
    result.context.replaceRange.start = 0;
    result.context.replaceRange.end = original.sql.length;
    result.items[0].insertText = 'DROP DATABASE demo';
    result.items[0].id = 'display-id';
    result.items.push({ ...result.items[0], id: 'invented' });
    result.requestId = 'display-request';
    assert.throws(() => engine.apply({ document: original, result, itemId: 'invented' }), { code: 'UNKNOWN_ITEM' });
    assert.equal(engine.apply({ document: original, result, itemId }).sql, 'SELECT u.email FROM demo.users u');
    await engine.complete(document('SELECT * FROM us|'));
    const tables = calls.find((call) => call.method === 'searchTables');
    assert.equal(tables.params.database, 'demo');
    assert.equal(tables.params.connectionId, 'test-connection');
  } finally {
    reply.resolve(response(params ?? { requestId: 'cleanup' }));
    engine.dispose();
  }
});

test('configuration and document validation report actionable errors before index requests', async () => {
  const valid = fixture();
  for (const overrides of [
    { connectionId: '' }, { database: ' ' }, { dialect: 'sqlite' },
    { index: {} }, { matchMode: 'fuzzy' },
  ]) assert.throws(() => createSqlCompletion({ ...valid.config, ...overrides }), TypeError);
  for (const limit of [0, 101, 2.5, NaN]) {
    assert.throws(() => createSqlCompletion({ ...valid.config, limit }), RangeError);
  }
  for (const input of [
    { sql: 'SELECT', cursor: -1 }, { sql: 'SELECT', cursor: 7 },
    { sql: 'SELECT', cursor: 1.5 }, { sql: 'SELECT', cursor: NaN },
  ]) await assert.rejects(valid.engine.complete(input), RangeError);
  await assert.rejects(valid.engine.complete({ sql: null, cursor: 0 }), TypeError);
  await assert.rejects(valid.engine.complete(document('SEL|', { database: '' })), TypeError);
  await assert.rejects(valid.engine.complete(document('SEL|', { dialect: 'sqlite' })), TypeError);
  assert.deepEqual(valid.calls, []);
  assert.ok(new SqlCompletionError('STALE_RESULT', 'test') instanceof Error);
  valid.engine.dispose();
});
