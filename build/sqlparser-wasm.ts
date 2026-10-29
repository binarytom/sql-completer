import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';

/** Expose the hidden loader and keep one deployable WASM asset in library builds. */
export const sqlparserWasmPlugin = (): Plugin => {
  let libraryBuild = false;
  let wasmReference: string;
  return {
    name: 'bundle-sqlparser-wasm-loader',
    enforce: 'pre',
    configResolved(config) {
      libraryBuild = Boolean(config.build.lib);
    },
    buildStart() {
      if (!libraryBuild) return;
      const parserEntry = createRequire(import.meta.url).resolve('@guanmingchiu/sqlparser-ts');
      const wasmPath = new URL('../wasm/sqlparser_rs_wasm_bg.wasm', pathToFileURL(parserEntry));
      wasmReference = this.emitFile({
        type: 'asset',
        fileName: 'assets/sqlparser_rs_wasm_bg.wasm',
        source: readFileSync(fileURLToPath(wasmPath)),
      });
    },
    resolveFileUrl({ referenceId, relativePath }) {
      if (referenceId !== wasmReference) return;
      return `new URL(${JSON.stringify(relativePath)}, import.meta.url).href`;
    },
    transform(code, id) {
      const filename = id.split('?')[0].replaceAll('\\', '/');
      if (!filename.includes('/@guanmingchiu/sqlparser-ts/')) return;
      if (filename.endsWith('/dist/index.mjs')) {
        code = code.replace(
          /\/\*\s*@vite-ignore\s*\*\/(\s*['"]\.\.\/wasm\/sqlparser_rs_wasm\.js['"])/,
          '$1',
        );
      }
      if (libraryBuild) {
        // Both the wrapper and glue refer to the same asset. Avoid Vite library
        // mode's default base64 inlining, which would duplicate the 3.4 MB binary.
        code = code.replace(
          /new URL\(['"](?:\.\.\/wasm\/)?sqlparser_rs_wasm_bg\.wasm['"], import\.meta\.url\)/g,
          `new URL(import.meta.ROLLUP_FILE_URL_${wasmReference})`,
        );
      }
      return { code, map: null };
    },
  };
};
