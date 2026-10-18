// Daily prefetching for the PWA (D-46, content-pipeline.md, "Prefetching for offline play"):
// one prefetcher per daily game, which the app hands to `registerPwa`. The PWA decides when
// (at a safe point, while idle and online) and for whom (an installed app, or a pinned game);
// this decides how: through the same storage, player and content client the daily mode plays
// from, so a prefetched day plays offline. An AI-content game prefetches nothing until the
// player has accepted the notice (D-44). Everything loads lazily, on the first prefetch.
import type { Validator } from '@joystyk/contracts';
import type { LauncherServices } from './services.ts';

/** What `registerPwa` takes for each daily game. */
export type DailyPrefetch = {
  readonly gameId: string;
  prefetch(today: string): Promise<unknown>;
};

/** Prefetchers for the daily games among `gameIds` (games whose manifest lists `daily`). */
export const dailyPrefetchers = (services: LauncherServices, gameIds: readonly string[]): readonly DailyPrefetch[] =>
  gameIds.map((gameId) => ({
    gameId,
    prefetch: async (today: string) => {
      const loader = services.games[gameId];
      if (loader === undefined) return null;
      const entry = await loader.entry();
      if (!entry.manifest.modes.includes('daily')) return null;
      const player = await services.openPlayer();
      if (player.device === undefined) return null;
      if (entry.manifest.aiContent === true) {
        const preferences = await player.storage.preferences.get();
        if (!preferences.ok || preferences.value.aiContentAccepted !== true) return null;
      }
      const module = await entry.load();
      const rules = module.engine ?? module.simulation;
      if (rules === undefined) return null;
      const { createDailyClient } = await import('@joystyk/daily/browser');
      const client = createDailyClient({
        baseUrl: services.daily?.baseUrl ?? '/daily',
        gameId,
        config: rules.schemas.config as Validator<unknown>,
        storage: player.device,
        ...(services.daily?.fetch === undefined ? {} : { fetch: services.daily.fetch }),
      });
      return client.prefetch(today);
    },
  }));
