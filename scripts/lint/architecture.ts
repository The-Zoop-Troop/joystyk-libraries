// The architecture lint's rules. The allowed edges live in scripts/architecture.json, and
// ARCHITECTURE.md's dependency table is generated from the same file, so the doc and the
// lint can't drift apart. The CLI is scripts/check-architecture.ts.
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, posix } from 'node:path';
import {
  collectImports,
  findImpurities,
  parseSource,
  SOURCE_EXTENSIONS,
  type ImportRef,
  type PurityConfig,
} from './imports.ts';
import { walk, type Finding } from './report.ts';

export interface PackageRule {
  readonly imports: readonly string[];
  readonly pure?: boolean;
  readonly heavy?: boolean;
  readonly note?: string;
}

export interface LayerRule {
  readonly packages: readonly string[];
  readonly layers: readonly string[];
  readonly pure?: boolean;
  readonly heavy?: boolean;
  readonly engineAllow?: boolean;
}

export interface ArchitectureConfig {
  readonly scope: string;
  readonly packages: Readonly<Record<string, PackageRule>>;
  readonly apps: { readonly packages: '*' | readonly string[]; readonly games: boolean; readonly note?: string };
  readonly games: { readonly layers: Readonly<Record<string, LayerRule>>; readonly note?: string };
  readonly heavyLibraries: readonly string[];
  readonly purity: PurityConfig;
  readonly resourceReads?: Readonly<Record<string, { readonly paths: readonly string[]; readonly reason: string }>>;
  readonly dynamicImports?: Readonly<Record<string, string>>;
}

export type WorkspaceKind = 'package' | 'app' | 'game';

export interface Workspace {
  readonly kind: WorkspaceKind;
  /** Root-relative folder, such as `packages/ui`. */
  readonly dir: string;
  /** The folder's own name, such as `ui`. */
  readonly folder: string;
  readonly name: string;
  readonly exports: unknown;
  readonly dependencies: ReadonlyMap<string, string>;
  readonly engineAllow: readonly string[];
}

const KIND_DIRS: Record<WorkspaceKind, string> = { package: 'packages', app: 'apps', game: 'games' };
const DOC_FILE = 'ARCHITECTURE.md';
const DOC_START = '<!-- architecture-table:start -->';
const DOC_END = '<!-- architecture-table:end -->';
const FIX_DOC =
  'Run `node scripts/check-architecture.ts --write-docs` to regenerate the table from scripts/architecture.json.';
const BUILTINS = new Set(builtinModules);

export const loadConfig = (path: string): ArchitectureConfig =>
  JSON.parse(readFileSync(path, 'utf8')) as ArchitectureConfig;

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every workspace under packages/, apps/ and games/ that has a package.json. */
export const loadWorkspaces = (root: string): { workspaces: Workspace[]; findings: Finding[] } => {
  const workspaces: Workspace[] = [];
  const findings: Finding[] = [];
  for (const [kind, parent] of Object.entries(KIND_DIRS) as [WorkspaceKind, string][]) {
    const folders = new Set(
      walk(root, parent)
        .map((file) => file.split('/')[1])
        .filter((f) => f !== undefined),
    );
    for (const folder of [...folders].sort()) {
      const dir = `${parent}/${folder}`;
      const manifest = readJson(join(root, dir, 'package.json'));
      if (manifest === null) continue;
      const dependencies = new Map<string, string>();
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = manifest[field];
        if (isRecord(deps)) for (const [name, range] of Object.entries(deps)) dependencies.set(name, String(range));
      }
      const joystyk = manifest['joystyk'];
      const allow = isRecord(joystyk) ? joystyk['engineAllow'] : undefined;
      if (allow !== undefined && !(Array.isArray(allow) && allow.every((a) => typeof a === 'string'))) {
        findings.push({
          rule: 'engine-allow',
          file: `${dir}/package.json`,
          message: '`joystyk.engineAllow` must be an array of package names.',
          fix: 'Write it as `"joystyk": { "engineAllow": ["effect"] }`, listing only pure libraries the engine needs.',
        });
      }
      workspaces.push({
        kind,
        dir,
        folder,
        name: typeof manifest['name'] === 'string' ? manifest['name'] : '',
        exports: manifest['exports'],
        dependencies,
        engineAllow: Array.isArray(allow) ? allow.filter((a): a is string => typeof a === 'string') : [],
      });
    }
  }
  return { workspaces, findings };
};

/** Splits a bare specifier into its package name and its `exports` subpath (`.` or `./x`). */
export const splitSpecifier = (specifier: string): { name: string; subpath: string } => {
  const parts = specifier.split('/');
  const size = specifier.startsWith('@') ? 2 : 1;
  const rest = parts.slice(size).join('/');
  return { name: parts.slice(0, size).join('/'), subpath: rest === '' ? '.' : `./${rest}` };
};

/** Whether `subpath` is reachable through a package.json `exports` value, following Node's rules. */
export const isExported = (exports: unknown, subpath: string): boolean => {
  if (!isRecord(exports) || !Object.keys(exports).some((key) => key.startsWith('.'))) return subpath === '.';
  if (subpath in exports) return exports[subpath] !== null;
  let best: { prefix: string; value: unknown } | null = null;
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
      if (best === null || prefix.length > best.prefix.length) best = { prefix, value };
    }
  }
  return best !== null && best.value !== null;
};

/** Whether an allowlist entry (`kit` or `rooms/protocol`) admits this target and subpath. */
const edgeAllows = (entries: readonly string[] | '*', folder: string, subpath: string): boolean => {
  if (entries === '*') return true;
  return entries.some((entry) => {
    const slash = entry.indexOf('/');
    if (slash === -1) return entry === folder;
    return entry.slice(0, slash) === folder && `./${entry.slice(slash + 1)}` === subpath;
  });
};

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CONFIG_FILE = /(^|\/)[^/]+\.config\.[cm]?[jt]s$/;
const WORKER_FILE = /\.worker\.[cm]?[jt]sx?$/;

/** Tests and tool configs may use anything their package declares; edge and purity rules skip them. */
export const isToolingFile = (path: string): boolean =>
  TEST_FILE.test(path) || CONFIG_FILE.test(path) || path.split('/').includes('__tests__');

/** A game file's layer: the first folder under games/<id>/ or games/<id>/src/, else `entry`. */
export const gameLayer = (config: ArchitectureConfig, pathInGame: string): string => {
  const segments = pathInGame.split('/');
  if (segments[0] === 'src') segments.shift();
  const first = segments[0];
  return segments.length > 1 && first !== undefined && first !== 'entry' && first in config.games.layers
    ? first
    : 'entry';
};

const describeEntries = (entries: readonly string[]): string =>
  entries.length === 0 ? 'nothing' : entries.map((e) => `\`${e}\``).join(', ');

interface FileContext {
  readonly config: ArchitectureConfig;
  readonly workspace: Workspace;
  readonly byName: ReadonlyMap<string, Workspace>;
  readonly all: readonly Workspace[];
  readonly file: string;
  readonly tooling: boolean;
  readonly layer: string | null;
  readonly pure: boolean;
}

const checkRelative = (ctx: FileContext, ref: ImportRef, specifier: string): Finding[] => {
  const at = { file: ctx.file, line: ref.line };
  if (specifier.startsWith('/')) {
    return [
      {
        rule: 'absolute-import',
        ...at,
        message: `\`${specifier}\` is an absolute file path.`,
        fix: 'Use a relative path inside the package, or import another package by its name.',
      },
    ];
  }
  const resolved = posix.normalize(posix.join(posix.dirname(ctx.file), specifier));
  const resource = ctx.config.resourceReads?.[ctx.file];
  if (
    ref.kind === 'url' &&
    (resource?.reason.length ?? 0) >= 20 &&
    resource?.paths.some((path) => resolved === path || resolved.startsWith(`${path}/`))
  )
    return [];
  const owner = ctx.all.find((ws) => resolved === ws.dir || resolved.startsWith(`${ws.dir}/`));
  if (owner === undefined) {
    return [
      {
        rule: 'outside-package',
        ...at,
        message: `\`${specifier}\` reaches outside ${ctx.workspace.dir}/ to ${resolved}.`,
        fix: 'A package reads only its own folder. Move the shared code into a workspace package and import it by name.',
      },
    ];
  }
  if (owner !== ctx.workspace) {
    return [
      {
        rule: 'relative-cross-package',
        ...at,
        message: `\`${specifier}\` reaches into ${owner.dir}/ by a relative path.`,
        fix: `Import \`${owner.name || owner.folder}\` by its package name (through its \`exports\`) and declare it with \`workspace:*\` in ${ctx.workspace.dir}/package.json.`,
      },
    ];
  }
  const targetPath = resolved.slice(ctx.workspace.dir.length + 1);
  const toolTarget =
    /\.(test|spec|test-util|config)(\.[cm]?[jt]sx?)?$/.test(resolved) ||
    resolved.split('/').includes('__tests__') ||
    /^(scripts|tools|build)\//.test(targetPath);
  if (!ctx.tooling && toolTarget) {
    return [
      {
        rule: 'production-imports-test',
        ...at,
        message: `Production code imports test support (${specifier}).`,
        fix: 'Move reusable production helpers out of test files and __tests__, and keep tests dependent on production code.',
      },
    ];
  }
  if (ctx.workspace.kind !== 'game' || ctx.tooling || ctx.layer === null) return [];
  if (ref.kind === 'url') return [];
  const target = gameLayer(ctx.config, resolved.slice(ctx.workspace.dir.length + 1));
  if (ref.kind === 'worker-url' && target === 'jobs' && WORKER_FILE.test(resolved)) return [];
  const rule = ctx.config.games.layers[ctx.layer];
  if (rule === undefined || rule.layers.includes(target)) return [];
  return [
    {
      rule: 'game-layer',
      ...at,
      message: `The game's ${ctx.layer} layer imports its ${target} layer (\`${specifier}\`).`,
      fix: `A game's ${ctx.layer}/ may import only its own ${rule.layers.join(', ')} layers. Move the shared code down into one of those, or invert the dependency. See ARCHITECTURE.md, "Dependency rules".`,
    },
  ];
};

const checkWorkspaceImport = (
  ctx: FileContext,
  ref: ImportRef,
  specifier: string,
  name: string,
  subpath: string,
): Finding[] => {
  const at = { file: ctx.file, line: ref.line };
  const target = ctx.byName.get(name);
  if (target === undefined) {
    return [
      {
        rule: 'unknown-package',
        ...at,
        message: `\`${name}\` is not a workspace package.`,
        fix: `Check the spelling, or create packages/${name.split('/')[1] ?? name}/ and add it to scripts/architecture.json.`,
      },
    ];
  }
  const findings: Finding[] = [];
  if (!isExported(target.exports, subpath)) {
    findings.push({
      rule: 'deep-import',
      ...at,
      message: `\`${specifier}\` is not exported by ${target.dir}/package.json.`,
      fix: `Import a path listed in that package's \`exports\` (usually \`${name}\` itself), or add the subpath to its \`exports\` if it is meant to be public.`,
    });
  }
  if (target === ctx.workspace) return findings;
  const declared = ctx.workspace.dependencies.get(name);
  if (declared === undefined) {
    findings.push({
      rule: 'undeclared-dependency',
      ...at,
      message: `${ctx.workspace.dir} imports \`${name}\` but its package.json doesn't declare it.`,
      fix: `Add \`"${name}": "workspace:*"\` to \`${ctx.tooling ? 'devDependencies' : 'dependencies'}\` in ${ctx.workspace.dir}/package.json, then run \`pnpm install\`.`,
    });
  } else if (!declared.startsWith('workspace:')) {
    findings.push({
      rule: 'workspace-protocol',
      ...at,
      message: `${ctx.workspace.dir}/package.json declares \`${name}\` as \`${declared}\`.`,
      fix: `Declare workspace packages as \`"${name}": "workspace:*"\`.`,
    });
  }
  if (target.kind === 'app') {
    findings.push({
      rule: 'imports-app',
      ...at,
      message: `\`${name}\` is an app; nothing imports an app.`,
      fix: 'Move the shared code into a package under packages/ and import that from both places.',
    });
    return findings;
  }
  if (target.kind === 'game') {
    if (ctx.workspace.kind === 'package') {
      findings.push({
        rule: 'platform-imports-game',
        ...at,
        message: `Platform package ${ctx.workspace.dir} imports the game \`${name}\`.`,
        fix: 'Platform packages never import a game. Load games through their manifest and a dynamic `import()` whose path comes from the manifest, or let an app wire the game in.',
      });
    } else if (ctx.workspace.kind === 'game') {
      findings.push({
        rule: 'game-imports-game',
        ...at,
        message: `Game ${ctx.workspace.dir} imports another game, \`${name}\`.`,
        fix: 'No game imports another game. Move the shared rules into @joystyk/kit (if pure) or a platform package, and import that.',
      });
    } else if (!ctx.config.apps.games) {
      findings.push({
        rule: 'forbidden-edge',
        ...at,
        message: `Apps may not import games (\`${name}\`).`,
        fix: 'Load the game through its manifest.',
      });
    }
    return findings;
  }
  if (ctx.tooling) return findings;
  if (ctx.workspace.kind === 'package') {
    const allowed = ctx.config.packages[ctx.workspace.folder]?.imports ?? [];
    if (!edgeAllows(allowed, target.folder, subpath)) {
      findings.push({
        rule: 'forbidden-edge',
        ...at,
        message: `\`${ctx.workspace.folder}\` may not import \`${specifier}\`; it may import ${describeEntries(allowed)}.`,
        fix: `Keep the dependency direction in ARCHITECTURE.md: move the code to a lower package, or pass the capability in. If the edge is truly needed, add it to "${ctx.workspace.folder}" in scripts/architecture.json, regenerate the doc table and record why.`,
      });
    }
  } else if (ctx.workspace.kind === 'app') {
    if (!edgeAllows(ctx.config.apps.packages, target.folder, subpath)) {
      findings.push({
        rule: 'forbidden-edge',
        ...at,
        message: `Apps may not import \`${specifier}\`.`,
        fix: 'Add the package to "apps" in scripts/architecture.json if apps should deploy it.',
      });
    }
  } else if (ctx.layer !== null) {
    const allowed = ctx.config.games.layers[ctx.layer]?.packages ?? [];
    if (!edgeAllows(allowed, target.folder, subpath)) {
      findings.push({
        rule: 'forbidden-edge',
        ...at,
        message: `A game's ${ctx.layer} layer may not import \`${specifier}\`; it may import ${describeEntries(allowed)}.`,
        fix:
          ctx.layer === 'engine'
            ? 'Engines import only @joystyk/contracts, @joystyk/kit and their engineAllow list. Move the code to the session, ui or render layer.'
            : `Move the import to a layer that may use it (see the table in ARCHITECTURE.md), or ask for the edge in scripts/architecture.json.`,
      });
    }
  }
  return findings;
};

const checkExternalImport = (ctx: FileContext, ref: ImportRef, specifier: string, name: string): Finding[] => {
  const at = { file: ctx.file, line: ref.line };
  const builtin = specifier.startsWith('node:') || BUILTINS.has(name);
  const findings: Finding[] = [];
  if (!builtin && !ctx.workspace.dependencies.has(name)) {
    findings.push({
      rule: 'undeclared-dependency',
      ...at,
      message: `${ctx.workspace.dir} imports \`${name}\` but its package.json doesn't declare it.`,
      fix: `Add it with \`pnpm --filter ${ctx.workspace.name || ctx.workspace.dir} add ${ctx.tooling ? '-D ' : ''}${name}\` (pin tools in the pnpm-workspace.yaml catalog and use \`catalog:\`).`,
    });
  }
  if (ctx.tooling) return findings;
  const heavy = ctx.config.heavyLibraries.includes(name);
  if (heavy) {
    const layerRule = ctx.layer === null ? undefined : ctx.config.games.layers[ctx.layer];
    const packageHeavy = ctx.workspace.kind === 'package' && ctx.config.packages[ctx.workspace.folder]?.heavy === true;
    if (
      !packageHeavy &&
      (ctx.workspace.kind !== 'game' || (layerRule?.heavy !== true && !WORKER_FILE.test(ctx.file)))
    ) {
      findings.push({
        rule: 'heavy-library',
        ...at,
        message: `\`${name}\` is a heavy library, imported outside a permitted game layer or a package with heavy: true.`,
        fix: "Use the game's render/ or jobs/ layer, a worker, or an explicitly heavy package in architecture.json, so the library loads only when needed.",
      });
    }
  }
  if (!ctx.pure || heavy) return findings;
  const allowed = ctx.workspace.kind === 'game' ? ctx.workspace.engineAllow : [];
  if (!allowed.includes(name)) {
    findings.push(
      ctx.workspace.kind === 'game'
        ? {
            rule: 'engine-import',
            ...at,
            message: `The engine imports \`${specifier}\`, which is not in this game's engineAllow list.`,
            fix: builtin
              ? 'Engines never use Node or browser host modules. Move the code to the session or jobs layer.'
              : `If \`${name}\` is a pure library (no clock, randomness, DOM, storage or network), add it to \`"joystyk": { "engineAllow": [...] }\` in ${ctx.workspace.dir}/package.json; otherwise move the code out of engine/.`,
          }
        : {
            rule: 'impure-import',
            ...at,
            message: `Pure package ${ctx.workspace.dir} imports \`${specifier}\`.`,
            fix: `${ctx.workspace.folder} has no runtime dependencies (D-17). Write the code in plain TypeScript, or move it to a package that may depend on \`${name}\`.`,
          },
    );
  }
  return findings;
};

const checkImport = (ctx: FileContext, ref: ImportRef): Finding[] => {
  const specifier = ref.specifier;
  if (ctx.tooling && (ref.kind === 'url' || ref.kind === 'worker-url')) return [];
  if (specifier === null) {
    if (ctx.tooling || (ctx.pure && ref.kind === 'dynamic')) return [];
    if (!ctx.pure && ref.kind === 'dynamic' && (ctx.config.dynamicImports?.[ctx.file]?.length ?? 0) >= 20) return [];
    return [
      {
        rule: 'computed-import',
        file: ctx.file,
        line: ref.line,
        message: 'A computed module or import.meta.url resource path cannot be checked.',
        fix: 'Use literal paths or a literal template prefix so workspace boundaries can be checked. For controlled plugin loading, declare a narrow exception in architecture.json.',
      },
    ];
  }
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const findings = checkRelative(ctx, ref, specifier);
    const resource = ctx.config.resourceReads?.[ctx.file];
    const resolved = posix.normalize(posix.join(posix.dirname(ctx.file), specifier));
    const approved =
      (resource?.reason.length ?? 0) >= 20 &&
      resource?.paths.some((path) => resolved === path || resolved.startsWith(`${path}/`));
    if (ref.computed === true && !ctx.tooling && !approved && findings.length === 0) {
      findings.push({
        rule: 'computed-import',
        file: ctx.file,
        line: ref.line,
        message: 'A resource URL contains a computed path segment.',
        fix: 'Use a literal resource path, or declare its validated directory and reason under resourceReads in architecture.json.',
      });
    }
    return findings;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith('node:')) return []; // virtual:, data:, https:
  const { name, subpath } = splitSpecifier(specifier.replace(/^node:/, ''));
  if (name.startsWith(`${ctx.config.scope}/`) || ctx.byName.has(name))
    return checkWorkspaceImport(ctx, ref, specifier, name, subpath);
  return checkExternalImport(ctx, ref, specifier, name);
};

const checkWorkspaceShape = (config: ArchitectureConfig, workspace: Workspace): Finding[] => {
  if (workspace.kind !== 'package') return [];
  const file = `${workspace.dir}/package.json`;
  const findings: Finding[] = [];
  if (config.packages[workspace.folder] === undefined) {
    findings.push({
      rule: 'unlisted-package',
      file,
      message: `${workspace.dir} is not in scripts/architecture.json, so its allowed imports are unknown.`,
      fix: `Add "${workspace.folder}": { "imports": [...] } to "packages" in scripts/architecture.json, then run \`node scripts/check-architecture.ts --write-docs\` and describe the package in ARCHITECTURE.md.`,
    });
  }
  const expected = `${config.scope}/${workspace.folder}`;
  if (workspace.name !== expected) {
    findings.push({
      rule: 'package-name',
      file,
      message: `${workspace.dir} is named \`${workspace.name}\`.`,
      fix: `Name it \`${expected}\`, matching its folder.`,
    });
  }
  return findings;
};

/** Checks one source file. `text` is the file's content; `file` is root-relative. */
export const checkFile = (
  config: ArchitectureConfig,
  workspaces: readonly Workspace[],
  file: string,
  text: string,
): Finding[] => {
  const workspace = workspaces.find((ws) => file.startsWith(`${ws.dir}/`));
  if (workspace === undefined) return [];
  const layer = workspace.kind === 'game' ? gameLayer(config, file.slice(workspace.dir.length + 1)) : null;
  const pureLayer =
    workspace.kind === 'package'
      ? config.packages[workspace.folder]?.pure === true
      : layer !== null && config.games.layers[layer]?.pure === true;
  const outsideSource = !file.startsWith(`${workspace.dir}/src/`);
  const tooling =
    (outsideSource &&
      (CONFIG_FILE.test(file) || /^(scripts|tools|build)\//.test(file.slice(workspace.dir.length + 1)))) ||
    TEST_FILE.test(file) ||
    /\.test-util\.[cm]?[jt]sx?$/.test(file) ||
    (!pureLayer && isToolingFile(file));
  const pure = pureLayer && !tooling;
  const ctx: FileContext = {
    config,
    workspace,
    byName: new Map(workspaces.filter((ws) => ws.name !== '').map((ws) => [ws.name, ws])),
    all: workspaces,
    file,
    tooling,
    layer,
    pure,
  };
  const source = parseSource(file, text);
  const findings = collectImports(source).flatMap((ref) => checkImport(ctx, ref));
  if (pure) {
    const where = layer === null ? `pure package ${workspace.dir}` : `${workspace.dir}'s engine`;
    for (const v of findImpurities(source, config.purity)) {
      findings.push({
        rule: 'engine-purity',
        file,
        line: v.line,
        message: `${v.what} is used in ${where}.`,
        fix: v.fix,
      });
    }
  }
  return findings;
};

/** Checks every source file in every workspace under `root`, plus the generated doc table. */
export const checkArchitecture = (root: string, config: ArchitectureConfig): { findings: Finding[]; files: number } => {
  const { workspaces, findings } = loadWorkspaces(root);
  let files = 0;
  for (const workspace of workspaces) {
    findings.push(...checkWorkspaceShape(config, workspace));
    for (const file of walk(root, workspace.dir)) {
      const extension = file.slice(file.lastIndexOf('.') + 1);
      if (!SOURCE_EXTENSIONS.has(extension) || file.endsWith('.d.ts')) continue;
      files += 1;
      findings.push(...checkFile(config, workspaces, file, readFileSync(join(root, file), 'utf8')));
    }
  }
  findings.push(...checkDocTable(root, config));
  return { findings, files };
};

const describeEdge = (entry: string): string => {
  const slash = entry.indexOf('/');
  return slash === -1 ? `\`${entry}\`` : `\`${entry.slice(0, slash)}\` (\`./${entry.slice(slash + 1)}\` only)`;
};

/** The dependency table ARCHITECTURE.md shows, rendered from the config. */
export const renderDocTable = (config: ArchitectureConfig): string => {
  const rows = ['| Code | May import | Notes |', '| --- | --- | --- |'];
  for (const [folder, rule] of Object.entries(config.packages)) {
    const notes = [
      rule.pure === true ? 'Pure: the engine purity rules apply.' : '',
      rule.heavy === true ? 'Heavy libraries allowed.' : '',
      rule.note ?? '',
    ]
      .filter((n) => n !== '')
      .join(' ');
    rows.push(
      `| \`${folder}\` | ${rule.imports.length === 0 ? 'Nothing' : rule.imports.map(describeEdge).join(', ')} | ${notes} |`,
    );
  }
  const apps = config.apps;
  rows.push(
    `| \`apps/*\` | ${apps.packages === '*' ? 'Any package' : apps.packages.map(describeEdge).join(', ')}${apps.games ? '; games through their `exports`' : ''} | ${apps.note ?? ''} |`,
  );
  for (const [layer, rule] of Object.entries(config.games.layers)) {
    const code = layer === 'entry' ? '`games/*` entry' : `\`games/*/${layer}/\``;
    const imports = [
      ...rule.packages.map(describeEdge),
      ...(rule.engineAllow === true ? ["the game's `engineAllow` list"] : []),
      `own layers: ${rule.layers.join(', ')}`,
    ].join(', ');
    const notes = [
      rule.pure === true ? 'Pure: the engine purity rules apply.' : '',
      rule.heavy === true ? 'Heavy libraries allowed.' : '',
    ]
      .filter((n) => n !== '')
      .join(' ');
    rows.push(`| ${code} | ${imports} | ${notes} |`);
  }
  return rows.join('\n');
};

const docBlock = (config: ArchitectureConfig): string => `${DOC_START}\n${renderDocTable(config)}\n${DOC_END}`;

export const checkDocTable = (root: string, config: ArchitectureConfig): Finding[] => {
  let text: string;
  try {
    text = readFileSync(join(root, DOC_FILE), 'utf8');
  } catch {
    return [];
  }
  const start = text.indexOf(DOC_START);
  const end = text.indexOf(DOC_END);
  if (start === -1 || end === -1) {
    return [
      {
        rule: 'doc-table',
        file: DOC_FILE,
        message: 'The generated dependency table markers are missing.',
        fix: `Put \`${DOC_START}\` and \`${DOC_END}\` under "Dependency rules", then: ${FIX_DOC}`,
      },
    ];
  }
  if (text.slice(start, end + DOC_END.length) === docBlock(config)) return [];
  return [
    {
      rule: 'doc-table',
      file: DOC_FILE,
      line: text.slice(0, start).split('\n').length,
      message: 'The dependency table differs from scripts/architecture.json.',
      fix: FIX_DOC,
    },
  ];
};

/** Rewrites ARCHITECTURE.md's table from the config; returns the new text, or null if markers are missing. */
export const rewriteDocTable = (text: string, config: ArchitectureConfig): string | null => {
  const start = text.indexOf(DOC_START);
  const end = text.indexOf(DOC_END);
  if (start === -1 || end === -1) return null;
  return text.slice(0, start) + docBlock(config) + text.slice(end + DOC_END.length);
};
