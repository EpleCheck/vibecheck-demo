/**
 * GitLab provider — commits content via the GitLab REST API (Personal Access
 * Token). Works against gitlab.com or self-managed GitLab CE.
 *
 * Env: GITLAB_TOKEN, GITLAB_PROJECT_ID (numeric id or URL-encoded path),
 * GITLAB_DEFAULT_BRANCH (=main), optional GITLAB_API_URL.
 */
import type { CommitAction, GitProvider, TreeEntry } from './types.js';

export function createGitLabProvider(): GitProvider {
  const API = process.env.GITLAB_API_URL ?? 'https://gitlab.com/api/v4';
  const PROJECT = encodeURIComponent(process.env.GITLAB_PROJECT_ID ?? '');
  const TOKEN = process.env.GITLAB_TOKEN ?? '';
  const defaultBranch = process.env.GITLAB_DEFAULT_BRANCH ?? 'main';

  async function gl(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${API}/projects/${PROJECT}${path}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': TOKEN,
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string>),
      },
    });
  }

  return {
    defaultBranch,

    async fileExists(filePath, ref = defaultBranch) {
      const res = await gl(
        `/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
        { method: 'HEAD' },
      );
      return res.ok;
    },

    async getFileRaw(filePath, ref = defaultBranch) {
      const res = await gl(
        `/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitLab getFileRaw ${res.status}: ${await res.text()}`);
      return res.text();
    },

    async listTree(path, opts = {}): Promise<TreeEntry[]> {
      const ref = opts.ref ?? defaultBranch;
      const out: TreeEntry[] = [];
      for (let page = 1; ; page++) {
        const res = await gl(
          `/repository/tree?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}` +
            `${opts.recursive ? '&recursive=true' : ''}&per_page=100&page=${page}`,
        );
        if (!res.ok) throw new Error(`GitLab listTree ${res.status}: ${await res.text()}`);
        const batch = (await res.json()) as TreeEntry[];
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },

    async commit({ branch, message, actions, startBranch }) {
      const body: Record<string, unknown> = {
        branch,
        commit_message: message,
        actions: actions as CommitAction[],
      };
      if (startBranch && startBranch !== branch) body.start_branch = startBranch;
      const res = await gl('/repository/commits', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`GitLab commit ${res.status}: ${await res.text()}`);
      return res.json() as Promise<{ web_url?: string; id: string }>;
    },

    async openPullRequest({ sourceBranch, targetBranch, title }) {
      const res = await gl('/merge_requests', {
        method: 'POST',
        body: JSON.stringify({
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title,
          remove_source_branch: true,
        }),
      });
      if (!res.ok) throw new Error(`GitLab createMergeRequest ${res.status}: ${await res.text()}`);
      return res.json() as Promise<{ web_url: string; iid: number }>;
    },
  };
}
