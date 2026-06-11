// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// `site` and `base` are env-driven so the same template deploys at a domain root
// (the default) or under a subpath (e.g. GitHub Pages project sites at /<repo>).
// Most hosts (Vercel/Netlify/Cloudflare Pages) serve at root — leave these unset.
export default defineConfig({
  site: process.env.SITE_URL || 'https://example.com',
  base: process.env.BASE_PATH || '/',
  integrations: [sitemap()],
  output: 'static',
});
