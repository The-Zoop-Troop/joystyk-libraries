// Install only real tarballs into a fresh npm project outside this checkout.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/mini';
import { packArtifacts } from './release/artifacts.ts';
import { artifactDirectory, saveArchive } from './release/archive.ts';
import { ROOT } from './release/packages.ts';
import { run } from './release/run.ts';

const artifacts = await packArtifacts(process.argv.includes('--release'));
const directory = mkdtempSync(join(tmpdir(), 'joystyk-consumer-'));
try {
  const tool = (name: string) =>
    z
      .object({ version: z.string() })
      .parse(JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'))).version;
  const dependencies = Object.fromEntries(artifacts.items.map((item) => [item.manifest.name, `file:${item.tarball}`]));
  const devDependencies = Object.fromEntries(
    ['typescript', 'vite', 'vitest', 'playwright', '@types/node', '@gyral/core', '@gyral/ssr'].map((name) => [
      name,
      tool(name),
    ]),
  );
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'joystyk-installed-consumer',
      private: true,
      type: 'module',
      dependencies,
      devDependencies,
    }),
  );
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  const entries = artifacts.items.flatMap(({ manifest }) =>
    Object.keys(manifest.exports ?? {}).map((key) => manifest.name + (key === '.' ? '' : key.slice(1))),
  );
  const modules = entries.filter((entry) => !entry.endsWith('.css'));
  const browser = modules.filter(
    (entry) =>
      ![
        '@joystyk/content',
        '@joystyk/ops',
        '@joystyk/testing',
        '@joystyk/testing/fixtures',
        '@joystyk/rooms/node',
        '@joystyk/catalog/server',
        '@joystyk/pwa/build',
      ].includes(entry),
  );
  const node = modules.filter(
    (entry) => !entry.includes('/browser') && !entry.endsWith('/client') && entry !== '@joystyk/testing',
  );
  writeFileSync(
    join(directory, 'types.ts'),
    modules.map((entry, i) => `import * as m${i} from '${entry}';`).join('\n') +
      `\nexport const api = [${modules.map((_, i) => `m${i}`).join(',')}];\n`,
  );
  const compilerOptions = {
    target: 'ES2023',
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: ['node'],
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
  };
  for (const mode of ['NodeNext', 'Bundler']) {
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          ...compilerOptions,
          module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext',
          moduleResolution: mode,
        },
        files: ['types.ts'],
      }),
    );
    await run('node', ['node_modules/typescript/bin/tsc', '--noEmit'], directory);
  }
  writeFileSync(
    join(directory, 'node.mjs'),
    `
import assert from 'node:assert/strict';
for (const entry of ${JSON.stringify(node)}) await import(entry);
const { createRng } = await import('@joystyk/kit/rng');
assert.deepEqual(createRng('installed').shuffle([1,2,3,4]), createRng('installed').shuffle([1,2,3,4]));
const { scowlVocabulary, rankedWords, defaultFilter, isPlainCommonWord } = await import('@joystyk/content');
assert.equal(scowlVocabulary().isCommon('house'), true);
assert.equal(isPlainCommonWord('coder'), true);
assert.ok(rankedWords().size > 1000);
assert.equal(defaultFilter().isListed('fuck'), true);
const { openSqliteStore } = await import('@joystyk/rooms/node');
const store = await openSqliteStore(':memory:'); store.close();
const { createMetrics } = await import('@joystyk/ops');
const metrics = createMetrics(); metrics.counter('installed_total', 'Installed').inc();
assert.match(metrics.render(), /installed_total 1/);
const { createRegistry } = await import('@joystyk/catalog');
const { createCatalogRenderer } = await import('@joystyk/catalog/server');
const render = createCatalogRenderer({ origin: 'https://example.test', registry: createRegistry([]), clientEntry: '/main.js', styles: [] });
const catalogPage = render(new URL('https://example.test/'));
assert.equal(catalogPage.status, 200);
assert.match(await catalogPage.text(), /<jy-app/);
console.log('Fresh Node imports, content assets, SQLite, metrics and catalog SSR passed');
`,
  );
  await run('node', ['node.mjs'], directory);
  writeFileSync(
    join(directory, 'consumer.test.mjs'),
    `import { runEngineConformance } from '@joystyk/testing';\nimport { nim, nimConformance } from '@joystyk/testing/fixtures';\nrunEngineConformance(nim, nimConformance);\n`,
  );
  writeFileSync(join(directory, 'vitest.config.mjs'), `export default { test: { include: ['consumer.test.mjs'] } };\n`);
  await run('node', ['node_modules/vitest/vitest.mjs', 'run'], directory);
  const imports = browser.map((entry, i) => `import * as b${i} from '${entry}';`).join('\n');
  const css = entries
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => `import '${entry}';`)
    .join('\n');
  writeFileSync(
    join(directory, 'main.js'),
    `${imports}\n${css}\nwindow.releaseModules = [${browser.map((_, i) => `b${i}`).join(',')}];\nwindow.releaseReady = true;\n`,
  );
  const template = readFileSync(join(ROOT, 'scripts/release/consumer-browser.mjs'), 'utf8');
  writeFileSync(join(directory, 'browser.mjs'), template);
  const result = await run('node', ['browser.mjs'], directory);
  console.log(result.stdout.trim());
  console.log(
    `Installed consumer passed for all ${artifacts.items.length} libraries: Node, NodeNext/Bundler types, Vitest, browser, Gyral SSR and PWA build.`,
  );
  const archive = artifactDirectory();
  if (archive) {
    await saveArchive(artifacts, archive, process.argv.includes('--release'));
    console.log(`Exact verified tarballs retained at ${archive}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
  artifacts.cleanup();
}
