import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'bundle-sqlparser-wasm-loader',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith('/@guanmingchiu/sqlparser-ts/dist/index.mjs')) return;
      // The package hides this import from Vite. Expose only its browser loader
      // so the JS glue and WASM binary both receive deployable, hashed URLs.
      const bundled = code.replace(
        /\/\*\s*@vite-ignore\s*\*\/(\s*['"]\.\.\/wasm\/sqlparser_rs_wasm\.js['"])/,
        '$1',
      );
      return { code: bundled, map: null };
    },
  }],
  optimizeDeps: {
    exclude: ['@guanmingchiu/sqlparser-ts'],
  },
});
