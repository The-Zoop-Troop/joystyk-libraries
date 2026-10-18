// Manual staged release only. Approval on npm remains a separate owner action.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/mini';
import { packArtifacts } from './release/artifacts.ts';
import { artifactDirectory, loadArchive } from './release/archive.ts';
import { packages, ROOT } from './release/packages.ts';
import { run } from './release/run.ts';
import {
  assertStageEnvironment,
  NPM_REGISTRY,
  RELEASE_REPOSITORY,
  RELEASE_REPOSITORY_URL,
} from './release/identity.ts';

if (!process.argv.includes('--stage') && !process.argv.includes('--verify-live'))
  throw new Error(
    'Use --stage in the protected hosted workflow, or --verify-live after owner approval. See docs/RELEASING.md.',
  );
const staging = process.argv.includes('--stage');
const archive = artifactDirectory();
if (staging && !archive)
  throw new Error('Staging requires --artifact-dir containing the tarballs that passed check:release');
if (staging && process.argv.includes('--verify-live')) throw new Error('Choose one release operation');
if (readdirSync(join(ROOT, '.changeset')).some((file) => file.endsWith('.md') && file !== 'README.md'))
  throw new Error('Consume pending changesets in a reviewed version change first');

if (staging) {
  assertStageEnvironment(process.env);
  for (const { manifest } of packages())
    if (manifest.repository?.url !== RELEASE_REPOSITORY_URL)
      throw new Error(`${manifest.name}: provenance repository does not match workflow source`);
  const result = await fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!result.ok || z.object({ private: z.boolean() }).parse(await result.json()).private)
    throw new Error('npm provenance requires the release source repository to be public');
}

const registryVersion = async (
  name: string,
  version: string,
): Promise<{ readonly integrity: string; readonly latest?: string } | null> => {
  const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(name)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry read failed (${response.status}) for ${name}`);
  const data = z
    .object({
      versions: z.record(z.string(), z.looseObject({ dist: z.object({ integrity: z.string() }) })),
      'dist-tags': z.record(z.string(), z.string()),
    })
    .parse(await response.json());
  const published = data.versions[version];
  return published ? { integrity: published.dist.integrity, latest: data['dist-tags']['latest'] } : null;
};

const artifacts = archive ? await loadArchive(archive) : await packArtifacts(true);
try {
  const receipt: {
    name: string;
    version: string;
    sha256: string;
    integrity: string;
    status: string;
    output?: string;
  }[] = [];
  for (const item of artifacts.items) {
    const { name, version } = item.manifest;
    const integrity = `sha512-${createHash('sha512').update(readFileSync(item.tarball)).digest('base64')}`;
    const published = await registryVersion(name, version);
    if (published) {
      if (published.integrity !== integrity)
        throw new Error(`${name}@${version}: registry bytes differ; never overwrite a published version`);
      if (!staging && published.latest !== version)
        throw new Error(`${name}: approved version is not the latest dist-tag`);
      receipt.push({ name, version, sha256: item.sha256, integrity, status: 'verified-live' });
      console.log(`${name}@${version}: identical release is live`);
    } else if (staging) {
      const result = await run('pnpm', [
        'exec',
        'npm',
        'stage',
        'publish',
        item.tarball,
        '--access',
        'public',
        '--registry',
        NPM_REGISTRY,
        '--provenance',
        '--tag',
        'latest',
        '--ignore-scripts',
      ]);
      receipt.push({
        name,
        version,
        sha256: item.sha256,
        integrity,
        status: 'staged-awaiting-owner-approval',
        output: result.stdout.trim(),
      });
      console.log(result.stdout.trim());
    } else throw new Error(`${name}@${version}: not live; owner approval is still pending`);
    // Preserve a partial receipt on the ephemeral runner if a later package fails.
    if (process.env['RUNNER_TEMP'])
      writeFileSync(
        join(process.env['RUNNER_TEMP'], 'joystyk-npm-receipt.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
  }
  console.log(
    staging
      ? 'Staging finished. Staged entries still require owner 2FA approval; no live release tags were created.'
      : `All ${artifacts.items.length} live package versions, tarball integrities and latest tags verified.`,
  );
} finally {
  artifacts.cleanup();
}
