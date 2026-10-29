# 打包与部署

sql-completer 采用单包、两个公共入口：补全入口 `sql-completer` 和元数据类型入口 `sql-completer/metadata`。库与演示分别构建，安装包只分发库产物和 npm 默认包含的包说明。

[项目概览](../README.md) · [补全设计与 API](completion-design.md) · [元数据扩展](metadata-index.md)

## 构建配置与依赖

| 文件 | 职责 |
| --- | --- |
| `vite.config.ts` | 以库模式构建两个 ESM 入口、解析器 JS 和 WASM |
| `tsconfig.lib.json` | 只为 `src/` 做类型检查并输出 `.d.ts` |
| `tsconfig.json` | 库与演示的类型检查；将包名映射到库源码供开发使用 |
| `vite.demo.config.ts` | 开发使用源码，生产使用构建后的库；输出 `dist-demo/` |
| `build/sqlparser-wasm.ts` | 暴露解析器隐藏的动态导入，并在库构建中输出共享 WASM |
| `package.json` | 通过 `exports`、`types`、`files` 和 `prepack` 定义消费与打包边界 |

开发工具和解析器均为开发依赖。解析器运行时代码与 WASM 随库打包，当前安装包没有运行时 npm 依赖；消费项目无需再安装 `@guanmingchiu/sqlparser-ts`。

开发和验证使用 Node.js 24 或以上及 npm。库输出目标为 ES2023，主要面向支持 ESM、WebAssembly 和标准取消 API 的现代浏览器。当前只提供 ESM，没有 CommonJS、UMD 或编辑器框架专用产物。

## 构建命令与顺序

```sh
npm ci
npm test
npm run build
npm run test:package
```

`npm run build` 顺序执行以下步骤：

1. `build:lib`：Vite 构建库 JS 和 WASM，然后 TypeScript 检查库并生成声明。
2. `build:demo`：TypeScript 检查库和演示，再将消费库产物的页面构建至 `dist-demo/`。

仅需安装包时可执行 `npm run build:lib`，无需构建演示。单独执行 `npm run build:demo` 前，必须先生成最新的 `dist/`；它不会自动重建库。

生产预览使用：

```sh
npm run build
npm run preview
```

`preview` 服务的是演示产物 `dist-demo/`。`npm run dev` 使用源码开发服务器，可在尚未构建库时启动。

## 库产物

```text
dist/
  index.js                         补全 ESM 入口
  index.d.ts                       补全类型入口
  metadata.js                      元数据类型入口对应的空运行时模块
  metadata/index.d.ts               元数据类型声明
  metadata/types.d.ts               搜索契约声明
  shared/types.d.ts                 基础类型声明
  completion/*.d.ts                 公开类型所需的内部声明
  sqlparser_rs_wasm-<hash>.js        动态加载的解析器 JS glue
  assets/sqlparser_rs_wasm_bg.wasm   共享 WASM 文件
  .vite/license.md                 构建生成的依赖许可证记录
```

`exports` 只开放包根入口和 `/metadata`。`completion/*.d.ts` 等文件用于声明之间的引用，不代表对外开放相应子路径。业务项目通过公共入口导入，避免依赖内部文件名或 chunk 哈希。

`files: ["dist"]` 限制安装包内容；npm 还会包含 README、package.json 等默认文件。`examples/`、源码、测试和构建脚本不分发，当前 `docs/` 专题文档也仅保留在源码仓库。`sideEffects: false` 为消费端提供未使用模块的消除提示。

## WASM 加载与部署

解析器依赖原本通过隐藏动态导入加载 glue，且其资源路径基于依赖自身目录。构建插件暴露该导入，并将 wrapper 和 glue 中的 WASM 地址统一指向一份资源，输出相对 `import.meta.url` 的定位表达式。这样可避免库模式将同一二进制多次内联为 base64。

| 消费方式 | 部署要求 |
| --- | --- |
| Vite 应用 | 从包入口导入；消费构建会识别相对模块资源地址并输出新的 WASM 地址，无需复制本仓库插件 |
| 浏览器直接导入 ESM | 整体部署 `dist/`，保留入口、glue、WASM 之间的目录关系，再按 URL 导入 `index.js` |
| 其他打包器 | 需支持动态 ESM 导入和 `new URL(..., import.meta.url)` 资源处理；接入时独立验证 |
| Node.js | 安装包消费测试验证 Node 24 中的初始化与补全；其他版本和服务端环境未单独验证 |

不能只部署 `index.js`。静态服务须可访问 JS 与 WASM；推荐对 `.wasm` 返回 `application/wasm`，以支持流式初始化。跨源部署时，资源所在服务也需允许消费页面访问。

生产演示使用 `base: './'`，其资源链接适合整体放在站点子路径下。演示生产构建没有额外注入解析器插件，而是实际消费 `dist/index.js`，检查库资源能否再次打包。worker 与 SSR 初始化尚未作为独立兼容目标验证。

## 生成和安装 tarball

在仓库运行：

```sh
npm pack
```

`prepack` 会执行 `npm run build:lib`，产出当前版本的 `sql-completer-0.1.0.tgz`。打包不要求生成演示，也不包含本地 `node_modules/`。

在消费项目运行：

```sh
npm install /path/to/sql-completer-0.1.0.tgz
```

消费项目使用 `import { createSqlCompletion } from 'sql-completer'`，元数据适配器使用 `import type { MetadataIndex } from 'sql-completer/metadata'`。不需要导入仓库的 `src/` 或 `examples/`。

## 验证与发布边界

`npm run test:package` 先构建库，然后将真实 tarball 安装到临时 ESM 消费项目，验证：

- 只分发库产物，包含声明、依赖许可证记录和一份 WASM。
- 使用 NodeNext 模块解析的 TypeScript 消费项目能解析两个入口。
- Node 24 能实际初始化 WASM、搜索候选并应用补全。
- `/metadata` 不导出运行时实现，内部路径被 `exports` 阻止访问。
- 消费项目无需安装解析器依赖。

浏览器验证使用生产预览：确认解析器初始化、候选展示与 Tab / Enter 插入。源码行为测试使用真实解析器，但不能单独证明安装包的声明、资源和入口正确。

当前包保持 `private: true`，可通过 tarball 本地分发，未发布到 npm registry。正式发布时再确定包名、版本与项目许可证，调整 private 标记，并重复上述构建、安装包和浏览器验证。

`dist/`、`dist-demo/`、`node_modules/` 与 `*.tgz` 均为生成物，不提交到 Git。
