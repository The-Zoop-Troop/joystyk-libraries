# @joystyk/cards-ui

Shared card tables, hands and solitaire controls for Gyral games. A game supplies a public table layout and intentions; these components handle pointer, keyboard and screen-reader interaction. Keep game authority in the engine.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/cards-ui
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser. Tested with Gyral 0.3.1.

| Import | Format |
| --- | --- |
| `@joystyk/cards-ui` | ES module and TypeScript declarations |
| `@joystyk/cards-ui/controller` | ES module and TypeScript declarations |
| `@joystyk/cards-ui/layout` | ES module and TypeScript declarations |
| `@joystyk/cards-ui/solitaire` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

```ts
import { CardTable, CardHand } from '@joystyk/cards-ui';
import { EMPTY_LAYOUT, DEFAULT_OPTIONS } from '@joystyk/cards-ui/layout';

// CardTable and CardHand register <jy-card-table> and <jy-card-hand>.
// Bind the layout/options properties from your Gyral parent.
```
