#!/usr/bin/env node
import express, { type Request, type Response, type NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import YAML from 'yaml';
import {
  pageSchema,
  postSchema,
  type Post,
  sectionSchema,
  seoSchema,
  slugSchema,
  navSchema,
  type NavItem,
} from '@vibecheck/schema';
import { registerOAuth, verifyAccessToken, baseUrl } from './oauth.js';
import {
  DEFAULT_BRANCH,
  type CommitAction,
  commit,
  createMergeRequest,
  fileExists,
  getFileRaw,
  listTree,
} from './provider.js';

// Repo-root-relative content paths. Defaults match the VibeCheck site template
// (site at repo root). For the monorepo layout, point these at apps/site/...
const PAGES_DIR = process.env.VIBECHECK_PAGES_DIR ?? 'src/content/pages';
const POSTS_DIR = process.env.VIBECHECK_POSTS_DIR ?? 'src/content/blog';
const REDIRECTS_PATH = process.env.VIBECHECK_REDIRECTS_PATH ?? 'public/_redirects';
// The nav menu data file. Sibling of the pages dir by default (…/content/nav.yaml).
const NAV_PATH =
  process.env.VIBECHECK_NAV_PATH ?? `${PAGES_DIR.replace(/\/pages\/?$/, '')}/nav.yaml`;

function pageFilePath(slug: string): string {
  return `${PAGES_DIR}/${slug}.yaml`;
}

function postFilePath(slug: string): string {
  return `${POSTS_DIR}/${slug}.md`;
}

/** Serialize post frontmatter + Markdown body into a .md file body. */
function serializePost(fm: Post, body: string): string {
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const front: Record<string, unknown> = { title: fm.title };
  if (fm.description) front.description = fm.description;
  front.pubDate = ymd(fm.pubDate);
  if (fm.updatedDate) front.updatedDate = ymd(fm.updatedDate);
  if (fm.draft) front.draft = true;
  if (fm.categories.length) front.categories = fm.categories;
  if (fm.tags.length) front.tags = fm.tags;
  if (fm.seo) front.seo = fm.seo;
  return `---\n${YAML.stringify(front)}---\n\n${body.trim()}\n`;
}

/** Split a Markdown file into YAML frontmatter + body. */
function parsePost(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  return {
    frontmatter: (YAML.parse(m[1]) as Record<string, unknown>) ?? {},
    body: m[2].replace(/^\n+/, ''),
  };
}

/** Serialize a validated page object to a YAML file body. */
function serializePage(page: unknown): string {
  const header =
    '# Managed by VibeCheck. Structure must match the @vibecheck/schema content\n' +
    '# contract (mirrored by the site at src/content.config.ts).\n';
  return header + YAML.stringify(page);
}

/** Serialize the nav menu (ordered list) to a YAML file body. */
function serializeNav(items: NavItem[]): string {
  const header =
    '# Site nav menu — managed by VibeCheck. Order here is the menu order.\n' +
    '# Each item: { label, href, external? }. Internal hrefs must point at a real\n' +
    '# page (the site build fails on a dangling link). external: true = off-site.\n';
  // Drop the default `external: false` so the file stays clean for hand-editing.
  const clean = items.map((i) => (i.external ? i : { label: i.label, href: i.href }));
  return header + YAML.stringify(clean);
}

/** Read + validate the nav menu, or [] if the file doesn't exist yet. */
async function readNav(): Promise<NavItem[]> {
  const raw = await getFileRaw(NAV_PATH);
  if (raw === null) return [];
  return navSchema.parse(YAML.parse(raw) ?? []);
}

type PublishMode = 'direct' | 'merge_request';

/** Commit a set of actions either directly to the default branch or via a PR. */
async function publish(opts: {
  mode: PublishMode;
  message: string;
  actions: Parameters<typeof commit>[0]['actions'];
}): Promise<string> {
  if (opts.mode === 'direct') {
    const c = await commit({ branch: DEFAULT_BRANCH, message: opts.message, actions: opts.actions });
    return `Committed to ${DEFAULT_BRANCH}. Your host (e.g. Vercel) builds & deploys on push. ${c.web_url ?? ''}`.trim();
  }
  const branch = `content/${Date.now()}`;
  await commit({
    branch,
    startBranch: DEFAULT_BRANCH,
    message: opts.message,
    actions: opts.actions,
  });
  const pr = await createMergeRequest({
    sourceBranch: branch,
    targetBranch: DEFAULT_BRANCH,
    title: opts.message,
  });
  return `Opened pull request #${pr.iid}: ${pr.web_url}`;
}

const publishModeSchema = z
  .enum(['direct', 'merge_request'])
  .default('merge_request')
  .describe(
    'How to publish:\n"merge_request" (default) = new branch + pull request for review; goes live after merge.\n"direct" = commit straight to the default branch; your host deploys on push.',
  );

/** Append a redirect line to a `_redirects` body, idempotently. */
function appendRedirectLine(existing: string, line: string): string {
  if (existing.split('\n').some((l) => l.trim() === line.trim())) return existing;
  const base = existing === '' || existing.endsWith('\n') ? existing : existing + '\n';
  return base + line + '\n';
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// Orientation injected into every client at connect time (initialize response).
// Keep concise — it loads into the client's context. Authoritative rules also
// live in each tool's description (the channel agents always read).
const INSTRUCTIONS = `VibeCheck manages a website's content by committing structured YAML/Markdown into
its git repo (GitHub by default, GitLab optional). Your host (e.g. Vercel) builds
and deploys on push. This server never touches the live site directly.

WORKFLOW RULES
- Editing a page: call get_page FIRST, modify the returned content, then update_page.
  update_page REPLACES the entire page — never call it without reading first.
- Creating: create_page (fails if the slug exists).
- Removing: delete_page (auto-adds a 301 redirect, default "/"; pass "" to skip).
- Moving/renaming: use rename_page (preserves content + git history, auto-301s old→new).
  NEVER change a slug via delete+create — that loses history and risks broken links.
- Publish/unpublish without rewriting: set_draft.
- list_pages is recursive (returns nested pages too).

BLOG POSTS (optional — only if the site has a blog collection)
- Tools: create_post, update_post, get_post, list_posts, set_post_draft, delete_post.
- get_post before update_post (it OVERWRITES, like pages). A post is Markdown body +
  frontmatter (title, pubDate, description?, categories[], tags[], draft).

PUBLISH MODES (every write tool)
- merge_request (default): commits to a branch + opens a pull request for review.
  Goes live after the PR is merged and the host redeploys.
- direct: commits straight to the default branch; the host builds and deploys on push.

CONTENT MODEL
- A page is data, not markup: sections of type hero | features | pricing | cta |
  richtext | faq | testimonials | embed | heading | image | gallery | divider |
  spacer | iconlist | form. Only richtext carries raw HTML, so generated content
  can't break the build. The schema is the @vibecheck/schema contract the site also
  validates against.

SEO / URLS (important)
- URLs are sacred: preserve slugs. delete_page and rename_page record 301s in the
  redirects file. How redirects are enforced is host-specific.`;

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'vibecheck', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'help',
    {
      title: 'Help',
      description:
        'Return this server\'s workflow rules and publish modes as a reference. Supplementary — the authoritative rules are in each tool\'s description.',
      inputSchema: {},
    },
    async () => ok(INSTRUCTIONS),
  );

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description:
        'List all website content page slugs, recursively (includes nested pages like datahjelp-i-oslo/bestill-en-tekniker). Read-only.',
      inputSchema: {},
    },
    async () => {
      const entries = await listTree(PAGES_DIR, { recursive: true });
      const slugs = entries
        .filter((e) => e.type === 'blob' && /\.ya?ml$/.test(e.name))
        .map((e) => e.path.slice(PAGES_DIR.length + 1).replace(/\.ya?ml$/, ''))
        .sort();
      return ok(slugs.length ? `Pages:\n- ${slugs.join('\n- ')}` : 'No pages found.');
    },
  );

  server.registerTool(
    'get_page',
    {
      title: 'Get page',
      description:
        'Read a page\'s current content (title, seo, sections) as structured data. ALWAYS call this before update_page so you edit existing content instead of overwriting it.',
      inputSchema: { slug: slugSchema },
    },
    async ({ slug }) => {
      const raw = await getFileRaw(pageFilePath(slug));
      if (raw === null) return fail(`Page "${slug}" does not exist.`);
      return ok(`Current content of "${slug}" (${pageFilePath(slug)}):\n\n\`\`\`yaml\n${raw}\n\`\`\``);
    },
  );

  server.registerTool(
    'create_page',
    {
      title: 'Create page',
      description:
        'Create a NEW page from structured sections (hero/features/pricing/cta/richtext/form). Fails if the slug already exists — use update_page for existing pages.',
      inputSchema: {
        slug: slugSchema,
        title: z.string(),
        description: z.string().optional(),
        seo: seoSchema,
        sections: z.array(sectionSchema).default([]),
        publishMode: publishModeSchema,
      },
    },
    async ({ slug, title, description, seo, sections, publishMode }) => {
      const path = pageFilePath(slug);
      if (await fileExists(path)) return fail(`Page "${slug}" already exists. Use update_page.`);
      const page = pageSchema.parse({ title, description, seo, sections, draft: false });
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Add page: ${slug}`,
        actions: [{ action: 'create', file_path: path, content: serializePage(page) }],
      });
      return ok(`Created page "${slug}" -> /${slug}\n${result}`);
    },
  );

  server.registerTool(
    'update_page',
    {
      title: 'Update page',
      description:
        'Replace an existing page\'s content. OVERWRITES the whole page — call get_page first and modify the returned content; never write blind. Fails if the page does not exist.',
      inputSchema: {
        slug: slugSchema,
        title: z.string(),
        description: z.string().optional(),
        seo: seoSchema,
        sections: z.array(sectionSchema).default([]),
        publishMode: publishModeSchema,
      },
    },
    async ({ slug, title, description, seo, sections, publishMode }) => {
      const path = pageFilePath(slug);
      if (!(await fileExists(path))) return fail(`Page "${slug}" does not exist. Use create_page.`);
      const page = pageSchema.parse({ title, description, seo, sections, draft: false });
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Update page: ${slug}`,
        actions: [{ action: 'update', file_path: path, content: serializePage(page) }],
      });
      return ok(`Updated page "${slug}".\n${result}`);
    },
  );

  server.registerTool(
    'update_pricing',
    {
      title: 'Update pricing',
      description:
        'Replace the pricing table (plans) on a page (default slug "priser"). Convenience wrapper over update_page.',
      inputSchema: {
        slug: z.string().default('priser'),
        heading: z.string().optional(),
        plans: sectionSchema.options[2].shape.plans,
        publishMode: publishModeSchema,
      },
    },
    async ({ slug, heading, plans, publishMode }) => {
      const path = pageFilePath(slug);
      const raw = await getFileRaw(path);
      if (raw === null) return fail(`Page "${slug}" does not exist.`);
      const parsed = pageSchema.parse(YAML.parse(raw));
      const idx = parsed.sections.findIndex((s) => s.type === 'pricing');
      const pricingSection = {
        type: 'pricing' as const,
        heading: heading ?? (idx >= 0 ? (parsed.sections[idx] as any).heading : undefined),
        plans,
      };
      if (idx >= 0) parsed.sections[idx] = pricingSection;
      else parsed.sections.push(pricingSection);
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Update pricing on: ${slug}`,
        actions: [{ action: 'update', file_path: path, content: serializePage(parsed) }],
      });
      return ok(`Updated pricing on "${slug}".\n${result}`);
    },
  );

  server.registerTool(
    'delete_page',
    {
      title: 'Delete page',
      description:
        'Delete a page. By default adds a 301 from the old URL (redirectTo, default "/") to preserve SEO; pass redirectTo:"" to skip. Preferred over manual file removal.',
      inputSchema: {
        slug: slugSchema,
        redirectTo: z
          .string()
          .default('/')
          .describe('Where the old URL should 301 to (default "/"). Empty string skips the redirect.'),
        publishMode: publishModeSchema,
      },
    },
    async ({ slug, redirectTo, publishMode }) => {
      const path = pageFilePath(slug);
      if (!(await fileExists(path))) return fail(`Page "${slug}" does not exist.`);
      const actions: CommitAction[] = [{ action: 'delete', file_path: path }];
      let extra = '';
      if (redirectTo) {
        const existing = (await getFileRaw(REDIRECTS_PATH)) ?? '';
        const content = appendRedirectLine(existing, `/${slug}/  ${redirectTo}  301`);
        actions.push({ action: 'update', file_path: REDIRECTS_PATH, content });
        extra = ` + 301 /${slug}/ -> ${redirectTo}`;
      }
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Delete page: ${slug}`,
        actions,
      });
      return ok(`Deleted page "${slug}"${extra}.\n${result}`);
    },
  );

  server.registerTool(
    'rename_page',
    {
      title: 'Rename / move page',
      description:
        'Move/rename a page to a new slug, preserving content and git history, and auto-adding a 301 old→new. Use for ANY slug change — never delete+create.',
      inputSchema: {
        from: slugSchema,
        to: slugSchema,
        publishMode: publishModeSchema,
      },
    },
    async ({ from, to, publishMode }) => {
      if (from === to) return fail('"from" and "to" slugs are identical.');
      const fromPath = pageFilePath(from);
      const toPath = pageFilePath(to);
      if (!(await fileExists(fromPath))) return fail(`Page "${from}" does not exist.`);
      if (await fileExists(toPath)) return fail(`Target "${to}" already exists. Pick a free slug.`);
      const existing = (await getFileRaw(REDIRECTS_PATH)) ?? '';
      const actions: CommitAction[] = [
        { action: 'move', file_path: toPath, previous_path: fromPath },
        { action: 'update', file_path: REDIRECTS_PATH, content: appendRedirectLine(existing, `/${from}/  /${to}/  301`) },
      ];
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Rename page: ${from} -> ${to}`,
        actions,
      });
      return ok(`Renamed "${from}" -> "${to}" + 301 /${from}/ -> /${to}/.\n${result}`);
    },
  );

  server.registerTool(
    'set_draft',
    {
      title: 'Set draft status',
      description:
        'Toggle a page\'s draft flag (publish/unpublish) without rewriting its content.',
      inputSchema: {
        slug: slugSchema,
        draft: z.boolean(),
        publishMode: publishModeSchema,
      },
    },
    async ({ slug, draft, publishMode }) => {
      const path = pageFilePath(slug);
      const raw = await getFileRaw(path);
      if (raw === null) return fail(`Page "${slug}" does not exist.`);
      const page = pageSchema.parse(YAML.parse(raw));
      page.draft = draft;
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Set draft=${draft} on: ${slug}`,
        actions: [{ action: 'update', file_path: path, content: serializePage(page) }],
      });
      return ok(`Set draft=${draft} on "${slug}".\n${result}`);
    },
  );

  server.registerTool(
    'set_redirect',
    {
      title: 'Set redirect',
      description:
        'Add a 301 redirect (from → to) to public/_redirects. Use for redirects not already handled automatically by delete_page/rename_page.',
      inputSchema: {
        from: z.string().describe('Old path, e.g. /gammel-side/'),
        to: z.string().describe('New path, e.g. /tjenester'),
        code: z.number().default(301),
        publishMode: publishModeSchema,
      },
    },
    async ({ from, to, code, publishMode }) => {
      const existing = (await getFileRaw(REDIRECTS_PATH)) ?? '';
      const content = appendRedirectLine(existing, `${from}  ${to}  ${code}`);
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Add redirect: ${from} -> ${to}`,
        actions: [{ action: 'update', file_path: REDIRECTS_PATH, content }],
      });
      return ok(`Added redirect ${from} -> ${to} (${code}).\n${result}`);
    },
  );

  // ---- Nav menu (typed, ordered; rendered by the site Header) -------------

  server.registerTool(
    'list_nav',
    {
      title: 'List nav menu',
      description: 'List the site navigation menu items, in menu order.',
      inputSchema: {},
    },
    async () => {
      const items = await readNav();
      if (!items.length) return ok('The nav menu is empty.');
      return ok(
        'Nav menu (in order):\n' +
          items
            .map((i, n) => `${n}. ${i.label} -> ${i.href}${i.external ? ' (external)' : ''}`)
            .join('\n'),
      );
    },
  );

  server.registerTool(
    'add_nav_item',
    {
      title: 'Add page to nav menu',
      description:
        'Add a link to the site navigation menu. To add an existing page, pass its href (e.g. "/about/"); the label defaults to the page title. For an off-site link pass external:true and a label. Fails if an internal page does not exist or the href is already in the menu. Optional position inserts at a 0-based index (default: end).',
      inputSchema: {
        href: z.string().describe('Internal path like "/about/" (or full URL if external).'),
        label: z.string().optional().describe('Menu text. Defaults to the page title for an internal href.'),
        external: z.boolean().default(false),
        position: z.number().int().min(0).optional().describe('0-based insert index; default appends.'),
        publishMode: publishModeSchema,
      },
    },
    async ({ href, label, external, position, publishMode }) => {
      const current = await readNav();
      if (current.some((i) => i.href === href)) return fail(`The nav menu already links to "${href}".`);

      let resolvedLabel = label;
      if (!external && href.startsWith('/')) {
        const slug = href.replace(/^\/+|\/+$/g, '');
        if (slug !== '' && slug !== 'home') {
          const pf = pageFilePath(slug);
          if (!(await fileExists(pf)))
            return fail(
              `No page "${slug}" exists (${pf}). Create the page first, or pass external:true for an off-site link.`,
            );
          if (!resolvedLabel) {
            const raw = await getFileRaw(pf);
            const title = raw ? (YAML.parse(raw)?.title as string | undefined) : undefined;
            resolvedLabel = title ?? slug;
          }
        } else if (!resolvedLabel) {
          resolvedLabel = 'Home';
        }
      }
      if (!resolvedLabel) return fail('A label is required (e.g. for external links).');

      const item: NavItem = { label: resolvedLabel, href, external: external ?? false };
      const next = [...current];
      next.splice(position ?? next.length, 0, item);
      const exists = await fileExists(NAV_PATH);
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Add nav item: ${resolvedLabel}`,
        actions: [{ action: exists ? 'update' : 'create', file_path: NAV_PATH, content: serializeNav(next) }],
      });
      return ok(`Added "${resolvedLabel}" -> ${href} to the nav menu.\n${result}`);
    },
  );

  server.registerTool(
    'remove_nav_item',
    {
      title: 'Remove from nav menu',
      description: 'Remove a link from the site navigation menu by its href (e.g. "/about/"). Does not delete the page.',
      inputSchema: {
        href: z.string(),
        publishMode: publishModeSchema,
      },
    },
    async ({ href, publishMode }) => {
      const current = await readNav();
      const next = current.filter((i) => i.href !== href);
      if (next.length === current.length)
        return fail(`No nav item with href "${href}". Use list_nav to see the current menu.`);
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Remove nav item: ${href}`,
        actions: [{ action: 'update', file_path: NAV_PATH, content: serializeNav(next) }],
      });
      return ok(`Removed "${href}" from the nav menu.\n${result}`);
    },
  );

  // ---- Blog posts (Markdown at the site root, /<slug>/) -------------------

  const postInput = {
    slug: slugSchema,
    title: z.string(),
    pubDate: z.string().describe('Publish date, e.g. 2026-06-06.'),
    body: z.string().describe('Post body as Markdown.'),
    description: z.string().optional(),
    updatedDate: z.string().optional().describe('Last-updated date, e.g. 2026-06-06.'),
    seo: seoSchema,
    categories: z.array(z.string()).default([]).describe('Category slugs (drive category archive pages, if the site has them).'),
    tags: z.array(z.string()).default([]).describe('Tag slugs -> /stikkord/<slug>/.'),
    draft: z.boolean().default(false),
    publishMode: publishModeSchema,
  };

  server.registerTool(
    'list_posts',
    {
      title: 'List posts',
      description: 'List all blog post slugs (with pubDate/draft). Read-only.',
      inputSchema: {},
    },
    async () => {
      const entries = await listTree(POSTS_DIR, { recursive: true });
      const slugs = entries
        .filter((e) => e.type === 'blob' && /\.md$/.test(e.name))
        .map((e) => e.path.slice(POSTS_DIR.length + 1).replace(/\.md$/, ''));
      const rows = await Promise.all(
        slugs.map(async (slug) => {
          const raw = await getFileRaw(postFilePath(slug));
          const fm = raw ? parsePost(raw).frontmatter : {};
          const pd = fm.pubDate;
          const pub = pd instanceof Date ? pd.toISOString().slice(0, 10) : String(pd ?? '').slice(0, 10);
          return { pub, line: `- ${slug}  (${pub || '????-??-??'})${fm.draft ? ' [draft]' : ''}` };
        }),
      );
      rows.sort((a, b) => (a.pub < b.pub ? 1 : -1));
      return ok(rows.length ? `Posts:\n${rows.map((r) => r.line).join('\n')}` : 'No posts found.');
    },
  );

  server.registerTool(
    'get_post',
    {
      title: 'Get post',
      description: 'Read a post\'s frontmatter + Markdown body. ALWAYS call before update_post.',
      inputSchema: { slug: slugSchema },
    },
    async ({ slug }) => {
      const raw = await getFileRaw(postFilePath(slug));
      if (raw === null) return fail(`Post "${slug}" does not exist.`);
      return ok(`Current content of "${slug}" (${postFilePath(slug)}):\n\n\`\`\`markdown\n${raw}\n\`\`\``);
    },
  );

  server.registerTool(
    'create_post',
    {
      title: 'Create post',
      description:
        'Create a NEW blog post (Markdown body + frontmatter) at the site root (/<slug>/). Fails if the slug exists — use update_post for existing posts.',
      inputSchema: postInput,
    },
    async ({ slug, body, publishMode, ...fmInput }) => {
      const path = postFilePath(slug);
      if (await fileExists(path)) return fail(`Post "${slug}" already exists. Use update_post.`);
      const fm = postSchema.parse({ ...fmInput, draft: fmInput.draft ?? false });
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Add post: ${slug}`,
        actions: [{ action: 'create', file_path: path, content: serializePost(fm, body) }],
      });
      return ok(`Created post "${slug}" -> /${slug}/\n${result}`);
    },
  );

  server.registerTool(
    'update_post',
    {
      title: 'Update post',
      description:
        'Replace an existing post\'s content. OVERWRITES the whole post — call get_post first and modify the returned content; never write blind. Fails if the post does not exist.',
      inputSchema: postInput,
    },
    async ({ slug, body, publishMode, ...fmInput }) => {
      const path = postFilePath(slug);
      if (!(await fileExists(path))) return fail(`Post "${slug}" does not exist. Use create_post.`);
      const fm = postSchema.parse({ ...fmInput, draft: fmInput.draft ?? false });
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Update post: ${slug}`,
        actions: [{ action: 'update', file_path: path, content: serializePost(fm, body) }],
      });
      return ok(`Updated post "${slug}".\n${result}`);
    },
  );

  server.registerTool(
    'set_post_draft',
    {
      title: 'Set post draft status',
      description: 'Toggle a post\'s draft flag (publish/unpublish) without rewriting it.',
      inputSchema: { slug: slugSchema, draft: z.boolean(), publishMode: publishModeSchema },
    },
    async ({ slug, draft, publishMode }) => {
      const raw = await getFileRaw(postFilePath(slug));
      if (raw === null) return fail(`Post "${slug}" does not exist.`);
      const { frontmatter, body } = parsePost(raw);
      const fm = postSchema.parse({ ...frontmatter, draft });
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Set draft=${draft} on post: ${slug}`,
        actions: [{ action: 'update', file_path: postFilePath(slug), content: serializePost(fm, body) }],
      });
      return ok(`Set draft=${draft} on post "${slug}".\n${result}`);
    },
  );

  server.registerTool(
    'delete_post',
    {
      title: 'Delete post',
      description: 'Delete a post. By default adds a 301 (redirectTo, default "/"); pass "" to skip.',
      inputSchema: {
        slug: slugSchema,
        redirectTo: z.string().default('/').describe('Where the old URL should 301 to (default "/"). Empty string skips.'),
        publishMode: publishModeSchema,
      },
    },
    async ({ slug, redirectTo, publishMode }) => {
      const path = postFilePath(slug);
      if (!(await fileExists(path))) return fail(`Post "${slug}" does not exist.`);
      const actions: CommitAction[] = [{ action: 'delete', file_path: path }];
      let extra = '';
      if (redirectTo) {
        const existing = (await getFileRaw(REDIRECTS_PATH)) ?? '';
        const content = appendRedirectLine(existing, `/${slug}/  ${redirectTo}  301`);
        actions.push({ action: 'update', file_path: REDIRECTS_PATH, content });
        extra = ` + 301 /${slug}/ -> ${redirectTo}`;
      }
      const result = await publish({
        mode: publishMode as PublishMode,
        message: `Delete post: ${slug}`,
        actions,
      });
      return ok(`Deleted post "${slug}"${extra}.\n${result}`);
    },
  );

  return server;
}

// ---- HTTP transport + auth ------------------------------------------------

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://your-mcp-host.example.com

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // /authorize + /token forms

// OAuth endpoints (public, no auth): metadata, registration, authorize, token.
// Lets claude.ai / Claude Desktop custom connectors register and obtain tokens.
registerOAuth(app, { publicUrl: PUBLIC_URL, gateToken: AUTH_TOKEN, resourcePath: '/mcp' });

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) {
    res.status(500).json({ error: 'Server misconfigured: MCP_AUTH_TOKEN not set.' });
    return;
  }
  const token = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  // Accept either the static token (Claude Code / API) or an OAuth access token.
  if (token && (token === AUTH_TOKEN || verifyAccessToken(token))) {
    next();
    return;
  }
  // Point OAuth-capable clients at the protected-resource metadata (RFC 9728).
  res
    .status(401)
    .set(
      'WWW-Authenticate',
      `Bearer resource_metadata="${baseUrl(req, PUBLIC_URL)}/.well-known/oauth-protected-resource"`,
    )
    .json({ error: 'Unauthorized' });
}

// Stateless: a fresh server+transport per request keeps things simple and safe.
app.post('/mcp', requireAuth, async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`VibeCheck MCP listening on :${PORT} (POST /mcp)`);
});
