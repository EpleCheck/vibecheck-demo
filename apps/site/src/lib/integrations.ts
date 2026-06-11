/**
 * Integration registry — the Tier-2 spine.
 *
 * A `form` section references an integration by NAME (e.g. `integration: contact`).
 * This file is the single place that maps a name to a real submission endpoint, so
 * content never carries a URL. Endpoints come from env (with safe local defaults),
 * which keeps deploy-specific URLs and any secrets out of the git-tracked content.
 *
 * Fulfillment is provider-agnostic: an endpoint can be a hosted form service
 * (Formspree, Buttondown, Brevo…) or your own function — the page doesn't care.
 *
 * Adding an integration = one entry here. That's the whole point: newsletter,
 * booking, and the EpleCheck contact webhook are all the same primitive.
 *
 * NOTE: read env via `process.env` (not `import.meta.env`) — this runs at build
 * time in Node, and the endpoint URL is public anyway (it lands in the form's
 * `action` attribute). True secrets (API auth) live in the receiving service.
 */

export interface Integration {
  /** Where the form POSTs. Public — ends up in the rendered HTML. */
  endpoint: string;
  /** HTTP method for the form. Defaults to POST. */
  method?: 'POST' | 'GET';
}

const env = (key: string): string | undefined => process.env[key];

/**
 * The registry. Each entry's endpoint is read from env so it can differ per
 * deploy, falling back to a sensible local placeholder so `npm run build` works
 * out of the box without any env configured.
 */
const registry: Record<string, Integration> = {
  // Contact form — on EpleCheck this points at the existing contact webhook.
  contact: {
    endpoint: env('CONTACT_ENDPOINT') ?? '/api/contact',
  },
  // Newsletter signup — point at a hosted provider (Buttondown/Brevo/…) via env.
  newsletter: {
    endpoint: env('NEWSLETTER_ENDPOINT') ?? '/api/newsletter',
  },
};

/**
 * Resolve an integration name to its endpoint, or throw — which fails the build.
 * This is the guarantee that makes named integrations schema-safe: a page that
 * references an integration nobody registered can never deploy, exactly like a
 * page with an unknown section type can't.
 */
export function resolveIntegration(name: string): Integration {
  const found = registry[name];
  if (!found) {
    const known = Object.keys(registry).join(', ') || '(none)';
    throw new Error(
      `Unknown integration "${name}". Add it to apps/site/src/lib/integrations.ts ` +
        `(known integrations: ${known}).`,
    );
  }
  return found;
}
