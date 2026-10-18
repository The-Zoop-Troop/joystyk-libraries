/**
 * The four version numbers every game declares. The reasons are in
 * docs/design-docs/offline-and-updates.md.
 */
export type GameVersions = {
  /** Semver of the game package, e.g. "1.4.0". */
  readonly build: string;
  /** Bump when outcomes could differ for the same inputs. */
  readonly rules: number;
  /** Bump when the saved shape changes. */
  readonly save: number;
  /** Lowest wire protocol version the game supports. */
  readonly minProtocol: number;
};
