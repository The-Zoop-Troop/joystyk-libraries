import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadArchive, saveArchive } from './archive.ts';
import type { Artifact } from './artifacts.ts';
import { run } from './run.ts';

// Fixtures model a separately approved release, without changing the workspace's license.
const fixtures = vi.hoisted(() =>
  ['contracts', 'kit'].map((name) => ({
    name: `@joystyk/${name}`,
    version: '0.1.0',
    private: false,
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'git+https://github.com/example/library-fixture.git',
      directory: `packages/${name}`,
    },
  })),
);
vi.mock('./packages.ts', async (original) => ({
  ...(await original<typeof import('./packages.ts')>()),
  packages: () => fixtures.map((manifest) => ({ directory: '', manifest })),
}));

let directory: string;
let archive: string;
let items: Artifact[];
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'joystyk-archive-test-'));
  archive = join(directory, 'retained');
  const source = join(directory, 'input');
  mkdirSync(join(source, 'package'), { recursive: true });
  items = [];
  for (const manifest of fixtures) {
    writeFileSync(join(source, 'package/package.json'), JSON.stringify(manifest));
    const tarball = join(directory, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
    await run('tar', ['-czf', tarball, '-C', source, 'package']);
    items.push({ manifest, tarball, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') });
  }
  await saveArchive({ directory, items, cleanup: () => {} }, archive, true);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('retains exactly the verified bytes, source commit and publication order', async () => {
  const loaded = await loadArchive(archive);
  expect(loaded.items.map((item) => [item.manifest.name, item.sha256])).toEqual(
    items.map((item) => [item.manifest.name, item.sha256]),
  );
  for (const item of loaded.items)
    expect(readFileSync(item.tarball)).toEqual(readFileSync(join(directory, basename(item.tarball))));
});

it('rejects a changed tarball before any publishing command', async () => {
  writeFileSync(join(archive, basename(items[0]!.tarball)), 'tampered');
  await expect(loadArchive(archive)).rejects.toThrow('validated tarball hash changed');
});

it('rejects archives without final owner-approved release metadata', async () => {
  await saveArchive({ directory, items, cleanup: () => {} }, archive, false);
  await expect(loadArchive(archive)).rejects.toThrow('without final license/source validation');
});

it('rejects an archive from a different source commit', async () => {
  const receipt = join(archive, 'verified-artifacts.json');
  // Deliberately corrupt a boundary fixture rather than trusting a parsed receipt.
  writeFileSync(receipt, readFileSync(receipt, 'utf8').replace(/"commit": "[^"]+"/, '"commit": "other-commit"'));
  await expect(loadArchive(archive)).rejects.toThrow('source commit does not match');
});
