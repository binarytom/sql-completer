export type SqlDialect = 'mysql' | 'postgresql' | 'generic';
export type CompletionKind = 'keyword' | 'database' | 'table' | 'column' | 'function';
export type SqlClause = 'start' | 'select' | 'from' | 'join' | 'where' | 'on' | 'group' | 'order' | 'having' | 'other';

export interface TableReference {
  database: string;
  table: string;
  alias?: string;
}

export interface TextRange {
  start: number;
  end: number;
}

export interface CompletionContext {
  clause: SqlClause;
  prefix: string;
  qualifier?: string;
  kinds: CompletionKind[];
  tables: TableReference[];
  replaceRange: TextRange;
  statementRange: TextRange;
  parserStatus: 'parsed' | 'recovered' | 'lexical' | 'suppressed';
  parserMessage?: string;
  ast?: unknown;
}

export interface SearchParams {
  requestId: string;
  connectionId: string;
  dialect: SqlDialect;
  query: string;
  matchMode: 'prefix' | 'contains';
  limit: number;
  cursor?: string;
}

export interface DatabaseSearchParams extends SearchParams {}
export interface TableSearchParams extends SearchParams {
  database?: string;
}
export interface ColumnSearchParams extends SearchParams {
  tables: TableReference[];
}
export interface FunctionSearchParams extends SearchParams {
  database?: string;
}
export interface KeywordSearchParams extends SearchParams {
  clause: SqlClause;
}

export interface IndexItem {
  id: string;
  kind: CompletionKind;
  label: string;
  insertText: string;
  detail: string;
  database?: string;
  table?: string;
  dataType?: string;
  signature?: string;
  popularity: number;
}

export interface SearchResult {
  requestId: string;
  items: IndexItem[];
  total: number;
  nextCursor?: string;
  elapsedMs: number;
}

export interface SearchOptions {
  signal?: AbortSignal;
}

export interface MetadataIndex {
  searchDatabases(params: DatabaseSearchParams, options?: SearchOptions): Promise<SearchResult>;
  searchTables(params: TableSearchParams, options?: SearchOptions): Promise<SearchResult>;
  searchColumns(params: ColumnSearchParams, options?: SearchOptions): Promise<SearchResult>;
  searchFunctions(params: FunctionSearchParams, options?: SearchOptions): Promise<SearchResult>;
  searchKeywords(params: KeywordSearchParams, options?: SearchOptions): Promise<SearchResult>;
}

export interface CompletionRequest {
  sql: string;
  cursor: number;
  database: string;
  dialect: SqlDialect;
  connectionId: string;
  requestId: string;
}

export interface CompletionItem extends IndexItem {
  score: number;
  reason: string;
}

export interface CompletionResult {
  context: CompletionContext;
  items: CompletionItem[];
  elapsedMs: number;
  errors: string[];
}

export interface RequestLog {
  id: string;
  endpoint: string;
  params: SearchParams | TableSearchParams | ColumnSearchParams | FunctionSearchParams | KeywordSearchParams;
  status: 'pending' | 'success' | 'cancelled' | 'error';
  startedAt: number;
  elapsedMs?: number;
  count?: number;
  error?: string;
}
