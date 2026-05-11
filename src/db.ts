import Database from "better-sqlite3";
import { config } from "./config.js";
import type { Bounty, Draft, ScoredBounty } from "./types.js";

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS bounties (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    repo_full_name TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    language TEXT,
    labels TEXT NOT NULL,
    reward_usd REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    issue_number INTEGER,
    issue_state TEXT,
    comments_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    score REAL,
    score_reasons TEXT,
    scored_at TEXT
  );

  CREATE TABLE IF NOT EXISTS drafts (
    bounty_id TEXT PRIMARY KEY REFERENCES bounties(id),
    summary TEXT NOT NULL,
    approach TEXT NOT NULL,
    complexity TEXT NOT NULL,
    estimated_hours REAL,
    risks TEXT NOT NULL,
    pr_description TEXT NOT NULL,
    confidence TEXT NOT NULL,
    recommend_pursue INTEGER NOT NULL,
    recommendation_reason TEXT NOT NULL,
    drafted_at TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_input_tokens INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submissions (
    bounty_id TEXT PRIMARY KEY REFERENCES bounties(id),
    status TEXT NOT NULL,
    pr_url TEXT,
    notes TEXT,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_usd REAL,
    paid_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_bounties_score ON bounties(score DESC);
  CREATE INDEX IF NOT EXISTS idx_bounties_state ON bounties(issue_state);
`);

const upsertBountyStmt = db.prepare(`
  INSERT INTO bounties (
    id, source, source_url, repo_url, repo_full_name, title, body,
    language, labels, reward_usd, created_at, updated_at,
    issue_number, issue_state, comments_count, last_seen_at
  ) VALUES (
    @id, @source, @source_url, @repo_url, @repo_full_name, @title, @body,
    @language, @labels, @reward_usd, @created_at, @updated_at,
    @issue_number, @issue_state, @comments_count, datetime('now')
  )
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    body = excluded.body,
    labels = excluded.labels,
    reward_usd = excluded.reward_usd,
    updated_at = excluded.updated_at,
    issue_state = excluded.issue_state,
    comments_count = excluded.comments_count,
    last_seen_at = datetime('now')
`);

export function upsertBounty(b: Bounty): void {
  upsertBountyStmt.run({
    ...b,
    labels: JSON.stringify(b.labels),
  });
}

const updateScoreStmt = db.prepare(`
  UPDATE bounties SET score = ?, score_reasons = ?, scored_at = datetime('now') WHERE id = ?
`);

export function saveScore(
  id: string,
  score: number,
  reasons: string[],
): void {
  updateScoreStmt.run(score, JSON.stringify(reasons), id);
}

const upsertDraftStmt = db.prepare(`
  INSERT INTO drafts (
    bounty_id, summary, approach, complexity, estimated_hours, risks,
    pr_description, confidence, recommend_pursue, recommendation_reason,
    drafted_at, model, input_tokens, output_tokens, cache_read_input_tokens
  ) VALUES (
    @bounty_id, @summary, @approach, @complexity, @estimated_hours, @risks,
    @pr_description, @confidence, @recommend_pursue, @recommendation_reason,
    @drafted_at, @model, @input_tokens, @output_tokens, @cache_read_input_tokens
  )
  ON CONFLICT(bounty_id) DO UPDATE SET
    summary = excluded.summary,
    approach = excluded.approach,
    complexity = excluded.complexity,
    estimated_hours = excluded.estimated_hours,
    risks = excluded.risks,
    pr_description = excluded.pr_description,
    confidence = excluded.confidence,
    recommend_pursue = excluded.recommend_pursue,
    recommendation_reason = excluded.recommendation_reason,
    drafted_at = excluded.drafted_at,
    model = excluded.model,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_input_tokens = excluded.cache_read_input_tokens
`);

export function saveDraft(d: Draft): void {
  upsertDraftStmt.run({
    ...d,
    risks: JSON.stringify(d.risks),
    recommend_pursue: d.recommend_pursue ? 1 : 0,
  });
}

interface BountyRow {
  id: string;
  source: string;
  source_url: string;
  repo_url: string;
  repo_full_name: string;
  title: string;
  body: string;
  language: string | null;
  labels: string;
  reward_usd: number | null;
  created_at: string;
  updated_at: string;
  issue_number: number | null;
  issue_state: string | null;
  comments_count: number;
  score: number | null;
  score_reasons: string | null;
}

function rowToScored(row: BountyRow): ScoredBounty {
  return {
    id: row.id,
    source: row.source as ScoredBounty["source"],
    source_url: row.source_url,
    repo_url: row.repo_url,
    repo_full_name: row.repo_full_name,
    title: row.title,
    body: row.body,
    language: row.language,
    labels: JSON.parse(row.labels) as string[],
    reward_usd: row.reward_usd,
    created_at: row.created_at,
    updated_at: row.updated_at,
    issue_number: row.issue_number,
    issue_state: row.issue_state as ScoredBounty["issue_state"],
    comments_count: row.comments_count,
    score: row.score ?? 0,
    score_reasons: row.score_reasons
      ? (JSON.parse(row.score_reasons) as string[])
      : [],
  };
}

export function listOpenBounties(): ScoredBounty[] {
  const rows = db
    .prepare(
      `SELECT * FROM bounties WHERE issue_state IS NULL OR issue_state = 'open' ORDER BY score DESC NULLS LAST, reward_usd DESC NULLS LAST`,
    )
    .all() as BountyRow[];
  return rows.map(rowToScored);
}

export function listTopUndrafted(limit: number): ScoredBounty[] {
  const rows = db
    .prepare(
      `SELECT b.* FROM bounties b
       LEFT JOIN drafts d ON d.bounty_id = b.id
       WHERE d.bounty_id IS NULL
         AND (b.issue_state IS NULL OR b.issue_state = 'open')
         AND b.score IS NOT NULL
       ORDER BY b.score DESC
       LIMIT ?`,
    )
    .all(limit) as BountyRow[];
  return rows.map(rowToScored);
}

interface DraftRow {
  bounty_id: string;
  summary: string;
  approach: string;
  complexity: string;
  estimated_hours: number | null;
  risks: string;
  pr_description: string;
  confidence: string;
  recommend_pursue: number;
  recommendation_reason: string;
  drafted_at: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export function getDraft(bountyId: string): Draft | null {
  const row = db
    .prepare(`SELECT * FROM drafts WHERE bounty_id = ?`)
    .get(bountyId) as DraftRow | undefined;
  if (!row) return null;
  return {
    bounty_id: row.bounty_id,
    summary: row.summary,
    approach: row.approach,
    complexity: row.complexity as Draft["complexity"],
    estimated_hours: row.estimated_hours,
    risks: JSON.parse(row.risks) as string[],
    pr_description: row.pr_description,
    confidence: row.confidence as Draft["confidence"],
    recommend_pursue: row.recommend_pursue === 1,
    recommendation_reason: row.recommendation_reason,
    drafted_at: row.drafted_at,
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_input_tokens: row.cache_read_input_tokens,
  };
}

export function listScoredWithDrafts(): Array<ScoredBounty & { draft: Draft | null }> {
  const open = listOpenBounties();
  return open.map((b) => ({ ...b, draft: getDraft(b.id) }));
}

export function close(): void {
  db.close();
}
