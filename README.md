# SQL Studio

一个基于 TypeScript、Vite 和 `@guanmingchiu/sqlparser-ts` 的浏览器 SQL 补全演示：解析光标上下文，调用元数据索引，再由前端排序和插入候选。

## 功能

- 补全关键字、库、表、字段和函数，支持表别名、限定名、JOIN 与同名字段消歧。
- 对不完整 SQL 使用占位符解析、有限修复和词法降级；注释、字符串内抑制补全。
- 提供 MySQL、PostgreSQL、Generic 方言选项，以及字段、库表、JOIN、函数等示例。
- 展示 AST、搜索前缀、替换范围、表作用域和各索引请求参数。
- 支持异步搜索取消、过期结果丢弃、候选去重和前端评分。

## 本地运行

需要 **Node.js 24 或以上**和 npm。测试使用 Node 内置测试运行器与 TypeScript 加载钩子。

```sh
npm ci
npm run dev
```

打开终端打印的本地地址。输入 SQL 自动触发补全；点击左侧目录中的表可载入字段补全示例，工具栏可切换方言和当前库。

| 操作 | 快捷键 |
| --- | --- |
| 手动触发补全 | `Ctrl + Space` / `⌘ + Space` |
| 选择候选 | `↑` / `↓` |
| 插入选中候选 | `Tab` / `Enter`（候选弹窗打开时） |
| 关闭补全并取消当前请求 | `Esc` |
| 插入两个空格 | `Tab`（候选弹窗关闭时） |

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖 |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm test` | 运行上下文分析、排序和元数据契约测试，使用真实 WASM 解析器 |
| `npm run build` | 执行 TypeScript 检查并构建到 `dist/` |
| `npm run preview` | 启动生产产物预览；先运行构建 |

提交前运行 `npm test` 和 `npm run build`。修改解析器加载逻辑时，也应在生产预览中检查 WASM 初始化。

## 补全模块接入

编辑器统一从 `src/completion/index.ts` 导入 `createSqlCompletion` 和公共类型。每个编辑器创建一个实例，实例负责解析初始化、索引召回、排序、请求取消、结果有效性和安全替换；UI 只负责触发、展示和把编辑结果写回。`context.ts`、`service.ts` 和 `edits.ts` 是内部实现，不需要由业务页面分别调用。

```ts
import { createSqlCompletion } from './src/completion/index';
import { createMockMetadataIndex } from './src/metadata';

const completion = createSqlCompletion({
  index: createMockMetadataIndex((entry) => console.log(entry)),
  connectionId: 'demo-local',
  database: 'demo',
  dialect: 'mysql',
});

async function example() {
  // 可选预热；complete() 也会等待解析器初始化。
  await completion.ready();
  const document = {
    sql: 'SELECT u.em FROM demo.users u',
    cursor: 'SELECT u.em'.length,
  };
  const result = await completion.complete(document);
  const item = result.items.find((candidate) =>
    candidate.kind === 'column' && candidate.label === 'email');
  if (item) {
    const next = completion.apply({ document, result, itemId: item.id });
    console.log(next.sql, next.cursor, next.edit);
    // SELECT u.email FROM demo.users u
    // UI 将 next.sql 和 next.cursor 写回编辑器。
  }
}

example().catch(console.error).finally(() => completion.dispose());
```

示例路径相对于仓库根目录；当前模块随此 Vite 项目使用，尚未发布为独立 npm 包。集成到其他构建系统时需保留 `vite.config.ts` 中解析器 JS/WASM 的加载适配。

### 配置与调用契约

| `createSqlCompletion(config)` 参数 | 说明 |
| --- | --- |
| `index` | 必填，注入实现五类搜索的 `MetadataIndex`；模块不依赖 mock、HTTP 或 DOM |
| `connectionId` | 必填，连接标识；当前 mock 仅接受 `demo-local` |
| `database` | 必填，默认当前库，不能为空 |
| `dialect` | `mysql`（默认）/ `postgresql` / `generic` |
| `limit` | 每个索引的召回数量，`1..100` 的整数，默认 `30` |
| `matchMode` | `prefix`（默认）/ `contains` |

| 方法 | 输入与返回 |
| --- | --- |
| `ready()` | `Promise<void>`；可选预热解析器，重复调用共用初始化过程 |
| `complete(input, options?)` | `input: { sql, cursor, database?, dialect? }`；`options: { signal? }`；返回 `Promise<SqlCompletionResult>` |
| `apply(input)` | `{ document: { sql, cursor }, result, itemId }`；同步返回 `{ sql, cursor, edit: { range, text } }` |
| `cancel()` | 取消当前请求，使已有结果失效，实例可继续使用 |
| `dispose()` | 取消请求并永久销毁实例；编辑器卸载时调用，可重复调用 |

`SqlCompletionResult` 包含 `requestId`、已排序的 `items`、`context`、`elapsedMs`、`errors`。每个候选有 `id`、`label`、`insertText`、`kind`、`score` 和 `reason`；`context` 提供 `prefix`、`qualifier`、`tables`、`replaceRange`、`parserStatus` 等诊断信息。索引部分失败仍返回可用候选和 `errors`，可结合 UI 提示降级状态。

`cursor`、`range.start/end` 均为 **UTF-16 偏移**，范围是 `[start, end)`，可直接与 `textarea.selectionStart` 对接。接口只接受单光标位置；UI 在非空选区时应抑制补全。`apply()` 应传入编辑器此刻的真实 SQL 和光标，以及 `complete()` 返回的同一个 `result` 对象；接受一次后结果失效。模块内部保留原始候选和替换范围的快照，展示层重新排序或修改结果不会改变实际插入文本。

每次有效的 `complete()` 会取代上次请求并使旧结果失效；主动取消、外部 `AbortSignal`、新请求或销毁都会让进行中的调用以 `AbortError` 拒绝。即使索引适配器忽略取消，旧调用也会立即结束；适配器仍应遵守 `signal` 以释放网络资源。SQL、光标、库或方言变化时，UI 应立即 `cancel()` 并安排新请求，展示层自行选择防抖间隔。普通取消无需显示错误。

`apply()` 的状态错误为 `SqlCompletionError`，可读取 `code`：

| `code` | 处理方式 |
| --- | --- |
| `DISPOSED` | 实例已销毁，重新创建实例 |
| `STALE_RESULT` | 结果被替代、已接受、取消或来自其他实例，重新补全 |
| `DOCUMENT_CHANGED` | SQL 或光标与生成结果时不同，重新补全 |
| `UNKNOWN_ITEM` | `itemId` 不属于该结果，使用返回候选的 ID |

销毁后调用 `ready()` / `complete()` 同样会拒绝 `DISPOSED`。非法配置抛出 `TypeError` / `RangeError`，非法光标偏移抛出 `RangeError`。初始化失败会拒绝 `ready()` / `complete()`；当前解析器全局复用初始化 Promise，刷新页面重新加载，不能依赖重建实例自动重试。

## 实现链路

```text
SQL + 光标 → 原始前缀与替换范围 → 占位符副本解析
           → 有限修复 / 词法降级 → 并行索引搜索
           → 前端评分与去重 → 确认候选后替换原文
```

以 `SELECT u.em|ail FROM demo.users u` 为例，`|` 表示光标：

1. 从原文保存 `prefix: 'em'`、`qualifier: 'u'`，替换范围覆盖完整的 `email` token。
2. 解析副本使用 `SELECT u.__suggestion__ FROM demo.users u`，定位字段角色和 `u → demo.users` 作用域。
3. 字段索引收到 `query: 'em'` 和 `tables: [{ database: 'demo', table: 'users', alias: 'u' }]`。
4. 选择 `email` 后替换完整 token，保留 `u.`，避免插入成 `emailail`。

恢复操作只修改解析副本。解析异常用于诊断和修复选择，失败后仍可按 token 上下文给出建议。

## 元数据索引接口

`MetadataIndex` 的五个异步方法共享 `(params, { signal? }) => Promise<SearchResult>` 契约。下列 HTTP 路径是接入后端时的约定，**当前实现为浏览器内 mock，没有 HTTP 服务或真实数据库连接**。

| 方法 | 约定端点（均为 `POST`） | 作用域参数 |
| --- | --- | --- |
| `searchDatabases` | `/api/completion/databases/search` | 无附加参数，搜索库 |
| `searchTables` | `/api/completion/tables/search` | `database?`；省略时可跨库搜索 |
| `searchColumns` | `/api/completion/columns/search` | `tables`；仅搜索指定表，空数组返回空结果 |
| `searchFunctions` | `/api/completion/functions/search` | `database?`；按 `dialect` 过滤函数 |
| `searchKeywords` | `/api/completion/keywords/search` | `clause`；按当前 SQL 子句检索 |

通用参数为 `requestId`、`connectionId`、`dialect`、`query`、`matchMode`、`limit`、可选分页 `cursor`。这里的分页 `cursor` 是不透明字符串，与编辑器的数字光标偏移不同。响应包含 `items`、`total`、可选 `nextCursor`、`elapsedMs`，并原样返回 `requestId`。接口接收前缀和作用域，无须接收整段 SQL；`AbortSignal` 只作为调用选项。

mock 支持忽略大小写的前缀/包含搜索、稳定分页和取消。索引先按名称分页，前端再按匹配程度、语法角色、当前库、字段作用域和热度评分。

接入后端时实现并注入 `MetadataIndex`，五个方法分别转发到上表端点，使用 `JSON.stringify(params)` 作为请求体，并把 `options?.signal` 传给 `fetch`。`SearchOptions` 只包含传输取消选项，`limit`、`matchMode` 由实例配置进入请求参数。完整参数类型、字段响应示例及 HTTP 适配代码见 [方案与接口设计](docs/completion-design.md#接入真实服务)。

每次发起搜索都会通过 `console.info('[metadata-index]', endpoint, params)` 打印完整参数。页面下方请求观察台可查看参数快照、耗时和 `pending / success / error / cancelled` 状态；预先取消的请求不会发起或记录。

### Mock 目录与方言

| 库 | 表 |
| --- | --- |
| `demo` | `users`、`orders`、`products` |
| `analytics` | `events`、`sessions`、`revenue_daily` |
| `warehouse` | `dim_customers`、`fact_orders` |

连接标识固定为 `demo-local`，模拟 40–100 ms 延迟。共享函数包括 `COUNT`、`SUM`、`COALESCE` 等；MySQL 另有 `IFNULL`、`DATE_FORMAT`，PostgreSQL 另有 `DATE_TRUNC`、`STRING_AGG`；Generic 仅提供共享函数。

## 项目结构

```text
src/
  main.ts                 编辑器、候选交互、目录和请求观察台
  style.css               页面样式
  metadata.ts             五类 mock 索引、分页与参数日志
  completion/
    index.ts              公开入口：工厂、错误类型与公共契约
    engine.ts             实例生命周期、并发取消与结果有效性
    types.ts              编辑器接口、上下文与索引契约
    context.ts            光标分析、占位符解析、恢复与作用域
    service.ts            并行召回、评分、去重与插入文本生成
    edits.ts              纯文本编辑和插入后的光标定位
tests/*.test.mjs           Node 测试
scripts/test-loader.mjs    测试用 TypeScript 加载钩子
vite.config.ts            构建配置与解析器 JS/WASM 加载适配
docs/completion-design.md 完整方案与接口设计
```

分层以职责和变化原因划分：页面处理交互，`engine` 统一编排，`context` 处理 SQL 语义，`service` 处理候选策略，`edits` 处理文档变更，索引适配器处理数据来源。原有解析、召回和 mock 分层保留；此前散在页面里的初始化、轮次取消和替换逻辑已收回公共入口，接入其他编辑器无需复制这些逻辑。

## 当前边界与扩展

- 以 SELECT 查询为主；其他语句降级为关键字建议。检测到 CTE、嵌套 SELECT 或集合运算时禁用字段召回，避免跨作用域推荐。
- 目录采用 `database.table` 两段式模型；尚未实现 PostgreSQL 的 catalog/schema/table 三层作用域。
- 补全链路目前只请求每个接口的第一页，默认 `limit: 30`（可配置到 `100`）；大目录中后续页的高分候选可能漏召回。
- 接入真实服务时实现同一 `MetadataIndex`，并在服务端完成连接鉴权、目录权限过滤和日志脱敏。

详细契约、恢复规则及接入建议见 [方案与接口设计](docs/completion-design.md)；开发约定见 [Repository Guidelines](AGENTS.md)。
