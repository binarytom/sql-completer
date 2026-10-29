# sql-completer

sql-completer 是一个可被外部项目引用的 TypeScript SQL 补全模块。项目使用 **sqlparser-ts**（npm 包名 `@guanmingchiu/sqlparser-ts`）及其 WebAssembly 解析器解析 SQL，提取光标位置的语法上下文。模块接收 SQL 与光标位置，通过注入的元数据索引搜索候选，返回排序后的建议和可应用的文档编辑。

当前提供 ESM、TypeScript 类型声明及解析器 WASM，主要面向浏览器编辑器。仓库内的浏览器演示应用独立消费该模块。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [补全设计与 API](docs/completion-design.md) | 分层、配置、实例方法、取消、结果有效性和补全规则 |
| [元数据扩展](docs/metadata-index.md) | 五类搜索契约、HTTP 适配、分页、取消和 mock 行为 |
| [打包与部署](docs/packaging.md) | 公共入口、产物、WASM、安装包验证与发布边界 |
| [开发约定](AGENTS.md) | 文件职责、编码、测试和提交要求 |

## 能力与公共入口

模块支持关键字、库、表、字段和函数补全，以及表别名、限定名、JOIN 和同名字段消歧。不完整 SQL 使用解析副本修复和词法降级；注释、字符串内抑制补全。实例负责请求取消、过期结果处理和文档编辑校验。

| 入口 | 导出 |
| --- | --- |
| `sql-completer` | `createSqlCompletion`、`SqlCompletionError` 和公共类型 |
| `sql-completer/metadata` | `MetadataIndex`、五类搜索参数、结果、取消选项和基础类型；仅类型 |

每个编辑器创建一个补全实例。外部项目实现 `MetadataIndex` 后注入，可对接 HTTP、本地目录或缓存；五个搜索方法也可以独立调用。HTTP 服务、编辑器 UI 和 mock 均由接入方提供。

## 安装与接入

当前包名为 `sql-completer`，版本为 `0.1.0`，保持 `private: true`，尚未发布到 npm registry。开发和验证仓库需要 **Node.js 24 或以上**及 npm；该版本要求不代表浏览器需要 Node.js。

在本仓库生成安装包：

```sh
npm ci
npm pack
```

在外部项目安装生成的文件：

```sh
npm install /path/to/sql-completer-0.1.0.tgz
```

以下是可独立接入的最小本地索引示例。它仅提供 `demo.users` 表候选，其余四类搜索返回空结果；完整目录实现可参考[元数据扩展](docs/metadata-index.md)。

```ts
import { createSqlCompletion } from 'sql-completer';
import type {
  IndexItem, MetadataIndex, SearchParams, SearchResult,
} from 'sql-completer/metadata';

async function emptySearch(params: SearchParams): Promise<SearchResult> {
  return { requestId: params.requestId, items: [], total: 0, elapsedMs: 0 };
}

const users: IndexItem = {
  id: 'table:demo.users', kind: 'table', label: 'users', insertText: 'users',
  detail: 'demo.users', database: 'demo', table: 'users', popularity: 100,
};

const index: MetadataIndex = {
  searchDatabases: emptySearch,
  searchColumns: emptySearch,
  searchFunctions: emptySearch,
  searchKeywords: emptySearch,
  async searchTables(params, options) {
    options?.signal?.throwIfAborted();
    const query = params.query.toLocaleLowerCase();
    const matches = params.matchMode === 'contains'
      ? users.label.includes(query) : users.label.startsWith(query);
    const items = matches && (!params.database || params.database === 'demo')
      ? [users] : [];
    return { requestId: params.requestId, items, total: items.length, elapsedMs: 0 };
  },
};

const completion = createSqlCompletion({
  index, connectionId: 'my-connection', database: 'demo', dialect: 'mysql',
});

async function example() {
  await completion.ready(); // 可选预热；complete() 也会等待初始化。
  const document = { sql: 'SELECT * FROM us', cursor: 'SELECT * FROM us'.length };
  const result = await completion.complete(document);
  const item = result.items.find((candidate) => candidate.id === users.id);
  if (item) {
    const next = completion.apply({ document, result, itemId: item.id });
    console.log(next.sql); // SELECT * FROM users
    // 编辑器将 next.sql 和 next.cursor 写回当前文档。
  }
}

example().catch(console.error).finally(() => completion.dispose());
```

`cursor` 和编辑范围均使用 UTF-16 偏移，范围为 `[start, end)`。`apply()` 要求传入编辑器此刻的真实 SQL、光标和原始结果对象；文档或光标变化后应取消旧结果并重新补全。配置、方法和错误处理见[补全设计与 API](docs/completion-design.md#补全-api)。

## 运行演示

```sh
npm ci
npm run dev
```

打开终端打印的地址。演示提供方言和当前库切换、SQL 示例、候选列表、AST、作用域与请求参数观察台。数据来自浏览器内 mock，无须后端；`demo-local` 是该 mock 的连接限制，外部索引可使用自己的连接标识。

| 操作 | 快捷键 |
| --- | --- |
| 手动触发补全 | `Ctrl + Space` / `⌘ + Space` |
| 选择候选 | `↑` / `↓` |
| 插入选中候选 | `Tab` / `Enter`（候选弹窗打开时） |
| 关闭补全并取消当前请求 | `Esc` |
| 插入两个空格 | `Tab`（候选弹窗关闭时） |

## 开发与验证

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按锁文件安装开发依赖 |
| `npm run dev` | 从库源码启动演示开发服务器 |
| `npm test` | 运行行为测试，使用真实 WASM 解析器 |
| `npm run build:lib` | 构建库 JS、WASM 和类型声明至 `dist/` |
| `npm run build:demo` | 检查库与演示类型，使用已构建的库生成 `dist-demo/`；先构建库 |
| `npm run build` | 顺序构建库与演示 |
| `npm run test:package` | 构建库，在临时项目安装真实 tarball，验证类型、入口和 WASM |
| `npm pack` | 通过 `prepack` 构建库并生成 `.tgz` |
| `npm run preview` | 预览 `dist-demo/`；先运行 `npm run build` |

提交前运行 `npm test` 和 `npm run build`。调整公共导出、声明或打包逻辑后，再运行 `npm run test:package`；调整解析器或 WASM 加载时，在生产预览中验证初始化和键盘插入。

## 项目结构

```text
src/
  index.ts                 补全公共入口
  completion/
    engine.ts              初始化、取消、结果与文档校验
    context.ts             光标上下文、解析恢复与作用域
    service.ts             搜索编排、排序、去重和插入文本生成
    edits.ts               纯文档编辑
    types.ts               补全契约与内部请求类型
  metadata/
    index.ts               元数据扩展公共入口（仅类型）
    types.ts               五类搜索契约
  shared/types.ts          方言、候选类别、子句与表引用
examples/demo/             演示页面、样式、mock、日志类型和静态资源
build/sqlparser-wasm.ts    库构建与开发服务器的解析器加载适配
scripts/test-loader.mjs    源码行为测试的 TypeScript 加载钩子
tests/*.test.mjs           源码行为测试
tests/package/            安装包消费测试
vite.config.ts             库构建
vite.demo.config.ts        演示开发、构建与预览
tsconfig.json              库与演示的类型检查配置
tsconfig.lib.json          仅为库生成类型声明
docs/                      设计、元数据扩展、打包部署文档
```

## 当前范围

- 以 SELECT 查询为主；其他语句降级为关键字建议。CTE、嵌套 SELECT 和集合运算场景保守地禁用字段召回。
- 方言为 MySQL、PostgreSQL、Generic；目录采用 `database.table` 两段式模型，尚未实现 catalog/schema/table 三层作用域。
- 每类搜索仅召回第一页，默认 `limit: 30`，可配置到 `100`；大目录中的后续页候选可能漏召回。
- 当前提供 ESM，浏览器为主要目标。Node 24 安装包烟雾测试验证了真实解析和补全；其他打包器、worker、SSR 初始化及其他服务端环境需单独验证。

WASM 随安装包分发，消费项目无需额外安装解析器或复制本仓库的构建插件。部署和发布说明见[打包与部署](docs/packaging.md)。
