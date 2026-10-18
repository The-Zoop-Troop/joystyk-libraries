// Shared plumbing for the repository lints: the finding shape, how findings print, and a
// file walker. Every finding names the rule, the place and the fix, because the reader is
// often an agent that will act on the message without opening the docs (core belief 4).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Finding {
  /** A short kebab-case rule ID, such as `deep-import`. Tests match on it. */
  readonly rule: string;
  /** Path relative to the repository root, with forward slashes. */
  readonly file: string;
  /** 1-based line number, when the finding points at a line. */
  readonly line?: number;
  /** What is wrong. */
  readonly message: string;
  /** How to fix it. */
  readonly fix: string;
  /** `info` findings print but never fail the check. */
  readonly severity?: 'error' | 'info';
}

export const isError = (finding: Finding): boolean => finding.severity !== 'info';

export const formatFinding = (finding: Finding): string => {
  const where = finding.line === undefined ? finding.file : `${finding.file}:${String(finding.line)}`;
  const label = finding.severity === 'info' ? 'info' : 'error';
  const head = `${where}: ${label} [${finding.rule}] ${finding.message}`;
  return finding.severity === 'info' ? head : `${head}\n  Fix: ${finding.fix}`;
};

/**
 * Prints findings and returns the process exit code: 1 when any finding is an error.
 * `summary` is printed on success.
 */
export const report = (name: string, findings: readonly Finding[], summary: string): number => {
  const errors = findings.filter(isError);
  const infos = findings.filter((f) => !isError(f));
  for (const finding of infos) console.log(formatFinding(finding));
  for (const finding of errors) console.error(formatFinding(finding));
  if (errors.length > 0) {
    console.error(`\n${name}: ${String(errors.length)} error${errors.length === 1 ? '' : 's'}.`);
    return 1;
  }
  console.log(`${name}: ${summary}`);
  return 0;
};

const ALWAYS_SKIPPED = new Set(['node_modules', 'dist', 'coverage', '.git']);

/**
 * Lists files under `root/dir`, recursively, as root-relative paths with forward slashes.
 * Skips `node_modules`, `dist`, `coverage` and `.git`, plus any directory name in `skip`.
 * A missing directory yields no files.
 */
export const walk = (root: string, dir: string, skip: ReadonlySet<string> = new Set()): string[] => {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = dir === '' || dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return ALWAYS_SKIPPED.has(entry.name) || skip.has(entry.name) ? [] : walk(root, rel, skip);
      }
      return entry.isFile() ? [rel] : [];
    });
};
