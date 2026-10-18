// Docs lint: relative links and anchors resolve, docs are indexed, AGENTS.md stays short,
// and decision IDs exist. Rules: scripts/lint/docs.ts. It checks markdown that git tracks
// or would track (untracked files that aren't ignored), so a new doc is checked before its
// first commit.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocs, isCheckedDoc } from './lint/docs.ts';
import { report, walk } from './lint/report.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

const markdownFiles = (): string[] => {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split('\0').filter((file) => file !== '' && existsSync(join(root, file)));
  } catch {
    return walk(root, '', new Set(['.git', 'vendor', '.agents', '.claude', '.beads'])).filter((file) =>
      file.endsWith('.md'),
    );
  }
};

const files = markdownFiles().filter(isCheckedDoc);
const { findings, links } = checkDocs(root, files);
process.exitCode = report(
  'check:docs',
  findings,
  `${String(files.length)} markdown files, ${String(links)} relative links resolve`,
);
