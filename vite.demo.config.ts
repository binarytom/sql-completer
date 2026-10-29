import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { sqlparserWasmPlugin } from './build/sqlparser-wasm.ts';

export default defineConfig(({ command }) => ({
  root: 'examples/demo',
  base: './',
  plugins: command === 'serve' ? [sqlparserWasmPlugin()] : [],
  resolve: {
    alias: {
      // Production demo consumes the library artifact, exercising its WASM packaging.
      'sql-completer': fileURLToPath(new URL(command === 'serve' ? './src/index.ts' : './dist/index.js', import.meta.url)),
    },
  },
  optimizeDeps: { exclude: ['@guanmingchiu/sqlparser-ts'] },
  build: { outDir: '../../dist-demo', emptyOutDir: true },
}));
