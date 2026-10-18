import { describe, expect, it } from 'vitest';
import { closeServer, createMetrics, METRICS_CONTENT_TYPE, startMetricsServer } from './metrics.ts';

describe('createMetrics', () => {
  it('renders counters and gauges in Prometheus text format', () => {
    const metrics = createMetrics();
    const requests = metrics.counter('site_requests_total', 'Responses by status class.', [
      { class: '2xx' },
      { class: '5xx' },
    ]);
    const errors = metrics.counter('site_errors_total', 'Error lines.');
    let open = 3;
    metrics.gauge('rooms_open', 'Rooms in memory.', () => open);
    requests.inc({ class: '2xx' });
    requests.inc({ class: '2xx' }, 2);
    open = 4;
    expect(metrics.render()).toBe(
      [
        '# HELP site_requests_total Responses by status class.',
        '# TYPE site_requests_total counter',
        'site_requests_total{class="2xx"} 3',
        'site_requests_total{class="5xx"} 0',
        '# HELP site_errors_total Error lines.',
        '# TYPE site_errors_total counter',
        'site_errors_total 0',
        '# HELP rooms_open Rooms in memory.',
        '# TYPE rooms_open gauge',
        'rooms_open 4',
        '',
      ].join('\n'),
    );
    errors.inc();
    expect(errors.value()).toBe(1);
  });

  it('drops the unlabelled placeholder once a labelled value exists, and escapes label values', () => {
    const metrics = createMetrics();
    const errors = metrics.counter('rooms_errors_total', 'Error events.');
    errors.inc({ event: 'say "hi"\\\n' });
    expect(metrics.render()).toContain('rooms_errors_total{event="say \\"hi\\"\\\\\\n"} 1');
    expect(metrics.render()).not.toMatch(/^rooms_errors_total 0$/m);
  });

  it('refuses bad names, duplicates and a counter going down', () => {
    const metrics = createMetrics();
    expect(() => metrics.counter('bad-name', 'x')).toThrow(/invalid metric name/);
    metrics.counter('ok_total', 'x');
    expect(() => metrics.gauge('ok_total', 'x', () => 1)).toThrow(/twice/);
    expect(() => metrics.counter('c_total', 'x').inc({}, -1)).toThrow(/only goes up/);
  });

  it('reports a gauge that throws as NaN rather than failing the scrape', () => {
    const metrics = createMetrics();
    metrics.gauge('broken', 'x', () => {
      throw new Error('boom');
    });
    expect(metrics.render()).toContain('broken NaN');
  });
});

describe('startMetricsServer', () => {
  it('serves /metrics and nothing else', async () => {
    const server = await startMetricsServer('127.0.0.1', 0, () => 'up 1\n');
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const ok = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
      expect(await ok.text()).toBe('up 1\n');
      expect((await fetch(`http://127.0.0.1:${String(port)}/`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${String(port)}/metrics`, { method: 'POST' })).status).toBe(405);
    } finally {
      await closeServer(server);
    }
  });
});
