# Repository Guidelines

## Project Structure & Module Organization

sql-completer is a reusable TypeScript SQL completion package built with Vite and `@guanmingchiu/sqlparser-ts`. The browser demo is a separate consumer of the library.

- `src/index.ts` defines the public completion API. `src/metadata/index.ts` exports metadata extension types without loading the parser. Keep package exports limited to these two entry points.
- `src/completion/engine.ts` owns initialization, cancellation, result validity, and application. `context.ts` derives SQL context; `service.ts` searches and ranks; `edits.ts` applies pure document edits; `types.ts` defines completion contracts and internal request types.
- `src/metadata/types.ts` defines the five asynchronous searches, parameters, results, and transport cancellation options. `src/shared/types.ts` contains dialects, candidate kinds, clauses, and table references.
- `examples/demo/main.ts` owns editor UI; `style.css` styles it. `mock-metadata.ts` implements mock searches; `types.ts` defines demo request logs. Static files live in `examples/demo/public/` and `examples/demo/assets/`.
- `vite.config.ts` builds the ESM library; `tsconfig.lib.json` emits its declarations. `vite.demo.config.ts` uses source in development and the built library in production. `build/sqlparser-wasm.ts` adapts parser loading and emits a shared WASM asset.
- `tests/*.test.mjs` contains source behavior tests; `scripts/test-loader.mjs` loads TypeScript in Node. `tests/package/*.test.mjs` exercises a real tarball in an independent consumer.

## Build, Test, and Development Commands

Use Node.js 24 or newer for development and the TypeScript test hooks.

- `npm ci`: install dependencies from the committed lockfile.
- `npm run dev`: start the source-backed demo; use the printed local URL.
- `npm test`: run source behavior tests with the real WASM parser.
- `npm run build:lib`: build library JS/WASM and declarations to `dist/`; the declaration step checks library types.
- `npm run build:demo`: check library and demo types, then build the demo to `dist-demo/`. Build the library first.
- `npm run build`: build the library and then its consuming demo. Unused locals and parameters fail type checking.
- `npm run test:package`: build the library, install a tarball into a temporary consumer, and check exports, declarations, and WASM.
- `npm pack`: rebuild the library through `prepack` and generate a local installation tarball. The package remains private until a release is explicitly requested.
- `npm run preview`: serve `dist-demo/` for production smoke testing; run `npm run build` first.

## Coding Style & Naming Conventions

Use two-space indentation, ES module imports, single-quoted strings, and semicolons. Use camelCase for functions and variables, PascalCase for types, and descriptive lowercase filenames. Prefer explicit types and guarded AST traversal over `any`. No dedicated formatter or linter is configured.

Use `.js` extensions for relative imports in library TypeScript so emitted declarations work with NodeNext consumers. The source test loader resolves these imports to the corresponding `.ts` files. Keep demo and transport implementations outside library imports.

## Testing Guidelines

Before submitting, run `npm test` and `npm run build`. Run `npm run test:package` after public API, declaration, dependency, or packaging changes. Name behavioral tests `*.test.mjs`; no coverage threshold applies.

Cover incomplete SQL, replacement ranges, qualified names, aliases, statement boundaries, and comment/string suppression. Verify metadata scope, pagination, cancellation, stale results, document changes, disposal, and complete mock parameter logging. For UI or parser loading changes, check production WASM initialization and keyboard insertion in a browser.

## Documentation

- `README.md` introduces the module, public imports, local installation, demo, commands, and current limits. Consumer examples must not depend on unpublished mock files.
- `docs/completion-design.md` explains architecture, completion API, lifecycle, context recovery, and ranking.
- `docs/metadata-index.md` defines extension contracts, HTTP mapping, pagination, cancellation, and demo mock behavior.
- `docs/packaging.md` documents build configuration, artifacts, WASM deployment, consumer checks, and release boundaries.

Synchronize documentation with exported contracts and actual scripts. Distinguish implemented behavior from proposed HTTP services or future scope. Keep links relative within repository documentation, and keep examples usable through public package entry points.

## Commit & Pull Request Guidelines

Use concise, imperative commit subjects, such as `Fix qualified table extraction`. Keep each commit focused on a coherent change. Pull requests should describe behavior, link relevant issues, and report validation results. Include screenshots for UI changes. Keep `dist/`, `dist-demo/`, `node_modules/`, and tarballs out of commits.

## Parser & Integration Notes

Keep recovery edits confined to a parsing copy; preserve original editor offsets. Retain the parser loader adaptation when changing initialization. Library builds must include the JS glue and one deployable WASM binary with module-relative resource URLs; production consumers must not require the repository's Vite plugin.

Use one `createSqlCompletion` instance per editor through the public package entry. Inject `MetadataIndex`; keep DOM, mock data, HTTP, and application logging outside the engine. All five metadata methods are required; unsupported categories may return empty results. Mock requests use `connectionId: 'demo-local'`; other adapters define their own connection identifiers and enforce connection and catalog authorization server-side.

Use UTF-16 offsets and real current documents in `apply()`. Cancel old results on document or context changes, and dispose instances when editors unmount. Metadata `cursor` is an opaque pagination token, distinct from the numeric editor cursor. The completion engine currently requests only the first page of each selected index.
