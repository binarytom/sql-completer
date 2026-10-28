# SQL 补全方案与索引接口

## 设计判断与链路

方案可行。将「光标上下文分析」「元数据召回」「前端排序和插入」分开，之后可把 mock 替换为 HTTP 服务而不改编辑器交互。

```text
编辑器 SQL + 光标
  → 保存原始前缀、限定符、替换范围
  → sqlparser-ts 解析带占位符的 SQL 副本
  → 有限修复重试 → 词法降级
  → 按上下文调用 MetadataIndex 的相关接口
  → 前端合并、去重、打分
  → 展示建议 → 用户确认后替换原文
```

SQL 只用于前端上下文分析，搜索接口接收搜索词和已解析的作用域，无须上传整段 SQL。解析器的 WebAssembly 模块须初始化后再使用，由公开入口统一等待初始化。

## 分层与高内聚入口

原有 `context → service → MetadataIndex` 的职责划分合理，主要问题是编辑器还需要了解解析器初始化、请求轮次、取消和替换细节；复制页面接入逻辑容易遗漏过期结果处理。现在由 `createSqlCompletion(config)` 聚合这些能力，编辑器只调用 `ready / complete / apply / cancel / dispose`，不直接导入内部解析或召回函数。

```text
main.ts：编辑器事件、防抖、候选呈现、写回文档、日志观察台
    ↓ 公共入口 completion/index.ts
engine.ts：初始化、输入校验、请求生命周期、结果与文档校验
    ├─ service.ts：分析上下文、选择索引、并行召回、评分和去重
    │      ├─ context.ts：分词、占位符 AST、有限修复、作用域
    │      └─ MetadataIndex：注入的数据访问契约
    │              └─ metadata.ts：独立 mock 适配器
    └─ edits.ts：纯文本替换、函数插入后的光标定位
```

`types.ts` 定义共享契约，`index.ts` 选择导出公共类型；内部 `CompletionRequest`、底层编排函数不作为页面接入入口。引擎不导入 mock、DOM 或 HTTP 实现。这样既能统一编辑器接入，也能独立替换元数据来源；高内聚入口不要求把所有实现合并为一个文件。当前不增加通用插件框架，后续有多编辑器或复杂方言需求时，再分别扩展 UI 适配器和上下文规则。

### 编辑器接口

```ts
interface SqlCompletionConfig {
  index: MetadataIndex;
  connectionId: string;
  database: string;
  dialect?: 'mysql' | 'postgresql' | 'generic'; // 默认 mysql
  limit?: number;                            // 1..100 整数，默认 30
  matchMode?: 'prefix' | 'contains';          // 默认 prefix
}

interface SqlDocument {
  sql: string;
  cursor: number; // UTF-16 偏移；范围 0..sql.length
}

interface SqlCompletion {
  ready(): Promise<void>;
  complete(
    input: SqlDocument & { database?: string; dialect?: SqlDialect },
    options?: { signal?: AbortSignal },
  ): Promise<SqlCompletionResult>;
  apply(input: {
    document: SqlDocument;
    result: SqlCompletionResult;
    itemId: string;
  }): AppliedCompletion;
  cancel(): void;
  dispose(): void;
}

interface SqlCompletionResult {
  requestId: string;
  context: CompletionContext;
  items: CompletionItem[]; // 包含 score / reason，已排序
  elapsedMs: number;
  errors: string[];       // 单个索引失败可部分成功
}

interface AppliedCompletion extends SqlDocument {
  edit: { range: { start: number; end: number }; text: string };
}
```

`connectionId` 和默认 `database` 必须非空；单次 `complete` 可覆盖当前库和方言。`ready()` 是可选预热，`complete()` 本身会等待解析器；初始化 Promise 在当前运行环境中全局复用，失败后应重新加载页面，当前未提供初始化重试接口。

一个实例绑定一个编辑器。开始有效的新请求时，旧请求被取消、旧结果立即失效；新请求失败也不会恢复旧结果。外部取消、`cancel()`、新请求和 `dispose()` 会令进行中的调用以 `AbortError` 拒绝，即使注入的索引忽略 `signal` 也能及时结束公开调用。底层索引仍应传递取消信号，释放网络和计算资源。

`apply()` 校验返回对象属于本实例的最新结果、当前 SQL 和光标完全一致、候选 ID 合法，然后使用私有快照里的原始候选和替换范围生成变更。修改展示用 `items` 或 `context` 不会改变实际插入行为。范围使用 `[start, end)`，所有偏移均为 UTF-16；接口只处理单光标，非空选区由编辑器抑制补全。UI 在文档、光标、当前库或方言变化时立即调用 `cancel()`，然后安排新请求；接受候选时传入真实当前文档，不能用旧快照冒充当前文档。

接受一次即令结果失效。`apply()` 抛出带 `code` 的 `SqlCompletionError`：`STALE_RESULT`（结果失效或属于其他实例）、`DOCUMENT_CHANGED`（SQL/光标变化）、`UNKNOWN_ITEM`（未知候选）、`DISPOSED`（实例已销毁）。`ready()` / `complete()` 在销毁后也会拒绝 `DISPOSED`；配置和输入校验失败使用 `TypeError` / `RangeError`。`cancel()` 后可继续补全；`dispose()` 为终态，可重复调用。完整运行示例见 [README](../README.md#补全模块接入)。

## 不完整 SQL：占位符不能丢失输入前缀

使用 `__suggestion__` 的思路合理，但要保留两份数据：**解析副本里的占位符**与**原文里的搜索前缀**。占位符只帮助识别语法角色，不能成为接口的 `query`，也不应即时写回编辑器。

以 `SELECT u.em|ail FROM demo.users u` 为例，`|` 表示光标：

1. 从原文提取 `prefix = "em"`、`qualifier = "u"`，保存覆盖整个 `email` token 的 `replaceRange`。
2. 只在解析副本里把整个 token 换成占位符，得到 `SELECT u.__suggestion__ FROM demo.users u`。由 AST 的标识符节点判断这是字段位置，解析 `u → demo.users`。
3. 请求字段接口时发送 `query: "em"` 和 `tables: [{ database: "demo", table: "users", alias: "u" }]`。选择 `email` 后，才替换原文里的完整 token；保留前面的 `u.`，避免产生 `emailail`。

同理，`FROM demo.us|` 保存 `query = "us"`，解析副本为 `FROM demo.__suggestion__`，召回 `demo` 下的表；空白位置则保存空前缀和零长度替换范围。中间编辑时，搜索词只取 token 起点至光标，替换范围仍覆盖整个 token。

### 解析与恢复原则

- **直接解析**：优先解析当前语句的占位符副本，检查占位符所在 AST 节点及父节点；标识符、表引用、函数名的位置有不同召回类别。
- **有限修复**：对副本补齐尾部缺少的表引用、操作数或 `BY`、未闭合的标识符引号，以及最多 6 个未闭合右括号；用状态 `recovered` 标识结果，不修改用户 SQL。修复产生的表名和字段不能进入真实作用域。
- **词法降级**：仍失败时，根据当前子句、点号限定符、可见表别名和原始前缀召回，状态为 `lexical`。字符串（含 PostgreSQL `E'…'` 转义字符串）和注释内不弹出普通 SQL 建议，状态为 `suppressed`。空或畸形限定符不请求目录接口。
- **错误只作辅助**：解析器异常可用于展示诊断或选择修复策略，但错误文本不是稳定的补全协议，也不保证枚举所有合法后继 token。不能仅靠「分析失败原因」覆盖所有不完整 SQL。

关键字尤其需要子句规则兜底：占位符是合法标识符，AST 可能把 `FR|` 解析成表达式/别名，无法据此直接推导 `FROM`。当前非 SELECT 语句明确降级为关键字建议；检测到 WITH、嵌套 SELECT 或集合运算时，会保守地禁用字段召回并输出诊断，保留关键字/函数候选。精确 CTE、嵌套查询、窗口表达式和方言扩展需要后续增加作用域与语法规则，demo 不宣称完整 SQL 语言服务能力。

## 统一搜索契约

五个方法均为 `(params, { signal? }) => Promise<SearchResult>`。`AbortSignal` 是前端调用选项，不序列化到 JSON。生产 HTTP 适配器可以实现相同的 `MetadataIndex`。

| 通用参数 | 类型 / 语义 |
| --- | --- |
| `requestId` | `string`，一次补全轮次的标识，响应原样返回；并行接口共享此值 |
| `connectionId` | `string`，连接/租户上下文；mock 仅接受 `demo-local` |
| `dialect` | `mysql` / `postgresql` / `generic` |
| `query` | 原文中光标左侧的输入前缀，如 `em`，允许空串 |
| `matchMode` | `prefix` / `contains`，均忽略大小写 |
| `limit` | `number`，mock 向下取整并限制为 `1..100` |
| `cursor` | 可选字符串，使用上一页的 `nextCursor`，不得自行构造 |

| 方法 / HTTP 端点 | 附加参数 | 返回内容 |
| --- | --- | --- |
| `searchDatabases` / `POST /api/completion/databases/search` | 无 | 可访问库 |
| `searchTables` / `POST /api/completion/tables/search` | `database?: string` | 指定库的表；省略时可跨库搜索 |
| `searchColumns` / `POST /api/completion/columns/search` | `tables: TableReference[]` | 仅指定表中的字段；空数组返回空结果 |
| `searchFunctions` / `POST /api/completion/functions/search` | `database?: string` | 当前方言可用函数与签名 |
| `searchKeywords` / `POST /api/completion/keywords/search` | `clause: SqlClause` | 当前子句的关键字 |

```ts
interface TableReference {
  database: string;
  table: string;
  alias?: string;
}

type SqlClause = 'start' | 'select' | 'from' | 'join' | 'where' | 'on'
  | 'group' | 'order' | 'having' | 'other';

interface SearchResult {
  requestId: string;
  items: IndexItem[];
  total: number;         // 过滤后、分页前的数量
  nextCursor?: string;  // 无后续页时省略
  elapsedMs: number;
}

interface IndexItem {
  id: string;
  kind: 'keyword' | 'database' | 'table' | 'column' | 'function';
  label: string;
  insertText: string;
  detail: string;
  database?: string;
  table?: string;
  dataType?: string;
  signature?: string;
  popularity: number;  // 排序信号，由前端决定权重
}
```

库和表作用域按完整名称精确匹配，不将模糊匹配用于作用域过滤。当前采用 `database.table` 两段式命名；PostgreSQL 的 catalog/schema/table 三层模型需要后续扩展契约，不能把 schema 默认为已支持。

### 字段搜索示例

`POST /api/completion/columns/search` 请求体：

```json
{
  "requestId": "completion-42",
  "connectionId": "demo-local",
  "dialect": "mysql",
  "query": "em",
  "matchMode": "prefix",
  "limit": 30,
  "tables": [{ "database": "demo", "table": "users", "alias": "u" }]
}
```

返回示意（耗时随请求变化）：

```json
{
  "requestId": "completion-42",
  "items": [{
    "id": "column:demo.users.email",
    "kind": "column",
    "label": "email",
    "insertText": "email",
    "detail": "demo.users · VARCHAR(255) · 电子邮箱",
    "database": "demo",
    "table": "users",
    "dataType": "VARCHAR(255)",
    "popularity": 90
  }],
  "total": 1,
  "elapsedMs": 68
}
```

## Mock 行为、排序与可观测性

mock 包含 `demo.users/orders/products`、`analytics.events/sessions/revenue_daily`、`warehouse.dim_customers/fact_orders`，并模拟 40–100 ms 延迟。MySQL 返回 `IFNULL`、`DATE_FORMAT`；PostgreSQL 返回 `DATE_TRUNC`、`STRING_AGG`；`generic` 返回共享函数。

索引只过滤、按名称稳定分页，不做相关度排序。前端根据精确/前缀匹配、语法角色、表/别名作用域和 `popularity` 合并排序；精确匹配优先于仅前缀匹配，分数相同时按名称和 ID 稳定排序。相同字段名在多个表出现时，生成 `u.status`、`o.status`；自连接保留每个别名的候选。已有 `u.` 限定符时只插入字段名，未知别名不扩展到其他表。

已有标识符引号时保留其定界符；缺少结束引号时，接受建议会补齐。标识符中的同类引号做双写转义，限定字段按每个路径部分分别引用。无引号输入遇到空格、特殊字符或常见保留字（如 `order`）时，按 MySQL 反引号或 PostgreSQL/Generic 双引号自动引用。当前使用保守的跨方言常见保留字字典，生产应接入对应数据库版本的完整关键字表。

接口的 `items` 不等于最终建议顺序。当前补全链路默认以 `limit: 30` 仅召回各接口第一页，可通过实例配置调整到 `100`，超大目录可能漏掉后续页中的高分项；生产可定义服务端召回排序再由前端重排。多个接口并行调用，单个接口失败不会丢弃其他接口的成功结果，错误通过公开结果 `SqlCompletionResult.errors` 展示。

每次调用立即执行 `console.info('[metadata-index]', endpoint, params)`，页面可通过 `createMockMetadataIndex(onLog)` 接收同样的参数快照与 `pending/success/error/cancelled` 状态。日志 ID 为 `requestId:endpoint`。提前取消的请求不发起、不记录；进行中的请求支持取消。引擎生成每个实例、每轮请求的标识并丢弃过期结果，页面不再自行生成 `requestId` 或管理请求的 `AbortController`。

mock 的 `cursor` 绑定接口、搜索条件和作用域；修改搜索条件后不能复用旧 cursor。无效连接、参数或 cursor 会 reject，真实服务建议映射为结构化 `400/401/403/429/503` 错误。

## 接入真实服务

当前没有内置 HTTP 适配器，可按以下方式实现同一契约，再传入 `createSqlCompletion({ index, connectionId, database })`：

```ts
import type {
  MetadataIndex, SearchOptions, SearchParams, SearchResult,
} from './src/completion/index';

async function post(
  resource: string,
  params: SearchParams,
  options?: SearchOptions,
): Promise<SearchResult> {
  const response = await fetch(`/api/completion/${resource}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: options?.signal,
  });
  if (!response.ok) throw new Error(`索引请求失败：${response.status}`);
  return response.json() as Promise<SearchResult>;
}

const index: MetadataIndex = {
  searchDatabases: (params, options) => post('databases', params, options),
  searchTables: (params, options) => post('tables', params, options),
  searchColumns: (params, options) => post('columns', params, options),
  searchFunctions: (params, options) => post('functions', params, options),
  searchKeywords: (params, options) => post('keywords', params, options),
};
```

路径相对于仓库根目录；`SearchParams` 接受各方法传入的扩展对象，因此 `database`、`tables`、`clause` 同样保留在 JSON 中。示例仅展示传输映射；生产适配器还应校验响应结构、响应 `requestId`、同一结果内 ID 唯一性，并按需要设置超时。`SearchOptions` 仅承载 `signal`，召回策略由引擎配置写入每次请求的 `limit` / `matchMode`。

由服务端做连接鉴权、库表字段权限过滤、方言过滤、限流、缓存及超时；前端传入的 `tables` 只表示请求范围，不能作为授权依据。游标应采用服务端签名的不透明 token，并随元数据版本失效。搜索可为规范化名称建立前缀索引，包含搜索按需要增加全文/三元组索引；所有查询使用参数绑定。生产日志应按权限脱敏，不照搬 demo 的完整控制台参数输出。
