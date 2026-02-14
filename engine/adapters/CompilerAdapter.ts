export class CompilerAdapter {
  async compile(filename: string, source: string): Promise<string> {
    const strippedImports = source.replace(/^\s*import[^;]*;?\s*$/gm, '').trim();
    const jsxTransformed = this.transformJSX(strippedImports);
    const wrapped = this.wrapAsModule(filename, jsxTransformed);
    return wrapped;
  }

  private transformJSX(code: string): string {
    // Very simplified JSX to React.createElement transformation:
    // - Self-closing: <Tag attr="x" /> -> React.createElement('Tag', { attr: "x" })
    // - With children: <div>text</div> -> React.createElement('div', null, "text")
    // This is intentionally basic to avoid external tooling.
    let output = code;

    // Convert self-closing tags
    output = output.replace(
      /<([A-Za-z0-9_]+)([^>]*)\/>/g,
      (_match, tag, attrs) => `React.createElement('${tag}', ${this.parseProps(attrs)})`,
    );

    // Convert opening/closing tags with inner text (no nested JSX in this naive pass)
    output = output.replace(
      /<([A-Za-z0-9_]+)([^>]*)>([^<]*)<\/\1>/g,
      (_match, tag, attrs, inner) =>
        `React.createElement('${tag}', ${this.parseProps(attrs)}, ${this.stringifyLiteral(inner)})`,
    );

    return output;
  }

  private parseProps(rawAttrs: string): string {
    if (!rawAttrs || !rawAttrs.trim()) {
      return 'null';
    }
    const props: string[] = [];
    const attrRegex = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(rawAttrs)) !== null) {
      const [, key, value] = match;
      props.push(`'${key}': ${this.stringifyLiteral(value)}`);
    }
    if (props.length === 0) {
      return 'null';
    }
    return `{ ${props.join(', ')} }`;
  }

  private stringifyLiteral(value: string): string {
    const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
    return '`' + escaped + '`';
  }

  private wrapAsModule(id: string, body: string): string {
    return `
define('${id}', [], function(require, exports, module) {
  ${body}
});
`.trim();
  }
}
