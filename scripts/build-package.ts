// A clean release build of one library: compiled ESM with the source module layout,
// exported API declarations, and the files needed by installed runtime/build helpers.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { build } from 'vite';
import { gyralVitePreset } from '@gyral/core/vite';
import { isTestFile, PACKAGE_NAMES, readManifest, ROOT } from './release/packages.ts';

const directory = process.cwd();
const name = relative(join(ROOT, 'packages'), directory);
if (!PACKAGE_NAMES.some((value) => value === name))
  throw new Error('Run the release build from an approved packages/<name> directory.');
const manifest = readManifest(directory);
const source = join(directory, 'src');
const out = join(directory, 'dist');

const filesIn = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = join(folder, entry.name);
    if (isTestFile(file)) return [];
    return entry.isDirectory() ? filesIn(file) : [file];
  });
const sources = filesIn(source);
const entries = Object.fromEntries(
  sources
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => [relative(source, file).slice(0, -3), file]),
);
const dependencies = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
const external = (id: string): boolean =>
  id.startsWith('node:') ||
  builtinModules.includes(id) ||
  dependencies.some((dependency) => id === dependency || id.startsWith(`${dependency}/`));

rmSync(out, { recursive: true, force: true });
await build({
  ...gyralVitePreset(),
  configFile: false,
  root: directory,
  publicDir: false,
  logLevel: 'warn',
  build: {
    // Libraries must retain Gyral's server segments as well as browser template parts.
    // Installed browser builds can consume this portable descriptor; SSR cannot recover
    // server segments discarded by a client-only build. Node asset URLs also stay intact.
    ssr: true,
    target: 'es2023',
    outDir: out,
    emptyOutDir: false,
    sourcemap: true,
    lib: { entry: entries, formats: ['es'] },
    rolldownOptions: {
      external,
      output: { preserveModules: true, preserveModulesRoot: source, entryFileNames: '[name].js' },
    },
  },
});

// Keep the worker, browser and Node type worlds separate, as the source checks do.
for (const configName of ['tsconfig.json', 'tsconfig.browser.json', 'tsconfig.sw.json']) {
  const configFile = join(directory, configName);
  if (!existsSync(configFile)) continue;
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  const roots = parsed.fileNames.filter((file) => file.startsWith(`${source}/`) && !isTestFile(file));
  const program = ts.createProgram(roots, {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    rootDir: ROOT,
    outDir: out,
  });
  const emitted = program.emit(
    undefined,
    (_file, body, _bom, _error, sources) => {
      const original = sources?.[0]?.fileName;
      if (original === undefined || !original.startsWith(`${source}/`) || isTestFile(original)) return;
      const target = join(out, relative(source, original).replace(/\.ts$/, '.d.ts'));
      mkdirSync(dirname(target), { recursive: true });
      // Consumers use normal .js specifiers, including in NodeNext declaration resolution.
      // TypeScript omits a leading non-JSDoc license block when emitting declarations.
      // Preserve the vendored Standard Schema notice in the distributed type definitions.
      const attribution =
        name === 'contracts' && relative(source, original) === 'standard-schema.ts'
          ? `${readFileSync(original, 'utf8').match(/^\/\*[\s\S]*?\*\//)?.[0] ?? ''}\n\n`
          : '';
      writeFileSync(target, attribution + body.replace(/(from\s+|import\()(['"])(\.[^'"]+)\.ts\2/g, '$1$2$3.js$2'));
    },
    undefined,
    true,
  );
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (diagnostics.length || emitted.emitSkipped) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => ROOT,
        getCanonicalFileName: (file) => file,
        getNewLine: () => '\n',
      }),
    );
    process.exitCode = 1;
  }
}
if (process.exitCode !== 1) {
  for (const file of sources.filter((file) => !file.endsWith('.ts'))) {
    const target = join(out, relative(source, file));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
  }
  for (const file of ['LICENSE', 'NOTICE']) {
    // Never retain stale terms if the owner changes the release licensing policy.
    rmSync(join(directory, file), { force: true });
    const reviewed = file === 'LICENSE' ? join(ROOT, 'packages', file) : join(ROOT, file);
    if (existsSync(reviewed)) cpSync(reviewed, join(directory, file));
  }
  if (name === 'content') {
    for (const file of [
      'scowl-common.txt',
      'scowl-vocabulary.txt',
      'scowl-ranked.txt',
      'blocklist.txt',
      'sensitive.txt',
      'SCOWL-COPYRIGHT',
    ]) {
      // These remain beside dist, matching the runtime modules' ../lists URLs.
      if (!existsSync(join(directory, 'lists', file))) throw new Error(`Missing content asset ${file}`);
    }
  }
  // Every published target must already exist, independently of later tarball checks.
  for (const target of Object.values(manifest.publishConfig?.exports ?? {}).flatMap((value) =>
    typeof value === 'string' ? [value] : [value.types, value.default],
  )) {
    if (!existsSync(resolve(directory, target)))
      throw new Error(`${manifest.name}: release export is missing: ${target}`);
  }
  console.log(`${manifest.name}: compiled ${Object.keys(entries).length} modules and API declarations`);
}
