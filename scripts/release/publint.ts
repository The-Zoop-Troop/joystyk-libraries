// Isolate publint's WASM lifecycle; the parent stops this child after its JSON result.
import { readFileSync } from 'node:fs';
import { publint } from 'publint';
import { formatMessage } from 'publint/utils';
import { manifestSchema } from './packages.ts';
import { run } from './run.ts';

const tarball = process.argv[2];
if (!tarball) throw new Error('Expected one tarball');
const packed = manifestSchema.parse(JSON.parse((await run('tar', ['-xzOf', tarball, 'package/package.json'])).stdout));
const bytes = readFileSync(tarball);
const result = await publint({
  pack: { tarball: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
  level: 'suggestion',
  strict: true,
});
process.stdout.write(`${JSON.stringify(result.messages.map((message) => formatMessage(message, packed)))}\n`);
