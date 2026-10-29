import { initializeParser } from './context.js';
import { applyCompletionEdit } from './edits.js';
import { complete } from './service.js';
import type {
  AppliedCompletion, ApplyCompletionInput, CompletionItem, CompletionRequest,
  SearchOptions, SqlCompletion, SqlCompletionConfig, SqlCompletionInput,
  SqlCompletionResult, SqlDialect, SqlDocument, TextRange,
} from './types.js';

export type SqlCompletionErrorCode = 'DISPOSED' | 'STALE_RESULT' | 'DOCUMENT_CHANGED' | 'UNKNOWN_ITEM';

export class SqlCompletionError extends Error {
  readonly code: SqlCompletionErrorCode;

  constructor(code: SqlCompletionErrorCode, message: string) {
    super(message);
    this.name = 'SqlCompletionError';
    this.code = code;
  }
}

interface ResultSnapshot {
  document: SqlDocument;
  range: TextRange;
  items: Map<string, CompletionItem>;
  result: SqlCompletionResult;
}

let instanceSequence = 0;

function abortError(): DOMException {
  return new DOMException('补全请求已取消或被新请求替代', 'AbortError');
}

/** Respond to cancellation even when an injected metadata adapter ignores it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}

function assertDialect(dialect: string): asserts dialect is SqlDialect {
  if (!['mysql', 'postgresql', 'generic'].includes(dialect)) throw new TypeError('不支持的 SQL 方言');
}

function assertDocument(document: SqlDocument): void {
  if (typeof document.sql !== 'string') throw new TypeError('sql 必须为字符串');
  if (!Number.isInteger(document.cursor) || document.cursor < 0 || document.cursor > document.sql.length) {
    throw new RangeError('cursor 必须是 SQL 范围内的 UTF-16 整数偏移');
  }
}

/** Editor-agnostic entry point. No DOM, mock catalog or HTTP implementation is imported. */
export function createSqlCompletion(config: SqlCompletionConfig): SqlCompletion {
  const { index, connectionId, database, dialect = 'mysql', limit = 30, matchMode = 'prefix' } = config;
  if (!connectionId?.trim() || !database?.trim()) throw new TypeError('connectionId 和 database 不能为空');
  assertDialect(dialect);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit 必须为 1..100 的整数');
  if (matchMode !== 'prefix' && matchMode !== 'contains') throw new TypeError('不支持的 matchMode');
  for (const method of ['searchDatabases', 'searchTables', 'searchColumns', 'searchFunctions', 'searchKeywords'] as const) {
    if (typeof index?.[method] !== 'function') throw new TypeError(`MetadataIndex 缺少 ${method}`);
  }
  const instanceId = ++instanceSequence;
  let generation = 0;
  let active: AbortController | undefined;
  let latest: ResultSnapshot | undefined;
  let disposed = false;

  const assertUsable = () => {
    if (disposed) throw new SqlCompletionError('DISPOSED', '补全实例已销毁');
  };
  const cancel = () => {
    generation++;
    latest = undefined;
    active?.abort();
    active = undefined;
  };

  return {
    async ready() {
      assertUsable();
      await initializeParser();
      assertUsable();
    },

    async complete(input: SqlCompletionInput, options?: SearchOptions): Promise<SqlCompletionResult> {
      assertUsable();
      assertDocument(input);
      const inputDatabase = input.database ?? database;
      const inputDialect = input.dialect ?? dialect;
      if (!inputDatabase.trim()) throw new TypeError('database 不能为空');
      assertDialect(inputDialect);
      if (options?.signal?.aborted) throw abortError();
      cancel();
      const version = generation;
      const controller = new AbortController();
      active = controller;
      const callerSignal = options?.signal;
      const abortFromCaller = () => controller.abort();
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
      if (callerSignal?.aborted) controller.abort();
      const request: CompletionRequest = {
        sql: input.sql, cursor: input.cursor,
        database: inputDatabase, dialect: inputDialect, connectionId,
        requestId: `sql-completion-${instanceId}-${version}`,
      };
      try {
        const response = await abortable(complete(request, index, { signal: controller.signal, limit, matchMode }), controller.signal);
        if (disposed || generation !== version || controller.signal.aborted) throw abortError();
        const result: SqlCompletionResult = { ...response, requestId: request.requestId };
        // Keep a private snapshot: callers may annotate or reorder their result for display.
        latest = {
          document: { sql: request.sql, cursor: request.cursor },
          range: { ...result.context.replaceRange },
          items: new Map(result.items.map((item) => [item.id, { ...item }])),
          result,
        };
        return result;
      } finally {
        callerSignal?.removeEventListener('abort', abortFromCaller);
        if (active === controller) active = undefined;
      }
    },

    apply(input: ApplyCompletionInput): AppliedCompletion {
      assertUsable();
      assertDocument(input.document);
      if (!latest || latest.result !== input.result) {
        throw new SqlCompletionError('STALE_RESULT', '补全结果已过期或不属于当前实例');
      }
      const snapshot = latest;
      if (snapshot.document.sql !== input.document.sql || snapshot.document.cursor !== input.document.cursor) {
        throw new SqlCompletionError('DOCUMENT_CHANGED', 'SQL 或光标已变化，请重新请求补全');
      }
      const item = snapshot.items.get(input.itemId);
      if (!item) throw new SqlCompletionError('UNKNOWN_ITEM', '候选不属于当前补全结果');
      const applied = applyCompletionEdit(snapshot.document, snapshot.range, item);
      cancel();
      return applied;
    },

    cancel,

    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
    },
  };
}
