/** Public editor integration surface; parser and orchestration modules are internal. */
export { createSqlCompletion, SqlCompletionError } from './completion/engine.js';
export type { SqlCompletionErrorCode } from './completion/engine.js';
export type {
  AppliedCompletion, ApplyCompletionInput, ColumnSearchParams, CompletionContext,
  CompletionItem, CompletionKind, CompletionTextEdit, DatabaseSearchParams,
  FunctionSearchParams, IndexItem, KeywordSearchParams, MetadataIndex,
  SearchOptions, SearchParams, SearchResult, SqlClause, SqlCompletion,
  SqlCompletionConfig, SqlCompletionInput, SqlCompletionResult, SqlDialect,
  SqlDocument, TableReference, TableSearchParams, TextRange,
} from './completion/types.js';
