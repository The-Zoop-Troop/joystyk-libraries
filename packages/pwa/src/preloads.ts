/** Remove document preloads before a service-worker response reaches the HTML parser.
 * A controlled page imports through its worker; cross-world preload hints can fetch the
 * same modules twice. Scripts, stylesheet links and CSP-hashed inline content stay intact.
 */
const modulePreloadLink = (tag: string): boolean => {
  if (!/^<link\b/i.test(tag)) return false;
  const attributes = tag.matchAll(/\s+([^\s="'<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g);
  for (const attribute of attributes) {
    if (attribute[1]?.toLowerCase() === 'rel') {
      return (attribute[2] ?? attribute[3] ?? attribute[4] ?? '').toLowerCase().split(/\s+/).includes('modulepreload');
    }
  }
  return false;
};

export const withoutModulePreloads = (html: string): string =>
  html.replace(/<!--[\s\S]*?-->|<(script|style|textarea|title|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>|<link\b[^>]*>/gi, (tag) =>
    modulePreloadLink(tag) ? '' : tag,
  );

export const withoutPreloadResponse = async (response: Response): Promise<Response> => {
  if (response.body === null || !/^\s*text\/html\b/i.test(response.headers.get('content-type') ?? '')) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(withoutModulePreloads(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
