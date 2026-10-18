// Builds scowl-ranked.txt, the ranked word list that grid games build their answers from
// (content-pipeline.md, "Word lists and licensing"; crossword.md, "The crossword word list";
// word-flux.md, "Words"). Like build-lists.ts, the script, not hand edits, produces the file:
//
//   node packages/content/lists/build-ranked.ts
//
// It downloads the same pinned SCOWL release as build-lists.ts, checks its SHA-256, and writes
// one line per word, "<word> <size>", where size is the smallest SCOWL size level (10 to 60)
// that lists the word. A lower size means a more common word. Only the lowercase word
// families count (english-words and american-words): proper names, capitalized words,
// abbreviations and contractions are left out, so no answer is a name or an abbreviation.
// Words are 3 to 12 letters a–z, sorted by UTF-16 code unit. Protected game and franchise
// names (scripts/trademarked-names.json) are left out, as in build-lists.ts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOWL = {
  version: '2020.12.07',
  url: 'https://downloads.sourceforge.net/wordlist/scowl-2020.12.07.tar.gz',
  sha256: '5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc',
} as const;

/** Lowercase word families only: no names, capitalized words, abbreviations or contractions. */
const FAMILIES = ['english-words', 'american-words'];
const MAX_SIZE = 60;
const WORD = /^[a-z]{3,12}$/;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const here = dirname(fileURLToPath(import.meta.url));

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

  const work = mkdtempSync(join(tmpdir(), 'scowl-ranked-'));
  try {
    writeFileSync(join(work, 'scowl.tar.gz'), archive);
    execFileSync('tar', ['-xzf', 'scowl.tar.gz'], { cwd: work });
    const final = join(work, `scowl-${SCOWL.version}`, 'final');
    const sizes = new Map<string, number>();
    for (const name of readdirSync(final)) {
      const match = /^(.+)\.(\d+)$/.exec(name);
      if (match === null || !FAMILIES.includes(match[1] ?? '')) continue;
      const size = Number(match[2]);
      if (size > MAX_SIZE) continue;
      for (const line of readFileSync(join(final, name), 'latin1').split('\n')) {
        const word = line.trim();
        if (!WORD.test(word)) continue;
        const known = sizes.get(word);
        if (known === undefined || size < known) sizes.set(word, size);
      }
    }
    for (const word of protectedWords()) sizes.delete(word);
    const lines = [...sizes.keys()].sort(compare).map((word) => `${word} ${String(sizes.get(word))}`);
    writeFileSync(join(here, 'scowl-ranked.txt'), `${lines.join('\n')}\n`);
    console.log(`scowl-ranked.txt: ${String(lines.length)} words`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

await main();
