# Repository Guidelines

## Project Structure & Module Organization

This browser SQL completion demo uses TypeScript, Vite, and `@guanmingchiu/sqlparser-ts`.

- `src/main.ts` implements the editor, completion popup, catalog, and request inspector; `src/style.css` styles the page.
- `src/completion/context.ts` derives cursor context using sentinel parsing, bounded recovery, and lexical fallback. `service.ts` searches providers and ranks candidates; `types.ts` defines shared contracts.
- `src/metadata.ts` implements five asynchronous mock index searches: databases, tables, columns, functions, and keywords.
- `tests/*.test.mjs` contains contract and completion tests; `scripts/test-loader.mjs` loads TypeScript source in Node.
- `docs/completion-design.md` documents the architecture and proposed HTTP endpoints. `public/` and `src/assets/` contain static assets.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from the committed lockfile.
- `npm run dev`: start the Vite development server; use the printed local URL.
- `npm test`: run Node's built-in test runner; use Node 24 or newer for the TypeScript loading hooks.
- `npm run build`: run TypeScript checks and produce `dist/`. Unused locals and parameters fail this check.
- `npm run preview`: serve `dist/` for production smoke testing, including WASM initialization.

## Coding Style & Naming Conventions

Use two-space indentation, ES module imports, single-quoted strings, and semicolons. Use camelCase for functions and variables, PascalCase for types, and descriptive lowercase filenames. Prefer explicit types and guarded AST traversal over `any`. No dedicated formatter or linter is configured.

## Testing Guidelines

Run `npm test` and `npm run build` before submitting changes. Add descriptive `*.test.mjs` cases for behavioral changes; no coverage threshold is configured. Check incomplete SQL, cursor replacement ranges, qualified names, aliases, statement boundaries, and suppression inside comments or strings. Verify metadata scope, pagination, cancellation, and complete parameter logging. Await parser initialization before parsing. For UI changes, verify keyboard insertion and production preview in a browser.

## Commit & Pull Request Guidelines

Use concise, imperative commit subjects, such as `Fix qualified table extraction`. Keep each commit focused on a coherent change. Pull requests should describe behavior, link relevant issues, and report validation results. Include screenshots for UI changes. Keep `dist/` and `node_modules/` out of commits.

## Parser & Configuration Notes

Keep recovery edits confined to a parsing copy; preserve original editor offsets. The Vite loader transform packages the dependency's JavaScript glue and WASM together; retain it when changing parser initialization. Mock requests use `connectionId: 'demo-local'`; future adapters must enforce connection and catalog authorization server-side.
