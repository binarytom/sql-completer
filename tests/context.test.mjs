import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { analyzeContext, initializeParser } from '../src/completion/context.ts';

before(initializeParser);

function analyze(markedSql, overrides = {}) {
  const cursor = markedSql.indexOf('|');
  assert.notEqual(cursor, -1);
  const request = {
    sql: markedSql.replace('|', ''), cursor, database: 'demo', dialect: 'mysql',
    connectionId: 'demo-local', requestId: 'context-test', ...overrides,
  };
  return { request, context: analyzeContext(request) };
}

test('the actual sentinel AST distinguishes table, expression, and function name roles', () => {
  const cases = [
    ['SELECT * FROM us|', ['database', 'table'], /Table\.name.*\(table\)/],
    ['SELECT us| FROM accounts', ['column', 'function', 'keyword'], /Identifier \(column\)/],
    ['SELECT SU|M(total) FROM accounts', ['function'], /Function\.name.*\(function\)/],
    ['SELECT * FROM accounts a|', ['keyword'], /alias\.name \(alias\)/],
  ];
  for (const [sql, kinds, diagnostic] of cases) {
    const { context, request } = analyze(sql);
    assert.equal(context.parserStatus, 'parsed', sql);
    assert.deepEqual(context.kinds, kinds, sql);
    assert.match(context.parserMessage, diagnostic, sql);
    assert.ok(JSON.stringify(context.ast).includes('__suggestion__'));
    assert.ok(!request.sql.includes('__suggestion__'));
  }
});

test('middle-token completion retains the original prefix, qualifier, and full replacement range', () => {
  const { context, request } = analyze('SELECT u.em|ail FROM commerce.accounts u');
  assert.equal(context.prefix, 'em');
  assert.equal(context.qualifier, 'u');
  assert.equal(request.sql.slice(context.replaceRange.start, context.replaceRange.end), 'email');
  assert.deepEqual(context.tables, [{ database: 'commerce', table: 'accounts', alias: 'u' }]);
});

test('SELECT projection resolves tables and joins that appear after the caret', () => {
  const { context } = analyze('SELECT o.to| FROM demo.users AS u JOIN sales.purchases o ON u.id = o.user_id');
  assert.equal(context.clause, 'select');
  assert.deepEqual(context.tables, [
    { database: 'demo', table: 'users', alias: 'u' },
    { database: 'sales', table: 'purchases', alias: 'o' },
  ]);
});

test('explicit AS alias positions have no catalog candidates, including parser fallback', () => {
  for (const dialect of ['mysql', 'postgresql', 'generic']) {
    for (const [sql, status] of [
      ["SELECT u.email AS |\nFROM demo.users AS u\nWHERE u.status = 'active';", 'parsed'],
      ['SELECT u.email AS user_em|ail FROM demo.users u', 'parsed'],
      ['SELECT u.email AS /* alias */ | FROM demo.users u', 'parsed'],
      ['SELECT * FROM demo.users AS |', 'parsed'],
      ['SELECT * FROM demo.users AS us|ers', 'parsed'],
      ['SELECT * FROM demo.users u JOIN demo.orders AS | ON u.id = user_id', 'parsed'],
      ['SELECT u.email AS | FROM demo.users u WHERE id =', 'recovered'],
      ['SELECT u.email AS | FROM demo.users u WHERE id = =', 'lexical'],
      ['SELECT * FROM demo.users AS | WHERE id = =', 'lexical'],
    ]) {
      const { context } = analyze(sql, { dialect });
      assert.equal(context.parserStatus, status, `${dialect}: ${sql}`);
      assert.deepEqual(context.kinds, [], `${dialect}: ${sql}`);
    }
  }
  const { context, request } = analyze('SELECT email AS user_em|ail FROM demo.users');
  assert.equal(context.prefix, 'user_em');
  assert.equal(request.sql.slice(context.replaceRange.start, context.replaceRange.end), 'user_email');
  for (const [sql, dialect] of [
    ['SELECT email AS `user_em|ail` FROM demo.users', 'mysql'],
    ['SELECT email AS "user_em|ail" FROM demo.users', 'postgresql'],
  ]) {
    assert.deepEqual(analyze(sql, { dialect }).context.kinds, [], sql);
  }
});

test('implicit aliases only recall keywords that match the prefix and fit the preceding SQL', () => {
  for (const dialect of ['mysql', 'postgresql', 'generic']) {
    for (const sql of [
      'SELECT email user_em| FROM demo.users',
      'SELECT email | FROM demo.users',
      'SELECT * FROM demo.users user_em|',
      'SELECT email user_em| FROM demo.users WHERE id = =',
      'SELECT * FROM demo.users user_em| WHERE id = =',
      dialect === 'mysql' ? 'SELECT email `FR|` FROM demo.users' : 'SELECT email "FR|" FROM demo.users',
    ]) {
      assert.deepEqual(analyze(sql, { dialect }).context.kinds, [], `${dialect}: ${sql}`);
    }
    for (const sql of [
      'SELECT email FR|',
      'SELECT email fr| demo.users',
      'SELECT email F|oo',
      'SELECT * FROM demo.users WH|',
      'SELECT * FROM demo.users JO| demo.orders ON users.id = orders.user_id',
      'SELECT * FROM demo.users JOIN demo.orders O|',
      'SELECT email A|',
      'SELECT * FROM demo.users GR|',
      'SELECT email FR| /* missing table */',
      'SELECT email FR| demo.users WHERE id =',
    ]) {
      assert.deepEqual(analyze(sql, { dialect }).context.kinds, ['keyword'], `${dialect}: ${sql}`);
    }
  }
});

test('CAST AS is not treated as alias declaration', () => {
  const { context } = analyze('SELECT CAST(email AS |) FROM demo.users');
  assert.notDeepEqual(context.kinds, []);
});

test('qualified table lookup preserves the database and excludes the synthetic table from scope', () => {
  const { context } = analyze('SELECT * FROM warehouse.acc|');
  assert.equal(context.prefix, 'acc');
  assert.equal(context.qualifier, 'warehouse');
  assert.deepEqual(context.kinds, ['table']);
  assert.deepEqual(context.tables, []);
});

test('AST ancestors distinguish ON, WHERE, GROUP BY, ORDER BY, and HAVING expressions', () => {
  const cases = [
    ['SELECT * FROM users u JOIN orders o ON o.us| = u.id', 'on'],
    ['SELECT * FROM users WHERE em|', 'where'],
    ['SELECT * FROM users GROUP BY em|', 'group'],
    ['SELECT * FROM users ORDER BY em|', 'order'],
    ['SELECT id FROM users GROUP BY id HAVING co| > 1', 'having'],
  ];
  for (const [sql, clause] of cases) {
    const { context } = analyze(sql);
    assert.equal(context.clause, clause, sql);
    assert.equal(context.parserStatus, 'parsed', sql);
    assert.ok(context.kinds.includes('column'), sql);
  }
});

test('incomplete SQL uses bounded parser repair while retaining marker context and real tables', () => {
  for (const sql of [
    'SELECT u.em| FROM users u WHERE id =',
    'SELECT u.em| FROM users u WHERE (id =',
    'SELECT u.em| FROM users u JOIN',
    'SELECT u.em| FROM users u GROUP',
  ]) {
    const { context } = analyze(sql);
    assert.equal(context.parserStatus, 'recovered', sql);
    assert.equal(context.prefix, 'em');
    assert.equal(context.qualifier, 'u');
    assert.deepEqual(context.tables, [{ database: 'demo', table: 'users', alias: 'u' }], sql);
    assert.match(context.parserMessage, /原解析错误/);
    assert.match(context.parserMessage, /__suggestion__.*column/);
  }
});

test('unrecoverable suffixes report lexical fallback without inventing table references', () => {
  const { context } = analyze('SELECT a.em| FROM tenant.accounts a WHERE id = =');
  assert.equal(context.parserStatus, 'lexical');
  assert.equal(context.qualifier, 'a');
  assert.deepEqual(context.kinds, ['column']);
  assert.deepEqual(context.tables, [{ database: 'tenant', table: 'accounts', alias: 'a' }]);
  assert.match(context.parserMessage, /词法上下文降级/);
});

test('a partial first keyword falls back to keyword search and GROUP/ORDER request BY', () => {
  const { context } = analyze('SEL|');
  assert.equal(context.clause, 'start');
  assert.equal(context.prefix, 'SEL');
  assert.equal(context.parserStatus, 'lexical');
  assert.deepEqual(context.kinds, ['keyword']);
  assert.deepEqual(analyze('SELECT * FROM users ORDER B|Y id').context.kinds, ['keyword']);
  assert.deepEqual(analyze('SELECT * FROM users GROUP |').context.kinds, ['keyword']);
});

test('only the current statement contributes table scope, even if a previous statement is malformed', () => {
  const { context, request } = analyze('SELECT (; SELECT o.to| FROM commerce.orders o; SELECT * FROM secret.users');
  assert.equal(context.parserStatus, 'parsed');
  assert.deepEqual(context.tables, [{ database: 'commerce', table: 'orders', alias: 'o' }]);
  assert.equal(request.sql.slice(context.statementRange.start, context.statementRange.end), ' SELECT o.to FROM commerce.orders o');
});

test('comment and literal contents cannot create statement boundaries or table references', () => {
  const { context } = analyze("SELECT em|, 'FROM fake; JOIN hidden' FROM accounts a /* ; FROM private */");
  assert.equal(context.parserStatus, 'parsed');
  assert.deepEqual(context.tables, [{ database: 'demo', table: 'accounts', alias: 'a' }]);
});

test('comments and SQL string forms suppress completion, including the line-end boundary', () => {
  const cases = [
    ["SELECT 'em|' FROM users", 'mysql'],
    ["SELECT 'it''s em|' FROM users", 'mysql'],
    ['SELECT "em|" FROM users', 'mysql'],
    ['SELECT -- em|\n FROM users', 'mysql'],
    ['SELECT # em|\n FROM users', 'mysql'],
    ['SELECT /* em| */ 1', 'generic'],
    ['SELECT /* first /* em| */ second */ 1', 'postgresql'],
    ['SELECT $tag$ em| $tag$ FROM users', 'postgresql'],
  ];
  for (const [sql, dialect] of cases) {
    const { context } = analyze(sql, { dialect });
    assert.equal(context.parserStatus, 'suppressed', sql);
    assert.deepEqual(context.kinds, [], sql);
  }
  assert.notEqual(analyze('SELECT /* comment */ | FROM users').context.parserStatus, 'suppressed');
});

test('quoted identifiers preserve their delimiters and expose unquoted prefix and alias', () => {
  for (const [sql, dialect] of [
    ['SELECT `u`.`em|ail` FROM `tenant`.`accounts` `u`', 'mysql'],
    ['SELECT "u"."em|ail" FROM "tenant"."accounts" "u"', 'postgresql'],
  ]) {
    const { context, request } = analyze(sql, { dialect });
    assert.equal(context.parserStatus, 'parsed');
    assert.equal(context.prefix, 'em');
    assert.equal(context.qualifier, 'u');
    assert.equal(request.sql.slice(context.replaceRange.start, context.replaceRange.end), 'email');
    assert.deepEqual(context.tables, [{ database: 'tenant', table: 'accounts', alias: 'u' }]);
  }
});

test('CTE, nested SELECT, and set expressions disable field scope conservatively', () => {
  for (const sql of [
    'WITH c AS (SELECT * FROM private.users) SELECT c.em| FROM c',
    'SELECT d.em| FROM (SELECT * FROM private.users) d',
    'SELECT em| FROM private.users UNION SELECT name FROM accounts',
  ]) {
    const { context } = analyze(sql);
    assert.deepEqual(context.tables, [], sql);
    assert.match(context.parserMessage, /复杂查询作用域暂不解析/, sql);
  }
});

test('an existing sentinel identifier does not steal the inserted marker location', () => {
  const { context } = analyze('SELECT __suggestion__, u.em| FROM users u');
  assert.equal(context.parserStatus, 'parsed');
  assert.equal(context.qualifier, 'u');
  assert.match(context.parserMessage, /projection\.1\./);
});

test('non-SELECT statements are explicit unsupported fallbacks rather than misleading AST field roles', () => {
  for (const sql of [
    'UPDATE users SET em| = 1',
    'DELETE FROM users WHERE em|',
    'CREATE TABLE demo.us| (id INT)',
    'INSERT INTO demo.us| VALUES (1)',
    'DELETE FROM users WHERE em| = =',
  ]) {
    const { context } = analyze(sql);
    assert.equal(context.parserStatus, 'lexical', sql);
    assert.deepEqual(context.tables, [], sql);
    assert.deepEqual(context.kinds, ['keyword'], sql);
    assert.match(context.parserMessage, /仅支持 SELECT/, sql);
  }
});

test('PostgreSQL escaped string prefixes retain suppression across escaped quotes', () => {
  for (const sql of [
    "SELECT E'it\\'s em|' FROM users",
    "SELECT e'it\\'s em|' FROM users",
  ]) {
    const { context } = analyze(sql, { dialect: 'postgresql' });
    assert.equal(context.parserStatus, 'suppressed', sql);
    assert.deepEqual(context.kinds, []);
  }
});

test('unclosed quoted identifiers recover only the parsing copy and exclude keyword/function candidates', () => {
  for (const [sql, clause, kinds] of [
    ['SELECT * FROM `us|', 'from', ['database', 'table']],
    ['SELECT * FROM users u WHERE u.`em|', 'where', ['column']],
    ['SELECT `em|', 'select', ['column']],
  ]) {
    const { context, request } = analyze(sql);
    assert.equal(context.parserStatus, 'recovered', sql);
    assert.equal(context.clause, clause, sql);
    assert.deepEqual(context.kinds, kinds, sql);
    assert.match(context.parserMessage, /补齐标识符右引号/, sql);
    assert.equal(request.sql.endsWith('`'), false);
  }
  assert.deepEqual(analyze('SELECT "em|ail" FROM users', { dialect: 'postgresql' }).context.kinds, ['column']);
});

test('empty or malformed qualifiers never default to an unrelated database or keyword as an alias', () => {
  for (const sql of ['SELECT * FROM .us|', 'SELECT * FROM ``.us|', 'SELECT u..em| FROM users u']) {
    const { context } = analyze(sql);
    assert.equal(context.qualifier, undefined, sql);
    assert.deepEqual(context.kinds, [], sql);
    assert.deepEqual(context.tables, [], sql);
    assert.match(context.parserMessage, /限定名缺少有效/, sql);
  }
  const { context } = analyze('SELECT * FROM demo.|');
  assert.equal(context.qualifier, 'demo');
  assert.deepEqual(context.kinds, ['table']);
});

test('ORDER BY direction, comparison operands, and EXISTS retain their documented scopes', () => {
  const ordered = analyze('SELECT * FROM users ORDER BY em| DESC').context;
  assert.equal(ordered.parserStatus, 'parsed');
  assert.equal(ordered.clause, 'order');
  assert.deepEqual(ordered.tables, [{ database: 'demo', table: 'users' }]);
  const compared = analyze('SELECT * FROM users WHERE id >= |').context;
  assert.equal(compared.parserStatus, 'parsed');
  assert.equal(compared.clause, 'where');
  assert.ok(compared.kinds.includes('column'));
  const nested = analyze('SELECT em| FROM users WHERE EXISTS (SELECT * FROM orders)').context;
  assert.deepEqual(nested.tables, []);
  assert.match(nested.parserMessage, /复杂查询作用域暂不解析/);
});
