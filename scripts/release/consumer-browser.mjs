// Copied into the fresh consumer project; every import resolves installed npm tarballs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';
import { html } from '@gyral/core';
import { gyralVitePreset } from '@gyral/core/vite';
import { renderPage } from '@gyral/ssr';
import '@joystyk/ui/button';
import { joystykPwa } from '@joystyk/pwa/build';
import { createRegistry } from '@joystyk/catalog';
import { createCatalogRenderer } from '@joystyk/catalog/server';

const page = renderPage({ title: 'Installed library test', lang: 'en', body: html`<main><jy-button toggle>Installed toggle</jy-button></main>`, scripts: ['/main.js'] });
const markup = await page.text();
assert.match(markup, /<button/);
assert.match(markup, /shadowrootmode/);
await writeFile('index.html', markup);
await build({ configFile: false, logLevel: 'warn', build: { manifest: true }, plugins: [...gyralVitePreset({ types: false }).plugins, joystykPwa({
  release: 'installed-0.1.0', releaseTime: '2026-10-11T12:00:00Z',
  site: async () => ({ games: [], shellPages: ['/'], render: async () => new Response(await readFile('dist/index.html'), { headers: { 'content-type': 'text/html' } }) }),
})] });
for (const file of ['sw.js', 'sw-remove.js', 'manifest.webmanifest', 'offline.html', 'pwa-control.json', 'release.json']) assert.ok((await readFile(`dist/${file}`)).length > 0, file);
const offline = await readFile('dist/offline.html', 'utf8');
assert.match(offline, /offline-/);
const root = resolve('dist');
const built = await readFile('dist/index.html', 'utf8');
const clientEntry = built.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
assert.ok(clientEntry, 'Vite client entry');
const catalogRender = createCatalogRenderer({ origin: 'https://example.test', registry: createRegistry([]), clientEntry, styles: [] });
const catalogMarkup = await catalogRender(new URL('https://example.test/')).text();
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (new URL(request.url ?? '/', 'http://localhost').searchParams.has('catalog')) {
    response.writeHead(200, { 'content-type': 'text/html' }).end(catalogMarkup);
    return;
  }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}/`)) { response.writeHead(400).end(); return; }
  try {
    response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
let browser;
try {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  browser = await chromium.launch({ headless: true });
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', error => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${address.port}/`);
  await tab.waitForFunction(() => window.releaseReady === true);
  const button = tab.getByRole('button', { name: 'Installed toggle' });
  await button.waitFor();
  assert.equal(await button.getAttribute('aria-pressed'), 'false');
  await button.click();
  await tab.waitForFunction(() => document.querySelector('jy-button')?.shadowRoot?.querySelector('button')?.getAttribute('aria-pressed') === 'true');
  assert.ok(await tab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--jy-hue').trim().length > 0));
  await tab.goto(`http://127.0.0.1:${address.port}/?catalog=1`);
  await tab.waitForFunction(() => window.releaseReady === true && document.querySelector('jy-app')?.matches(':state(live)'));
  await tab.evaluate(() => navigator.serviceWorker.register('/sw.js'));
  await tab.waitForFunction(async () => (await navigator.serviceWorker.getRegistration('/'))?.active?.state === 'activated', undefined, { timeout: 60_000 });
  assert.deepEqual(errors, []);
  console.log('Installed browser modules, CSS, SSR hydration and service worker passed');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(ready => server.close(ready));
}
