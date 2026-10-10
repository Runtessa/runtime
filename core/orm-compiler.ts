export const compileOrmSource = (source: string) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ts = require('typescript') as typeof import('typescript');
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        allowJs: true,
      },
      fileName: 'model.js',
    });
    const diagnostics = result.diagnostics ?? [];
    const errors = diagnostics.filter(
      (diag) => diag.category === ts.DiagnosticCategory.Error
    );
    if (errors.length) {
      const host: import('typescript').FormatDiagnosticsHost = {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      };
      const formatted = ts
        .formatDiagnosticsWithColorAndContext(errors, host)
        .replace(/\x1B\[[0-9;]*m/g, '');
      throw new Error(`Model compile error:\n${formatted}`);
    }
    return result.outputText || source;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Model compile error')) {
      throw err;
    }
    return source;
  }
};
