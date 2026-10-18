// A minimal Prometheus text-format registry (exposition format 0.0.4) and its listener. The
// services count a handful of things (DEPLOY.md, "Metrics"); a client library would be more
// than they need. Labels carry only fixed vocabularies, such as a status class, a game ID or a
// log event name: never an address, a token, a room code or a name, because every visitor may
// be a child (D-26).
//
// The listener runs on its own port (METRICS_PORT), never the service's public one. Traefik
// routes only the port its labels name, and Compose publishes nothing, so the metrics are
// reachable only from containers on the same Docker network.
import { createServer, type Server } from 'node:http';

export type Labels = Readonly<Record<string, string>>;

export interface Counter {
  inc(labels?: Labels, by?: number): void;
  /** The current value for these labels (tests, and gauges derived from counters). */
  value(labels?: Labels): number;
}

export interface Metrics {
  /** A counter; `seed` lists label sets reported as 0 before their first increment. */
  counter(name: string, help: string, seed?: readonly Labels[]): Counter;
  /** A gauge read at scrape time. */
  gauge(name: string, help: string, read: () => number): void;
  /** Every metric, in registration order, in Prometheus text format. */
  render(): string;
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const escapeLabel = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const escapeHelp = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

const labelKey = (labels: Labels): string => {
  const names = Object.keys(labels).sort();
  for (const name of names) if (!LABEL.test(name)) throw new Error(`invalid label name ${name}`);
  return names.length === 0 ? '' : `{${names.map((name) => `${name}="${escapeLabel(labels[name] ?? '')}"`).join(',')}}`;
};

const formatValue = (value: number): string =>
  Number.isFinite(value) ? String(value) : Number.isNaN(value) ? 'NaN' : value > 0 ? '+Inf' : '-Inf';

export const createMetrics = (): Metrics => {
  const sections: (() => string)[] = [];
  const names = new Set<string>();
  const register = (name: string): void => {
    if (!NAME.test(name)) throw new Error(`invalid metric name ${name}`);
    if (names.has(name)) throw new Error(`${name} is registered twice`);
    names.add(name);
  };

  return {
    counter: (name, help, seed = []) => {
      register(name);
      const values = new Map<string, number>();
      for (const labels of seed) values.set(labelKey(labels), 0);
      if (seed.length === 0) values.set('', 0);
      sections.push(() =>
        [
          `# HELP ${name} ${escapeHelp(help)}`,
          `# TYPE ${name} counter`,
          ...[...values].map(([key, value]) => `${name}${key} ${formatValue(value)}`),
        ].join('\n'),
      );
      return {
        inc: (labels = {}, by = 1) => {
          if (!(by >= 0)) throw new Error('a counter only goes up');
          const key = labelKey(labels);
          values.set(key, (values.get(key) ?? 0) + by);
          // An unlabelled zero is only a placeholder once labelled values exist.
          if (key !== '' && seed.length === 0 && values.get('') === 0) values.delete('');
        },
        value: (labels = {}) => values.get(labelKey(labels)) ?? 0,
      };
    },
    gauge: (name, help, read) => {
      register(name);
      sections.push(() => {
        let value: number;
        try {
          value = read();
        } catch {
          value = Number.NaN;
        }
        return [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} gauge`, `${name} ${formatValue(value)}`].join(
          '\n',
        );
      });
    },
    render: () => `${sections.map((section) => section()).join('\n')}\n`,
  };
};

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Serves `GET /metrics` on its own port. Anything else is 404. Resolves once listening. */
export const startMetricsServer = (host: string, port: number, render: () => string): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://metrics.invalid').pathname;
      if (path !== '/metrics') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response
          .writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
          .end('Method not allowed\n');
        return;
      }
      const body = render();
      response
        .writeHead(200, { 'content-type': METRICS_CONTENT_TYPE, 'cache-control': 'no-store' })
        .end(request.method === 'HEAD' ? undefined : body);
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });

/** Closes a listener and resolves when it has closed. */
export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
