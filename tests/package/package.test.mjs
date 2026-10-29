import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('a packed library installs independently with typed public exports and deployable WASM', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'sql-completer-package-'));
  try {
    const cache = join(temporary, 'cache');
    const [packed] = JSON.parse(execFileSync('npm', [
      'pack', '--ignore-scripts', '--json', '--cache', cache, '--pack-destination', temporary,
    ], { cwd: root, encoding: 'utf8' }));
    assert.equal(packed.name, 'sql-completer');
    assert.equal(packed.filename, `sql-completer-${packed.version}.tgz`);
    const paths = packed.files.map((file) => file.path);
    assert(paths.includes('dist/index.d.ts'));
    assert(paths.includes('dist/metadata/index.d.ts'));
    assert(paths.includes('dist/.vite/license.md'));
    assert.equal(paths.filter((path) => path.endsWith('.wasm')).length, 1);
    assert(!paths.some((path) => /^(src|examples|tests|build)\//.test(path)));
    const consumer = join(temporary, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    execFileSync('npm', [
      'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache,
      join(temporary, packed.filename),
    ], { cwd: consumer, stdio: 'pipe' });
    writeFileSync(join(consumer, 'usage.ts'), `
import { createSqlCompletion, type SqlCompletion } from 'sql-completer';
import type { MetadataIndex, SearchParams, SearchResult } from 'sql-completer/metadata';
const search = async (params: SearchParams): Promise<SearchResult> => ({
  requestId: params.requestId, items: [], total: 0, elapsedMs: 0,
});
const index: MetadataIndex = {
  searchDatabases: search, searchTables: search, searchColumns: search,
  searchFunctions: search, searchKeywords: search,
};
const completion: SqlCompletion = createSqlCompletion({ index, connectionId: 'consumer', database: 'demo' });
completion.dispose();
`);
    execFileSync(process.execPath, [
      join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'es2023', 'usage.ts',
    ], { cwd: consumer, stdio: 'pipe' });
    writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createSqlCompletion, SqlCompletionError } from 'sql-completer';
const calls = [];
const index = Object.fromEntries(['Databases', 'Tables', 'Columns', 'Functions', 'Keywords'].map((kind) => [
  'search' + kind, async (params) => {
    calls.push(kind);
    const items = kind === 'Tables' ? [{
      id: 'users', kind: 'table', label: 'users', insertText: 'users', detail: 'demo.users',
      database: 'demo', popularity: 100,
    }] : [];
    return { requestId: params.requestId, items, total: items.length, elapsedMs: 0 };
  },
]));
const completion = createSqlCompletion({ index, connectionId: 'consumer', database: 'demo' });
await completion.ready();
const document = { sql: 'SELECT * FROM us', cursor: 16 };
const result = await completion.complete(document);
assert.equal(result.context.parserStatus, 'parsed');
assert(calls.includes('Tables'));
const item = result.items.find((item) => item.id === 'users');
assert(item);
assert.equal(completion.apply({ document, result, itemId: item.id }).sql, 'SELECT * FROM users');
completion.dispose();
assert.throws(() => completion.apply({ document, result, itemId: item.id }), SqlCompletionError);
assert.deepEqual(Object.keys(await import('sql-completer/metadata')), []);
await assert.rejects(import('sql-completer/completion/context'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`);
    execFileSync(process.execPath, ['smoke.mjs'], { cwd: consumer, stdio: 'pipe' });
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/sql-completer/package.json'), 'utf8'));
    assert.equal(installed.name, 'sql-completer');
    assert.equal(installed.dependencies, undefined);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
