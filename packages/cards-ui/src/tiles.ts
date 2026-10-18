import { svg, html, type ChildValue } from '@gyral/core';
import { tileName, type TileFace } from '@joystyk/kit/tiles';
const spots: readonly (readonly number[])[] = [
  [],
  [4],
  [0, 8],
  [0, 4, 8],
  [0, 2, 6, 8],
  [0, 2, 4, 6, 8],
  [0, 2, 3, 5, 6, 8],
];
const half = (n: number, y: number, numbers: boolean): ChildValue =>
  svg`<g>${spots[n]!.map((i) => svg`<circle cx=${10 + (i % 3) * 10} cy=${y + 10 + Math.floor(i / 3) * 10} r="3.1" fill="#25251f"/>`)}${numbers ? svg`<text x="3" y=${y + 9} fill="#25251f" font-size="8" font-family="system-ui">${n}</text>` : null}</g>`;
export const tileFace = (tile: TileFace, numbers = false): ChildValue =>
  html`<svg viewBox="0 0 40 80" role="img" aria-label=${tileName(tile)} width="100%" height="100%"><rect x="1" y="1" width="38" height="78" rx="4" fill="#f6efd9" stroke="#454438" stroke-width="2"/><path d="M4 40H36" stroke="#454438"/><circle cx="20" cy="40" r="1.5" fill="#80703d"/>${half(tile.a, 0, numbers)}${half(tile.b, 40, numbers)}</svg>`;
