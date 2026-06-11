/**
 * Git provider interface. VibeCheck commits content into your repo through one
 * of these — GitHub by default, GitLab optional. Add another by implementing
 * this interface and wiring it up in ../provider.ts.
 */

export type CommitAction = {
  action: 'create' | 'update' | 'delete' | 'move';
  file_path: string;
  previous_path?: string; // for 'move'
  content?: string;
};

export interface TreeEntry {
  name: string;
  path: string;
  type: string; // 'blob' (file) | 'tree' (dir)
}

export interface GitProvider {
  readonly defaultBranch: string;
  /** True if a file exists on the given ref. */
  fileExists(filePath: string, ref?: string): Promise<boolean>;
  /** Raw file text, or null if missing. */
  getFileRaw(filePath: string, ref?: string): Promise<string | null>;
  /** Entries under a path. `recursive` includes nested files. */
  listTree(path: string, opts?: { recursive?: boolean; ref?: string }): Promise<TreeEntry[]>;
  /** One atomic commit of file actions. If `startBranch` differs from `branch`,
   * `branch` is created from `startBranch` (the pull-request flow). */
  commit(opts: {
    branch: string;
    message: string;
    actions: CommitAction[];
    startBranch?: string;
  }): Promise<{ web_url?: string; id: string }>;
  /** Open a pull/merge request. */
  openPullRequest(opts: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
  }): Promise<{ web_url: string; iid: number }>;
}
