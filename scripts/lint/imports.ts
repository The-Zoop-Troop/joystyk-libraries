// Syntax-level helpers for the architecture lint, built on the TypeScript compiler API so
// that `import type`, re-exports, `import()` types, dynamic imports and `require` calls are
// all seen, and so that text inside strings and comments is never mistaken for an import.
import ts from 'typescript';

export type ImportKind =
  'import' | 'import-type' | 'export-from' | 'dynamic' | 'require' | 'type-query' | 'url' | 'worker-url';

export interface ImportRef {
  /** The module specifier, or `null` for a dynamic import whose path is computed. */
  readonly specifier: string | null;
  readonly kind: ImportKind;
  readonly line: number;
  readonly computed?: boolean;
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
};

export const SOURCE_EXTENSIONS = new Set(Object.keys(SCRIPT_KINDS));

export const parseSource = (fileName: string, text: string): ts.SourceFile => {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extension] ?? ts.ScriptKind.TS);
};

const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

const literalText = (node: ts.Node | undefined): string | null =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/** Every module reference in a file, in source order. */
export const collectImports = (source: ts.SourceFile): ImportRef[] => {
  const refs: ImportRef[] = [];
  const add = (specifier: string | null, kind: ImportKind, node: ts.Node, computed = false): void => {
    refs.push({ specifier, kind, line: lineOf(source, node), ...(computed ? { computed: true } : {}) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const typeOnly = node.importClause?.isTypeOnly === true;
      add(literalText(node.moduleSpecifier), typeOnly ? 'import-type' : 'import', node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(literalText(node.moduleSpecifier), 'export-from', node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(literalText(node.moduleReference.expression), 'require', node);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      add(ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : null, 'type-query', node);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(literalText(first), 'dynamic', node);
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length === 1
      ) {
        add(literalText(first), 'require', node);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const [path, base] = node.arguments ?? [];
      if (base?.getText(source) === 'import.meta.url') {
        const specifier =
          literalText(path) ??
          (path !== undefined && ts.isTemplateExpression(path) && path.head.text !== '' ? `${path.head.text}*` : null);
        const parent = node.parent;
        const worker =
          ts.isNewExpression(parent) &&
          ts.isIdentifier(parent.expression) &&
          ['Worker', 'SharedWorker'].includes(parent.expression.text);
        add(specifier, worker ? 'worker-url' : 'url', node, literalText(path) === null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
};

/** True when the identifier is a value reference rather than a property name, label or type. */
const isValueReference = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent)) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if (ts.isJsxAttribute(parent)) return false;
  for (let current: ts.Node = parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return false;
  }
  return true;
};

export interface PurityConfig {
  readonly clock: readonly string[];
  readonly randomness: readonly string[];
  readonly dom: readonly string[];
  readonly io: readonly string[];
  readonly mathAllowed: readonly string[];
  readonly dateAllowed: readonly string[];
}

export interface PurityViolation {
  readonly line: number;
  readonly what: string;
  readonly fix: string;
}

const FIX = {
  clock:
    'Engines never read the clock. Take time as data: a timestamp in the command, or a `timeout` input from the runner.',
  randomness: 'Draw randomness from the seeded `rng` argument the runner passes in; never from a global source.',
  dom: "Engines run anywhere, including workers and the server. Move DOM and host access to the game's ui/ or render/ layer, or to a platform package.",
  io: 'Engines take and return data only. Do network and storage work in the session layer or a platform package, then pass the data in.',
  math: 'Transcendental Math functions differ between JavaScript engines and break replays. Use + - * /, Math.sqrt/floor/ceil/round/abs/min/max and integer operations, or a deterministic helper from @joystyk/kit.',
  dynamic: 'Import modules statically with a literal path, so the architecture lint can check the edge.',
};

/**
 * Finds clock, randomness, DOM, storage and network access, and non-deterministic Math,
 * in a file that must stay pure. A name the file declares itself (for example a parameter
 * called `document`) is not treated as the global.
 */
export const findImpurities = (source: ts.SourceFile, config: PurityConfig): PurityViolation[] => {
  // The binder resolves lexical scopes without loading dependencies or host globals.
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (name) => (name === source.fileName ? source : undefined);
  const checker = ts.createProgram([source.fileName], { noLib: true, noResolve: true }, host).getTypeChecker();
  const isLocal = (node: ts.Identifier): boolean =>
    checker.getSymbolAtLocation(node)?.declarations?.some((declaration) => declaration.getSourceFile() === source) ??
    false;
  const banned = new Map<string, keyof typeof FIX>();
  for (const name of config.clock) banned.set(name, 'clock');
  for (const name of config.randomness) banned.set(name, 'randomness');
  for (const name of config.dom) banned.set(name, 'dom');
  for (const name of config.io) banned.set(name, 'io');
  const mathAllowed = new Set(config.mathAllowed);
  const dateAllowed = new Set(config.dateAllowed);
  const violations: PurityViolation[] = [];
  const flag = (node: ts.Node, what: string, fix: string): void => {
    violations.push({ line: lineOf(source, node), what, fix });
  };

  const memberName = (parent: ts.Node, node: ts.Node): string | null | undefined => {
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return parent.name.text;
    if (ts.isElementAccessExpression(parent) && parent.expression === node)
      return literalText(parent.argumentExpression);
    return undefined; // not a member access
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      literalText(node.arguments[0]) === null
    ) {
      flag(node, 'a dynamic import() with a computed path', FIX.dynamic);
    }
    if (ts.isIdentifier(node) && !isLocal(node) && isValueReference(node)) {
      const parent = node.parent;
      const category = banned.get(node.text);
      if (category !== undefined) {
        flag(node, `the global \`${node.text}\``, FIX[category]);
      } else if (node.text === 'eval' || node.text === 'Function') {
        flag(
          node,
          `dynamic code execution through ${node.text}`,
          'Pure code must be statically inspectable. Replace eval/Function with explicit functions and data.',
        );
      } else if (node.text === 'Math') {
        const member = memberName(parent, node);
        if (member === 'random') flag(node, '`Math.random`', FIX.randomness);
        else if (member === undefined) flag(node, 'the `Math` object passed around as a value', FIX.math);
        else if (member === null || !mathAllowed.has(member))
          flag(node, `\`Math.${member ?? '[computed]'}\``, FIX.math);
      } else if (node.text === 'Date') {
        const member = memberName(parent, node);
        if (ts.isNewExpression(parent) && parent.expression === node) flag(node, '`new Date`', FIX.clock);
        else if (ts.isCallExpression(parent) && parent.expression === node) flag(node, '`Date()`', FIX.clock);
        else if (member === undefined || member === null || !dateAllowed.has(member)) {
          flag(
            node,
            member === undefined ? 'the `Date` object passed around as a value' : `\`Date.${member ?? '[computed]'}\``,
            FIX.clock,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};
