export type SqlDialect = 'mysql' | 'postgresql' | 'generic';
export type CompletionKind = 'keyword' | 'database' | 'table' | 'column' | 'function';
export type SqlClause = 'start' | 'select' | 'from' | 'join' | 'where' | 'on' | 'group' | 'order' | 'having' | 'other';

export interface TableReference {
  database: string;
  table: string;
  alias?: string;
}
