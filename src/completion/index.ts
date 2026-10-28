/** Public editor integration surface; parser and orchestration modules are internal. */
export { createSqlCompletion, SqlCompletionError } from './engine';
export type { SqlCompletionErrorCode } from './engine';
export type {
  AppliedCompletion, ApplyCompletionInput, ColumnSearchParams, CompletionContext,
  CompletionItem, CompletionKind, CompletionTextEdit, DatabaseSearchParams,
  FunctionSearchParams, IndexItem, KeywordSearchParams, MetadataIndex, RequestLog,
  SearchOptions, SearchParams, SearchResult, SqlClause, SqlCompletion,
  SqlCompletionConfig, SqlCompletionInput, SqlCompletionResult, SqlDialect,
  SqlDocument, TableReference, TableSearchParams, TextRange,
} from './types';
