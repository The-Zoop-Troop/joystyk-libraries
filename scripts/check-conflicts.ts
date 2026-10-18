// No tracked text file may contain merge-conflict markers. A merge once landed with markers
// in a design doc and every other check passed, because markers are valid Markdown.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKER = /^(<{7}|>{7})( |$)|^={7}$/;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|tgz|gz|wasm|sqlite|db)$/i;

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f !== '' && !BINARY.test(f) && !f.startsWith('vendor/') && !f.startsWith('.agents/'));

const problems: string[] = [];
for (const file of files) {
  let text: string;
  try {
    text = await readFile(new URL(file, `file://${ROOT}`), 'utf8');
  } catch {
    continue; // deleted in the working tree but still in the index
  }
  text.split('\n').forEach((line, i) => {
    if (MARKER.test(line)) problems.push(`${file}:${String(i + 1)}: merge-conflict marker "${line.slice(0, 7)}"`);
  });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    `check:conflicts: ${String(problems.length)} marker(s). Resolve the conflict, keep the intended text, and delete the marker lines.`,
  );
  process.exit(1);
}
console.log(`check:conflicts: ${String(files.length)} tracked text files have no conflict markers`);
