export type Source = "algora" | "github";

export interface Bounty {
  id: string;
  source: Source;
  source_url: string;
  repo_url: string;
  repo_full_name: string;
  title: string;
  body: string;
  language: string | null;
  labels: string[];
  reward_usd: number | null;
  created_at: string;
  updated_at: string;
  issue_number: number | null;
  issue_state: "open" | "closed" | null;
  comments_count: number;
}

export interface ScoredBounty extends Bounty {
  score: number;
  score_reasons: string[];
}

export interface Draft {
  bounty_id: string;
  summary: string;
  approach: string;
  complexity: "trivial" | "small" | "medium" | "large" | "unknown";
  estimated_hours: number | null;
  risks: string[];
  pr_description: string;
  confidence: "low" | "medium" | "high";
  recommend_pursue: boolean;
  recommendation_reason: string;
  drafted_at: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}
