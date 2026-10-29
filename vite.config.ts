import { defineConfig } from 'vite';
import { sqlparserWasmPlugin } from './build/sqlparser-wasm.ts';

export default defineConfig({
  plugins: [sqlparserWasmPlugin()],
  build: {
    target: 'es2023',
    license: true,
    lib: {
      entry: { index: 'src/index.ts', metadata: 'src/metadata/index.ts' },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
  },
});
