import type { CompletionKind, SqlClause, SqlDialect, TableReference } from '../shared/types.js';
import type { IndexItem, MetadataIndex, SearchOptions, SearchParams } from '../metadata/types.js';

// Internal modules share these contracts; package exports define the supported API.
export type * from '../shared/types.js';
export type * from '../metadata/types.js';

/** Completion policy stays separate from the metadata transport options. */
export interface CompletionSearchOptions extends SearchOptions {
  limit?: number;
  matchMode?: SearchParams['matchMode'];
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

/** Offsets are UTF-16 string indices, matching textarea.selectionStart. */
export interface SqlDocument {
  sql: string;
  cursor: number;
}

export interface SqlCompletionInput extends SqlDocument {
  database?: string;
  dialect?: SqlDialect;
}

export interface SqlCompletionConfig {
  index: MetadataIndex;
  connectionId: string;
  database: string;
  dialect?: SqlDialect;
  /** Candidate recall window per metadata endpoint, integer 1..100; default 30. */
  limit?: number;
  matchMode?: SearchParams['matchMode'];
}

export interface SqlCompletionResult extends CompletionResult {
  requestId: string;
}

export interface CompletionTextEdit {
  range: TextRange;
  text: string;
}

export interface AppliedCompletion extends SqlDocument {
  edit: CompletionTextEdit;
}

export interface ApplyCompletionInput {
  document: SqlDocument;
  result: SqlCompletionResult;
  itemId: string;
}

/** One instance represents one editor and owns its request lifecycle. */
export interface SqlCompletion {
  ready(): Promise<void>;
  complete(input: SqlCompletionInput, options?: SearchOptions): Promise<SqlCompletionResult>;
  apply(input: ApplyCompletionInput): AppliedCompletion;
  cancel(): void;
  dispose(): void;
}
