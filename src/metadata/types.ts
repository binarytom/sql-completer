import type { CompletionKind, SqlClause, SqlDialect, TableReference } from '../shared/types.js';

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
