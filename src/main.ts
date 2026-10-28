import './style.css';
import { createSqlCompletion } from './completion/index';
import { createMockMetadataIndex, MOCK_DATABASES } from './metadata';
import type { CompletionItem, SqlCompletionResult, RequestLog, SqlDialect } from './completion/index';

const icons = {
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M10 10v10"/>',
  column: '<path d="M5 4h14v16H5zM9 4v16M15 4v16"/>',
  function: '<path d="M16 4h-3c-2 0-3 2-3 4l-2 9c0 2-1 3-3 3M5 10h11"/>',
  keyword: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
};
type IconName = keyof typeof icons;
const icon = (name: IconName) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const kindLabel = { keyword: '关键字', database: '数据库', table: '数据表', column: '字段', function: '函数' };
const clauseLabel: Record<string, string> = { start: '语句起始', select: 'SELECT 投影', from: 'FROM 表引用', join: 'JOIN 表引用', where: 'WHERE 条件', on: 'ON 连接条件', group: 'GROUP BY 分组', order: 'ORDER BY 排序', having: 'HAVING 条件', other: '其他位置' };
const statusLabel = { parsed: '占位符解析', recovered: '修复解析', lexical: 'Token 降级', suppressed: '已抑制补全' };
const samples = [
  { name: '字段补全', note: '别名 · 前缀搜索', sql: 'SELECT u.em|\nFROM demo.users AS u\nWHERE u.status = \'active\';' },
  { name: '库与表', note: '限定数据库', sql: 'SELECT *\nFROM demo.us|' },
  { name: 'JOIN 别名', note: '多表作用域', sql: 'SELECT u.name, o.|\nFROM demo.users u\nJOIN demo.orders o ON u.id = o.user_id;' },
  { name: '函数补全', note: '方言 · 函数签名', sql: 'SELECT COU|\nFROM demo.users;' },
  { name: '不完整 SQL', note: '尾部缺失恢复', sql: 'SELECT u.|\nFROM demo.users u\nWHERE' },
  { name: '关键字', note: '语句起始', sql: 'SEL|' },
];

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <aside class="rail">
    <a class="brand" href="#" aria-label="SQL Studio 首页"><span class="brand-mark">${icon('keyword')}</span><span>SQL<span class="brand-light">Studio</span></span></a>
    <div class="workspace-label">WORKSPACE <span>LOCAL</span></div>
    <div class="nav-item active">${icon('spark')}<span>智能补全实验室</span><span class="nav-dot"></span></div>
    <div class="rail-section"><span>数据目录</span><span class="small-badge">MOCK</span></div>
    <div class="catalog" id="catalog"></div>
    <div class="rail-guide"><span class="guide-symbol">${icon('keyword')}</span><strong>从一行 SQL 开始</strong><p>输入库名、表名或字段前缀，查看光标位置的推荐结果。</p><div><kbd>Ctrl</kbd> + <kbd>Space</kbd><span>唤起补全</span></div></div>
    <div class="rail-bottom"><span class="connection-dot"></span>浏览器本地 Mock <span>v0.1</span></div>
  </aside>
  <main>
    <header class="topbar"><div>工作空间 <span>/</span> <strong>SQL 智能补全</strong></div><span class="topbar-right">${icon('database')} demo-local <span class="connection-dot"></span></span></header>
    <div class="page-content">
      <section class="page-heading"><div><div class="eyebrow">SQL COMPLETION PLAYGROUND</div><h1>让下一次输入，更有把握<span>.</span></h1><p>解析光标上下文，检索元数据，在前端生成有序的补全建议。</p></div><span class="environment-badge"><span class="connection-dot"></span>交互演示 · Mock 数据</span></section>
      <section class="workspace-card">
        <div class="editor-toolbar"><div class="file-tab">${icon('keyword')} query.sql <span class="file-dot"></span></div><div class="editor-controls"><label>方言 <select id="dialect" aria-label="SQL 方言"><option value="mysql">MySQL</option><option value="postgresql">PostgreSQL</option><option value="generic">Generic</option></select></label><span class="control-divider"></span><label>当前库 <select id="database" aria-label="当前数据库">${MOCK_DATABASES.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select></label></div></div>
        <div class="workspace-body">
          <div class="editor-column">
            <div class="sample-bar"><span>试一试</span>${samples.map((sample, position) => `<button class="sample-chip${position === 0 ? ' selected' : ''}" data-sample="${position}" title="${sample.note}">${sample.name}</button>`).join('')}</div>
            <div class="editor-surface" id="editor-surface">
              <div class="editor-lines" id="line-numbers" aria-hidden="true"></div>
              <div class="code-scroll"><pre id="highlight" aria-hidden="true"></pre><textarea id="sql-editor" spellcheck="false" wrap="off" aria-label="SQL 编辑器" role="combobox" aria-autocomplete="list" aria-controls="completion-list" aria-expanded="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea></div>
              <div class="completion-popup hidden" id="completion-popup"><div class="popup-heading"><span>${icon('spark')} 推荐补全</span><span id="result-count"></span></div><div id="completion-list" role="listbox" aria-label="SQL 补全候选"></div><div id="candidate-detail"></div><div class="popup-help"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Tab</kbd> / <kbd>Enter</kbd> 插入</span><span><kbd>Esc</kbd> 关闭</span></div></div>
            </div>
            <div class="editor-status"><span id="cursor-position">Ln 1, Col 1</span><span id="parser-status"><span class="loading-dot"></span>初始化 WASM…</span><span>UTF-8</span><button id="complete-button" disabled>${icon('spark')}获取补全 <kbd>⌃ Space</kbd></button></div>
          </div>
          <aside class="context-panel"><div class="panel-title"><span>${icon('spark')}光标上下文</span><span class="live-badge">LIVE</span></div><p class="panel-intro">原始前缀用于搜索，占位符只用于解析副本。</p><div id="context-content" class="context-content"><div class="placeholder">解析器正在初始化…</div></div><details class="ast-details"><summary>查看解析副本 AST <span>↗</span></summary><pre id="ast-view">尚未解析</pre></details></aside>
        </div>
      </section>
      <div class="flow-strip"><span class="flow-label">补全链路</span><span><b>01</b> 光标与前缀</span><i>→</i><span><b>02</b> 占位符解析</span><i>→</i><span><b>03</b> 索引搜索</span><i>→</i><span><b>04</b> 前端排序</span><i>→</i><span><b>05</b> 插入候选</span></div>
      <section class="request-card"><div class="request-header"><div><h2>索引请求观察台 <span id="log-count">0</span></h2><p>每次请求的完整参数同步打印到浏览器 Console。</p></div><button class="text-button" id="clear-logs">清空记录</button></div><div class="request-body"><div class="request-list" id="request-list"><div class="empty-requests">输入 SQL 后，搜索请求会显示在这里。</div></div><div class="request-inspector"><div class="inspector-label"><span id="inspector-title">REQUEST PARAMETERS</span><span class="json-badge">JSON</span></div><pre id="request-json">// 点击左侧请求查看完整参数</pre></div></div></section>
      <footer><span>Powered by <strong>sqlparser-ts</strong> · WebAssembly</span><span>Mock 接口可替换为远程 MetadataIndex 实现</span></footer>
    </div>
  </main><div class="toast hidden" id="toast" role="status"></div>`;

const editor = document.querySelector<HTMLTextAreaElement>('#sql-editor')!;
const highlight = document.querySelector<HTMLPreElement>('#highlight')!;
const popup = document.querySelector<HTMLDivElement>('#completion-popup')!;
const list = document.querySelector<HTMLDivElement>('#completion-list')!;
const button = document.querySelector<HTMLButtonElement>('#complete-button')!;
const database = document.querySelector<HTMLSelectElement>('#database')!;
const dialect = document.querySelector<HTMLSelectElement>('#dialect')!;
let ready = false;
let result: SqlCompletionResult | undefined;
let selected = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let isComposing = false;
let dismissed = false;
const logs: RequestLog[] = [];
let selectedLog: string | undefined;
let followLatestLog = true;
const index = createMockMetadataIndex((entry) => {
  const existing = logs.findIndex((log) => log.id === entry.id);
  if (existing >= 0) logs[existing] = entry;
  else if (entry.status === 'pending') {
    logs.unshift(entry);
    if (followLatestLog) selectedLog = entry.id;
  } else return;
  if (logs.length > 50) logs.length = 50;
  if (!selectedLog || !logs.some((log) => log.id === selectedLog)) selectedLog = logs[0]?.id;
  renderLogs();
});
const completion = createSqlCompletion({
  index, connectionId: 'demo-local', database: 'demo', dialect: 'mysql',
});

const catalogTables: Record<string, string[]> = { demo: ['users', 'orders', 'products'], analytics: ['events', 'sessions', 'revenue_daily'], warehouse: ['dim_customers', 'fact_orders'] };
document.querySelector('#catalog')!.innerHTML = MOCK_DATABASES.map((name) => `<details ${name === 'demo' ? 'open' : ''}><summary>${icon('database')}<span>${escapeHtml(name)}</span><span class="catalog-count">${catalogTables[name]?.length ?? 0}</span></summary><div>${(catalogTables[name] ?? []).map((table) => `<button data-table="${escapeHtml(name)}.${escapeHtml(table)}">${icon('table')}${escapeHtml(table)}</button>`).join('')}</div></details>`).join('');

function highlightSql(sql: string) {
  const tokenPattern = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\b(?:SELECT|FROM|WHERE|AS|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|GROUP|BY|ORDER|HAVING|LIMIT|DESC|ASC|INSERT|INTO|UPDATE|DELETE|SET|WITH|DISTINCT|NULL|IS|NOT|IN|TRUE|FALSE)\b|\b\d+(?:\.\d+)?\b)/gi;
  let html = '';
  let offset = 0;
  for (const match of sql.matchAll(tokenPattern)) {
    html += escapeHtml(sql.slice(offset, match.index));
    const value = match[0];
    const kind = value.startsWith('--') || value.startsWith('/*') ? 'comment' : /^['"`]/.test(value) ? 'string' : /^\d/.test(value) ? 'number' : 'keyword';
    html += `<span class="sql-${kind}">${escapeHtml(value)}</span>`;
    offset = match.index + value.length;
  }
  return html + escapeHtml(sql.slice(offset)) + '\n';
}

function syncEditor() {
  highlight.innerHTML = highlightSql(editor.value);
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
  const numbers = document.querySelector<HTMLDivElement>('#line-numbers')!;
  numbers.innerHTML = Array.from({ length: Math.max(12, editor.value.split('\n').length) }, (_, position) => `<div>${position + 1}</div>`).join('');
  numbers.scrollTop = editor.scrollTop;
  const beforeCursor = editor.value.slice(0, editor.selectionStart);
  document.querySelector('#cursor-position')!.textContent = `Ln ${beforeCursor.split('\n').length}, Col ${beforeCursor.split('\n').at(-1)!.length + 1}`;
}

function hidePopup() {
  popup.classList.add('hidden');
  editor.setAttribute('aria-expanded', 'false');
  editor.removeAttribute('aria-activedescendant');
}

function positionPopup() {
  const before = editor.value.slice(0, editor.selectionStart).split('\n');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.font = getComputedStyle(editor).font;
  const width = context.measureText(before.at(-1)!.replace(/\t/g, '  ')).width;
  const surface = document.querySelector<HTMLDivElement>('#editor-surface')!;
  const left = Math.min(Math.max(16, 62 + width - editor.scrollLeft), Math.max(16, surface.clientWidth - 375));
  const top = Math.min(Math.max(40, 24 + before.length * 28 - editor.scrollTop), 128);
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function renderCandidates() {
  if (!result?.items.length || dismissed || document.activeElement !== editor) { hidePopup(); return; }
  selected = Math.min(selected, result.items.length - 1);
  list.innerHTML = result.items.map((item, position) => `<div id="candidate-${position}" class="candidate${position === selected ? ' is-selected' : ''}" role="option" aria-selected="${position === selected}" data-candidate="${position}"><span class="kind-icon ${item.kind}">${icon(item.kind)}</span><span class="candidate-name">${escapeHtml(item.label)}</span><span class="candidate-type">${escapeHtml(item.dataType ?? kindLabel[item.kind])}</span><span class="candidate-score">${Math.round(item.score)}</span></div>`).join('');
  document.querySelector('#result-count')!.textContent = `${result.items.length} 项`;
  const item = result.items[selected];
  document.querySelector('#candidate-detail')!.innerHTML = `<div>${escapeHtml(item.signature ?? item.detail)}</div><span>${escapeHtml(item.reason)}</span>`;
  popup.classList.remove('hidden');
  editor.setAttribute('aria-expanded', 'true');
  editor.setAttribute('aria-activedescendant', `candidate-${selected}`);
  positionPopup();
  document.querySelector(`#candidate-${selected}`)?.scrollIntoView({ block: 'nearest' });
}

function renderContext() {
  if (!result) return;
  const context = result.context;
  const tables = context.tables.map((table) => `${table.database}.${table.table}${table.alias ? ` AS ${table.alias}` : ''}`);
  document.querySelector('#context-content')!.innerHTML = `
    <div class="context-field"><span>当前子句</span><strong>${escapeHtml(clauseLabel[context.clause] ?? context.clause)}</strong></div>
    <div class="context-pair"><div class="context-field"><span>搜索前缀</span><code>${context.prefix ? escapeHtml(context.prefix) : '<span class="muted">空前缀</span>'}</code></div><div class="context-field"><span>限定符</span><code>${escapeHtml(context.qualifier ?? '—')}</code></div></div>
    <div class="context-field"><span>检索范围</span><div class="kind-tags">${context.kinds.map((kind) => `<span class="kind-tag ${kind}">${icon(kind)}${kindLabel[kind]}</span>`).join('') || '<span class="muted">当前位置不触发补全</span>'}</div></div>
    <div class="context-field"><span>表作用域</span><div class="scope-list">${tables.map((table) => `<code>${escapeHtml(table)}</code>`).join('') || '<span class="muted">尚未引用数据表</span>'}</div></div>
    <div class="context-pair"><div class="context-field"><span>替换范围</span><code>[${context.replaceRange.start}, ${context.replaceRange.end})</code></div><div class="context-field"><span>推荐耗时</span><strong>${Math.round(result.elapsedMs)}<small> ms</small></strong></div></div>
    <div class="parse-note ${context.parserStatus}"><span class="note-dot"></span><div><strong>${statusLabel[context.parserStatus]}</strong><p>${escapeHtml(context.parserMessage ?? '使用 __suggestion__ 定位 AST 节点。')}</p></div></div>
    ${result.errors.length ? `<div class="inline-error">${result.errors.map(escapeHtml).join('<br>')}</div>` : ''}
    ${!result.items.length ? '<div class="no-results">当前没有匹配候选，可尝试其他前缀。</div>' : ''}`;
  document.querySelector('#ast-view')!.textContent = context.ast ? JSON.stringify(context.ast, null, 2) : '当前使用 token 上下文，无可用 AST。';
  document.querySelector('#parser-status')!.innerHTML = `<span class="connection-dot ${context.parserStatus === 'lexical' ? 'amber' : ''}"></span>${statusLabel[context.parserStatus]} · ${result.items.length} 个候选`;
}

async function requestCompletion() {
  if (!ready || isComposing || editor.selectionStart !== editor.selectionEnd) return;
  result = undefined;
  hidePopup();
  const sql = editor.value;
  const cursor = editor.selectionStart;
  document.querySelector('#parser-status')!.innerHTML = '<span class="loading-dot"></span>检索候选…';
  try {
    const nextResult = await completion.complete({ sql, cursor, database: database.value, dialect: dialect.value as SqlDialect });
    if (sql !== editor.value || cursor !== editor.selectionStart || cursor !== editor.selectionEnd) return;
    result = nextResult;
    selected = 0;
    renderContext();
    renderCandidates();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    document.querySelector('#parser-status')!.textContent = '补全请求失败';
    showToast(error instanceof Error ? error.message : String(error));
  }
}

function scheduleCompletion(delay = 160) {
  clearTimeout(timer);
  completion.cancel();
  result = undefined;
  dismissed = false;
  hidePopup();
  if (editor.selectionStart === editor.selectionEnd) timer = setTimeout(requestCompletion, delay);
}

function acceptCandidate(item: CompletionItem) {
  if (!result || editor.selectionStart !== editor.selectionEnd) return;
  try {
    const next = completion.apply({
      document: { sql: editor.value, cursor: editor.selectionStart },
      result, itemId: item.id,
    });
    const { start, end } = next.edit.range;
    editor.setRangeText(next.edit.text, start, end, 'end');
    editor.focus();
    editor.setSelectionRange(next.cursor, next.cursor);
    hidePopup();
    dismissed = true;
    syncEditor();
    showToast(`已插入 ${item.label}`);
    if (item.kind === 'database') scheduleCompletion(0);
  } catch (error) {
    hidePopup();
    showToast(error instanceof Error ? error.message : String(error));
    scheduleCompletion(0);
  }
}

function renderLogs() {
  document.querySelector('#log-count')!.textContent = String(logs.length);
  document.querySelector('#request-list')!.innerHTML = logs.length ? logs.map((log) => `<button class="request-row${selectedLog === log.id ? ' selected' : ''}" data-log="${escapeHtml(log.id)}"><span class="method">POST</span><span class="request-path">${escapeHtml(log.endpoint.replace(/^POST\s+\/api\/completion\//, ''))}<small>${escapeHtml(log.params.query ? `query: "${log.params.query}"` : 'query: ""')} · ${escapeHtml(log.params.requestId)}</small></span><span class="request-meta ${log.status}">${log.status === 'pending' ? '…' : log.status === 'cancelled' ? '取消' : log.status === 'error' ? '失败' : `${log.count} 项`}<small>${log.elapsedMs === undefined ? 'pending' : `${Math.round(log.elapsedMs)} ms`}</small></span></button>`).join('') : '<div class="empty-requests">输入 SQL 后，搜索请求会显示在这里。</div>';
  const entry = logs.find((log) => log.id === selectedLog);
  document.querySelector('#inspector-title')!.textContent = entry?.endpoint ?? 'REQUEST PARAMETERS';
  document.querySelector('#request-json')!.textContent = entry ? JSON.stringify({ ...entry.params }, null, 2) : '// 点击左侧请求查看完整参数';
}

let toastTimer: ReturnType<typeof setTimeout>;
function showToast(message: string) {
  const toast = document.querySelector<HTMLDivElement>('#toast')!;
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2200);
}

function loadSample(position: number) {
  const sample = samples[position];
  const cursor = sample.sql.indexOf('|');
  editor.value = sample.sql.replace('|', '');
  editor.focus();
  editor.setSelectionRange(cursor, cursor);
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  document.querySelectorAll<HTMLElement>('[data-sample]').forEach((element) => element.classList.toggle('selected', Number(element.dataset.sample) === position));
  syncEditor();
  scheduleCompletion(0);
}

editor.addEventListener('input', () => { syncEditor(); if (!isComposing) scheduleCompletion(); });
editor.addEventListener('compositionstart', () => { isComposing = true; clearTimeout(timer); completion.cancel(); result = undefined; hidePopup(); });
editor.addEventListener('compositionend', () => { isComposing = false; syncEditor(); scheduleCompletion(); });
editor.addEventListener('scroll', () => { syncEditor(); if (!popup.classList.contains('hidden')) positionPopup(); });
editor.addEventListener('click', () => { syncEditor(); scheduleCompletion(); });
editor.addEventListener('select', () => {
  syncEditor();
  if (editor.selectionStart !== editor.selectionEnd) {
    clearTimeout(timer);
    completion.cancel();
    result = undefined;
    hidePopup();
  }
});
editor.addEventListener('keyup', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) || (popup.classList.contains('hidden') && ['ArrowUp', 'ArrowDown'].includes(event.key))) { syncEditor(); scheduleCompletion(); }
});
editor.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && event.code === 'Space') { event.preventDefault(); dismissed = false; scheduleCompletion(0); return; }
  if (event.key === 'Escape') { event.preventDefault(); clearTimeout(timer); completion.cancel(); result = undefined; dismissed = true; hidePopup(); return; }
  if (!popup.classList.contains('hidden') && result?.items.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + result.items.length) % result.items.length; renderCandidates(); return; }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); acceptCandidate(result.items[selected]); return; }
  }
  if (event.key === 'Tab') { event.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); syncEditor(); scheduleCompletion(); }
});
list.addEventListener('mousedown', (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-candidate]');
  if (element && result) { event.preventDefault(); acceptCandidate(result.items[Number(element.dataset.candidate)]); }
});
editor.addEventListener('blur', hidePopup);
button.addEventListener('click', () => { editor.focus(); dismissed = false; scheduleCompletion(0); });
document.querySelectorAll<HTMLElement>('[data-sample]').forEach((element) => element.addEventListener('click', () => loadSample(Number(element.dataset.sample))));
database.addEventListener('change', () => { editor.focus(); scheduleCompletion(0); });
dialect.addEventListener('change', () => { editor.focus(); scheduleCompletion(0); });
document.querySelector('#request-list')!.addEventListener('click', (event) => { const element = (event.target as HTMLElement).closest<HTMLElement>('[data-log]'); if (element) { selectedLog = element.dataset.log; followLatestLog = false; renderLogs(); } });
document.querySelector('#clear-logs')!.addEventListener('click', () => { logs.length = 0; selectedLog = undefined; followLatestLog = true; renderLogs(); });
document.querySelector('#catalog')!.addEventListener('click', (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-table]');
  if (!element) return;
  const name = element.dataset.table!;
  editor.value = `SELECT \nFROM ${name};`;
  database.value = name.split('.')[0];
  editor.focus();
  editor.setSelectionRange(7, 7);
  document.querySelectorAll('[data-sample]').forEach((chip) => chip.classList.remove('selected'));
  syncEditor(); scheduleCompletion(0);
});
window.addEventListener('resize', () => { if (!popup.classList.contains('hidden')) positionPopup(); });
window.addEventListener('pagehide', () => { clearTimeout(timer); completion.cancel(); });
if (import.meta.hot) import.meta.hot.dispose(() => { clearTimeout(timer); completion.dispose(); });

loadSample(0);
completion.ready().then(() => { ready = true; button.disabled = false; scheduleCompletion(0); }).catch((error: unknown) => {
  document.querySelector('#parser-status')!.textContent = 'WASM 初始化失败';
  document.querySelector('#context-content')!.innerHTML = `<div class="inline-error">${escapeHtml(error instanceof Error ? error.message : error)}<br>请确认 WebAssembly 资源可访问后刷新页面。</div>`;
  console.error('[sql-completion] WASM initialization failed', error);
});
