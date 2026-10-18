import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bootstrapPlaceholders, packageExists } from './placeholders.ts';
import { readManifest } from './packages.ts';

afterEach(() => vi.unstubAllGlobals());

it('previews missing names without authenticating or writing to npm', async () => {
  const calls: string[][] = [];
  const temporary: string[] = [];
  await bootstrapPlaceholders({
    publish: false,
    lookup: async () => false,
    log: () => {},
    npm: async (args) => {
      calls.push([...args]);
      expect(args).toContain('--dry-run');
      const directory = args[1]!;
      temporary.push(directory);
      const manifest = readManifest(directory);
      expect(manifest.version).toBe('0.0.0');
      expect(manifest.repository?.url).toBe('git+https://github.com/joystyk-games/game-libraries.git');
      expect(readFileSync(join(directory, 'README.md'), 'utf8')).toContain('not yet available');
      expect(existsSync(join(directory, 'LICENSE'))).toBe(true);
    },
  });
  expect(calls).toHaveLength(17);
  expect(temporary.every((directory) => !existsSync(directory))).toBe(true);
});

it('skips existing names and resumes the remaining bootstrap after a partial failure', async () => {
  const published = new Set(['@joystyk/contracts']);
  const calls: string[] = [];
  const temporary: string[] = [];
  let fail = true;
  const options = {
    publish: true,
    lookup: async (name: string) => published.has(name),
    log: () => {},
    npm: async (args: readonly string[]) => {
      if (args[0] === 'whoami') return;
      expect(args).not.toContain('--dry-run');
      const directory = args[1]!;
      temporary.push(directory);
      const { name } = readManifest(directory);
      calls.push(name);
      if (name === '@joystyk/kit' && fail) throw new Error('Registry temporarily unavailable');
      published.add(name);
    },
  };
  await expect(bootstrapPlaceholders(options)).rejects.toThrow('Failed: @joystyk/kit');
  expect(calls).not.toContain('@joystyk/contracts');
  expect(published.size).toBe(16);
  expect(temporary.every((directory) => !existsSync(directory))).toBe(true);
  calls.length = 0;
  fail = false;
  await bootstrapPlaceholders(options);
  expect(calls).toEqual(['@joystyk/kit']);
  expect(published.size).toBe(17);
});

it('stops before publishing if npm login fails', async () => {
  let lookups = 0;
  await expect(
    bootstrapPlaceholders({
      publish: true,
      lookup: async () => {
        lookups++;
        return false;
      },
      log: () => {},
      npm: async (args) => {
        expect(args[0]).toBe('whoami');
        throw new Error('Not signed in');
      },
    }),
  ).rejects.toThrow('Not signed in');
  expect(lookups).toBe(0);
});

it('treats only registry 404 as absent, without claiming ownership or availability', async () => {
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  expect(await packageExists('@joystyk/contracts')).toBe(false);
  vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }));
  await expect(packageExists('@joystyk/contracts')).rejects.toThrow('Registry read failed (403)');
  vi.stubGlobal('fetch', async () => Response.json({ name: '@other/contracts' }));
  await expect(packageExists('@joystyk/contracts')).rejects.toThrow('identity does not match');
  vi.stubGlobal('fetch', async () => Response.json({ name: '@joystyk/contracts' }));
  expect(await packageExists('@joystyk/contracts')).toBe(true);
});
