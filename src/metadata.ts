import type {
  ColumnSearchParams, DatabaseSearchParams, FunctionSearchParams, IndexItem,
  KeywordSearchParams, MetadataIndex, RequestLog, SearchOptions, SearchParams,
  SearchResult, SqlClause, SqlDialect, TableSearchParams,
} from './completion/types';

export const MOCK_DATABASES = ['demo', 'analytics', 'warehouse'];

interface CatalogColumn {
  name: string;
  type: string;
  description: string;
}

interface CatalogTable {
  database: string;
  name: string;
  description: string;
  popularity: number;
  columns: CatalogColumn[];
}

const catalog: CatalogTable[] = [
  {
    database: 'demo', name: 'users', description: '用户资料', popularity: 100,
    columns: [
      { name: 'id', type: 'BIGINT', description: '用户主键' },
      { name: 'name', type: 'VARCHAR(100)', description: '用户姓名' },
      { name: 'email', type: 'VARCHAR(255)', description: '电子邮箱' },
      { name: 'status', type: 'VARCHAR(20)', description: '账户状态' },
      { name: 'created_at', type: 'TIMESTAMP', description: '注册时间' },
    ],
  },
  {
    database: 'demo', name: 'orders', description: '交易订单', popularity: 95,
    columns: [
      { name: 'order_id', type: 'BIGINT', description: '订单主键' },
      { name: 'user_id', type: 'BIGINT', description: '关联 users.id' },
      { name: 'product_id', type: 'BIGINT', description: '关联 products.id' },
      { name: 'amount', type: 'DECIMAL(12,2)', description: '订单金额' },
      { name: 'status', type: 'VARCHAR(20)', description: '订单状态' },
      { name: 'created_at', type: 'TIMESTAMP', description: '下单时间' },
    ],
  },
  {
    database: 'demo', name: 'products', description: '商品目录', popularity: 80,
    columns: [
      { name: 'id', type: 'BIGINT', description: '商品主键' },
      { name: 'name', type: 'VARCHAR(200)', description: '商品名称' },
      { name: 'category', type: 'VARCHAR(80)', description: '商品类别' },
      { name: 'price', type: 'DECIMAL(12,2)', description: '销售单价' },
      { name: 'stock', type: 'INT', description: '库存数量' },
    ],
  },
  {
    database: 'analytics', name: 'events', description: '用户行为事件', popularity: 85,
    columns: [
      { name: 'event_id', type: 'BIGINT', description: '事件主键' },
      { name: 'user_id', type: 'BIGINT', description: '用户标识' },
      { name: 'session_id', type: 'VARCHAR(64)', description: '会话标识' },
      { name: 'event_name', type: 'VARCHAR(100)', description: '事件名称' },
      { name: 'properties', type: 'JSON', description: '事件属性' },
      { name: 'occurred_at', type: 'TIMESTAMP', description: '事件时间' },
    ],
  },
  {
    database: 'analytics', name: 'sessions', description: '访问会话', popularity: 70,
    columns: [
      { name: 'session_id', type: 'VARCHAR(64)', description: '会话主键' },
      { name: 'user_id', type: 'BIGINT', description: '用户标识' },
      { name: 'started_at', type: 'TIMESTAMP', description: '会话开始时间' },
      { name: 'duration_seconds', type: 'INT', description: '会话时长（秒）' },
      { name: 'source', type: 'VARCHAR(100)', description: '访问来源' },
    ],
  },
  {
    database: 'analytics', name: 'revenue_daily', description: '每日营收汇总', popularity: 75,
    columns: [
      { name: 'revenue_date', type: 'DATE', description: '统计日期' },
      { name: 'order_count', type: 'BIGINT', description: '订单数量' },
      { name: 'total_amount', type: 'DECIMAL(18,2)', description: '总成交金额' },
      { name: 'active_users', type: 'BIGINT', description: '活跃用户数量' },
    ],
  },
  {
    database: 'warehouse', name: 'dim_customers', description: '客户维度', popularity: 60,
    columns: [
      { name: 'customer_key', type: 'BIGINT', description: '客户代理键' },
      { name: 'user_id', type: 'BIGINT', description: '业务用户标识' },
      { name: 'customer_name', type: 'VARCHAR(100)', description: '客户姓名' },
      { name: 'region', type: 'VARCHAR(100)', description: '客户所在地区' },
      { name: 'valid_from', type: 'DATE', description: '维度生效日期' },
    ],
  },
  {
    database: 'warehouse', name: 'fact_orders', description: '订单事实', popularity: 65,
    columns: [
      { name: 'order_key', type: 'BIGINT', description: '订单代理键' },
      { name: 'customer_key', type: 'BIGINT', description: '关联 dim_customers' },
      { name: 'order_date', type: 'DATE', description: '订单日期' },
      { name: 'quantity', type: 'INT', description: '商品数量' },
      { name: 'gross_amount', type: 'DECIMAL(18,2)', description: '订单总额' },
    ],
  },
];

interface CatalogFunction {
  name: string;
  signature: string;
  description: string;
  popularity: number;
  dialects?: SqlDialect[];
}

const functions: CatalogFunction[] = [
  { name: 'COUNT', signature: 'COUNT(expression)', description: '统计非空行数；COUNT(*) 统计所有行', popularity: 100 },
  { name: 'SUM', signature: 'SUM(expression)', description: '数值求和', popularity: 95 },
  { name: 'AVG', signature: 'AVG(expression)', description: '数值平均值', popularity: 85 },
  { name: 'MAX', signature: 'MAX(expression)', description: '最大值', popularity: 80 },
  { name: 'MIN', signature: 'MIN(expression)', description: '最小值', popularity: 80 },
  { name: 'COALESCE', signature: 'COALESCE(value, ...)', description: '返回第一个非空值', popularity: 90 },
  { name: 'LOWER', signature: 'LOWER(text)', description: '转换为小写', popularity: 60 },
  { name: 'UPPER', signature: 'UPPER(text)', description: '转换为大写', popularity: 60 },
  { name: 'CONCAT', signature: 'CONCAT(value, ...)', description: '拼接字符串', popularity: 75 },
  { name: 'ROUND', signature: 'ROUND(number, digits)', description: '按精度四舍五入', popularity: 70 },
  { name: 'LENGTH', signature: 'LENGTH(text)', description: '字符串长度', popularity: 65 },
  { name: 'IFNULL', signature: 'IFNULL(value, fallback)', description: '为空时返回替代值', popularity: 90, dialects: ['mysql'] },
  { name: 'DATE_FORMAT', signature: 'DATE_FORMAT(date, format)', description: '格式化日期', popularity: 80, dialects: ['mysql'] },
  { name: 'NOW', signature: 'NOW()', description: '当前日期与时间', popularity: 85, dialects: ['mysql', 'postgresql'] },
  { name: 'DATE_TRUNC', signature: 'DATE_TRUNC(unit, timestamp)', description: '按指定单位截断时间', popularity: 90, dialects: ['postgresql'] },
  { name: 'STRING_AGG', signature: 'STRING_AGG(value, delimiter)', description: '聚合拼接字符串', popularity: 75, dialects: ['postgresql'] },
];

const keywordsByClause: Record<SqlClause, string[]> = {
  start: ['SELECT', 'WITH', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'EXPLAIN'],
  select: ['DISTINCT', 'AS', 'FROM', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL'],
  from: ['AS', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'GROUP BY', 'ORDER BY', 'LIMIT'],
  join: ['AS', 'ON', 'USING'],
  where: ['AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'TRUE', 'FALSE', 'NULL', 'GROUP BY', 'ORDER BY', 'LIMIT'],
  on: ['AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'JOIN', 'LEFT JOIN', 'WHERE', 'GROUP BY', 'ORDER BY'],
  group: ['BY', 'HAVING', 'ORDER BY', 'LIMIT'],
  order: ['BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET'],
  having: ['AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'ORDER BY', 'LIMIT'],
  other: ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'AND', 'OR', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT'],
};

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return (result >>> 0).toString(36);
}

function abortError(): DOMException {
  return new DOMException('元数据请求已取消', 'AbortError');
}

function waitForResponse(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function validateParams(params: SearchParams): number {
  if (params.connectionId !== 'demo-local') throw new Error('未知连接：仅支持 demo-local');
  if (!params.requestId || typeof params.requestId !== 'string') throw new Error('requestId 不能为空');
  if (!['mysql', 'postgresql', 'generic'].includes(params.dialect)) throw new Error('不支持的 SQL 方言');
  if (typeof params.query !== 'string') throw new Error('query 必须为字符串');
  if (!['prefix', 'contains'].includes(params.matchMode)) throw new Error('matchMode 必须为 prefix 或 contains');
  if (!Number.isFinite(params.limit)) throw new Error('limit 必须为有限数字');
  return Math.max(1, Math.min(100, Math.floor(params.limit)));
}

// Bind a cursor to its endpoint, filters and scope, but not the request ID.
// Production adapters should use a server-signed opaque token instead.
function scopeKey(endpoint: string, params: RequestLog['params']): string {
  const { requestId: _requestId, limit: _limit, cursor: _cursor, ...filters } = params;
  return hash(JSON.stringify([endpoint, filters]));
}

function pageItems(endpoint: string, params: RequestLog['params'], items: IndexItem[], limit: number): Omit<SearchResult, 'elapsedMs'> {
  const query = params.query.toLocaleLowerCase();
  const matched = items.filter((item) => {
    const label = item.label.toLocaleLowerCase();
    return params.matchMode === 'contains' ? label.includes(query) : label.startsWith(query);
  }).sort((left, right) => left.label.localeCompare(right.label, 'en') || left.id.localeCompare(right.id, 'en'));
  const key = scopeKey(endpoint, params);
  let offset = 0;
  if (params.cursor !== undefined) {
    const cursor = /^v1\.([0-9]+)\.([a-z0-9]+)$/.exec(params.cursor);
    if (!cursor || cursor[2] !== key) throw new Error('无效分页 cursor：请使用同一查询返回的 nextCursor');
    offset = Number(cursor[1]);
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= matched.length) throw new Error('分页 cursor 已失效');
  }
  const end = offset + limit;
  return {
    requestId: params.requestId,
    items: matched.slice(offset, end),
    total: matched.length,
    ...(end < matched.length ? { nextCursor: `v1.${end}.${key}` } : {}),
  };
}

/** Five mock search methods share the same contract as a future HTTP adapter. */
export function createMockMetadataIndex(onLog?: (entry: RequestLog) => void): MetadataIndex {
  async function search(
    kind: 'databases' | 'tables' | 'columns' | 'functions' | 'keywords',
    params: RequestLog['params'],
    options: SearchOptions | undefined,
    getItems: () => IndexItem[],
  ): Promise<SearchResult> {
    // Pre-aborted requests do not start, including logging.
    if (options?.signal?.aborted) throw abortError();
    const snapshot = structuredClone(params);
    const endpoint = `POST /api/completion/${kind}/search`;
    const startedAt = Date.now();
    const baseLog = { id: `${snapshot.requestId}:${endpoint}`, endpoint, params: snapshot, startedAt };
    const log = (entry: RequestLog) => onLog?.(structuredClone(entry));
    console.info('[metadata-index]', endpoint, structuredClone(snapshot));
    log({ ...baseLog, status: 'pending' });
    try {
      const limit = validateParams(snapshot);
      await waitForResponse(40 + parseInt(hash(baseLog.id), 36) % 61, options?.signal);
      if (options?.signal?.aborted) throw abortError();
      const result = { ...pageItems(endpoint, snapshot, getItems(), limit), elapsedMs: Date.now() - startedAt };
      log({ ...baseLog, status: 'success', elapsedMs: result.elapsedMs, count: result.items.length });
      return result;
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      log({
        ...baseLog,
        status: cancelled ? 'cancelled' : 'error',
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {
    searchDatabases(params: DatabaseSearchParams, options?: SearchOptions) {
      return search('databases', params, options, () => MOCK_DATABASES.map((database) => ({
        id: `database:${database}`, kind: 'database', label: database, insertText: database,
        database, detail: `${catalog.filter((table) => table.database === database).length} 张表`,
        popularity: database === 'demo' ? 100 : 70,
      })));
    },
    searchTables(params: TableSearchParams, options?: SearchOptions) {
      const snapshot = structuredClone(params);
      return search('tables', snapshot, options, () => catalog
        .filter((table) => snapshot.database === undefined || table.database === snapshot.database)
        .map((table) => ({
          id: `table:${table.database}.${table.name}`, kind: 'table', label: table.name,
          insertText: table.name, database: table.database, table: table.name,
          detail: `${table.database}.${table.name} · ${table.description}`, popularity: table.popularity,
        })));
    },
    searchColumns(params: ColumnSearchParams, options?: SearchOptions) {
      const snapshot = structuredClone(params);
      return search('columns', snapshot, options, () => {
        if (!Array.isArray(snapshot.tables)) throw new Error('tables 必须为表引用数组');
        const scope = new Set(snapshot.tables.map((table) => JSON.stringify([table.database, table.table])));
        return catalog.filter((table) => scope.has(JSON.stringify([table.database, table.name])))
          .flatMap((table) => table.columns.map((column) => ({
            id: `column:${table.database}.${table.name}.${column.name}`, kind: 'column' as const,
            label: column.name, insertText: column.name, database: table.database, table: table.name,
            dataType: column.type,
            detail: `${table.database}.${table.name} · ${column.type} · ${column.description}`,
            popularity: column.name === 'id' || column.name.endsWith('_id') ? 95 : table.popularity - 10,
          })));
      });
    },
    searchFunctions(params: FunctionSearchParams, options?: SearchOptions) {
      const snapshot = structuredClone(params);
      return search('functions', snapshot, options, () => {
        if (snapshot.database !== undefined && !MOCK_DATABASES.includes(snapshot.database)) return [];
        return functions.filter((item) => !item.dialects || item.dialects.includes(snapshot.dialect))
          .map((item) => ({
            id: `function:${item.name}`, kind: 'function', label: item.name,
            insertText: `${item.name}()`, signature: item.signature,
            detail: `${item.signature} · ${item.description}`, popularity: item.popularity,
          }));
      });
    },
    searchKeywords(params: KeywordSearchParams, options?: SearchOptions) {
      const snapshot = structuredClone(params);
      return search('keywords', snapshot, options, () => {
        const words = keywordsByClause[snapshot.clause];
        if (!words) throw new Error('不支持的 SQL 子句');
        return words.map((word) => ({
          id: `keyword:${word}`, kind: 'keyword', label: word, insertText: word,
          detail: `${snapshot.clause.toUpperCase()} 子句关键字`, popularity: 50,
        }));
      });
    },
  };
}
