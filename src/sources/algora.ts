import { request } from "undici";
import type { Bounty } from "../types.js";

// Algora exposes a public bounty board. The public API surface has changed
// over time; this module hits the documented JSON endpoint and falls back
// gracefully if the shape drifts. Override with ALGORA_API_URL if needed.
const ALGORA_API_URL =
  process.env.ALGORA_API_URL ?? "https://console.algora.io/api/v1/bounties";

interface AlgoraBounty {
  id?: string;
  number?: number;
  task?: {
    id?: string;
    title?: string;
    body?: string;
    url?: string;
    repo_owner?: string;
    repo_name?: string;
    forge?: string;
    number?: number;
    type?: string;
    status?: string;
  };
  reward?: {
    amount?: number;
    currency?: string;
  };
  amount?: { amount?: number; currency?: string } | number;
  status?: string;
  type?: string;
  created_at?: string;
  updated_at?: string;
  url?: string;
  org?: { handle?: string; display_name?: string };
}

interface AlgoraResponse {
  items?: AlgoraBounty[];
  data?: AlgoraBounty[];
  bounties?: AlgoraBounty[];
}

function pickArray(json: unknown): AlgoraBounty[] {
  if (Array.isArray(json)) return json as AlgoraBounty[];
  if (json && typeof json === "object") {
    const r = json as AlgoraResponse;
    return r.items ?? r.data ?? r.bounties ?? [];
  }
  return [];
}

function toUsd(b: AlgoraBounty): number | null {
  // Algora amounts are typically integer cents.
  const r = b.reward ?? (typeof b.amount === "object" ? b.amount : undefined);
  if (r && typeof r.amount === "number") {
    const currency = (r.currency ?? "USD").toUpperCase();
    if (currency !== "USD") return null; // skip non-USD for simplicity
    return r.amount > 1000 ? r.amount / 100 : r.amount;
  }
  if (typeof b.amount === "number") {
    return b.amount > 1000 ? b.amount / 100 : b.amount;
  }
  return null;
}

export async function fetchAlgoraBounties(): Promise<Bounty[]> {
  let body: unknown;
  try {
    const res = await request(ALGORA_API_URL, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "bounty-triage/0.1" },
    });
    if (res.statusCode >= 400) {
      console.warn(
        `[algora] HTTP ${res.statusCode} — skipping Algora discovery this run`,
      );
      return [];
    }
    body = await res.body.json();
  } catch (err) {
    console.warn(`[algora] fetch failed: ${(err as Error).message}`);
    return [];
  }

  const items = pickArray(body);
  const out: Bounty[] = [];
  for (const raw of items) {
    const task = raw.task ?? {};
    const owner = task.repo_owner ?? raw.org?.handle ?? null;
    const repoName = task.repo_name ?? null;
    const issueNumber = task.number ?? raw.number ?? null;
    const reward = toUsd(raw);
    if (!owner || !repoName || !issueNumber) continue;

    const repoFullName = `${owner}/${repoName}`;
    const sourceUrl =
      task.url ?? raw.url ?? `https://github.com/${repoFullName}/issues/${issueNumber}`;

    out.push({
      id: `algora:${repoFullName}#${issueNumber}`,
      source: "algora",
      source_url: sourceUrl,
      repo_url: `https://github.com/${repoFullName}`,
      repo_full_name: repoFullName,
      title: task.title ?? `Issue #${issueNumber}`,
      body: task.body ?? "",
      language: null,
      labels: [],
      reward_usd: reward,
      created_at: raw.created_at ?? new Date().toISOString(),
      updated_at: raw.updated_at ?? raw.created_at ?? new Date().toISOString(),
      issue_number: issueNumber,
      issue_state: (task.status === "closed" ? "closed" : "open") as
        | "open"
        | "closed",
      comments_count: 0,
    });
  }
  return out;
}
