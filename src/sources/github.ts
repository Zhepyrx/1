import { request } from "undici";
import { config } from "../config.js";
import type { Bounty } from "../types.js";

// Search GitHub for open issues with bounty-flavored labels. This catches
// projects that fund their own issues outside of dedicated bounty platforms
// (Sentry, Polar, hand-rolled programs, etc.).
const SEARCH_LABELS = [
  '"bounty"',
  '"💰 bounty"',
  '"💰 Bounty"',
  '"$$"',
  '"$"',
  '"bountied"',
];

interface GitHubSearchIssueItem {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  comments: number;
  labels: Array<{ name: string }>;
  repository_url: string;
}

interface GitHubSearchResponse {
  items?: GitHubSearchIssueItem[];
  message?: string;
}

interface GitHubRepo {
  full_name: string;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  pushed_at: string;
}

const repoCache = new Map<string, GitHubRepo | null>();

async function ghGet<T>(url: string): Promise<T | null> {
  try {
    const res = await request(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.githubToken}`,
        "user-agent": "bounty-triage/0.1",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.statusCode === 403 || res.statusCode === 429) {
      const reset = res.headers["x-ratelimit-reset"];
      console.warn(
        `[github] rate-limited (${res.statusCode}); reset=${reset ?? "?"}`,
      );
      return null;
    }
    if (res.statusCode >= 400) {
      console.warn(`[github] HTTP ${res.statusCode} on ${url}`);
      return null;
    }
    return (await res.body.json()) as T;
  } catch (err) {
    console.warn(`[github] fetch failed (${url}): ${(err as Error).message}`);
    return null;
  }
}

async function getRepo(apiRepoUrl: string): Promise<GitHubRepo | null> {
  const cached = repoCache.get(apiRepoUrl);
  if (cached !== undefined) return cached;
  const repo = await ghGet<GitHubRepo>(apiRepoUrl);
  repoCache.set(apiRepoUrl, repo);
  return repo;
}

function extractReward(text: string): number | null {
  // Look for $123, $1,200, $1.2k, USD 500 style mentions.
  const patterns = [
    /\$\s*([0-9][0-9,]*)(?:\.[0-9]+)?\s*(k|K)?/g,
    /\b(USD|usd)\s*([0-9][0-9,]*)/g,
  ];
  let best: number | null = null;
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const numStr = (m[1] ?? m[2] ?? "").replace(/,/g, "");
      let n = parseFloat(numStr);
      if (Number.isFinite(n)) {
        if (m[2] === "k" || m[2] === "K") n *= 1000;
        if (n >= 5 && n <= 1_000_000 && (best === null || n > best)) best = n;
      }
    }
  }
  return best;
}

export async function fetchGitHubBounties(): Promise<Bounty[]> {
  const queries = SEARCH_LABELS.map(
    (label) => `q=is:issue+is:open+label:${encodeURIComponent(label)}&per_page=50&sort=updated`,
  );

  const seen = new Set<string>();
  const out: Bounty[] = [];

  for (const q of queries) {
    const url = `https://api.github.com/search/issues?${q}`;
    const result = await ghGet<GitHubSearchResponse>(url);
    if (!result?.items) continue;

    for (const item of result.items) {
      const repo = await getRepo(item.repository_url);
      if (!repo) continue;

      const id = `github:${repo.full_name}#${item.number}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const reward =
        extractReward(item.title) ??
        extractReward(item.body ?? "") ??
        null;

      out.push({
        id,
        source: "github",
        source_url: item.html_url,
        repo_url: repo.html_url,
        repo_full_name: repo.full_name,
        title: item.title,
        body: item.body ?? "",
        language: repo.language,
        labels: item.labels.map((l) => l.name),
        reward_usd: reward,
        created_at: item.created_at,
        updated_at: item.updated_at,
        issue_number: item.number,
        issue_state: item.state,
        comments_count: item.comments,
      });
    }
  }
  return out;
}
