/**
 * Active git provider, selected by env. `index.ts` imports the bound functions
 * below, so it stays provider-agnostic.
 *
 *   VIBECHECK_PROVIDER=github  (default) | gitlab
 */
import { createGitHubProvider } from './providers/github.js';
import { createGitLabProvider } from './providers/gitlab.js';
import type { GitProvider } from './providers/types.js';

export type { CommitAction } from './providers/types.js';

const which = (process.env.VIBECHECK_PROVIDER ?? 'github').toLowerCase();
const active: GitProvider = which === 'gitlab' ? createGitLabProvider() : createGitHubProvider();

export const DEFAULT_BRANCH = active.defaultBranch;
export const fileExists = active.fileExists.bind(active);
export const getFileRaw = active.getFileRaw.bind(active);
export const listTree = active.listTree.bind(active);
export const commit = active.commit.bind(active);
// Kept as `createMergeRequest` so index.ts reads naturally for both providers.
export const createMergeRequest = active.openPullRequest.bind(active);
