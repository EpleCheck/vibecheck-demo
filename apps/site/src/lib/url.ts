// Prefix internal root-relative links with Astro's configured `base`, so the
// site works whether it's deployed at a domain root ('/') or under a subpath
// (e.g. GitHub Pages at '/vibecheck'). External links, anchors, mailto/tel and
// already-relative hrefs are returned unchanged. At root, this is a no-op.
const BASE = import.meta.env.BASE_URL; // '/' or '/subpath/'

export function withBase(href: string | undefined): string | undefined {
  if (!href || !href.startsWith('/')) return href;
  if (BASE === '/' || BASE === '') return href;
  return BASE.replace(/\/$/, '') + href;
}
