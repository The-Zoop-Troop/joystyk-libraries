import { describe, expect, it } from 'vitest';
import { OFFLINE_ATTRIBUTE } from './names.ts';
import { markOfflineAvailability, markOfflineHtml, markOfflineResponse } from './offline-mark.ts';

const PAGE = `<!doctype html>
<html lang="en" data-theme="auto">
<head><meta charset="utf-8"><title>Joystyk</title></head>
<body><p>&lt;html&gt; in text</p></body>
</html>
`;

describe('markOfflineHtml', () => {
  it("adds data-offline to the page's <html> tag and changes nothing else", () => {
    const marked = markOfflineHtml(PAGE);
    expect(OFFLINE_ATTRIBUTE).toBe('data-offline');
    expect(marked).toBe(PAGE.replace('<html lang="en"', '<html data-offline lang="en"'));
  });

  it('marks a bare, an uppercase and a self-closing-looking tag, never the doctype', () => {
    expect(markOfflineHtml('<!doctype html><html><body></body></html>')).toBe(
      '<!doctype html><html data-offline><body></body></html>',
    );
    expect(markOfflineHtml('<!DOCTYPE html>\n<HTML LANG="en">')).toBe('<!DOCTYPE html>\n<HTML data-offline LANG="en">');
    expect(markOfflineHtml('<html\nlang="en">')).toBe('<html data-offline\nlang="en">');
    expect(markOfflineHtml('<html/>')).toBe('<html data-offline/>');
  });

  it('marks only the first <html> tag', () => {
    expect(markOfflineHtml('<html><body><template><html></template></body></html>')).toBe(
      '<html data-offline><body><template><html></template></body></html>',
    );
  });

  it('leaves a document without an <html> tag, or one already marked, as it is', () => {
    expect(markOfflineHtml('<!doctype html><title>x</title><p>no html tag')).toBe(
      '<!doctype html><title>x</title><p>no html tag',
    );
    expect(markOfflineHtml('<htmlx><p>')).toBe('<htmlx><p>');
    const once = markOfflineHtml(PAGE);
    expect(markOfflineHtml(once)).toBe(once);
    expect(markOfflineHtml('<html lang="en" data-offline="">')).toBe('<html lang="en" data-offline="">');
  });

  it('does not take a lookalike attribute for the mark', () => {
    expect(markOfflineHtml('<html data-offline-copy="1">')).toBe('<html data-offline data-offline-copy="1">');
  });
});

it('renders accurate offline labels before paint without changing raw text or scripts', () => {
  const labels =
    '<jy-offline-availability game-id="nim" hidden></jy-offline-availability><jy-offline-availability game-id="tally" hidden></jy-offline-availability>';
  const literal = `<script>const text='${labels}';</script><!-- ${labels} -->`;
  const rendered = markOfflineAvailability(`${literal}${labels}`, ['nim']);
  expect(rendered).toBe(
    `${literal}<jy-offline-availability game-id="nim" data-available="true">Available offline</jy-offline-availability><jy-offline-availability game-id="tally" data-available="false">Unavailable offline</jy-offline-availability>`,
  );
});

describe('markOfflineResponse', () => {
  const cachedPage = (body = PAGE): Response =>
    new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(new TextEncoder().encode(body).byteLength),
        'content-security-policy': "default-src 'self'; style-src 'sha256-abc'",
        'cache-control': 'no-cache',
      },
    });

  it('marks a cached page and keeps its status and headers, except a length that no longer fits', async () => {
    const marked = await markOfflineResponse(cachedPage());
    expect(marked.status).toBe(200);
    expect(marked.statusText).toBe('OK');
    expect(marked.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(marked.headers.get('content-security-policy')).toBe("default-src 'self'; style-src 'sha256-abc'");
    expect(marked.headers.get('cache-control')).toBe('no-cache');
    expect(marked.headers.get('content-length')).toBeNull();
    expect(await marked.text()).toBe(markOfflineHtml(PAGE));
  });

  it('keeps a page that is not a success, such as a cached 404, as served but marked', async () => {
    const notFound = new Response('<!doctype html><html lang="en"><h1>Not found</h1>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });
    const marked = await markOfflineResponse(notFound);
    expect(marked.status).toBe(404);
    expect(await marked.text()).toBe('<!doctype html><html data-offline lang="en"><h1>Not found</h1>');
  });

  it('passes anything that is not an HTML document through untouched', async () => {
    const json = new Response('{"html":"<html>"}', { headers: { 'content-type': 'application/json' } });
    expect(await markOfflineResponse(json)).toBe(json);
    const untyped = new Response('<html>');
    untyped.headers.delete('content-type');
    expect(await markOfflineResponse(untyped)).toBe(untyped);
    const empty = new Response(null, { status: 204, headers: { 'content-type': 'text/html' } });
    expect(await markOfflineResponse(empty)).toBe(empty);
  });
});
