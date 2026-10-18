import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAMES, readManifest } from './release/packages.ts';
import { RELEASE_REPOSITORY_URL } from './release/identity.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const folder of ['apps', 'games', 'deploy', 'vendor'])
  if (existsSync(join(root, folder))) throw new Error('Unapproved source directory: ' + folder);
for (const name of readdirSync(join(root, 'packages'))) {
  if (!lstatSync(join(root, 'packages', name)).isDirectory()) continue;
  if (!PACKAGE_NAMES.some((allowed) => allowed === name)) throw new Error('Unapproved package: ' + name);
}
for (const name of PACKAGE_NAMES) {
  const manifest = readManifest(join(root, 'packages', name));
  if (manifest.license !== 'MIT' || manifest.repository?.url !== RELEASE_REPOSITORY_URL)
    throw new Error('Review release identity and MIT metadata for ' + name);
}
for (const file of [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'docs/index.md',
  'docs/PLANS.md',
  'docs/QUALITY_SCORE.md',
  'docs/design-docs/core-beliefs.md',
  'docs/design-docs/decisions.md',
  '.beads/metadata.json',
])
  if (!existsSync(join(root, file))) throw new Error('Missing harness file: ' + file);
console.log('source: 17 approved libraries, public metadata and Beads/harness files present');
