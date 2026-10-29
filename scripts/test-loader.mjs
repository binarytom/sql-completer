import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Keep browser source imports unchanged while exercising the same modules in Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !relative || (extname(specifier) && !specifier.endsWith('.js'))) {
        throw error;
      }
      return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) {
      return nextLoad(url, context);
    }
    const filename = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        inlineSourceMap: true,
        inlineSources: true,
      },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  },
});
