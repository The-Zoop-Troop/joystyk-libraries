// The docs lint's rules: links and anchors resolve, design docs and product specs are
// indexed, AGENTS.md stays a short map, and decision IDs exist. The CLI is scripts/check-docs.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Finding } from './report.ts';

/** Markdown under these prefixes is vendored, generated or a deliberately broken fixture. */
export const IGNORED_PREFIXES = ['.agents/skills/', 'vendor/', 'node_modules/', '.claude/', 'scripts/__fixtures__/'];
export const INDEXED_DIRS = ['docs/design-docs', 'docs/product-specs'];
export const AGENTS_MAX_LINES = 110;
export const DECISIONS_FILE = 'docs/design-docs/decisions.md';

export const isCheckedDoc = (path: string): boolean =>
  path.endsWith('.md') &&
  !IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
  !path.includes('/node_modules/');

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Blanks fenced code blocks and HTML comments, keeping line breaks so line numbers hold. */
export const maskCode = (text: string): string => {
  const lines = text.split('\n');
  let fence: string | null = null;
  const masked = lines.map((line) => {
    const match = FENCE.exec(line);
    if (fence === null) {
      if (match?.[1] !== undefined) {
        fence = match[1];
        return '';
      }
      return line;
    }
    if (
      match?.[1] !== undefined &&
      match[1][0] === fence[0] &&
      match[1].length >= fence.length &&
      line.trim() === match[1]
    )
      fence = null;
    return '';
  });
  return masked.join('\n').replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
};

/** Also blanks inline code spans, so `[a](b)` inside backticks is not read as a link. */
const maskInlineCode = (line: string): string =>
  line.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (span) => ' '.repeat(span.length));

export interface Link {
  readonly target: string;
  readonly line: number;
}

/** Reads a link destination starting just after `](`, honouring `<...>` and nested parentheses. */
const readDestination = (line: string, start: number): string | null => {
  if (line[start] === '<') {
    const end = line.indexOf('>', start);
    return end === -1 ? null : line.slice(start + 1, end);
  }
  let depth = 0;
  let i = start;
  for (; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ' ' || ch === '\t') {
      break;
    }
  }
  return line.slice(start, i);
};

/** Inline links and images, reference definitions, and `href`/`src` attributes. */
export const extractLinks = (text: string): Link[] => {
  const links: Link[] = [];
  maskCode(text)
    .split('\n')
    .forEach((raw, index) => {
      const line = maskInlineCode(raw);
      const lineNumber = index + 1;
      for (let at = line.indexOf(']('); at !== -1; at = line.indexOf('](', at + 2)) {
        const target = readDestination(line, at + 2);
        if (target !== null && target !== '') links.push({ target, line: lineNumber });
      }
      const definition = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line);
      if (definition?.[1] !== undefined) links.push({ target: definition[1], line: lineNumber });
      for (const match of line.matchAll(/<(?:a|img)\b[^>]*?\s(?:href|src)="([^"]+)"/gi)) {
        if (match[1] !== undefined) links.push({ target: match[1], line: lineNumber });
      }
    });
  return links;
};

/** GitHub's heading anchor for some heading text (github-slugger, without the duplicate suffix). */
export const githubSlug = (heading: string): string =>
  heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~]/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+([^_]+?)_+(?=[^\p{L}\p{N}]|$)/gu, '$1$2')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');

/** Every anchor a document offers: heading slugs (with -1, -2 for repeats) and HTML ids. */
export const anchorsOf = (text: string): Set<string> => {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const addHeading = (heading: string): void => {
    const slug = githubSlug(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${String(count)}`);
  };
  const lines = maskCode(text).split('\n');
  lines.forEach((line, index) => {
    const atx = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (atx?.[1] !== undefined) {
      addHeading(atx[1]);
    } else {
      const next = lines[index + 1] ?? '';
      if (/^ {0,3}(=+|-+)\s*$/.test(next) && line.trim() !== '' && !/^\s*([|>*#-]|\d+\.)/.test(line))
        addHeading(line.trim());
    }
    for (const match of line.matchAll(/\s(?:id|name)="([^"]+)"/g)) if (match[1] !== undefined) anchors.add(match[1]);
  });
  return anchors;
};

const lineCount = (text: string): number => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

interface Resolved {
  /** Root-relative target path; `''` for the linking file itself. */
  readonly path: string;
  readonly anchor: string | null;
  readonly outside: boolean;
}

/** Resolves a link from `file`; null for external URLs. */
export const resolveLink = (file: string, target: string): Resolved | null => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const hash = target.indexOf('#');
  const pathPart = decode((hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/, ''));
  const anchor = hash === -1 ? null : decode(target.slice(hash + 1));
  if (pathPart === '') return { path: file, anchor, outside: false };
  const joined = pathPart.startsWith('/')
    ? posix.normalize(pathPart.slice(1))
    : posix.normalize(posix.join(posix.dirname(file), pathPart));
  const path = joined.replace(/\/$/, '');
  return { path, anchor, outside: path === '..' || path.startsWith('../') };
};

const RELATIVE_TO = /^<!--\s*check-docs:\s*links-relative-to\s+(\S+?)\/?\s*-->\s*$/m;

/**
 * The path links in `file` are resolved from. A template that is meant to be copied
 * elsewhere declares its destination folder with
 * `<!-- check-docs: links-relative-to docs/product-specs/games/ -->` on a line of its own,
 * and its links are checked as if it lived there.
 */
export const linkBase = (file: string, text: string): string => {
  const match = RELATIVE_TO.exec(text);
  return match?.[1] === undefined ? file : `${match[1]}/${posix.basename(file)}`;
};

export interface DocsResult {
  readonly findings: Finding[];
  readonly links: number;
}

/**
 * Checks the markdown files `files` (root-relative) under `root`. Link targets may be any
 * file on disk; anchors are checked in markdown targets.
 */
export const checkDocs = (root: string, files: readonly string[]): DocsResult => {
  const docs = files.filter(isCheckedDoc);
  const findings: Finding[] = [];
  const cache = new Map<string, string | null>();
  const read = (path: string): string | null => {
    if (!cache.has(path)) {
      try {
        cache.set(path, readFileSync(join(root, path), 'utf8'));
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path) ?? null;
  };
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (path: string): Set<string> => {
    let anchors = anchorCache.get(path);
    if (anchors === undefined) {
      anchors = anchorsOf(read(path) ?? '');
      anchorCache.set(path, anchors);
    }
    return anchors;
  };
  const byBasename = (path: string): string[] => docs.filter((doc) => posix.basename(doc) === posix.basename(path));

  let links = 0;
  const linkedFrom = new Map<string, Set<string>>();
  for (const file of docs) {
    const text = read(file);
    if (text === null) continue;
    const targets = new Set<string>();
    linkedFrom.set(file, targets);
    const base = linkBase(file, text);
    for (const link of extractLinks(text)) {
      const resolved = resolveLink(base, link.target);
      if (resolved === null) continue;
      links += 1;
      const at = { file, line: link.line };
      if (resolved.outside) {
        findings.push({
          rule: 'outside-repo',
          severity: 'info',
          ...at,
          message: `\`${link.target}\` points outside the repository; it is not checked.`,
          fix: 'None needed if the link is a deliberate pointer to a sibling repository.',
        });
        continue;
      }
      targets.add(resolved.path);
      if (!existsSync(join(root, resolved.path))) {
        const candidates = byBasename(resolved.path).map((c) => posix.relative(posix.dirname(base), c));
        findings.push({
          rule: 'broken-link',
          ...at,
          message: `\`${link.target}\` points to ${resolved.path}, which does not exist.`,
          fix:
            candidates.length > 0
              ? `Did you mean \`${candidates.join('` or `')}\`? Paths are relative to the linking file.`
              : 'Point the link at an existing file (paths are relative to the linking file), or remove it.',
        });
        continue;
      }
      if (resolved.anchor !== null && resolved.anchor !== '' && resolved.path.endsWith('.md')) {
        const anchors = anchorsFor(resolved.path);
        if (!anchors.has(resolved.anchor) && !anchors.has(resolved.anchor.toLowerCase())) {
          findings.push({
            rule: 'broken-anchor',
            ...at,
            message: `\`${link.target}\`: ${resolved.path} has no heading with the anchor #${resolved.anchor}.`,
            fix: 'Link to an existing heading. Anchors are GitHub slugs: lowercase, punctuation dropped, spaces turned into hyphens (`## Resolved questions (2026-10-08)` is `#resolved-questions-2026-10-08`).',
          });
        }
      }
    }
  }

  for (const dir of INDEXED_DIRS) {
    const index = `${dir}/index.md`;
    const members = docs.filter((doc) => doc.startsWith(`${dir}/`) && doc !== index);
    if (members.length === 0) continue;
    const indexed = linkedFrom.get(index);
    if (indexed === undefined) {
      findings.push({
        rule: 'missing-index',
        file: index,
        message: `${dir}/ has documents but no index.md.`,
        fix: `Create ${index} with a table linking every document in ${dir}/.`,
      });
      continue;
    }
    for (const doc of members.filter((m) => !indexed.has(m))) {
      findings.push({
        rule: 'unindexed-doc',
        file: doc,
        message: `${doc} is not linked from ${index}.`,
        fix: `Add a row for it to the table in ${index}, with its status, so readers can find it.`,
      });
    }
  }

  const agents = read('AGENTS.md');
  if (agents !== null && docs.includes('AGENTS.md') && lineCount(agents) > AGENTS_MAX_LINES) {
    findings.push({
      rule: 'agents-length',
      file: 'AGENTS.md',
      line: AGENTS_MAX_LINES + 1,
      message: `AGENTS.md has ${String(lineCount(agents))} lines; the limit is ${String(AGENTS_MAX_LINES)}.`,
      fix: 'AGENTS.md is a map, not a manual (core belief 2). Move the detail into the document that owns the topic and leave a one-line pointer.',
    });
  }

  const decisions = read(DECISIONS_FILE);
  if (decisions !== null) {
    const defined = new Set([...decisions.matchAll(/^\|\s*([DP]-\d+)\s*\|/gm)].map((m) => m[1]));
    for (const file of docs) {
      maskCode(read(file) ?? '')
        .split('\n')
        .forEach((line, index) => {
          for (const match of line.matchAll(/\b([DP]-\d{2,})\b/g)) {
            if (defined.has(match[1])) continue;
            findings.push({
              rule: 'unknown-decision',
              file,
              line: index + 1,
              message: `${String(match[1])} is not an entry in ${DECISIONS_FILE}.`,
              fix: `Use an ID from ${DECISIONS_FILE}, or record the decision there first (a table row starting \`| ${String(match[1])} |\`).`,
            });
          }
        });
    }
  }

  return { findings, links };
};
