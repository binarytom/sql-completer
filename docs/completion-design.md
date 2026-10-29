# SQL 补全设计与 API

sql-completer 的公开职责是接收 SQL 文档与光标，调用可替换的元数据索引，并返回可供编辑器展示和应用的补全结果。核心不依赖 DOM、mock 目录或 HTTP 实现。

[项目概览](../README.md) · [元数据扩展](metadata-index.md) · [打包与部署](packaging.md)

## 模块边界

| 入口 | 职责 |
| --- | --- |
| `sql-completer` | `createSqlCompletion`、`SqlCompletionError` 与公共类型；同时导出元数据类型 |
| `sql-completer/metadata` | 元数据扩展类型；使用 `import type`，无需加载解析器 |

库源码位于 `src/`。`src/index.ts` 选择导出补全 API，`src/metadata/index.ts` 选择导出搜索契约。`completion/types.ts` 定义补全契约，`metadata/types.ts` 定义索引契约，`shared/types.ts` 定义基础类型。内部请求、解析函数和排序函数不开放为包子路径。

外部项目为每个编辑器创建一个 `createSqlCompletion(config)` 实例，通过 `MetadataIndex` 注入自己的数据源。当前扩展点是这五类搜索方法；尚未提供解析器替换、排序策略注册或编辑器框架适配器。

## 运行链路与文件职责

```text
编辑器：触发、防抖、展示、读取当前文档、写回编辑结果
  ↓ sql-completer / src/index.ts
src/completion/engine.ts：初始化、校验、请求生命周期、结果有效性
  ├─ service.ts：上下文分析、选择索引、并行召回、评分、去重
  │    ├─ context.ts：分词、占位符 AST、有限修复、表作用域
  │    └─ MetadataIndex：由调用方注入
  └─ edits.ts：纯文本替换和插入后的光标定位
```

`examples/demo/main.ts` 提供一种编辑器接入，`examples/demo/mock-metadata.ts` 提供一种索引实现。二者均不进入库安装包。演示请求观察台与 `RequestLog` 属于演示层，核心不会默认打印元数据请求。

SQL 在模块所在运行环境内用于上下文分析。默认搜索参数只有搜索词、方言、连接标识与作用域，不包含整段 SQL；HTTP 传输由注入的适配器决定。解析器 WASM 由公开实例统一等待初始化，编辑器不需要直接调用解析器。

## 补全 API

```ts
import type {
  CompletionContext, CompletionItem, SqlDialect,
} from 'sql-completer';
import type { MetadataIndex } from 'sql-completer/metadata';

// 以下接口摘录用于解释调用方式；业务代码直接使用包导出的类型。
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

| 配置 | 约束与默认值 |
| --- | --- |
| `index` | 必填，五个搜索方法必须全部存在；暂不支持的类别可以返回空结果 |
| `connectionId` | 必填非空字符串；连接变化时创建新实例 |
| `database` | 必填非空字符串；单次请求可覆盖 |
| `dialect` | `mysql`（默认）、`postgresql`、`generic`；单次请求可覆盖 |
| `limit` | 每类搜索的召回窗口，`1..100` 整数，默认 `30` |
| `matchMode` | `prefix`（默认）或 `contains` |

`complete()` 返回的 `context` 包括 `clause`、`prefix`、`qualifier`、`kinds`、`tables`、`replaceRange`、`statementRange`、`parserStatus` 及可选诊断。每个候选继承元数据项，并增加 `score` 与 `reason`。`errors` 表示部分索引失败或响应标识不匹配；注释和字符串内返回空候选，不请求元数据。

### 初始化与请求生命周期

`connectionId` 和默认 `database` 必须非空；单次 `complete` 可覆盖当前库和方言。`ready()` 是可选预热，`complete()` 本身会等待解析器；初始化 Promise 在当前运行环境中全局复用，失败后应重新加载页面，当前未提供初始化重试接口。

一个实例绑定一个编辑器。开始有效的新请求时，旧请求被取消、旧结果立即失效；新请求失败也不会恢复旧结果。外部取消、`cancel()`、新请求和 `dispose()` 会令进行中的调用以 `AbortError` 拒绝，即使注入的索引忽略 `signal` 也能及时结束公开调用。底层索引仍应传递取消信号，释放网络和计算资源。

`apply()` 校验返回对象属于本实例的最新结果、当前 SQL 和光标完全一致、候选 ID 合法，然后使用私有快照里的原始候选和替换范围生成变更。修改展示用 `items` 或 `context` 不会改变实际插入行为。范围使用 `[start, end)`，所有偏移均为 UTF-16；接口只处理单光标，非空选区由编辑器抑制补全。UI 在文档、光标、当前库或方言变化时立即调用 `cancel()`，然后安排新请求；接受候选时传入真实当前文档，不能用旧快照冒充当前文档。

接受成功后结果失效；`cancel()` 后仍可继续补全，`dispose()` 则永久销毁实例。完整运行示例见 [README](../README.md#安装与接入)。

### 错误处理

| 情况 | 结果与处理 |
| --- | --- |
| 取消、外部信号中止或被新请求替代 | Promise 以 `AbortError` 拒绝，通常无需显示错误 |
| `DISPOSED` | 实例已销毁，创建新实例 |
| `STALE_RESULT` | 结果来自其他实例、已取消、已接受或已被取代；重新请求 |
| `DOCUMENT_CHANGED` | 当前 SQL 或光标与生成结果时不同；重新请求 |
| `UNKNOWN_ITEM` | 候选 ID 不属于该结果；使用返回候选的 ID |
| 配置或输入非法 | `TypeError` / `RangeError`；校验输入与配置 |
| 解析器初始化失败 | `ready()` / `complete()` 拒绝；检查 JS/WASM 资源与运行环境 |

实例状态错误使用公开的 `SqlCompletionError`，可通过 `instanceof` 与 `error.code` 判断。元数据方法抛出的普通错误通常被收集到 `result.errors`，其他成功索引仍可返回候选。核心会忽略 `requestId` 与本轮请求不一致的响应，但不会替代适配器对任意响应结构的校验。

### 编辑器接入约定

1. 文本、光标、库或方言变化时立即 `cancel()`，清理旧候选，再按 UI 的防抖策略请求。
2. 只处理单光标；输入法组合输入、非空选区期间由 UI 暂停补全。
3. 显示 `complete()` 返回的候选；用户接受时重新读取真实当前文档，再调用 `apply()`。
4. 将 `AppliedCompletion.sql` 和 `cursor` 写回编辑器，或按 `edit` 调用编辑器自身的编辑 API。
5. 编辑器卸载时 `dispose()`。不同编辑器使用不同实例，请求互不取消。

## 上下文分析与恢复

上下文分析保留两份数据：**解析副本里的占位符**与**原文里的搜索前缀**。占位符只帮助识别语法角色，不能成为接口的 `query`，也不应即时写回编辑器。

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

关键字尤其需要子句规则兜底：占位符是合法标识符，AST 可能把 `FR|` 解析成表达式/别名，无法据此直接推导 `FROM`。当前非 SELECT 语句明确降级为关键字建议；检测到 WITH、嵌套 SELECT 或集合运算时，会保守地禁用字段召回并输出诊断，保留关键字/函数候选。精确 CTE、嵌套查询、窗口表达式和方言扩展需要后续增加作用域与语法规则，当前模块尚未实现完整 SQL 语言服务能力。

## 候选召回与排序

演示索引只过滤、按名称稳定分页，不做相关度排序。生产索引可按自己的召回策略返回候选。前端根据精确/前缀匹配、语法角色、表/别名作用域和 `popularity` 合并排序；精确匹配优先于仅前缀匹配，分数相同时按名称和 ID 稳定排序。相同字段名在多个表出现时，生成 `u.status`、`o.status`；自连接保留每个别名的候选。已有 `u.` 限定符时只插入字段名，未知别名不扩展到其他表。

已有标识符引号时保留其定界符；缺少结束引号时，接受建议会补齐。标识符中的同类引号做双写转义，限定字段按每个路径部分分别引用。无引号输入遇到空格、特殊字符或常见保留字（如 `order`）时，按 MySQL 反引号或 PostgreSQL/Generic 双引号自动引用。当前使用保守的跨方言常见保留字字典，生产应接入对应数据库版本的完整关键字表。

接口的 `items` 不等于最终建议顺序。当前补全链路默认以 `limit: 30` 仅召回各接口第一页，可通过实例配置调整到 `100`，超大目录可能漏掉后续页中的高分项；生产可定义服务端召回排序再由前端重排。多个接口并行调用，单个接口失败不会丢弃其他接口的成功结果，错误通过公开结果 `SqlCompletionResult.errors` 展示。

## 元数据扩展

元数据接口支持库、表、字段、函数和关键字五类异步搜索。接口本身与 HTTP 解耦，可单独用于目录检索；引擎按语法位置选择要调用的方法。完整参数、响应和 mock 说明见[元数据扩展](metadata-index.md)。

## 接入真实服务

实现并注入 `MetadataIndex` 即可替换数据源，补全引擎和编辑器调用方式保持一致。HTTP 适配代码与约定端点见[HTTP 适配示例](metadata-index.md#http-适配示例)。仓库不包含 HTTP 服务。

## 构建与部署

库输出到 `dist/`，生产演示输出到 `dist-demo/`。解析器 JS 与一个共享 WASM 文件随库分发，外部项目通过公开入口导入。命令顺序、包内容、资源路径和验证方式见[打包与部署](packaging.md)。

## 当前实现边界

当前以 SELECT、当前语句作用域和 `database.table` 命名模型为主。CTE、嵌套查询、集合运算的字段召回保守禁用；PostgreSQL 的三层目录、完整保留字表和精确嵌套作用域尚待扩展。函数插入后的光标定位由纯编辑函数处理，当前不提供 snippet 占位符或多光标协议。

新增能力时保持恢复编辑只作用于解析副本，保持外部索引与 DOM 在引擎之外；公开契约变化应同步更新 README、元数据文档和安装包消费验证。
