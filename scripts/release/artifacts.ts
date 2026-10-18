import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/mini';
import { isTestFile, manifestSchema, packages, ROOT, type Manifest } from './packages.ts';
import { run } from './run.ts';

export type Artifact = { readonly manifest: Manifest; readonly tarball: string; readonly sha256: string };
export type Artifacts = {
  readonly directory: string;
  readonly items: readonly Artifact[];
  readonly cleanup: () => void;
};

const lint = (tarball: string): Promise<readonly string[]> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts/release/publint.ts'), tarball], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      result: readonly string[] | undefined,
      problem: Error | undefined;
    const timer = setTimeout(() => {
      problem = new Error('publint exceeded 60 seconds');
      child.kill('SIGKILL');
    }, 60_000);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes('\n') || result !== undefined || problem !== undefined) return;
      try {
        result = z.array(z.string()).parse(JSON.parse(stdout.split('\n')[0]!));
      } catch (error) {
        problem = error instanceof Error ? error : new Error(String(error));
      }
      child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      problem = error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (problem !== undefined) reject(problem);
      else if (result !== undefined) resolve(result);
      else reject(new Error(`publint exited ${String(code)}: ${stderr}`));
    });
  });

export const assertReleaseMetadata = (manifest: Manifest): void => {
  if (!['MIT', 'Apache-2.0'].includes(manifest.license ?? ''))
    throw new Error(`${manifest.name}: owner-approved release license is missing`);
  if (!manifest.repository?.url.startsWith('git+https://github.com/') || !manifest.repository.url.endsWith('.git'))
    throw new Error(`${manifest.name}: release source repository is missing`);
};

export const packArtifacts = async (release = false): Promise<Artifacts> => {
  const directory = mkdtempSync(join(tmpdir(), 'joystyk-pack-'));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  const items: Artifact[] = [];
  try {
    const approved = packages();
    const versions = new Map(approved.map(({ manifest }) => [manifest.name, manifest.version]));
    if (new Set(versions.values()).size !== 1) throw new Error('The fixed release group must share one version');
    // A standalone public library source need not contain private applications/games.
    for (const folder of ['packages', 'apps', 'games'])
      for (const entry of existsSync(join(ROOT, folder))
        ? readdirSync(join(ROOT, folder), { withFileTypes: true })
        : []) {
        if (!entry.isDirectory() || !existsSync(join(ROOT, folder, entry.name, 'package.json'))) continue;
        const workspace = manifestSchema.parse(
          JSON.parse(readFileSync(join(ROOT, folder, entry.name, 'package.json'), 'utf8')),
        );
        if (folder === 'packages' && versions.has(workspace.name)) continue;
        if (workspace.private !== true)
          throw new Error(`${folder}/${entry.name} is outside the approved release scope and must stay private`);
      }
    const seen = new Set<string>();
    for (const { manifest } of approved) {
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (dependency.startsWith('@joystyk/') && !seen.has(dependency))
          throw new Error(`${manifest.name}: release order must put ${dependency} first`);
      }
      seen.add(manifest.name);
    }
    for (const { directory: source, manifest } of approved) {
      if (manifest.private || manifest.version === '0.0.0')
        throw new Error(`${manifest.name}: package has not been prepared for versioning`);
      if (release) assertReleaseMetadata(manifest);
      await run('pnpm', ['pack', '--pack-destination', directory], source);
      const tarball = join(directory, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
      const files = (await run('tar', ['-tzf', tarball])).stdout.trim().split('\n');
      if (files.some((file) => !file.startsWith('package/') || file.includes('..')))
        throw new Error(`${manifest.name}: invalid tarball path`);
      const packed = manifestSchema.parse(
        JSON.parse((await run('tar', ['-xzOf', tarball, 'package/package.json'])).stdout),
      );
      const paths = files.map((file) => file.slice('package/'.length));
      const required = [
        'package.json',
        'README.md',
        'CHANGELOG.md',
        'NOTICE',
        ...(release || manifest.license ? ['LICENSE'] : []),
      ];
      for (const file of required) if (!paths.includes(file)) throw new Error(`${manifest.name}: missing ${file}`);
      for (const file of paths) {
        const data = manifest.name === '@joystyk/content' && /^lists\/(?:[^/]+\.txt|SCOWL-COPYRIGHT)$/.test(file);
        if (
          !data &&
          !['package.json', 'README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md'].includes(file) &&
          !file.startsWith('dist/')
        )
          throw new Error(`${manifest.name}: unexpected file ${file}`);
        if (isTestFile(file)) throw new Error(`${manifest.name}: test material in tarball: ${file}`);
      }
      if (packed.private || packed.name !== manifest.name || packed.version !== manifest.version)
        throw new Error(`${manifest.name}: incorrect packed identity`);
      const specs = [packed.dependencies, packed.devDependencies, packed.peerDependencies].flatMap((field) =>
        Object.values(field ?? {}),
      );
      if (specs.some((spec) => /^(?:workspace|catalog):/.test(spec)))
        throw new Error(`${manifest.name}: unresolved dependency protocol`);
      for (const target of Object.values(packed.exports ?? {}).flatMap((value) =>
        typeof value === 'string' ? [value] : [value.types, value.default],
      )) {
        if (!target.startsWith('./dist/') || !paths.includes(target.slice(2)))
          throw new Error(`${manifest.name}: missing compiled export ${target}`);
      }
      for (const [dependency, version] of Object.entries(packed.dependencies ?? {})) {
        if (dependency.startsWith('@joystyk/') && versions.get(dependency) !== version)
          throw new Error(`${manifest.name}: unapproved or mismatched release dependency ${dependency}@${version}`);
      }
      if (manifest.name === '@joystyk/content')
        for (const file of [
          'SCOWL-COPYRIGHT',
          'scowl-common.txt',
          'scowl-vocabulary.txt',
          'scowl-ranked.txt',
          'common-extra.txt',
          'blocklist.txt',
          'sensitive.txt',
        ]) {
          if (!paths.includes(`lists/${file}`)) throw new Error(`Missing content runtime data: ${file}`);
        }
      if (manifest.name === '@joystyk/contracts') {
        const declaration = (await run('tar', ['-xzOf', tarball, 'package/dist/standard-schema.d.ts'])).stdout;
        if (
          !declaration.includes('Copyright (c) 2024 Colin McDonnell') ||
          !declaration.includes('Permission is hereby granted')
        )
          throw new Error('Standard Schema attribution was lost in declaration emission');
      }
      const messages = await lint(tarball);
      if (messages.length) throw new Error(`${manifest.name}: publint\n${messages.join('\n')}`);
      // CSS exports are assets, checked in the browser consumer rather than TS resolution.
      const typedEntries = Object.entries(packed.exports ?? {})
        .filter(([, target]) => typeof target !== 'string')
        .map(([key]) => key);
      await run('pnpm', [
        'exec',
        'attw',
        tarball,
        '--profile',
        'esm-only',
        '--format',
        'ascii',
        '--no-color',
        '--entrypoints',
        ...typedEntries,
      ]);
      const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
      items.push({ manifest: packed, tarball, sha256 });
      console.log(`${manifest.name}@${manifest.version}: tarball, exports, dependencies and types verified`);
    }
    if (release && !existsSync(join(ROOT, 'packages', 'LICENSE')))
      throw new Error('Library release license is missing');
    return { directory, items, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
};
