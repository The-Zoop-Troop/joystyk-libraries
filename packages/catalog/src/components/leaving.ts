// "You're leaving Joystyk": the page an ad click opens before the advertiser's site
// (advertising-policy.md, section 6; monetization.md, "Counting"). It names where the ad goes
// and offers two plain links, so it works without JavaScript: on to the advertiser, straight
// to the creative's approved link, or back to the page the visitor came from. The site's ad
// routes count the click and seed the destination; nothing here reads the request.
import { html } from '@gyral/core';
import { SITE_NAME } from '../seo.ts';
import type { Leaving } from '../store.ts';

export const leavingView = (l: Leaving) => html`<section class="leaving" aria-labelledby="leaving-heading">
  <p class="kicker">Advertisement</p>
  <h1 id="leaving-heading" tabindex="-1">You’re leaving ${SITE_NAME}</h1>
  <p class="lede">
    The ad you chose goes to <strong class="leaving-domain">${l.domain}</strong>, a website ${SITE_NAME} doesn’t run. Its
    own rules apply there.
  </p>
  <ul class="leaving-links" role="list">
    <li><a class="cta" href=${l.href} rel="sponsored noopener">Continue to ${l.domain}</a></li>
    <li><a class="back" href=${l.back}>Back to ${SITE_NAME}</a></li>
  </ul>
</section>`;
