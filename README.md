# VibeCheck

[![build](https://github.com/EpleCheck/vibecheck/actions/workflows/build.yml/badge.svg)](https://github.com/EpleCheck/vibecheck/actions/workflows/build.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**The CMS you talk to.** A git-backed, schema-safe, headless CMS you edit by
chatting with an AI agent.

🔗 **[Live demo →](https://vibecheck.eplecheck.no)** — a real site you can edit by
chatting with an AI agent, wired to a live MCP server. You bring the *vibe* — a
sentence to the agent — it does the *check*: validates against a schema, commits to
the repo, and the site redeploys. Content is typed data, not markup, so an agent
**can't break the build**.

> **Note:** this is the repo backing that live demo. Its live editing runs through a
> GitHub token that expires around **September 2026**. If edits stop going live after
> that, please [open an issue](https://github.com/EpleCheck/vibecheck/issues) and we'll
> rotate it.

> _Part of the EpleCheck family._ Built with Astro + the Model Context Protocol.

```
You: "Add a pricing page with three tiers."
→ agent writes structured content → commits to GitHub → Vercel ships it. ~30s.
```

## Why

- **Edit by conversation** — no admin UI, no dashboard. Just talk to Claude.
- **Can't break the build** — every change is schema-validated. A bad edit fails
  the check, not the site.
- **Git-native** — every edit is a reviewable commit / pull request. Full
  history, rollbacks, the workflow you already trust.
- **Deploys itself** — static output to Vercel / Netlify / Cloudflare Pages.

## Layout (npm workspaces monorepo)

```
packages/schema   @vibecheck/schema  — the content contract (zod). One source of truth.
apps/site         the Astro site     — renderer + your content. This is what deploys.
apps/mcp          @vibecheck/mcp     — the MCP server: lets an agent edit from anywhere.
```

`site` and `mcp` both import `@vibecheck/schema`, so the contract can never drift.

## Quickstart

1. **Use this template** → your own GitHub repo (or `git clone`).
2. **Deploy to Vercel** — import the repo. For this monorepo, set the project
   **Root Directory** to `apps/site`. (Netlify / Cloudflare Pages / GitHub Pages
   work too — it's static output.)
3. **Edit by chat**, two ways:
   - **Claude Code (local, zero infra):** open the repo in Claude Code and ask it
     to edit pages. It writes the YAML directly; the schema validates at build.
   - **MCP server (edit from anywhere):** run the VibeCheck MCP and add it to
     Claude as a connector — edit from claude.ai, Desktop, or your phone:
     ```bash
     cp apps/mcp/.env.example apps/mcp/.env   # fill in GITHUB_TOKEN + GITHUB_REPO
     npm run build && npm start -w @vibecheck/mcp
     ```
4. **Talk to it:** _"Create an FAQ page"_, _"change the hero headline"_,
   _"unpublish the pricing page"_ → committed → live.

## ✨ Try these prompts

Once the MCP is connected to Claude, paste any of these to the agent. Each one
commits to the repo and the site rebuilds in ~a minute. Add **"publish directly"**
so it goes live without opening a PR.

**Build a whole landing page in one shot**

> Create a page at `/launch/` titled "Acme — Launch". Give it a hero
> ("Ship content by chatting" with a short subheading and a "See pricing" button
> to /pricing/), a three-card features section (Fast, Schema-safe, Git-native),
> a three-tier pricing section (Starter / Pro / Scale), and a closing
> call-to-action. Then add the page to the nav menu. Publish directly.

**Add an SEO-friendly FAQ** — emits real `FAQPage` JSON-LD, not faked markup

> Add an FAQ page answering five common questions about VibeCheck, and put it in
> the nav menu. Publish directly.

**Drop in social proof** — emits `Review` JSON-LD

> Add a testimonials section to the home page with three five-star reviews of
> VibeCheck. Publish directly.

**Rearrange the menu**

> Reorder the nav so Pricing comes right after Home, and remove the FAQ link.
> Publish directly.

Every one of these is typed data under the hood — the agent **can't** emit markup
that breaks the build.

> _On the public demo, content + nav reset to a baseline every 6 hours, so feel
> free to experiment._

## Content model

A page is a YAML file in `apps/site/src/content/pages/**/*.yaml` — a `title` and
a list of typed `sections`:

| Section | What it is |
|---------|-----------|
| `hero` | heading, subheading, CTA |
| `features` | grid of cards (optional links / images) |
| `pricing` | plans with features + CTAs |
| `cta` | a call-to-action band |
| `richtext` | the only section with raw HTML |
| `form` | a simple form (name/email/fields) |

Only `richtext` carries HTML, so machine-generated content stays safe. The schema
lives in `packages/schema/src/index.ts`.

## The MCP server

`@vibecheck/mcp` exposes tools (`create_page`, `update_page`, `get_page`,
`delete_page`, `rename_page`, `set_draft`, `list_pages`, plus blog-post tools)
that commit content into your repo. Configure it via `apps/mcp/.env`:

- **GitHub** (default): `GITHUB_TOKEN`, `GITHUB_REPO` (`owner/name`).
- **GitLab** (optional): set `VIBECHECK_PROVIDER=gitlab` + `GITLAB_*`.
- `MCP_AUTH_TOKEN` — clients send this as the Bearer token.

Publish modes on every write tool: `merge_request` (default — opens a PR for
review) or `direct` (commit to the default branch; your host deploys on push).

**Run it** — locally (`npm start -w @vibecheck/mcp`), or with Docker:

```bash
cp apps/mcp/.env.example apps/mcp/.env   # fill in token + repo
docker compose up -d --build             # or pull the prebuilt image:
# docker pull ghcr.io/eplecheck/vibecheck-mcp:latest
```

It listens on `:8787` (`POST /mcp`); add it to Claude as an MCP connector with
`Authorization: Bearer <MCP_AUTH_TOKEN>`.

## CI

- `build.yml` runs `npm run build` on every push/PR — because the site build
  validates every page against the schema, **a green build means all content is
  valid**.
- `docker.yml` builds the MCP image and publishes it to
  `ghcr.io/eplecheck/vibecheck-mcp`.

## License

MIT © EpleCheck AS.
