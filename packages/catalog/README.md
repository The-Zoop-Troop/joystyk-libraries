# @joystyk/catalog

Catalog models, server rendering and the browser application shell. Supply game metadata and routing data from your application. The browser entry registers the catalog components and installs router drivers on the document root; load it in the browser.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/catalog
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser. Tested with Gyral 0.3.1.

| Import | Format |
| --- | --- |
| `@joystyk/catalog` | ES module and TypeScript declarations |
| `@joystyk/catalog/client` | ES module and TypeScript declarations |
| `@joystyk/catalog/server` | ES module and TypeScript declarations |
| `@joystyk/catalog/styles.css` | CSS asset |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

```ts
import '@joystyk/catalog/client';
import '@joystyk/catalog/styles.css';

// Server rendering helpers are available separately from @joystyk/catalog/server.
```
