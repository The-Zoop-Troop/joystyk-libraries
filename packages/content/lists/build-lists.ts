// Builds the derived word lists in this folder from a pinned SCOWL release
// (content-pipeline.md, "Word lists and licensing"). The script, not hand edits, produces
// every SCOWL-derived list, so a rebuild is reproducible:
//
//   node packages/content/lists/build-lists.ts
//
// It downloads the release, checks its SHA-256, extracts it with the system `tar`, and writes:
//
//   scowl-common.txt      every word at SCOWL size 50 or below: "common words" for player-facing text
//   scowl-vocabulary.txt  the words at sizes 55 to 70 that are not in scowl-common.txt
//   SCOWL-COPYRIGHT       SCOWL's copyright and permission notice, which must travel with the lists
//                         (no extension, so the name gate doesn't read the license text)
//
// Both lists are lowercase, one word per line, sorted by UTF-16 code unit, without possessive
// forms ("'s"). They include American spellings, capitalized words (lowercased), proper names
// and contractions from the same size levels, and leave out abbreviations. Protected game and
// franchise names (scripts/trademarked-names.json) are left out too: generated text should
// never use them, and the name gate scans this folder.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCOWL = {
  version: '2020.12.07',
  url: 'https://downloads.sourceforge.net/wordlist/scowl-2020.12.07.tar.gz',
  sha256: '5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc',
} as const;

/** The SCOWL list families that count as words (abbreviations are left out). */
const FAMILIES = [
  'english-words',
  'american-words',
  'english-upper',
  'american-upper',
  'english-contractions',
  'english-proper-names',
  'american-proper-names',
];
const COMMON_MAX = 50;
const VOCABULARY_MAX = 70;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The lowercase words in one SCOWL list file (Latin-1), without possessives. */
const readList = (file: string): string[] =>
  readFileSync(file, 'latin1')
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((word) => word !== '' && !word.endsWith("'s"));

const here = dirname(fileURLToPath(import.meta.url));

/** Protected names as single lowercase words (two-word names joined); generic names match only capitalized, so they stay. */
const protectedWords = (): Set<string> => {
  const parsed = JSON.parse(readFileSync(join(here, '../../../scripts/trademarked-names.json'), 'utf8')) as {
    names: (string | { name: string; generic?: boolean })[];
  };
  return new Set(
    parsed.names
      .map((entry) => (typeof entry === 'string' ? { name: entry } : entry))
      .filter((entry) => !('generic' in entry && entry.generic === true))
      .map((entry) =>
        entry.name
          .normalize('NFC')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, ''),
      ),
  );
};

const main = async (): Promise<void> => {
  const response = await fetch(SCOWL.url);
  if (!response.ok) throw new Error(`SCOWL download failed: HTTP ${String(response.status)}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== SCOWL.sha256) throw new Error(`SCOWL checksum mismatch: expected ${SCOWL.sha256}, got ${digest}`);

  const work = mkdtempSync(join(tmpdir(), 'scowl-'));
  try {
    writeFileSync(join(work, 'scowl.tar.gz'), archive);
    execFileSync('tar', ['-xzf', 'scowl.tar.gz'], { cwd: work });
    const root = join(work, `scowl-${SCOWL.version}`);
    const final = join(root, 'final');
    const common = new Set<string>();
    const vocabulary = new Set<string>();
    for (const name of readdirSync(final)) {
      const match = /^(.+)\.(\d+)$/.exec(name);
      if (match === null || !FAMILIES.includes(match[1] ?? '')) continue;
      const size = Number(match[2]);
      if (size > VOCABULARY_MAX) continue;
      for (const word of readList(join(final, name))) (size <= COMMON_MAX ? common : vocabulary).add(word);
    }
    for (const word of common) vocabulary.delete(word);
    for (const word of protectedWords()) {
      common.delete(word);
      vocabulary.delete(word);
    }
    const write = (file: string, words: Set<string>) =>
      writeFileSync(join(here, file), `${[...words].sort(compare).join('\n')}\n`);
    write('scowl-common.txt', common);
    write('scowl-vocabulary.txt', vocabulary);
    writeFileSync(
      join(here, 'SCOWL-COPYRIGHT'),
      `Derived from SCOWL ${SCOWL.version} (${SCOWL.url}, sha256 ${SCOWL.sha256}).\n` +
        `scowl-common.txt: sizes 10 to ${String(COMMON_MAX)}; scowl-vocabulary.txt: sizes 55 to ${String(VOCABULARY_MAX)}.\n` +
        `Families: ${FAMILIES.join(', ')}. Lowercased; possessives and protected game names removed.\n\n` +
        readFileSync(join(root, 'Copyright'), 'latin1'),
    );
    console.log(
      `scowl-common.txt: ${String(common.size)} words; scowl-vocabulary.txt: ${String(vocabulary.size)} words`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

await main();
