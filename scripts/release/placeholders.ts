// One-time name reservation, following Gyral's bootstrap before configuring trusted publishers.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/mini';
import { NPM_REGISTRY, RELEASE_REPOSITORY, RELEASE_REPOSITORY_URL } from './identity.ts';
import { packages, ROOT } from './packages.ts';

export const packageExists = async (name: string): Promise<boolean> => {
  const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Registry read failed (${response.status}) for ${name}`);
  const data = z.object({ name: z.string() }).parse(await response.json());
  if (data.name !== name) throw new Error(`Registry package identity does not match ${name}`);
  return true;
};

export const bootstrapPlaceholders = async (options: {
  readonly publish: boolean;
  readonly npm: (args: readonly string[]) => Promise<void>;
  readonly lookup: (name: string) => Promise<boolean>;
  readonly log: (message: string) => void;
}): Promise<void> => {
  if (options.publish) await options.npm(['whoami', '--registry', NPM_REGISTRY]);
  const failed: string[] = [];
  for (const { manifest } of packages()) {
    const { name } = manifest;
    if (await options.lookup(name)) {
      options.log(`skip ${name}: already exists on npm; confirm write access before configuring its publisher`);
      continue;
    }
    const directory = mkdtempSync(join(tmpdir(), 'joystyk-placeholder-'));
    try {
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify(
          {
            name,
            version: '0.0.0',
            description: 'Reserved for the first Joystyk library release.',
            license: 'MIT',
            repository: { type: 'git', url: RELEASE_REPOSITORY_URL, directory: manifest.repository?.directory },
            homepage: `https://github.com/${RELEASE_REPOSITORY}`,
            files: ['README.md', 'LICENSE', 'NOTICE'],
            publishConfig: { access: 'public' },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(directory, 'README.md'),
        `# ${name}\n\nThe first Joystyk library release is not yet available. This placeholder reserves the package name.\n\nSource: https://github.com/${RELEASE_REPOSITORY}\n`,
      );
      copyFileSync(join(ROOT, 'LICENSE'), join(directory, 'LICENSE'));
      copyFileSync(join(ROOT, 'NOTICE'), join(directory, 'NOTICE'));
      options.log(`${options.publish ? 'publish' : 'dry-run'} ${name}@0.0.0`);
      await options.npm([
        'publish',
        directory,
        '--access',
        'public',
        '--registry',
        NPM_REGISTRY,
        '--ignore-scripts',
        ...(options.publish ? [] : ['--dry-run']),
      ]);
    } catch {
      // npm displays its own error without logging authentication arguments here.
      failed.push(name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (failed.length)
    throw new Error(`Failed: ${failed.join(', ')}. Fix npm access and rerun; existing names are skipped.`);
  options.log(
    options.publish
      ? 'Names checked. Configure each package’s trusted publisher for release.yml and the npm environment.'
      : 'Dry run only. Publishing the placeholders requires --publish and npm login.',
  );
};
