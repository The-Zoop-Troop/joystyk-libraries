# @joystyk/ui

Shared Gyral controls and design tokens. Import a component module once to register its custom element. The button wraps a native button and supports keyboard activation and a pressed state. Ad modules implement contextual slots and their validated wire formats.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/ui
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser. Tested with Gyral 0.3.1.

| Import | Format |
| --- | --- |
| `@joystyk/ui` | ES module and TypeScript declarations |
| `@joystyk/ui/button` | ES module and TypeScript declarations |
| `@joystyk/ui/ad-slot` | ES module and TypeScript declarations |
| `@joystyk/ui/ad-wire` | ES module and TypeScript declarations |
| `@joystyk/ui/slots` | ES module and TypeScript declarations |
| `@joystyk/ui/tokens.css` | CSS asset |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

```ts
import '@joystyk/ui/button';
import '@joystyk/ui/tokens.css';

// In a Gyral view: <jy-button toggle>Sound</jy-button>
```
