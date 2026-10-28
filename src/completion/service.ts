import { analyzeContext, initializeParser } from './context';
import type {
  CompletionContext, CompletionItem, CompletionKind, CompletionRequest, CompletionSearchOptions,
  CompletionResult, IndexItem, MetadataIndex, SearchOptions, SearchParams,
  SearchResult, TableReference,
} from './types';

// Conservative cross-dialect dictionary: quoting an extra identifier is safe.
// A production adapter can supply dialect/version-specific keyword metadata.
const reservedIdentifiers = new Set((
  'ALL ALTER AND ANY ARRAY AS ASC ASYMMETRIC AUTHORIZATION BETWEEN BIGINT BINARY BIT BOOLEAN BOTH BY CALL CASE CAST CHAR CHARACTER CHECK COLLATE COLUMN CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_ROLE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DATABASE DATABASES DATE DAY DEALLOCATE DEC DECIMAL DEFAULT DEFERRABLE DELETE DESC DESCRIBE DISTINCT DO DOUBLE DROP ELSE END ESCAPE EXCEPT EXISTS EXPLAIN FALSE FETCH FLOAT FOR FOREIGN FROM FULL GRANT GROUP HAVING HOUR IF IN INDEX INNER INSERT INT INTEGER INTERSECT INTERVAL INTO IS JOIN KEY LATERAL LEADING LEFT LIKE LIMIT LOCALTIME LOCALTIMESTAMP LOCK MINUTE NATURAL NOT NULL NUMERIC OFFSET ON ONLY OR ORDER OUTER OVER PARTITION PRECISION PRIMARY PROCEDURE RANGE REAL REFERENCES RETURNING RIGHT ROW ROWS SCHEMA SELECT SESSION_USER SET SMALLINT SOME SYMMETRIC TABLE THEN TIME TIMESTAMP TO TRAILING TRUE TRUNCATE UNION UNIQUE UPDATE USER USING VALUES VARCHAR VARYING VIEW WHEN WHERE WINDOW WITH YEAR'
).split(' '));

function assertActive(options?: SearchOptions): void {
  if (options?.signal?.aborted) throw new DOMException('补全请求已取消', 'AbortError');
}

function normalized(value: string): string {
  return value.toLocaleLowerCase();
}

function sameName(left: string, right: string): boolean {
  return normalized(left) === normalized(right);
}

function scopedTables(context: CompletionContext): TableReference[] {
  const references = context.tables.filter((reference, index, all) => all.findIndex((other) =>
    other.database === reference.database && other.table === reference.table && other.alias === reference.alias,
  ) === index);
  if (!context.qualifier) return references;
  const parts = context.qualifier.split('.');
  if (parts.length === 1) {
    // An explicit alias hides its physical table name in expression scope.
    return references.filter((reference) => sameName(reference.alias ?? reference.table, parts[0]));
  }
  if (parts.length === 2) {
    return references.filter((reference) => !reference.alias
      && sameName(reference.database, parts[0]) && sameName(reference.table, parts[1]));
  }
  return [];
}

function tableMatches(item: IndexItem, reference: TableReference): boolean {
  return item.database !== undefined && item.table !== undefined
    && sameName(item.database, reference.database) && sameName(item.table, reference.table);
}

function quoteForRange(request: CompletionRequest, context: CompletionContext): { delimiter: string; needsClose: boolean } | undefined {
  const before = request.sql[context.replaceRange.start - 1];
  return before === '`' || before === '"'
    ? { delimiter: before, needsClose: request.sql[context.replaceRange.end] !== before }
    : undefined;
}

function escapedIdentifier(value: string, quote: string): string {
  return value.replaceAll(quote, quote + quote);
}

function unquotedPath(parts: string[], request: CompletionRequest): string {
  const quote = request.dialect === 'mysql' ? '`' : '"';
  return parts.map((part) => /^[A-Za-z_][\w$]*$/.test(part) && !reservedIdentifiers.has(part.toUpperCase())
    ? part
    : `${quote}${escapedIdentifier(part, quote)}${quote}`).join('.');
}

interface Candidate {
  item: IndexItem;
  sourceLabel: string;
  scoped: boolean;
  insertParts?: string[];
}

function columnCandidates(items: IndexItem[], references: TableReference[], qualified: boolean): Candidate[] {
  const expanded = items.filter((item) => item.kind === 'column').flatMap((item) => references
    .filter((reference) => tableMatches(item, reference))
    .map((reference) => ({ item, reference })));
  const unique = expanded.filter((entry, index, all) => all.findIndex((other) =>
    other.item.id === entry.item.id && other.reference.database === entry.reference.database
    && other.reference.table === entry.reference.table && other.reference.alias === entry.reference.alias,
  ) === index);
  return unique.map(({ item, reference }) => {
    const ambiguous = !qualified && unique.some((other) => normalized(other.item.label) === normalized(item.label)
      && (other.reference.database !== reference.database || other.reference.table !== reference.table
        || other.reference.alias !== reference.alias));
    if (!ambiguous) return { item, sourceLabel: item.label, scoped: true, insertParts: [item.insertText] };
    const sameTableName = !reference.alias && references.some((other) => !other.alias
      && sameName(other.table, reference.table) && !sameName(other.database, reference.database));
    const qualifierParts = reference.alias ? [reference.alias]
      : sameTableName ? [reference.database, reference.table] : [reference.table];
    const qualifier = qualifierParts.join('.');
    const parts = [...qualifierParts, item.insertText];
    return {
      item: { ...item, id: `${item.id}@${qualifier}`, label: `${qualifier}.${item.label}` },
      sourceLabel: item.label,
      scoped: true,
      insertParts: parts,
    };
  });
}

function rankedItem(candidate: Candidate, context: CompletionContext, request: CompletionRequest): CompletionItem {
  const { item, sourceLabel, scoped } = candidate;
  const prefix = normalized(context.prefix);
  const label = normalized(sourceLabel);
  const matchScore = prefix && label === prefix ? 1000 : prefix && label.startsWith(prefix) ? 700 : prefix && label.includes(prefix) ? 300 : 0;
  const matchReason = prefix && label === prefix ? '精确匹配' : prefix && label.startsWith(prefix) ? '前缀匹配' : prefix && label.includes(prefix) ? '包含匹配' : '上下文推荐';
  const roleScores: Record<CompletionKind, number> = { column: 180, table: 160, function: 120, database: 100, keyword: 80 };
  const popularity = Number.isFinite(item.popularity) ? Math.max(0, Math.min(100, item.popularity)) : 0;
  const currentDatabase = item.database !== undefined && sameName(item.database, request.database);
  const quote = quoteForRange(request, context);
  let insertText = item.insertText;
  if (candidate.insertParts) {
    // The existing outer quotes remain in the editor. Insert separators between quoted parts.
    insertText = quote
      ? candidate.insertParts.map((part) => escapedIdentifier(part, quote.delimiter)).join(`${quote.delimiter}.${quote.delimiter}`)
      : unquotedPath(candidate.insertParts, request);
  } else if (quote && item.kind !== 'keyword') {
    insertText = escapedIdentifier(insertText, quote.delimiter);
  } else if (item.kind === 'table' || item.kind === 'database') {
    insertText = unquotedPath([insertText], request);
  }
  if (quote?.needsClose && item.kind !== 'keyword') insertText += quote.delimiter;
  if (item.kind === 'function' && /^\s*\(/.test(request.sql.slice(context.replaceRange.end))) {
    insertText = insertText.replace(/\(\)$/, '');
  }
  const scopeReason = scoped ? '字段作用域' : currentDatabase ? '当前库' : '语法位置';
  return {
    ...item,
    insertText,
    score: matchScore + roleScores[item.kind] + (scoped ? 50 : 0) + (currentDatabase ? 20 : 0) + popularity,
    reason: `${matchReason} · ${scopeReason} · 热度 ${popularity}`,
  };
}

/** Resolve context, recall candidates in parallel, then rank on the client. */
export async function complete(
  request: CompletionRequest,
  index: MetadataIndex,
  options?: CompletionSearchOptions,
): Promise<CompletionResult> {
  const startedAt = Date.now();
  request = { ...request };
  const searchOptions = options?.signal ? { signal: options.signal } : undefined;
  const limit = options?.limit === undefined ? 30 : options.limit;
  const matchMode = options?.matchMode === undefined ? 'prefix' : options.matchMode;
  assertActive(searchOptions);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit 必须为 1 到 100 之间的整数');
  }
  if (matchMode !== 'prefix' && matchMode !== 'contains') {
    throw new TypeError('matchMode 必须为 prefix 或 contains');
  }
  await initializeParser();
  assertActive(searchOptions);
  const context = analyzeContext(request);
  if (context.parserStatus === 'suppressed' || context.kinds.length === 0) {
    return { context, items: [], errors: [], elapsedMs: Date.now() - startedAt };
  }
  const base: SearchParams = {
    requestId: request.requestId,
    connectionId: request.connectionId,
    dialect: request.dialect,
    query: context.prefix,
    matchMode,
    limit,
  };
  const references = scopedTables(context);
  const providers: { kind: CompletionKind; run: () => Promise<SearchResult> }[] = [];
  for (const kind of new Set(context.kinds)) {
    switch (kind) {
      case 'database':
        providers.push({ kind, run: () => index.searchDatabases(base, searchOptions) });
        break;
      case 'table': {
        const database = context.qualifier ?? request.database;
        providers.push({ kind, run: () => index.searchTables({ ...base, database }, searchOptions) });
        break;
      }
      case 'column':
        if (references.length > 0) providers.push({ kind, run: () => index.searchColumns({ ...base, tables: references }, searchOptions) });
        break;
      case 'function':
        providers.push({ kind, run: () => index.searchFunctions({ ...base, database: request.database }, searchOptions) });
        break;
      case 'keyword':
        providers.push({ kind, run: () => index.searchKeywords({ ...base, clause: context.clause }, searchOptions) });
        break;
    }
  }
  const results = await Promise.allSettled(providers.map((provider) => Promise.resolve().then(() => {
    assertActive(searchOptions);
    return provider.run();
  })));
  assertActive(searchOptions);
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  results.forEach((result, position) => {
    const kind = providers[position].kind;
    if (result.status === 'rejected') {
      errors.push(`${kind}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return;
    }
    if (result.value.requestId !== request.requestId) {
      errors.push(`${kind}: 忽略不匹配的 requestId`);
      return;
    }
    const items = result.value.items.filter((item) => item.kind === kind);
    if (kind === 'column') {
      candidates.push(...columnCandidates(items, references, Boolean(context.qualifier)));
    } else {
      candidates.push(...items.map((item) => ({ item, sourceLabel: item.label, scoped: false })));
    }
  });
  const ranked = candidates.map((candidate) => rankedItem(candidate, context, request))
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label, 'en')
      || left.kind.localeCompare(right.kind, 'en') || left.id.localeCompare(right.id, 'en'));
  const seen = new Set<string>();
  const items = ranked.filter((item) => {
    const key = JSON.stringify([item.kind, item.database, item.table, item.insertText]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { context, items, errors, elapsedMs: Date.now() - startedAt };
}
