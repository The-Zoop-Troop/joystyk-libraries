import { expect, it } from 'vitest';
import { withoutModulePreloads, withoutPreloadResponse } from './preloads.ts';

it('removes only modulepreload links without changing executable content or styles', () => {
  const kept =
    '<script type="module" src="/entry.js"></script><link rel="stylesheet" href="/style.css"><link data-rel="modulepreload" href="/other.css"><link href="/asset?rel=modulepreload" rel="stylesheet"><script>const text="modulepreload";</script>';
  expect(
    withoutModulePreloads(
      `<link href="/a.js" rel="modulepreload"><LINK REL='modulepreload' href='/b.js'><link rel=modulepreload href=/c.js>${kept}`,
    ),
  ).toBe(kept);
});

it('preserves response headers and leaves non-HTML responses alone', async () => {
  const original = new Response('<html><link rel="modulepreload" href="/a.js"></html>', {
    headers: { 'content-type': 'text/html', 'content-length': '60', 'content-security-policy': "script-src 'self'" },
  });
  const result = await withoutPreloadResponse(original);
  expect(await result.text()).toBe('<html></html>');
  expect(result.headers.get('content-length')).toBeNull();
  expect(result.headers.get('content-security-policy')).toBe("script-src 'self'");
  const data = new Response('{}', { headers: { 'content-type': 'application/json' } });
  expect(await withoutPreloadResponse(data)).toBe(data);
});

it('preserves literal tags in scripts, styles, comments and text containers for CSP hashes', () => {
  const kept =
    '<script>const text=`<link rel=modulepreload href=/literal.js>`;</script><!-- <link rel=modulepreload href=/comment.js> --><style>.x::after{content:"<link rel=modulepreload>"}</style><textarea><link rel=modulepreload></textarea><title><link rel=modulepreload></title>';
  expect(withoutModulePreloads(`${kept}<link rel=modulepreload href=/real.js>`)).toBe(kept);
});
