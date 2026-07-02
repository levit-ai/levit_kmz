import * as vscode from 'vscode';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Tag-based folding + pretty-print formatting for KML/WPML documents, so waypoint
 * blocks can be collapsed/expanded even when VS Code's indentation folding falls short
 * (e.g. minified files). Registered for *.kml / *.wpml on disk and inside KMZ archives.
 */
export function registerXmlTools(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { language: 'xml', pattern: '**/*.wpml' },
    { language: 'xml', pattern: '**/*.kml' },
    { scheme: 'kmz', language: 'xml' },
  ];

  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(selector, {
      provideFoldingRanges(document): vscode.FoldingRange[] {
        return computeXmlFoldingRanges(document.getText()).map(
          (r) =>
            new vscode.FoldingRange(
              r.start,
              r.end,
              r.kind === 'comment' ? vscode.FoldingRangeKind.Comment : undefined
            )
        );
      },
    }),
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits(document, options): vscode.TextEdit[] {
        const indent = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
        const formatted = formatXml(document.getText(), indent);
        if (formatted === null) {
          void vscode.window.showErrorMessage('Could not format: the document is not well-formed XML.');
          return [];
        }
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        return [vscode.TextEdit.replace(fullRange, formatted)];
      },
    })
  );
}

export type XmlFoldingRange = { start: number; end: number; kind?: 'comment' };

const XML_TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([^\s/>!?][^\s/>]*)(?:"[^"]*"|'[^']*'|[^"'>])*?(\/?)>/g;

export function computeXmlFoldingRanges(text: string): XmlFoldingRange[] {
  const ranges: XmlFoldingRange[] = [];
  const stack: { name: string; line: number }[] = [];

  let lastPos = 0;
  let lastLine = 0;
  const lineAt = (pos: number): number => {
    for (let i = lastPos; i < pos; i++) {
      if (text.charCodeAt(i) === 10) {
        lastLine++;
      }
    }
    lastPos = pos;
    return lastLine;
  };

  XML_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XML_TOKEN_RE.exec(text)) !== null) {
    const startLine = lineAt(m.index);
    if (m[0].startsWith('<!--')) {
      const endLine = lineAt(m.index + m[0].length);
      if (endLine > startLine) {
        ranges.push({ start: startLine, end: endLine, kind: 'comment' });
      }
      continue;
    }
    if (m[2] === undefined) {
      continue; // CDATA, processing instruction, DOCTYPE
    }
    const isClose = m[1] === '/';
    const isSelfClose = m[3] === '/';
    if (isSelfClose) {
      continue;
    }
    if (!isClose) {
      stack.push({ name: m[2], line: startLine });
      continue;
    }
    // Closing tag: pop to the matching open tag (tolerant of mismatches).
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === m[2]) {
        const open = stack[i];
        stack.length = i;
        const endLine = lineAt(m.index + m[0].length);
        if (endLine > open.line) {
          ranges.push({ start: open.line, end: endLine });
        }
        break;
      }
    }
  }
  return ranges;
}

/** Pretty-print XML, preserving node order, attributes, comments, CDATA, and value text. */
export function formatXml(text: string, indent: string): string | null {
  try {
    if (XMLValidator.validate(text) !== true) {
      return null;
    }
    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      cdataPropName: '__cdata',
      commentPropName: '__comment',
    });
    const ast = parser.parse(text);
    if (!Array.isArray(ast) || ast.length === 0) {
      return null;
    }
    const builder = new XMLBuilder({
      preserveOrder: true,
      ignoreAttributes: false,
      format: true,
      indentBy: indent,
      suppressEmptyNode: false,
      cdataPropName: '__cdata',
      commentPropName: '__comment',
    });
    const out = builder.build(ast);
    if (typeof out !== 'string') {
      return null;
    }
    return out.replace(/^\s+/, '').replace(/\s*$/, '\n');
  } catch {
    return null;
  }
}
