// The "Advertise with us" pages: the slots, the audience, rates, the creative rules and the
// contact form (monetization.md, "How a campaign works", step 1), the creative policy, and
// where a sent form lands. The form is a plain POST to the site's contact handler, so it
// works without JavaScript; a rejected post comes back as this page with the visitor's values
// and the errors, seeded into the catalog store (`contactForm`). List rows are module-level
// and pure (Gyral's `each` rule).
import { each, html, invalid, nothing } from '@gyral/core';
import { SLOTS, type SlotDefinition, type TargetingKey } from '@joystyk/ui/slots';
import {
  ADVERTISE_EMAIL,
  CLAIMS_RULES,
  CONTACT_HANDLED_RETENTION_DAYS,
  CONTACT_HONEYPOT,
  CONTACT_LIMITS,
  CONTACT_RETENTION_MONTHS,
  FORMAT_RULES,
  LANDING_RULES,
  PROHIBITED,
  REFUND_RULES,
  REPLY_BUSINESS_DAYS,
  RESTRICTED,
  REVIEW_STEPS,
  RULE_SUMMARY,
  SLOT_NAMES,
  SURFACE_NAMES,
  previewSize,
  sizeLabel,
  type PolicyItem,
} from '../advertise.ts';
import { ADVERTISE_PATH, ADVERTISE_POLICY_PATH } from '../routes.ts';
import type { CatalogState } from '../store.ts';

const TARGET_NAMES: Readonly<Record<TargetingKey, string>> = {
  page: 'page',
  game: 'game',
  category: 'category',
  date: 'date',
};

/** "a, b and c". */
const listWords = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Previews are drawn at a third of the slot's size, so they compare with each other. */
const PREVIEW_SCALE = 3;

// --- The slot gallery --------------------------------------------------------------------

const SlotCard = (s: SlotDefinition) => {
  const box = previewSize(s);
  return html`<li>
    <article class="slot-card" aria-labelledby="slot-${s.id}">
      <h3 id="slot-${s.id}">${SLOT_NAMES[s.id]}</h3>
      <div class="slot-preview">
        <svg
          class="slot-shape"
          width=${Math.round(box.width / PREVIEW_SCALE)}
          height=${Math.round(box.height / PREVIEW_SCALE)}
          aria-hidden="true"
          focusable="false"
        >
          <rect width="100%" height="100%" rx="3" />
        </svg>
      </div>
      <p>${s.placement}</p>
      <dl class="slot-facts">
        <div><dt>Appears on</dt><dd>${capitalize(listWords(s.surfaces.map((x) => SURFACE_NAMES[x])))}</dd></div>
        <div><dt>Wide screens</dt><dd>${s.sizes.wide === null ? 'Not shown' : sizeLabel(s.sizes.wide)}</dd></div>
        <div><dt>Narrow screens</dt><dd>${s.sizes.narrow === null ? 'Not shown' : sizeLabel(s.sizes.narrow)}</dd></div>
        <div><dt>Label</dt><dd>${s.label}</dd></div>
        <div><dt>Targeting</dt><dd>${capitalize(listWords(s.targeting.map((t) => TARGET_NAMES[t])))}</dd></div>
      </dl>
    </article>
  </li>`;
};

const gallery = () => html`<section class="advertise-section" aria-labelledby="slots-heading">
  <h2 id="slots-heading">The ad slots</h2>
  <p>
    Each slot has a fixed size on wide and narrow screens, so your ad appears exactly as you made it and the page never
    jumps around it. The shapes below are drawn to scale.
  </p>
  <ul class="slot-gallery" role="list">
    ${each(SLOTS, (s) => s.id, SlotCard)}
  </ul>
</section>`;

// --- Audience, rates and rules -----------------------------------------------------------

const audience = () => html`<section class="advertise-section" aria-labelledby="audience-heading">
  <h2 id="audience-heading">Who sees your ad</h2>
  <ul class="points">
    <li><strong>Every age.</strong> Joystyk is for families, children and grown-ups alike, so every ad must suit all of them.</li>
    <li>
      <strong>Chosen by context, never by person.</strong> We pick an ad by the page, game, category and date. Everyone on
      the same page on the same day sees the same ad.
    </li>
    <li>
      <strong>No tracking.</strong> No cookies, profiles or third-party ad scripts. We never learn who saw your ad, and
      neither do you.
    </li>
    <li><strong>Counted on our server.</strong> We report impressions and clicks per creative per day.</li>
  </ul>
  <p>We don't publish traffic figures yet. Once we have a season of data, we'll share them on request.</p>
</section>`;

const rates = () => html`<section class="advertise-section" aria-labelledby="rates-heading">
  <h2 id="rates-heading">Rates</h2>
  <p>
    Contact us for rates. We price each booking by slot and dates: the home page banner sells by the day or the week, and
    the daily presenting sponsor by the day. We bill by invoice.
  </p>
</section>`;

const Point = (text: string) => html`<li>${text}</li>`;

const rules = () => html`<section class="advertise-section" aria-labelledby="rules-heading">
  <h2 id="rules-heading">The rules every ad meets</h2>
  <p>Children see these slots, so we hold every ad to children's advertising standards. In short:</p>
  <ul class="points">
    ${each(RULE_SUMMARY, (r) => r, Point)}
  </ul>
  <p><a href=${ADVERTISE_POLICY_PATH}>Read the full creative policy</a>, with the image specs for each slot.</p>
</section>`;

// --- The contact form --------------------------------------------------------------------

type Errors = Readonly<Record<string, readonly string[]>>;

const text = (c: CatalogState, name: string): string => {
  const value = c.contactForm?.values[name];
  return typeof value === 'string' ? value : '';
};

const chosenSlots = (c: CatalogState): readonly string[] => {
  const value = c.contactForm?.values['slots'];
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
};

/** The ids an input's aria-describedby names: its hint and its error, when present. */
const describedBy = (id: string, hint: boolean, errors: readonly string[] | undefined): string | null => {
  const ids = [...(hint ? [`${id}-hint`] : []), ...(errors === undefined ? [] : [`${id}-error`])];
  return ids.length === 0 ? null : ids.join(' ');
};

const fieldError = (id: string, errors: readonly string[] | undefined) =>
  errors === undefined ? nothing : html`<p class="field-error" id="${id}-error">${errors.join(' ')}</p>`;

interface TextField {
  readonly name: 'name' | 'company' | 'email';
  readonly label: string;
  readonly type: 'text' | 'email';
  readonly autocomplete: string;
  readonly required: boolean;
}

const TEXT_FIELDS: readonly TextField[] = [
  { name: 'name', label: 'Your name', type: 'text', autocomplete: 'name', required: true },
  { name: 'company', label: 'Company or organization', type: 'text', autocomplete: 'organization', required: false },
  { name: 'email', label: 'Email address', type: 'email', autocomplete: 'email', required: true },
];

const optional = html` <span class="optional">(optional)</span>`;

const textField = (f: TextField, value: string, errors: readonly string[] | undefined) => {
  const id = `contact-${f.name}`;
  return html`<div class="field">
    <label for=${id}>${f.label}${f.required ? nothing : optional}</label>
    ${fieldError(id, errors)}
    <input
      id=${id}
      name=${f.name}
      type=${f.type}
      autocomplete=${f.autocomplete}
      maxlength=${CONTACT_LIMITS[f.name]}
      ?required=${f.required}
      value=${value}
      aria-describedby=${describedBy(id, false, errors)}
      ${invalid(errors)}
    />
  </div>`;
};

const SlotChoice = (s: SlotDefinition, checked: boolean) => html`<li>
  <label class="choice">
    <input type="checkbox" name="slots" value=${s.id} ?checked=${checked} />
    ${SLOT_NAMES[s.id]}
  </label>
</li>`;

interface Problem {
  readonly field: string;
  readonly message: string;
}

/** Where each field's error links to in the summary. */
const FIELD_TARGETS: Readonly<Record<string, string>> = {
  name: 'contact-name',
  company: 'contact-company',
  email: 'contact-email',
  slots: 'contact-slots',
  start: 'contact-start',
  end: 'contact-end',
  message: 'contact-message',
};

const ProblemItem = (p: Problem) => {
  const target = FIELD_TARGETS[p.field];
  return html`<li>${target === undefined ? p.message : html`<a href="#${target}">${p.message}</a>`}</li>`;
};

const problems = (errors: Errors): readonly Problem[] =>
  ['', ...Object.keys(FIELD_TARGETS)].flatMap((field) => (errors[field] ?? []).map((message) => ({ field, message })));

const errorSummary = (errors: Errors) => {
  const list = problems(errors);
  return list.length === 0
    ? nothing
    : html`<div class="form-errors" role="alert" aria-labelledby="form-errors-heading">
        <h3 id="form-errors-heading">Your message wasn't sent</h3>
        <ul>
          ${each(list, (p) => `${p.field}:${p.message}`, ProblemItem)}
        </ul>
      </div>`;
};

/** How the form's messages are used and kept (advertising-policy.md, "Contact form messages"). */
const PRIVACY_NOTE =
  'We use what you send only to reply to you about advertising. We never add you to a mailing list or share your ' +
  `details. We delete each message ${String(CONTACT_HANDLED_RETENTION_DAYS)} days after we've dealt with it, and ` +
  `always within ${String(CONTACT_RETENTION_MONTHS)} months of its arrival. This form is for businesses: if you're ` +
  "under 18, please don't use it.";

/** The address, as text anyone can select and copy, and as a mailto: link for those whose mail app opens. */
const emailLink = () => html`<a href=${`mailto:${ADVERTISE_EMAIL}`}>${ADVERTISE_EMAIL}</a>`;

const contactForm = (c: CatalogState) => {
  const errors: Errors = c.contactForm?.errors ?? {};
  const chosen = chosenSlots(c);
  const isChosen = (s: SlotDefinition) => chosen.includes(s.id);
  return html`<section class="advertise-section contact" aria-labelledby="contact-heading">
    <h2 id="contact-heading">Get in touch</h2>
    <p>
      Tell us what you'd like to advertise and when. We'll reply by email within ${REPLY_BUSINESS_DAYS} business days, with
      availability and rates. You can also write to us at ${emailLink()}.
    </p>
    <form class="contact-form" method="post" action=${ADVERTISE_PATH} aria-labelledby="contact-heading">
      ${errorSummary(errors)}
      ${TEXT_FIELDS.map((f) => textField(f, text(c, f.name), errors[f.name]))}
      <fieldset class="field" id="contact-slots" aria-describedby=${describedBy('contact-slots', false, errors['slots'])}>
        <legend>Slots you're interested in${optional}</legend>
        ${fieldError('contact-slots', errors['slots'])}
        <ul class="choices" role="list">
          ${each(SLOTS, (s) => s.id, SlotChoice, isChosen)}
        </ul>
      </fieldset>
      <fieldset class="field dates" aria-describedby="contact-dates-hint">
        <legend>Dates${optional}</legend>
        <p class="hint" id="contact-dates-hint">The first and last day you'd like your ad to run.</p>
        <div class="date-pair">
          <div class="field">
            <label for="contact-start">First day</label>
            ${fieldError('contact-start', errors['start'])}
            <input
              id="contact-start"
              name="start"
              type="date"
              value=${text(c, 'start')}
              aria-describedby=${describedBy('contact-start', false, errors['start'])}
              ${invalid(errors['start'])}
            />
          </div>
          <div class="field">
            <label for="contact-end">Last day</label>
            ${fieldError('contact-end', errors['end'])}
            <input
              id="contact-end"
              name="end"
              type="date"
              value=${text(c, 'end')}
              aria-describedby=${describedBy('contact-end', false, errors['end'])}
              ${invalid(errors['end'])}
            />
          </div>
        </div>
      </fieldset>
      <div class="field">
        <label for="contact-message">Message</label>
        <p class="hint" id="contact-message-hint">What you'd like to advertise, and anything else we should know.</p>
        ${fieldError('contact-message', errors['message'])}
        <textarea
          id="contact-message"
          name="message"
          rows="6"
          maxlength=${CONTACT_LIMITS.message}
          required
          aria-describedby=${describedBy('contact-message', true, errors['message'])}
          ${invalid(errors['message'])}
        >${text(c, 'message')}</textarea>
      </div>
      <div class="trap">
        <label for="contact-${CONTACT_HONEYPOT}">Leave this field empty</label>
        <input id="contact-${CONTACT_HONEYPOT}" name=${CONTACT_HONEYPOT} type="text" tabindex="-1" autocomplete="off" />
      </div>
      <p class="form-note">${PRIVACY_NOTE}</p>
      <p><button type="submit" class="cta">Send message</button></p>
    </form>
  </section>`;
};

export function advertiseView(c: CatalogState) {
  return html`<div class="advertise-page">
    <header class="page-head">
      <p class="kicker">Advertise</p>
      <h1 tabindex="-1">Advertise with us</h1>
      <p class="lede">
        Joystyk sells its own ad space, like billboards beside a road. Your ad sits in a fixed, labeled slot beside free games
        for every age: never inside a game and never during play.
      </p>
    </header>
    ${audience()} ${gallery()} ${rates()} ${rules()} ${contactForm(c)}
  </div>`;
}

// --- The creative policy -----------------------------------------------------------------

const PolicyEntry = (p: PolicyItem) => html`<div>
  <dt>${p.name}</dt>
  <dd>${p.detail}</dd>
</div>`;

const SpecRow = (s: SlotDefinition) => html`<tr>
  <th scope="row">${SLOT_NAMES[s.id]}</th>
  <td>${s.sizes.wide === null ? 'Not shown' : sizeLabel(s.sizes.wide)}</td>
  <td>${s.sizes.narrow === null ? 'Not shown' : sizeLabel(s.sizes.narrow)}</td>
  <td>${s.label}</td>
</tr>`;

const Step = (text: string) => html`<li>${text}</li>`;

export function policyView() {
  return html`<article class="advertise-page policy-page" aria-labelledby="policy-title">
    <nav class="crumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href=${ADVERTISE_PATH}>Advertise with us</a></li>
        <li><a href=${ADVERTISE_POLICY_PATH} aria-current="page">Creative policy</a></li>
      </ol>
    </nav>
    <header class="page-head">
      <p class="kicker">For advertisers</p>
      <h1 id="policy-title" tabindex="-1">Creative policy</h1>
      <p class="lede">
        Children play on Joystyk, so every ad must suit every age. These rules follow children's advertising standards in the
        US and the UK, and every creative meets them before it runs.
      </p>
    </header>
    <section class="advertise-section" aria-labelledby="prohibited-heading">
      <h2 id="prohibited-heading">Products we never advertise</h2>
      <dl class="policy-list">
        ${each(PROHIBITED, (p) => p.name, PolicyEntry)}
      </dl>
    </section>
    <section class="advertise-section" aria-labelledby="restricted-heading">
      <h2 id="restricted-heading">Products we advertise with conditions</h2>
      <dl class="policy-list">
        ${each(RESTRICTED, (p) => p.name, PolicyEntry)}
      </dl>
    </section>
    <section class="advertise-section" aria-labelledby="claims-heading">
      <h2 id="claims-heading">Honest ads, no pressure</h2>
      <ul class="points">
        ${each(CLAIMS_RULES, (r) => r, Point)}
      </ul>
    </section>
    <section class="advertise-section" aria-labelledby="labels-heading">
      <h2 id="labels-heading">Labels</h2>
      <p>
        Every slot carries a label we add: “Advertisement”, or “Sponsored” for the daily presenting sponsor. Your creative
        must not hide the label, imitate it or call itself anything else.
      </p>
    </section>
    <section class="advertise-section" aria-labelledby="landing-heading">
      <h2 id="landing-heading">Landing pages</h2>
      <ul class="points">
        ${each(LANDING_RULES, (r) => r, Point)}
      </ul>
    </section>
    <section class="advertise-section" aria-labelledby="specs-heading">
      <h2 id="specs-heading">Image specs</h2>
      <ul class="points">
        ${each(FORMAT_RULES, (r) => r, Point)}
      </ul>
      <div class="table-scroll" role="region" aria-labelledby="specs-caption" tabindex="0">
        <table class="spec-table">
          <caption id="specs-caption">The box each slot reserves, in CSS pixels</caption>
          <thead>
            <tr>
              <th scope="col">Slot</th>
              <th scope="col">Wide screens</th>
              <th scope="col">Narrow screens</th>
              <th scope="col">Label</th>
            </tr>
          </thead>
          <tbody>
            ${each(SLOTS, (s) => s.id, SpecRow)}
          </tbody>
        </table>
      </div>
    </section>
    <section class="advertise-section" aria-labelledby="review-heading">
      <h2 id="review-heading">Review</h2>
      <ol class="steps">
        ${each(REVIEW_STEPS, (r) => r, Step)}
      </ol>
      <p>
        We may refuse any creative, and take down any ad at any time, if it breaks these rules or we judge it unsuitable for
        a young audience. When we take an ad down, we tell you why.
      </p>
    </section>
    <section class="advertise-section" aria-labelledby="refunds-heading">
      <h2 id="refunds-heading">If an ad doesn't run</h2>
      <ul class="points">
        ${each(REFUND_RULES, (r) => r, Point)}
      </ul>
    </section>
    <p><a href=${`${ADVERTISE_PATH}#contact-heading`}>Ask us about advertising</a></p>
  </article>`;
}

// --- After a post ------------------------------------------------------------------------

export const sentView = () => html`<section class="sent" aria-labelledby="sent-heading">
  <p class="kicker">Message sent</p>
  <h1 id="sent-heading" tabindex="-1">Thanks for getting in touch</h1>
  <p class="lede">We read every message about advertising, and we'll reply by email within ${REPLY_BUSINESS_DAYS} business days.</p>
  <p>To add something to your message, write to us at ${emailLink()}.</p>
  <ul class="sent-links">
    <li><a href=${ADVERTISE_PATH}>Back to Advertise with us</a></li>
    <li><a href="/">See all games</a></li>
  </ul>
</section>`;
