// What the "Advertise with us" pages and the site share: slot names for people, the contact
// form's fields and limits, how long a message is kept, the creative specs the ad store
// enforces, and the advertiser-facing summary of the creative policy. The policy itself, with
// its sources, is docs/product-specs/advertising-policy.md; change both together
// (scripts/advertising-policy.test.ts checks the categories, the rating line and the spec numbers).
import type { FormFields } from '@gyral/core';
import type { SlotDefinition, SlotId, SlotSurface } from '@joystyk/ui/slots';

/** A slot's name on the advertise pages and in the contact form. */
export const SLOT_NAMES: Readonly<Record<SlotId, string>> = {
  'index-hero': 'Home page banner',
  'index-inline': 'Home page inline banner',
  'category-rail': 'Side rail',
  'game-page': 'Game page rectangle',
  results: 'Game-over rectangle',
  'daily-presenting': 'Daily presenting sponsor',
};

/** Where a surface is, in words. */
export const SURFACE_NAMES: Readonly<Record<SlotSurface, string>> = {
  home: 'the home page',
  category: 'category pages',
  game: 'game pages',
  results: 'the game-over screen',
  daily: 'daily games',
};

/** "728 × 90 px". */
export const sizeLabel = (size: { readonly width: number; readonly height: number }): string =>
  `${String(size.width)} × ${String(size.height)} px`;

/** The box a slot's preview draws: its wide box, or its narrow one if it has no wide box. */
export const previewSize = (s: SlotDefinition) => s.sizes.wide ?? s.sizes.narrow ?? { width: 0, height: 0 };

// --- The contact form ---------------------------------------------------------------------

/** The form's `data-intent` name: `IntentRejected.intent` when the server rejects a post. */
export const CONTACT_INTENT = 'SendContact';

/** Longest value each text field takes, in characters. The markup and the server share them. */
export const CONTACT_LIMITS = { name: 100, company: 100, email: 254, message: 2000 } as const;

/**
 * The honeypot: a field people never see (CSS hides it) and bots tend to fill. A post with
 * anything in it is answered like a real one and thrown away.
 */
export const CONTACT_HONEYPOT = 'website';

/**
 * The longest a message is kept, counted from when it arrives, handled or not
 * (advertising-policy.md, section 9). The page quotes this number.
 */
export const CONTACT_RETENTION_MONTHS = 12;

/** How long a message is kept after it is marked handled, if that comes sooner. */
export const CONTACT_HANDLED_RETENTION_DAYS = 90;

/** Where advertisers can write instead of using the form. */
export const ADVERTISE_EMAIL = 'info@joystyk.com';

/** The reply time the thank-you page promises, in business days. */
export const REPLY_BUSINESS_DAYS = 3;

/** A rejected post, as the page re-renders it: what was sent and the errors per field. */
export interface ContactFormState {
  readonly values: FormFields;
  /** Errors per field name; '' holds form-level errors (rate limit, a full inbox). */
  readonly errors: Readonly<Record<string, readonly string[]>>;
}

// --- Creative specs ---------------------------------------------------------------------

/**
 * The technical limits every creative meets (advertising-policy.md, section 7). The site's
 * ad store enforces these numbers, and the policy page quotes them.
 */
export const CREATIVE_SPECS = {
  /** Largest image file, in KB of 1,024 bytes. */
  imageKb: 150,
  /** An image may be at most this many times its box's CSS pixels on each side. */
  density: 2,
  /** Longest alt text, in characters. */
  alt: 125,
  /** Longest headline, in characters. */
  headline: 40,
  /** Longest headline for a creative that runs only as the daily presenting line. */
  presentingHeadline: 60,
} as const;

// --- The creative policy, for advertisers ------------------------------------------------

/** The oldest ratings an advertised film, show, game or app may carry (policy sections 1 and 2). */
export const MEDIA_RATINGS = 'G, U, PEGI 3 or ESRB Everyone';

export interface PolicyItem {
  readonly name: string;
  readonly detail: string;
}

/** The rules in brief. For the /advertise page; scripts/advertising-policy.test.ts checks it keeps the rating line. */
export const RULE_SUMMARY: readonly string[] = [
  'No alcohol, tobacco or vaping, gambling, dating, weapons, adult content, food and drink, charities, or political and issue ads.',
  `Games, apps, films and shows only when rated ${MEDIA_RATINGS}, with the rating shown.`,
  'Honest claims and no pressure to buy: nothing that tells children to ask a parent or to hurry.',
  'Nothing that looks like part of the site or a game, such as fake buttons, scores or alerts.',
  'A static image with alt text, a short headline and one link to a page that suits every age.',
  'We review every creative before it runs, and may refuse or remove any ad.',
];

/** Never advertised, in any slot. */
export const PROHIBITED: readonly PolicyItem[] = [
  { name: 'Alcohol', detail: 'Drinks, brands, bars and alcohol-branded merchandise.' },
  {
    name: 'Tobacco and vaping',
    detail: 'Cigarettes, e-cigarettes, vapes, nicotine pouches, cannabis and their accessories.',
  },
  {
    name: 'Gambling',
    detail: 'Betting, casinos, lotteries, sweepstakes casinos, loot boxes sold for money and skin gambling.',
  },
  { name: 'Dating and relationships', detail: 'Dating apps, matchmaking and companion chat services.' },
  { name: 'Weapons', detail: 'Firearms, ammunition, knives sold as weapons, fireworks and realistic replica guns.' },
  { name: 'Adult content', detail: 'Sexual products and services, and suggestive or violent imagery.' },
  {
    name: 'Political and issue ads',
    detail: 'Candidates, parties, elections, ballot measures and campaigns on social or political issues.',
  },
  {
    name: 'Drugs and supplements',
    detail: 'Prescription and over-the-counter medicines, diet and weight-loss products, and supplements.',
  },
  {
    name: 'Financial products',
    detail: 'Loans, credit, buy-now-pay-later, trading, crypto-assets and get-rich schemes.',
  },
  { name: 'Cosmetic procedures', detail: 'Surgery, injectables and other cosmetic treatments.' },
  {
    name: 'Media rated for older audiences',
    detail: `Films, shows, games and apps rated above ${MEDIA_RATINGS}, or an equivalent.`,
  },
  {
    name: 'Food and drink',
    detail: 'All food and drink, including brand-only ads from companies that sell food high in fat, salt or sugar.',
  },
  { name: 'Charities', detail: 'Ads from charities and other good causes. We may accept them in a later version.' },
  {
    name: 'Data collection',
    detail: 'Offers that ask for personal details, such as sign-ups, quizzes, surveys and contests.',
  },
  { name: 'Unmoderated chat and social apps', detail: 'Services where children could talk with strangers.' },
  {
    name: 'Deceptive or harmful offers',
    detail: 'Scams, miracle claims, malware, fake downloads and anything illegal where it is shown.',
  },
];

/** Allowed only with the conditions given. */
export const RESTRICTED: readonly PolicyItem[] = [
  {
    name: 'Games, apps, films and shows',
    detail: `Rated ${MEDIA_RATINGS}, or an equivalent, with the rating shown. In-game purchases must be stated, and the ad may not push them.`,
  },
  {
    name: 'Toys and products for children',
    detail: 'Shown as they are, at their real size, doing what they really do.',
  },
  {
    name: 'Paid services and subscriptions',
    detail: 'The ad must say when something costs money. Free trials must say what happens when they end.',
  },
  { name: 'Education', detail: 'Learning products and courses, with no promise of grades or results.' },
];

/** How an ad may speak to the people who see it. */
export const CLAIMS_RULES: readonly string[] = [
  'Be truthful. Every claim must be one you can prove, and the image must show the product as it is, at its real size.',
  'No pressure to buy: no "buy now", "ask your parents", countdowns, "only today" or "last chance", and no "only" or "just" in front of a price.',
  'Never suggest that someone is less popular, clever or grown-up without the product.',
  'Show prices plainly, and say when something is sold separately or needs batteries.',
  'Endorsements must be genuine, and any paid connection must be stated.',
  'Show nothing unsafe that a child could copy.',
  'No imitation of the site or a game: no fake buttons, close marks, scores, rewards, timers, alerts or system messages.',
  'No content that mocks, stereotypes or frightens.',
];

/** Where a click may take someone. */
export const LANDING_RULES: readonly string[] = [
  'The page the ad links to must match the ad, load over HTTPS and be suitable for every age.',
  'No pop-ups, automatic downloads, redirects to other offers or requests for personal details.',
  'The link may not carry tracking that identifies a visitor. We count clicks on our own server, without cookies.',
  "Before anyone leaves Joystyk, a page of ours says they're leaving and names your site's domain. They continue from there straight to your page.",
];

/** Format rules for every slot; the sizes come from the slot registry. */
export const FORMAT_RULES: readonly string[] = [
  'A static image in AVIF, WebP or PNG, at twice the box size so it stays sharp on high-density screens, and no larger.',
  `At most ${String(CREATIVE_SPECS.imageKb)} KB per image file.`,
  `Alt text that says what the image shows, in ${String(CREATIVE_SPECS.alt)} characters or fewer.`,
  `A headline of ${String(CREATIVE_SPECS.headline)} characters or fewer; the daily presenting line may run to ${String(CREATIVE_SPECS.presentingHeadline)}.`,
  'One link, to an HTTPS page.',
  'No HTML, JavaScript, animation, sound or video. Animated images may come later; we will say when.',
];

/** What happens between a booking and a creative going live. */
export const REVIEW_STEPS: readonly string[] = [
  'You send the images, headline, alt text, link and dates.',
  'We check the content against these rules and the technical specs, and look at the landing page.',
  'We approve the creative, or tell you what to change.',
  'Only approved creatives run. We look again if the landing page or the product changes.',
];

/** What happens to payment when an ad doesn't run (policy section 8). */
export const REFUND_RULES: readonly string[] = [
  "If an ad can't run through our own fault, we refund the days it missed or run it for as many extra days.",
  'If we take an ad down because it breaks these rules, we refund only the days it has not yet run.',
];
