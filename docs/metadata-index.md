# 元数据搜索扩展

元数据扩展通过 `MetadataIndex` 注入 sql-completer。扩展负责搜索和返回候选，核心负责 SQL 上下文、请求生命周期、候选排序与编辑生成。索引可以访问 HTTP 服务、本地数据、缓存或其他目录系统。

[项目概览](../README.md) · [补全设计与 API](completion-design.md) · [打包与部署](packaging.md)

## 导入与实现边界

```ts
import type {
  ColumnSearchParams, DatabaseSearchParams, FunctionSearchParams, IndexItem,
  KeywordSearchParams, MetadataIndex, SearchOptions, SearchParams, SearchResult,
  SqlClause, SqlDialect, TableReference, TableSearchParams,
} from 'sql-completer/metadata';
```

该子入口仅提供类型，`import type` 不会引入解析器运行时代码。主入口同时导出这些类型，元数据适配器优先从 `/metadata` 导入，以明确依赖边界。

`MetadataIndex` 必须实现 `searchDatabases`、`searchTables`、`searchColumns`、`searchFunctions`、`searchKeywords` 五个方法。即使某类数据暂不可用，也应提供该方法并返回带有原始 `requestId` 的空结果。引擎在创建实例时校验方法是否存在。

类型接口不会自动生成搜索实现、默认目录或 HTTP 客户端。索引方法可以直接被目录页面调用，无需先创建补全实例；此时由调用方提供请求 ID、作用域和分页参数。

下列 HTTP 路径是推荐映射，调用方可自行调整。仓库内只有浏览器 mock，不包含 HTTP 服务或数据库连接器。

## 搜索契约

五个方法均为 `(params, { signal? }) => Promise<SearchResult>`。`AbortSignal` 是调用选项，不序列化到 JSON。生产 HTTP 适配器可以实现相同的 `MetadataIndex`。

| 通用参数 | 类型 / 语义 |
| --- | --- |
| `requestId` | `string`，一次补全轮次的标识，响应原样返回；并行接口共享此值 |
| `connectionId` | `string`，连接/租户上下文；mock 仅接受 `demo-local` |
| `dialect` | `mysql` / `postgresql` / `generic` |
| `query` | 搜索词，允许空串；引擎调用时为光标左侧输入前缀，如 `em` |
| `matchMode` | `prefix` / `contains`；mock 均忽略大小写，适配器应约定一致的匹配语义 |
| `limit` | `number`；引擎发送 `1..100` 整数，mock 独立调用时向下取整并限制范围 |
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

## 演示 mock

mock 包含 `demo.users/orders/products`、`analytics.events/sessions/revenue_daily`、`warehouse.dim_customers/fact_orders`，并模拟 40–100 ms 延迟。MySQL 返回 `IFNULL`、`DATE_FORMAT`；PostgreSQL 返回 `DATE_TRUNC`、`STRING_AGG`；`generic` 返回共享函数。

mock 位于 `examples/demo/mock-metadata.ts`，通过 `createMockMetadataIndex(onLog?)` 创建。该函数和目录数据仅供仓库演示，不从 npm 包导出。`MOCK_DATABASES` 包含 `demo`、`analytics`、`warehouse`，连接标识固定为 `demo-local`；库本身没有这一连接限制。

mock 对库表范围精确过滤，对搜索词执行不区分大小写的前缀或包含匹配，再按名称与 ID 稳定分页。字段查询按物理表去重，空 `tables` 返回空结果；函数按方言过滤，关键字按子句选择。

每次真正发起的 mock 请求会打印 `console.info('[metadata-index]', endpoint, params)`。`onLog` 接收完整参数快照与 `pending / success / error / cancelled` 状态，日志 ID 为 `requestId:endpoint`。提前取消的请求不发起、不记录。`RequestLog` 定义在 `examples/demo/types.ts`，不属于公开契约；生产适配器应自行选择日志方式。

## 响应与作用域要求

- 响应原样返回 `requestId`。同一补全轮次的并行索引共享该 ID；核心忽略不匹配的响应。
- `items` 的 `kind` 应与调用的方法一致。字段项必须包含实际 `database`、`table`，否则无法匹配当前表作用域。
- 候选 ID 应稳定，并在同一轮所有类别中保持唯一。推荐使用 `column:demo.users.email` 等包含类别和完整作用域的名称。
- 库表与字段的 `insertText` 返回原始名称；字段项无需为每个表别名复制，限定符和必要的引号由核心生成。函数可返回 `COUNT()`，签名单独放在 `signature`。
- `popularity` 是排序信号，建议为 `0..100`；核心对有限数值做范围限制，对非有限值按零处理。
- 单个方法可 reject，核心将错误收集到 `SqlCompletionResult.errors`，其他成功方法仍可提供候选。返回结构的完整校验由适配器负责。

## 分页与取消

分页 `cursor` 是不透明字符串，与 SQL 文档的数字光标偏移不同。`total` 表示当前过滤条件下分页前的总数量；无后续页时省略 `nextCursor`。使用上一页返回的 `nextCursor` 获取下一页，不自行构造游标。

mock 的游标绑定接口、匹配条件和作用域，不绑定请求 ID 或每页数量。修改查询或作用域后不可复用旧游标。生产服务可将游标与目录版本绑定，并使用服务端生成的不透明 token。

**补全引擎当前只调用每类索引的第一页**，不会自动追踪 `nextCursor`。`limit` 是每个方法的召回窗口，不是所有类别合并后的最终候选数量。独立目录搜索可由调用方继续分页；大目录应在索引侧安排合适的召回顺序。

`options?.signal` 应传入网络或计算操作。取消时以 `AbortError` 拒绝，不转换成普通成功结果。核心即使遇到忽略信号的适配器，也会及时结束被取消的公开调用，但这不会停止适配器内部仍在运行的请求。

## HTTP 适配示例

下列实现可保存为消费项目的 `metadata-index.ts`。它映射五类请求并传递取消信号；服务地址由接入方指定。

```ts
import type {
  MetadataIndex, SearchOptions, SearchParams, SearchResult,
} from 'sql-completer/metadata';

export function createHttpMetadataIndex(baseUrl = '/api/completion'): MetadataIndex {
  const base = baseUrl.replace(/\/$/, '');
  async function post(
    resource: string,
    params: SearchParams,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    const response = await fetch(`${base}/${resource}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: options?.signal,
    });
    if (!response.ok) throw new Error(`索引请求失败：${response.status}`);
    return response.json() as Promise<SearchResult>;
  }

  return {
    searchDatabases: (params, options) => post('databases', params, options),
    searchTables: (params, options) => post('tables', params, options),
    searchColumns: (params, options) => post('columns', params, options),
    searchFunctions: (params, options) => post('functions', params, options),
    searchKeywords: (params, options) => post('keywords', params, options),
  };
}
```

`SearchParams` 允许方法收到的扩展对象按其原始内容传递，因此 `database`、`tables`、`clause` 同样保留在 JSON 中。`AbortSignal` 只作为调用选项，不序列化；`limit` 和 `matchMode` 则是请求体参数。

注入补全实例：

```ts
import { createSqlCompletion } from 'sql-completer';
import { createHttpMetadataIndex } from './metadata-index.js';

const completion = createSqlCompletion({
  index: createHttpMetadataIndex('/api/completion'),
  connectionId: 'my-connection',
  database: 'demo',
});

// 编辑器卸载时销毁；实际请求、展示与接受流程见补全 API 文档。
completion.dispose();
```

示例中的类型断言不验证响应内容。正式适配器还应校验响应结构、请求 ID 和候选 ID 唯一性，并按需要提供鉴权、超时和错误映射。连接授权、目录权限过滤和方言过滤由服务端执行；客户端传入的 `tables` 仅表示查询范围。生产日志应根据业务权限处理，不直接照搬演示的完整参数输出。
