// Adapt the catalog's SEO facts to Gyral's shared server/client head model.
import type { Head as GyralHead } from '@gyral/core';
import { SITE_NAME, type Head } from './seo.ts';

/** Open Graph properties for a head; og:url only for indexable pages. */
export function openGraph(head: Head): readonly (readonly [property: string, content: string])[] {
  return [
    ['og:site_name', SITE_NAME],
    ['og:type', head.ogType],
    ['og:title', head.title],
    ['og:description', head.description],
    ...(head.canonical === null ? [] : [['og:url', head.canonical] as const]),
  ];
}

/** Both SSR and client navigation use this value, including removal of absent metadata. */
export function toGyralHead(head: Head): GyralHead {
  return {
    title: head.title,
    description: head.description,
    ...(head.canonical === null ? {} : { canonical: head.canonical }),
    robots: head.robots === 'index' ? 'index, follow' : 'noindex',
    meta: [
      ...openGraph(head).map(([property, content]) => ({ property, content })),
      { name: 'twitter:card', content: 'summary' },
    ],
    jsonLd: head.jsonLd === null ? [] : [head.jsonLd],
  };
}
