# Contributing to VibeCheck

Thanks for your interest in VibeCheck — the agentic CMS you talk to. Contributions
of all sizes are welcome: bug fixes, docs, new section types, provider support,
themes, or just ideas.

## Ground rules

- Be kind. See our [Code of Conduct](./CODE_OF_CONDUCT.md).
- Small, focused pull requests are easier to review and land faster.
- Open an issue (or a [Discussion](https://github.com/EpleCheck/vibecheck/discussions))
  before large changes, so we can agree on direction first.

## Project layout

VibeCheck is an npm-workspaces monorepo:

```
packages/schema   @vibecheck/schema — the content contract (zod). One source of truth.
apps/site         the Astro site    — renderer + your content. This is what deploys.
apps/mcp          @vibecheck/mcp    — the MCP server (lets an agent edit from anywhere).
```

`site` and `mcp` both import `@vibecheck/schema`, so changing the contract changes
both at once — never edit a schema in two places.

## Local setup

Requires **Node 22+**.

```bash
npm install          # installs all workspaces
npm run build        # build schema -> build site (validates content) -> typecheck mcp
npm run dev -w site  # local preview at http://localhost:4321
```

## Making a change

- **Content / a new page** → edit YAML in `apps/site/src/content/pages/`.
- **A new section type** → update `packages/schema/src/index.ts` **and** render it in
  `apps/site/src/components/PageRenderer.astro`. (The MCP picks up the schema change
  automatically.)
- **MCP tools / providers** → `apps/mcp/src/` (`providers/` for git backends).

## Before you open a PR

```bash
npm run build   # must pass — this is exactly what CI runs
```

Because the site build validates every page against the schema, **a green build
means your content is valid.** Then:

1. Branch off `main`.
2. Make your change with a clear commit message.
3. Open a pull request describing what and why. CI runs the build automatically.

## Questions?

Open a [Discussion](https://github.com/EpleCheck/vibecheck/discussions) — no question
is too small.
