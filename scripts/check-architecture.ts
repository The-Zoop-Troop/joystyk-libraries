// Architecture lint: dependency edges, deep imports, game layers, heavy libraries and
// engine purity. Rules: scripts/lint/architecture.ts; allowed edges: scripts/architecture.json.
// `--write-docs` regenerates the dependency table in ARCHITECTURE.md from that file.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, loadConfig, rewriteDocTable } from './lint/architecture.ts';
import { report } from './lint/report.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig(join(root, 'scripts/architecture.json'));

if (process.argv.includes('--write-docs')) {
  const path = join(root, 'ARCHITECTURE.md');
  const next = rewriteDocTable(readFileSync(path, 'utf8'), config);
  if (next === null) {
    console.error(
      'ARCHITECTURE.md has no <!-- architecture-table:start --> / <!-- architecture-table:end --> markers.',
    );
    process.exit(1);
  }
  writeFileSync(path, next);
  console.log('ARCHITECTURE.md: dependency table regenerated from scripts/architecture.json');
}

const { findings, files } = checkArchitecture(root, config);
process.exitCode = report('check:arch', findings, `${String(files)} source files follow the dependency rules`);
