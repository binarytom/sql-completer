import { init, parse } from '@guanmingchiu/sqlparser-ts';
import type {
  CompletionContext,
  CompletionKind,
  CompletionRequest,
  SqlClause,
  SqlDialect,
  TableReference,
  TextRange,
} from './types';

const sentinel = '__suggestion__';
const recoveryTable = '__completion_recovery_table__';
const wordCharacter = /[\p{L}\p{N}_$]/u;
const reserved = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'FROM', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
  'FULL', 'CROSS', 'NATURAL', 'ON', 'USING', 'WHERE', 'GROUP', 'ORDER', 'BY',
  'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'AS', 'AND', 'OR',
  'WITH', 'WINDOW', 'QUALIFY', 'FETCH', 'FOR', 'INTO', 'SET', 'VALUES', 'WHEN',
]);

interface Token {
  kind: 'word' | 'quoted' | 'string' | 'comment' | 'symbol';
  value: string;
  start: number;
  end: number;
  depth: number;
  closed?: boolean;
  delimiter?: string;
}

type AstRecord = Record<string, unknown>;
type AstPath = (string | number)[];
type MarkerRole = 'table' | 'column' | 'function' | 'alias' | 'unsupported';
interface MarkerLocation {
  path: AstPath;
  role: MarkerRole;
  clause?: SqlClause;
}

let initialization: Promise<void> | undefined;

export function initializeParser(): Promise<void> {
  initialization ??= init();
  return initialization;
}

function scan(sql: string, dialect: SqlDialect): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  let depth = 0;
  while (position < sql.length) {
    const start = position;
    const character = sql[position];
    if (/\s/.test(character)) {
      position++;
      continue;
    }
    if (sql.startsWith('--', start) || (character === '#' && dialect === 'mysql')) {
      const newline = sql.indexOf('\n', start);
      position = newline === -1 ? sql.length : newline;
      tokens.push({ kind: 'comment', value: '', start, end: position, depth, closed: newline !== -1, delimiter: 'line' });
      continue;
    }
    if (sql.startsWith('/*', start)) {
      position += 2;
      let nesting = 1;
      while (position < sql.length && nesting > 0) {
        if (sql.startsWith('/*', position)) {
          nesting++;
          position += 2;
        } else if (sql.startsWith('*/', position)) {
          nesting--;
          position += 2;
        } else position++;
      }
      tokens.push({ kind: 'comment', value: '', start, end: position, depth, closed: nesting === 0 });
      continue;
    }
    const dollarTag = character === '$' && dialect !== 'mysql'
      ? sql.slice(start).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
      : undefined;
    if (dollarTag) {
      const close = sql.indexOf(dollarTag, start + dollarTag.length);
      position = close === -1 ? sql.length : close + dollarTag.length;
      tokens.push({ kind: 'string', value: '', start, end: position, depth, closed: close !== -1 });
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const kind = character === "'" || (character === '"' && dialect === 'mysql') ? 'string' : 'quoted';
      const previous = tokens.at(-1);
      const escapedString = dialect === 'postgresql' && character === "'" &&
        previous?.kind === 'word' && previous.value.toUpperCase() === 'E' && previous.end === start;
      position++;
      let closed = false;
      while (position < sql.length) {
        if (sql[position] === '\\' && (dialect === 'mysql' || escapedString)) {
          position += Math.min(2, sql.length - position);
        } else if (sql[position] === character) {
          position++;
          if (sql[position] === character) position++;
          else {
            closed = true;
            break;
          }
        } else position++;
      }
      const value = sql.slice(start + 1, closed ? position - 1 : position)
        .split(character + character).join(character);
      tokens.push({ kind, value, start, end: position, depth, closed, delimiter: character });
      continue;
    }
    if (wordCharacter.test(character)) {
      while (position < sql.length && wordCharacter.test(sql[position])) position++;
      tokens.push({ kind: 'word', value: sql.slice(start, position), start, end: position, depth });
      continue;
    }
    if (character === ')') depth = Math.max(0, depth - 1);
    tokens.push({ kind: 'symbol', value: character, start, end: ++position, depth });
    if (character === '(') depth++;
    if (character === ';') depth = 0;
  }
  return tokens;
}

function isIdentifier(token: Token | undefined): token is Token {
  return token?.kind === 'word' || token?.kind === 'quoted';
}

function currentStatement(tokens: Token[], cursor: number, length: number): TextRange {
  let start = 0;
  let end = length;
  for (const token of tokens) {
    if (token.kind !== 'symbol' || token.value !== ';') continue;
    if (token.start < cursor) start = token.end;
    else {
      end = token.start;
      break;
    }
  }
  return { start, end };
}

function lexicalClause(tokens: Token[], before: number): SqlClause {
  let clause: SqlClause = 'start';
  for (const token of tokens) {
    if (token.start >= before || token.depth !== 0 || token.kind !== 'word') continue;
    const value = token.value.toUpperCase();
    const clauses: Record<string, SqlClause> = {
      SELECT: 'select', FROM: 'from', JOIN: 'join', WHERE: 'where', ON: 'on',
      GROUP: 'group', ORDER: 'order', HAVING: 'having',
    };
    if (clauses[value]) clause = clauses[value];
    else if (['LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'SET', 'VALUES'].includes(value)) clause = 'other';
  }
  return clause;
}

function lexicalKinds(clause: SqlClause, tokens: Token[], range: TextRange, qualifier?: string): CompletionKind[] {
  const preceding = tokens.filter((token) => token.end <= range.start && token.depth === 0);
  const last = preceding.at(-1)?.value.toUpperCase();
  if (clause === 'from' || clause === 'join') {
    if (qualifier) return ['table'];
    return last === 'FROM' || last === 'JOIN' || last === ',' ? ['database', 'table'] : ['keyword'];
  }
  if ((clause === 'group' || clause === 'order') && (last === 'GROUP' || last === 'ORDER')) return ['keyword'];
  if (['select', 'where', 'on', 'group', 'order', 'having'].includes(clause)) {
    return qualifier ? ['column'] : ['column', 'function', 'keyword'];
  }
  return ['keyword'];
}

function qualifierBefore(tokens: Token[], targetStart: number): string | undefined {
  const previous = tokens.filter((token) => token.end <= targetStart && token.kind !== 'comment');
  const parts: string[] = [];
  let position = previous.length - 1;
  while (previous[position]?.value === '.') {
    const part = previous[position - 1];
    if (!isIdentifier(part) || !part.value || part.kind === 'word' && reserved.has(part.value.toUpperCase())) return undefined;
    parts.unshift(part.value);
    position -= 2;
  }
  return parts.length ? parts.join('.') : undefined;
}

function asRecord(value: unknown): AstRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as AstRecord : undefined;
}

function identifierValue(value: unknown): string | undefined {
  const record = asRecord(value);
  if (typeof record?.value === 'string') return record.value;
  return typeof asRecord(record?.Identifier)?.value === 'string'
    ? asRecord(record?.Identifier)?.value as string
    : undefined;
}

function clauseFromPath(path: AstPath): SqlClause | undefined {
  if (path.includes('projection')) return 'select';
  if (path.includes('selection')) return 'where';
  if (path.includes('having')) return 'having';
  if (path.includes('group_by') || path.includes('groupBy')) return 'group';
  if (path.includes('order_by') || path.includes('orderBy')) return 'order';
  if (path.includes('On')) return 'on';
  if (path.includes('joins')) return 'join';
  if (path.includes('from')) return 'from';
  return undefined;
}

function markerRole(path: AstPath): MarkerRole {
  if (path.includes('alias')) return 'alias';
  const table = path.lastIndexOf('Table');
  if (table !== -1 && path[table + 1] === 'name') return 'table';
  const functionNode = path.lastIndexOf('Function');
  if (functionNode !== -1 && path[functionNode + 1] === 'name') return 'function';
  if (path.includes('Identifier') || path.includes('CompoundIdentifier')) return 'column';
  return 'unsupported';
}

function findMarker(ast: unknown, sql: string, insertedAt: number): MarkerLocation | undefined {
  const matches: { path: AstPath; offset?: number }[] = [];
  const visit = (node: unknown, path: AstPath) => {
    if (Array.isArray(node)) {
      node.forEach((value, index) => visit(value, [...path, index]));
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    if (record.value === sentinel) {
      const start = asRecord(asRecord(record.span)?.start);
      let offset: number | undefined;
      if (typeof start?.line === 'number' && typeof start.column === 'number') {
        const lines = sql.split('\n');
        offset = lines.slice(0, start.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + start.column - 1;
      }
      matches.push({ path, offset });
    }
    Object.entries(record).forEach(([key, value]) => visit(value, [...path, key]));
  };
  visit(ast, []);
  const match = matches.find(({ offset }) => offset === insertedAt || offset === insertedAt - 1) ??
    (matches.length === 1 ? matches[0] : undefined);
  if (!match) return undefined;
  return { path: match.path, role: markerRole(match.path), clause: clauseFromPath(match.path) };
}

function astTables(ast: unknown, database: string): TableReference[] {
  const statements = Array.isArray(ast) ? ast : [];
  const query = asRecord(asRecord(statements[0])?.Query);
  const select = asRecord(asRecord(query?.body)?.Select);
  const from = select?.from;
  if (!Array.isArray(from)) return [];
  const tables: TableReference[] = [];
  const addRelation = (relation: unknown) => {
    const table = asRecord(asRecord(relation)?.Table);
    if (!Array.isArray(table?.name)) return;
    const parts = table.name.map(identifierValue);
    if (parts.some((part) => !part || part === sentinel || part === recoveryTable) || parts.length > 2) return;
    const alias = identifierValue(asRecord(table.alias)?.name);
    tables.push({
      database: parts.length === 2 ? parts[0]! : database,
      table: parts.at(-1)!,
      ...(alias && alias !== sentinel ? { alias } : {}),
    });
  };
  from.forEach((entry: unknown) => {
    const record = asRecord(entry);
    addRelation(record?.relation);
    if (Array.isArray(record?.joins)) record.joins.forEach((join) => addRelation(asRecord(join)?.relation));
  });
  return tables;
}

function lexicalTables(tokens: Token[], database: string, replaceRange: TextRange): TableReference[] {
  const top = tokens.filter((token) => token.depth === 0);
  const tables: TableReference[] = [];
  let inFrom = false;
  for (let position = 0; position < top.length; position++) {
    const keyword = top[position].value.toUpperCase();
    if (['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'ON'].includes(keyword)) inFrom = false;
    if (keyword !== 'FROM' && keyword !== 'JOIN' && !(inFrom && keyword === ',')) continue;
    inFrom = true;
    let next = position + 1;
    const parts: string[] = [];
    let intersectsCursor = false;
    while (isIdentifier(top[next]) && !reserved.has(top[next].value.toUpperCase())) {
      const token = top[next];
      if (token.start < replaceRange.end && token.end > replaceRange.start) intersectsCursor = true;
      parts.push(token.value);
      next++;
      if (top[next]?.value !== '.') break;
      next++;
    }
    if (!parts.length || parts.length > 2 || intersectsCursor || top[next - 1]?.value === '.') continue;
    if (top[next]?.value.toUpperCase() === 'AS') next++;
    const alias = isIdentifier(top[next]) && !reserved.has(top[next].value.toUpperCase()) ? top[next].value : undefined;
    tables.push({ database: parts.length === 2 ? parts[0] : database, table: parts.at(-1)!, ...(alias ? { alias } : {}) });
  }
  return tables;
}

function hasComplexScope(tokens: Token[]): boolean {
  return tokens.some((token) => token.kind === 'word' && (
    token.value.toUpperCase() === 'SELECT' && token.depth > 0 ||
    ['WITH', 'UNION', 'EXCEPT', 'INTERSECT'].includes(token.value.toUpperCase()) && token.depth === 0
  ));
}

function repairCandidates(sql: string, dialect: SqlDialect): { sql: string; reason: string }[] {
  const tokens = scan(sql, dialect).filter((token) => token.kind !== 'comment');
  const last = tokens.at(-1)?.value.toUpperCase();
  let suffix = '';
  if (last && ['FROM', 'JOIN', 'INTO', '.'].includes(last)) suffix = ` ${recoveryTable}`;
  else if (last === 'GROUP' || last === 'ORDER') suffix = ' BY 1';
  else if (last && ['WHERE', 'ON', 'HAVING', 'AND', 'OR', 'BY', '=', '>', '<', '+', '-', '*', '/', '(', ','].includes(last)) suffix = ' 0';
  const openings = tokens.filter((token) => token.value === '(').length;
  const closings = tokens.filter((token) => token.value === ')').length;
  const missing = Math.min(6, Math.max(0, openings - closings));
  const closers = ')'.repeat(missing);
  const candidates: { sql: string; reason: string }[] = [];
  if (suffix || closers) candidates.push({ sql: sql + suffix + closers, reason: `补齐尾部${suffix ? '缺失项' : ''}${missing ? `及 ${missing} 个右括号` : ''}` });
  // A trailing incomplete condition may already contain an unmatched function call.
  if (closers && suffix) candidates.push({ sql: sql + closers, reason: `补齐 ${missing} 个右括号` });
  return candidates;
}

/**
 * Analyze a parsing copy, never the editor buffer. The user's prefix and token
 * range are captured first and are independent from the AST placeholder.
 */
export function analyzeContext(request: CompletionRequest): CompletionContext {
  const { sql, dialect } = request;
  const cursor = Math.max(0, Math.min(sql.length, request.cursor));
  const allTokens = scan(sql, dialect);
  const statementRange = currentStatement(allTokens, cursor, sql.length);
  const tokens = allTokens.filter((token) => token.start >= statementRange.start && token.end <= statementRange.end && token.kind !== 'comment');
  const suppressed = allTokens.find((token) => (token.kind === 'comment' || token.kind === 'string') &&
    cursor > token.start && (cursor < token.end || cursor === token.end && (!token.closed || token.delimiter === 'line')));
  if (suppressed) {
    return {
      clause: lexicalClause(tokens, cursor), prefix: '', kinds: [], tables: [],
      replaceRange: { start: cursor, end: cursor }, statementRange,
      parserStatus: 'suppressed', parserMessage: '光标位于注释或字符串中，不请求补全。',
    };
  }
  const target = tokens.find((token) => isIdentifier(token) && (
    token.start < cursor && cursor <= token.end || token.start === cursor && !reserved.has(token.value.toUpperCase())
  ));
  const replaceRange = target
    ? { start: target.start + (target.kind === 'quoted' ? 1 : 0), end: target.end - (target.kind === 'quoted' && target.closed ? 1 : 0) }
    : { start: cursor, end: cursor };
  const prefixEnd = Math.min(cursor, replaceRange.end);
  const rawPrefix = sql.slice(replaceRange.start, prefixEnd);
  const prefix = target?.delimiter ? rawPrefix.split(target.delimiter + target.delimiter).join(target.delimiter) : rawPrefix;
  const qualifier = qualifierBefore(tokens, target?.start ?? cursor);
  const qualificationDot = tokens.filter((token) => token.end <= (target?.start ?? cursor)).at(-1)?.value === '.';
  const clause = lexicalClause(tokens, target?.start ?? cursor);
  const complex = hasComplexScope(tokens);
  const context: CompletionContext = {
    clause, prefix, ...(qualifier ? { qualifier } : {}),
    kinds: lexicalKinds(clause, tokens, replaceRange, qualifier),
    tables: complex ? [] : lexicalTables(tokens, request.database, replaceRange),
    replaceRange, statementRange, parserStatus: 'lexical',
  };
  if (qualificationDot && !qualifier) {
    return {
      ...context, kinds: [], tables: [],
      parserMessage: '限定名缺少有效的库名、表名或别名，暂不请求元数据。',
    };
  }
  const restrictQuotedKinds = () => {
    if (target?.kind === 'quoted') {
      context.kinds = context.kinds.filter((kind) => ['column', 'table', 'database'].includes(kind));
    }
  };
  restrictQuotedKinds();
  const localStart = replaceRange.start - statementRange.start;
  const statement = sql.slice(statementRange.start, statementRange.end);
  // With an empty insertion range, separate the marker from adjacent keywords.
  const left = statement.slice(0, localStart);
  const right = statement.slice(replaceRange.end - statementRange.start);
  const gapLeft = !target && wordCharacter.test(left.at(-1) ?? ' ') ? ' ' : '';
  const gapRight = !target && wordCharacter.test(right[0] ?? ' ') ? ' ' : '';
  const candidate = left + gapLeft + sentinel + gapRight + right;
  const insertedAt = localStart + gapLeft.length;
  let errorMessage = '';
  const quoteRepair = target?.kind === 'quoted' && !target.closed && target.delimiter
    ? [{ sql: candidate + target.delimiter, reason: '在解析副本中补齐标识符右引号' }]
    : [];
  const attempts = [{ sql: candidate, reason: '' }, ...quoteRepair, ...repairCandidates(candidate, dialect)];
  for (let position = 0; position < attempts.length; position++) {
    const attempt = attempts[position];
    try {
      const ast: unknown = parse(attempt.sql, dialect);
      if (!asRecord(asRecord(Array.isArray(ast) ? ast[0] : undefined)?.Query)) {
        context.ast = ast;
        context.kinds = ['keyword'];
        context.tables = [];
        context.clause = 'other';
        restrictQuotedKinds();
        errorMessage = '当前仅支持 SELECT 查询的 AST 补全，其他语句暂按关键字上下文降级。';
        break;
      }
      const marker = findMarker(ast, attempt.sql, insertedAt);
      if (!marker || marker.role === 'unsupported') {
        context.ast = ast;
        errorMessage = 'AST 中的占位符不属于当前支持的 SELECT 补全节点。';
        continue;
      }
      context.ast = ast;
      context.parserStatus = position === 0 ? 'parsed' : 'recovered';
      context.clause = marker.clause ?? context.clause;
      context.tables = complex ? [] : astTables(ast, request.database);
      switch (marker.role) {
        case 'table': context.kinds = qualifier ? ['table'] : ['database', 'table']; break;
        case 'column': context.kinds = qualifier ? ['column'] : ['column', 'function', 'keyword']; break;
        case 'function': context.kinds = ['function']; break;
        case 'alias': context.kinds = ['keyword']; break;
      }
      restrictQuotedKinds();
      context.parserMessage = `${sentinel} → ${marker.path.join('.')} (${marker.role})` +
        (position > 0 ? `；${attempt.reason}。原解析错误：${errorMessage}` : '') +
        (complex ? '；复杂查询作用域暂不解析，已禁用字段检索以避免跨作用域推荐。' : '');
      return context;
    } catch (error) {
      if (!errorMessage) errorMessage = error instanceof Error ? error.message : String(error);
    }
  }
  const statementKeyword = tokens[0]?.value.toUpperCase();
  if (statementKeyword !== 'SELECT' && statementKeyword !== 'WITH') {
    context.tables = [];
    context.kinds = ['keyword'];
    if (context.clause !== 'start') context.clause = 'other';
    restrictQuotedKinds();
    if (!errorMessage.includes('仅支持 SELECT')) errorMessage += '；当前仅支持 SELECT 查询的字段作用域。';
  }
  context.parserMessage = `占位符解析失败，按词法上下文降级：${errorMessage}` +
    (complex ? '；复杂查询作用域暂不解析，已禁用字段检索。' : '');
  return context;
}
