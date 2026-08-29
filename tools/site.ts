/**
 * The canonical origin, in one place.
 *
 * Fourteen strings across seven files named the host: the canonical link, the
 * Open Graph and Twitter URLs, the JSON-LD, the sitemap, robots.txt, llms.txt,
 * the generated glossary page and the README. Moving to a custom domain meant
 * finding all of them and missing one, and a stale canonical or an og:url
 * pointing at the old origin is the kind of mistake that survives for months
 * because nothing renders it visibly wrong.
 *
 * Build-time only, which is why it lives in tools/ rather than src/: the app
 * never needs to know its own address, only the metadata generated around it
 * does. Nothing here reaches the browser bundle.
 *
 * SITE_ORIGIN is the environment variable when set, so a preview deployment
 * can name itself instead of claiming to be production. Vercel exposes the
 * deployment host as VERCEL_URL without a scheme, hence the prefix.
 */
function fromEnv(): string | undefined {
  if (process.env.SITE_ORIGIN) return process.env.SITE_ORIGIN;
  if (process.env.VERCEL_ENV === 'production') return undefined;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return undefined;
}

export const SITE_ORIGIN = fromEnv() ?? 'https://breakscale.vercel.app';

/** An absolute URL for a path, for metadata that cannot take a relative one. */
export function siteUrl(path = '/'): string {
  return `${SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}
