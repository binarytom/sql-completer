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

`src/completion/types.ts` 定义共享契约，`context.ts` 分析光标，`service.ts` 编排搜索与排序；`src/metadata.ts` 实现 mock 索引。解析器的 WebAssembly 模块须初始化后再使用。SQL 只用于前端上下文分析，搜索接口接收搜索词和已解析的作用域，无须上传整段 SQL。

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

接口的 `items` 不等于最终建议顺序。当前补全链路以 `limit: 30` 仅召回各接口第一页，超大目录可能漏掉后续页中的高分项；生产可扩大候选窗口，或定义服务端召回排序再由前端重排。多个接口并行调用，单个接口失败不会丢弃其他接口的成功结果，错误通过 `CompletionResult.errors` 展示。

每次调用立即执行 `console.info('[metadata-index]', endpoint, params)`，页面可通过 `createMockMetadataIndex(onLog)` 接收同样的参数快照与 `pending/success/error/cancelled` 状态。日志 ID 为 `requestId:endpoint`。提前取消的请求不发起、不记录；进行中的请求支持取消。新输入还须使用轮次标识丢弃过期结果，避免旧建议覆盖新建议。

mock 的 `cursor` 绑定接口、搜索条件和作用域；修改搜索条件后不能复用旧 cursor。无效连接、参数或 cursor 会 reject，真实服务建议映射为结构化 `400/401/403/429/503` 错误。

## 接入真实服务

由服务端做连接鉴权、库表字段权限过滤、方言过滤、限流、缓存及超时；前端传入的 `tables` 只表示请求范围，不能作为授权依据。游标应采用服务端签名的不透明 token，并随元数据版本失效。搜索可为规范化名称建立前缀索引，包含搜索按需要增加全文/三元组索引；所有查询使用参数绑定。生产日志应按权限脱敏，不照搬 demo 的完整控制台参数输出。
