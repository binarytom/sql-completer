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

通用参数为 `requestId`、`connectionId`、`dialect`、`query`、`matchMode`、`limit`、可选 `cursor`。响应包含 `items`、`total`、可选 `nextCursor`、`elapsedMs`，并原样返回 `requestId`。接口接收前缀和作用域，无须接收整段 SQL；`AbortSignal` 只作为调用选项。

mock 支持忽略大小写的前缀/包含搜索、稳定分页和取消。索引先按名称分页，前端再按匹配程度、语法角色、当前库、字段作用域和热度评分。

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
    types.ts              上下文、请求与索引契约
    context.ts            光标分析、占位符解析、恢复与作用域
    service.ts            并行召回、评分、去重与插入文本生成
tests/*.test.mjs           Node 测试
scripts/test-loader.mjs    测试用 TypeScript 加载钩子
vite.config.ts            构建配置与解析器 JS/WASM 加载适配
docs/completion-design.md 完整方案与接口设计
```

## 当前边界与扩展

- 以 SELECT 查询为主；其他语句降级为关键字建议。检测到 CTE、嵌套 SELECT 或集合运算时禁用字段召回，避免跨作用域推荐。
- 目录采用 `database.table` 两段式模型；尚未实现 PostgreSQL 的 catalog/schema/table 三层作用域。
- 补全链路目前只请求每个接口的第一页，`limit: 30`；大目录中后续页的高分候选可能漏召回。
- 接入真实服务时实现同一 `MetadataIndex`，并在服务端完成连接鉴权、目录权限过滤和日志脱敏。

详细契约、恢复规则及接入建议见 [方案与接口设计](docs/completion-design.md)；开发约定见 [Repository Guidelines](AGENTS.md)。
