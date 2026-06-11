/**
 * GitHub provider — commits content via the GitHub REST API (Personal Access
 * Token or fine-grained token with `contents: write` + `pull_requests: write`).
 *
 * Multi-file changes go through the git-data API (blobs → tree → commit → ref)
 * so every change lands as one atomic commit, just like the GitLab commit API.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPO ("owner/name"), GITHUB_DEFAULT_BRANCH (=main),
 * optional GITHUB_API_URL (for GitHub Enterprise).
 */
import type { CommitAction, GitProvider, TreeEntry } from './types.js';

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

/** Encode each path segment but keep the slashes (GitHub wants literal `/`). */
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function createGitHubProvider(): GitProvider {
  const repo = process.env.GITHUB_REPO ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  const defaultBranch = process.env.GITHUB_DEFAULT_BRANCH ?? 'main';
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error('GITHUB_REPO must be set as "owner/name".');
  }

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vibecheck-mcp',
      ...extra,
    };
  }

  async function gh(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<Response> {
    const accept = init.raw ? { Accept: 'application/vnd.github.raw' } : undefined;
    const { raw, ...rest } = init;
    return fetch(`${API}/repos/${owner}/${name}${path}`, {
      ...rest,
      headers: { ...headers(accept), ...(init.headers as Record<string, string>) },
    });
  }

  async function ghJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await gh(path, init);
    if (!res.ok) {
      throw new Error(`GitHub ${init.method ?? 'GET'} ${path} ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    defaultBranch,

    async fileExists(filePath, ref = defaultBranch) {
      const res = await gh(`/contents/${encPath(filePath)}?ref=${encodeURIComponent(ref)}`);
      return res.ok;
    },

    async getFileRaw(filePath, ref = defaultBranch) {
      const res = await gh(`/contents/${encPath(filePath)}?ref=${encodeURIComponent(ref)}`, { raw: true });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub getFileRaw ${res.status}: ${await res.text()}`);
      return res.text();
    },

    async listTree(path, opts = {}): Promise<TreeEntry[]> {
      const ref = opts.ref ?? defaultBranch;
      if (opts.recursive) {
        const data = await ghJson<{ tree: Array<{ path: string; type: string }> }>(
          `/git/trees/${encPath(ref)}?recursive=1`,
        );
        const prefix = path.endsWith('/') ? path : `${path}/`;
        return data.tree
          .filter((e) => e.path === path || e.path.startsWith(prefix))
          .map((e) => ({ name: e.path.split('/').pop() ?? e.path, path: e.path, type: e.type }));
      }
      const res = await gh(`/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`GitHub listTree ${res.status}: ${await res.text()}`);
      const items = (await res.json()) as Array<{ name: string; path: string; type: string }>;
      return items.map((e) => ({ name: e.name, path: e.path, type: e.type === 'dir' ? 'tree' : 'blob' }));
    },

    async commit({ branch, message, actions, startBranch }) {
      const base = startBranch && startBranch !== branch ? startBranch : branch;
      const ref = await ghJson<{ object: { sha: string } }>(`/git/ref/heads/${encPath(base)}`);
      const baseSha = ref.object.sha;
      const baseCommit = await ghJson<{ tree: { sha: string } }>(`/git/commits/${baseSha}`);

      const tree: Array<Record<string, unknown>> = [];
      for (const a of actions) {
        if (a.action === 'delete') {
          tree.push({ path: a.file_path, mode: '100644', type: 'blob', sha: null });
        } else if (a.action === 'move') {
          if (a.previous_path) tree.push({ path: a.previous_path, mode: '100644', type: 'blob', sha: null });
          tree.push({ path: a.file_path, mode: '100644', type: 'blob', content: a.content ?? '' });
        } else {
          tree.push({ path: a.file_path, mode: '100644', type: 'blob', content: a.content ?? '' });
        }
      }

      const newTree = await ghJson<{ sha: string }>('/git/trees', {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
      });
      const newCommit = await ghJson<{ sha: string; html_url: string }>('/git/commits', {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
      });

      if (startBranch && startBranch !== branch) {
        await ghJson('/git/refs', {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
        });
      } else {
        await ghJson(`/git/refs/heads/${encPath(branch)}`, {
          method: 'PATCH',
          body: JSON.stringify({ sha: newCommit.sha }),
        });
      }
      return { id: newCommit.sha, web_url: newCommit.html_url };
    },

    async openPullRequest({ sourceBranch, targetBranch, title }) {
      const pr = await ghJson<{ html_url: string; number: number }>('/pulls', {
        method: 'POST',
        body: JSON.stringify({ title, head: sourceBranch, base: targetBranch }),
      });
      return { web_url: pr.html_url, iid: pr.number };
    },
  };
}
