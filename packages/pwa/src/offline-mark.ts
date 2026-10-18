// Marking pages served offline (offline-and-updates.md, "Pages served offline"). When the
// network fails and the worker answers a page from a cache, it adds `data-offline` to the
// page's <html> tag, so the document's own CSS can lay the page out for offline from the first
// paint: @joystyk/ui's tokens.css collapses every <ad-slot> under `:root[data-offline]` until
// the slot hears the browser is online. Pure, so it is tested in Node; sw/sw.ts applies it.
import { OFFLINE_ATTRIBUTE } from './names.ts';
import { isGameId } from '@joystyk/contracts';

/** The <html> start tag: `<html` followed by whitespace, `>` or `/`. Never `<!doctype html>`. */
const HTML_TAG = /<html(?=[\s/>])[^>]*>/i;
const MARKED = new RegExp(`\\s${OFFLINE_ATTRIBUTE}(?=[\\s=/>])`, 'i');

/**
 * `html` with `data-offline` on its <html> tag. A document without an <html> tag, or already
 * marked, comes back unchanged. Only the tag changes: no script or style is added, so the
 * page's Content-Security-Policy hashes still hold.
 */
export const markOfflineHtml = (html: string): string => {
  const match = HTML_TAG.exec(html);
  if (match === null || MARKED.test(match[0])) return html;
  const at = match.index + '<html'.length;
  return `${html.slice(0, at)} ${OFFLINE_ATTRIBUTE}${html.slice(at)}`;
};

/** Render pin-derived labels before first paint, so hydration need not grow every
 * catalog card and lineup row. Raw text and executable content keep their bytes. */
export const markOfflineAvailability = (html: string, pinned: readonly string[]): string => {
  const ids = new Set(pinned);
  return html.replace(
    /<!--[\s\S]*?-->|<(script|style|textarea|title|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>|<jy-offline-availability\b[^>]*>[\s\S]*?<\/jy-offline-availability\s*>/gi,
    (element) => {
      if (!/^<jy-offline-availability\b/i.test(element)) return element;
      const id = /\s+game-id\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(element);
      const game = id?.[1] ?? id?.[2];
      if (!isGameId(game)) return element;
      const available = ids.has(game);
      return `<jy-offline-availability game-id="${game}" data-available="${String(available)}">${available ? 'Available offline' : 'Unavailable offline'}</jy-offline-availability>`;
    },
  );
};

/** Whether a response is an HTML document, by its Content-Type. */
const isHtml = (response: Response): boolean => /^\s*text\/html\b/i.test(response.headers.get('content-type') ?? '');

/**
 * A cached page, marked as served offline. Status and headers carry over, except
 * Content-Length, which no longer fits the body; anything that isn't an HTML document comes
 * back as it is.
 */
export const markOfflineResponse = async (response: Response, pinned: readonly string[] = []): Promise<Response> => {
  if (!isHtml(response) || response.body === null) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(markOfflineAvailability(markOfflineHtml(await response.text()), pinned), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
