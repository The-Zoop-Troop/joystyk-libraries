// Retain the exact bytes that passed installed-consumer validation for later staging.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as z from 'zod/mini';
import { assertReleaseMetadata, type Artifacts } from './artifacts.ts';
import { manifestSchema, packages } from './packages.ts';
import { run } from './run.ts';

export const artifactDirectory = (): string | undefined => {
  const option = process.argv.indexOf('--artifact-dir');
  if (option < 0) return undefined;
  const value = process.argv[option + 1];
  if (!value || value.startsWith('--')) throw new Error('--artifact-dir needs a directory');
  return resolve(value);
};

const receiptSchema = z.object({
  format: z.literal(1),
  installedConsumerPassed: z.literal(true),
  finalMetadataValidated: z.boolean(),
  commit: z.string(),
  items: z.array(z.object({ name: z.string(), version: z.string(), filename: z.string(), sha256: z.string() })),
});

export const saveArchive = async (
  artifacts: Artifacts,
  directory: string,
  finalMetadataValidated: boolean,
): Promise<void> => {
  mkdirSync(directory, { recursive: true });
  const commit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const items = artifacts.items.map((item) => {
    const filename = basename(item.tarball);
    cpSync(item.tarball, join(directory, filename));
    return { name: item.manifest.name, version: item.manifest.version, filename, sha256: item.sha256 };
  });
  writeFileSync(
    join(directory, 'verified-artifacts.json'),
    JSON.stringify({ format: 1, installedConsumerPassed: true, finalMetadataValidated, commit, items }, null, 2) + '\n',
  );
};

export const loadArchive = async (directory: string): Promise<Artifacts> => {
  const receipt = receiptSchema.parse(JSON.parse(readFileSync(join(directory, 'verified-artifacts.json'), 'utf8')));
  if (!receipt.finalMetadataValidated)
    throw new Error('Candidate archives without final license/source validation cannot be staged');
  const commit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  if (receipt.commit !== commit) throw new Error('Archive source commit does not match this checkout');
  const approved = packages();
  if (receipt.items.length !== approved.length)
    throw new Error('Release archive must contain all 17 validated libraries');
  const items = [];
  for (const [index, source] of approved.entries()) {
    const item = receipt.items[index]!;
    const filename = `${source.manifest.name.replace('@', '').replace('/', '-')}-${source.manifest.version}.tgz`;
    if (item.name !== source.manifest.name || item.version !== source.manifest.version || item.filename !== filename)
      throw new Error('Archive identity/order does not match the release source');
    const tarball = join(directory, filename);
    if (createHash('sha256').update(readFileSync(tarball)).digest('hex') !== item.sha256)
      throw new Error(`${item.name}: validated tarball hash changed`);
    const manifest = manifestSchema.parse(
      JSON.parse((await run('tar', ['-xzOf', tarball, 'package/package.json'])).stdout),
    );
    assertReleaseMetadata(manifest);
    if (
      manifest.name !== item.name ||
      manifest.version !== item.version ||
      manifest.repository?.url !== source.manifest.repository?.url ||
      manifest.license !== source.manifest.license
    )
      throw new Error('Archive manifest does not match reviewed release metadata');
    items.push({ manifest, tarball, sha256: item.sha256 });
  }
  return { directory, items, cleanup: () => {} }; // Retained/downloaded artifacts belong to the caller.
};
