# Repository Guidelines

## Project Structure & Module Organization

SQL completion uses TypeScript, Vite, and `@guanmingchiu/sqlparser-ts`.

- `src/main.ts` owns editor UI; `src/style.css` styles it.
- `src/completion/index.ts` is the public integration surface. `engine.ts` owns initialization, cancellation, result validity, and application. `context.ts` derives SQL context; `service.ts` searches and ranks; `edits.ts` applies pure document edits; `types.ts` defines contracts.
- `src/metadata.ts` implements five asynchronous mock index searches: databases, tables, columns, functions, and keywords.
- `tests/*.test.mjs` contains tests; `scripts/test-loader.mjs` loads TypeScript in Node.
- `docs/completion-design.md` documents architecture and proposed HTTP endpoints; `public/` and `src/assets/` contain static assets.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from the committed lockfile.
- `npm run dev`: start the Vite development server; use the printed local URL.
- `npm test`: run Node's built-in test runner; use Node 24 or newer for the TypeScript loading hooks.
- `npm run build`: run TypeScript checks and produce `dist/`. Unused locals and parameters fail this check.
- `npm run preview`: serve `dist/` for production smoke testing, including WASM initialization.

## Coding Style & Naming Conventions

Use two-space indentation, ES module imports, single-quoted strings, and semicolons. Use camelCase for functions and variables, PascalCase for types, and descriptive lowercase filenames. Prefer explicit types and guarded AST traversal over `any`. No dedicated formatter or linter is configured.

## Testing Guidelines

Before submitting, run `npm test` and `npm run build`. Name behavioral tests `*.test.mjs`; no coverage threshold applies. Cover incomplete SQL, replacement ranges, qualified names, aliases, statement boundaries, and comment/string suppression. Verify metadata scope, pagination, cancellation, stale results, document changes, disposal, and complete parameter logging. Check UI keyboard insertion and production preview in a browser.

## Commit & Pull Request Guidelines

Use concise, imperative commit subjects, such as `Fix qualified table extraction`. Keep each commit focused on a coherent change. Pull requests should describe behavior, link relevant issues, and report validation results. Include screenshots for UI changes. Keep `dist/` and `node_modules/` out of commits.

## Parser & Configuration Notes

Keep recovery edits confined to a parsing copy; preserve original editor offsets. The Vite loader transform packages the dependency's JavaScript glue and WASM together; retain it when changing parser initialization. Mock requests use `connectionId: 'demo-local'`; future adapters must enforce connection and catalog authorization server-side.

Use one `createSqlCompletion` instance per editor via `index.ts`. Inject `MetadataIndex`; keep DOM/mock dependencies outside the engine. Use UTF-16 offsets and real current documents in `apply()`. Synchronize README examples with exported contracts.
