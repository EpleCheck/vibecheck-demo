import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { pageSchema } from '@vibecheck/schema';

/**
 * Pages live in src/content/pages/**\/*.yaml. The schema is shared with the MCP
 * server through @vibecheck/schema, so anything the agent commits validates and
 * builds here too — one contract, two consumers.
 *
 * To enable a blog, add a `blog` collection here using `postSchema` from
 * @vibecheck/schema and a `glob` over Markdown files.
 */
const pages = defineCollection({
  loader: glob({ pattern: '**/*.{yaml,yml}', base: './src/content/pages' }),
  schema: pageSchema,
});

export const collections = { pages };
