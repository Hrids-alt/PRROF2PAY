/** Repo facts from the GitHub REST API. Submitted code is read, never run. */

export interface GithubClient {
  commitExists(repo: string, sha: string): Promise<boolean>;
  getFile(repo: string, path: string, ref: string | null): Promise<{ exists: boolean; text: string | null }>;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function isValidRepo(v: string): boolean {
  return REPO_RE.test(v) && !v.includes("..");
}
export function isValidSha(v: string): boolean {
  return SHA_RE.test(v);
}

export function makeGithubClient(opts: { token?: string; fetchImpl?: typeof fetch } = {}): GithubClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "proof2pay-verifier",
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
  };
  const get = (path: string) => fetchImpl(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(10_000) });

  return {
    async commitExists(repo, sha) {
      if (!isValidRepo(repo) || !isValidSha(sha)) return false;
      const res = await get(`/repos/${repo}/commits/${sha}`);
      await res.body?.cancel();
      return res.status === 200;
    },
    async getFile(repo, path, ref) {
      if (!isValidRepo(repo) || path.includes("..") || path.startsWith("/")) return { exists: false, text: null };
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const q = ref && isValidSha(ref) ? `?ref=${ref}` : "";
      const res = await get(`/repos/${repo}/contents/${encoded}${q}`);
      if (res.status !== 200) {
        await res.body?.cancel();
        return { exists: false, text: null };
      }
      const json = (await res.json()) as { type?: string; content?: string; encoding?: string };
      if (json.type !== "file") return { exists: true, text: null };
      const text = json.encoding === "base64" && typeof json.content === "string" ? Buffer.from(json.content, "base64").toString("utf8") : null;
      return { exists: true, text };
    },
  };
}
