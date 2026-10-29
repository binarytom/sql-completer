import type { ColumnSearchParams, FunctionSearchParams, KeywordSearchParams, SearchParams, TableSearchParams } from 'sql-completer/metadata';

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
