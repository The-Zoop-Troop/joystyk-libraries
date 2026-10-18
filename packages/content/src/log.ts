// Structured logs: one JSON object per line on stdout, which Docker's json-file driver
// collects (hosting-and-scaling.md, "Operations"). The content service handles a secret (the
// model key) and a private endpoint, so every line passes through a redactor that replaces
// any configured secret with "[redacted]" before it is written, whatever field it hides in.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export type Fields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly debug: (msg: string, fields?: Fields) => void;
  readonly info: (msg: string, fields?: Fields) => void;
  readonly warn: (msg: string, fields?: Fields) => void;
  readonly error: (msg: string, fields?: Fields) => void;
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** Receives each line without its newline. Default: stdout. */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  /**
   * Strings that must never reach a log line: the model key, the endpoint's host. Each is
   * replaced with "[redacted]". Blank and very short strings are ignored (they would mangle
   * ordinary text).
   */
  readonly secrets?: readonly string[];
}

/** Errors don't survive JSON.stringify; turn them into plain fields. */
const plain = (value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;

/** Replaces every occurrence of each secret (and its JSON-escaped form) in `text`. */
export const redact = (text: string, secrets: readonly string[]): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    out = out.replaceAll(secret, '[redacted]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.replaceAll(escaped, '[redacted]');
  }
  return out;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = RANK[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const secrets = (options.secrets ?? []).filter((secret) => secret.trim() !== '');
  const log =
    (level: LogLevel) =>
    (msg: string, fields: Fields = {}) => {
      if (RANK[level] < min) return;
      const entry: Record<string, unknown> = { time: now().toISOString(), level, msg };
      for (const [key, value] of Object.entries(fields)) entry[key] = plain(value);
      write(redact(JSON.stringify(entry), secrets));
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/** A logger that drops everything, for tests. */
export const silentLogger: Logger = createLogger({ write: () => undefined });
