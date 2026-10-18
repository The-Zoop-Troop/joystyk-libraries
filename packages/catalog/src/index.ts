// @joystyk/catalog: the manifest registry, the slot registry, the route table, head metadata
// and the wire types. Components live behind `./client` (browser entry) and `./server`
// (request-time renderer); the document stylesheet is `./styles.css`.
export {
  ADVERTISE_EMAIL,
  CONTACT_HANDLED_RETENTION_DAYS,
  CONTACT_HONEYPOT,
  CONTACT_INTENT,
  CONTACT_LIMITS,
  CONTACT_RETENTION_MONTHS,
  CREATIVE_SPECS,
  REPLY_BUSINESS_DAYS,
  SLOT_NAMES,
  type ContactFormState,
} from './advertise.ts';
export { CATEGORIES, findCategory, type CategoryDefinition } from './categories.ts';
export { toGyralHead, openGraph } from './head.ts';
export { MODE_LABELS, STATUS_LABELS, playersLabel } from './labels.ts';
export { PLACEHOLDER_ENTRIES } from './placeholders.ts';
export {
  RegistryError,
  createRegistry,
  defineEntry,
  type CatalogEntry,
  type Listing,
  type Registry,
} from './registry.ts';
export {
  ADVERTISE_PATH,
  ADVERTISE_POLICY_PATH,
  ADVERTISE_SENT_PATH,
  categoryPath,
  gamePath,
  pageFor,
  pathOf,
  samePage,
  site,
  type Page,
} from './routes.ts';
export { SITE_NAME, headFor, pageTitleOf, playModes, type Head, type JsonLd } from './seo.ts';
// The slot registry lives in @joystyk/ui beside <ad-slot>; re-exported for catalog users.
export {
  SLOTS,
  SLOT_IDS,
  isSlotId,
  slot,
  type SlotDefinition,
  type SlotId,
  type SlotSize,
  type SlotSurface,
  type TargetingKey,
} from '@joystyk/ui/slots';
export { CatalogStateSchema, emptyCatalog, type CatalogState } from './store.ts';
export {
  CategoryInfoSchema,
  GAME_STATUSES,
  GameDetailSchema,
  GameSummaryListSchema,
  GameSummarySchema,
  MODES,
  type CategoryInfo,
  type GameDetail,
  type GameStatus,
  type GameSummary,
} from './wire.ts';
