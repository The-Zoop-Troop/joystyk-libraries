// The npm scope is explicit: adding a workspace never makes it publishable by accident.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/mini';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const PACKAGE_NAMES = [
  'contracts',
  'kit',
  'storage',
  'identity',
  'ops',
  'rooms',
  'session',
  'daily',
  'testing',
  'ui',
  'cards-ui',
  'arcade',
  'render3d',
  'launcher',
  'catalog',
  'pwa',
  'content',
] as const;

const strings = z.record(z.string(), z.string());
const targets = z.union([z.string(), z.object({ types: z.string(), default: z.string() })]);
export const manifestSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  private: z.optional(z.boolean()),
  type: z.optional(z.string()),
  license: z.optional(z.string()),
  exports: z.optional(z.record(z.string(), targets)),
  files: z.optional(z.array(z.string())),
  engines: z.optional(strings),
  repository: z.optional(z.object({ type: z.string(), url: z.string(), directory: z.string() })),
  dependencies: z.optional(strings),
  devDependencies: z.optional(strings),
  peerDependencies: z.optional(strings),
  publishConfig: z.optional(
    z.looseObject({
      access: z.optional(z.string()),
      exports: z.optional(z.record(z.string(), targets)),
    }),
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const readManifest = (directory: string): Manifest =>
  manifestSchema.parse(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')));

export const packages = () =>
  PACKAGE_NAMES.map((name) => {
    const directory = join(ROOT, 'packages', name);
    const manifest = readManifest(directory);
    if (manifest.name !== `@joystyk/${name}`)
      throw new Error(`Unexpected release package in ${directory}: ${manifest.name}`);
    return { directory, manifest };
  });

export const isTestFile = (file: string): boolean =>
  /(?:\.test[.-]|\.browser\.test\.|\.e2e\.test\.|(?:^|\/)__(?:tests|fixtures|screenshots)__\/)/.test(file);
