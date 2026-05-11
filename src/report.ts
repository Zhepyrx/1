import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { request } from "undici";
import { config } from "./config.js";
import { listScoredWithDrafts } from "./db.js";
import type { Draft, ScoredBounty } from "./types.js";

function formatBounty(b: ScoredBounty & { draft: Draft | null }): string {
  const reward = b.reward_usd !== null ? `$${b.reward_usd}` : "?";
  const draft = b.draft;

  const lines: string[] = [];
  lines.push(`### ${b.title}`);
  lines.push("");
  lines.push(
    `- **Repo:** [${b.repo_full_name}](${b.repo_url}) (${b.language ?? "?"})`,
  );
  lines.push(`- **Reward:** ${reward}`);
  lines.push(`- **Score:** ${b.score.toFixed(1)}`);
  lines.push(`- **Source:** [${b.source}](${b.source_url})`);
  lines.push(`- **Labels:** ${b.labels.join(", ") || "(none)"}`);
  lines.push("");

  if (draft) {
    const verdict = draft.recommend_pursue ? "✅ PURSUE" : "⏭️  SKIP";
    lines.push(`**${verdict}** — ${draft.recommendation_reason}`);
    lines.push("");
    lines.push(`**Summary.** ${draft.summary}`);
    lines.push("");
    lines.push(
      `**Effort.** ${draft.complexity}${
        draft.estimated_hours !== null ? ` (~${draft.estimated_hours}h)` : ""
      } · confidence: ${draft.confidence}`,
    );
    lines.push("");
    lines.push(`**Approach.**`);
    lines.push("");
    lines.push(draft.approach);
    lines.push("");
    if (draft.risks.length > 0) {
      lines.push(`**Risks.**`);
      for (const r of draft.risks) lines.push(`- ${r}`);
      lines.push("");
    }
    lines.push(`<details><summary>Draft PR description</summary>`);
    lines.push("");
    lines.push(draft.pr_description);
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  } else {
    lines.push(`_(not yet drafted)_`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

export function buildReport(): string {
  const all = listScoredWithDrafts();
  const ranked = [...all]
    .filter((b) => b.score > 0)
    .sort((a, b) => b.score - a.score);

  const recommended = ranked.filter((b) => b.draft?.recommend_pursue);
  const skipped = ranked.filter((b) => b.draft && !b.draft.recommend_pursue);
  const undrafted = ranked.filter((b) => !b.draft);

  const date = new Date().toISOString().slice(0, 10);
  const out: string[] = [];
  out.push(`# Bounty triage — ${date}`);
  out.push("");
  out.push(
    `**${recommended.length} recommended** · ${skipped.length} skipped · ${undrafted.length} undrafted · ${ranked.length} total scored`,
  );
  out.push("");
  out.push(
    `Reviewer's job: scan the recommended section, pick what you actually want to work on, submit under your identity. Don't auto-submit any of this.`,
  );
  out.push("");

  if (recommended.length > 0) {
    out.push(`## ✅ Recommended`);
    out.push("");
    for (const b of recommended) out.push(formatBounty(b));
  }

  if (skipped.length > 0) {
    out.push(`## ⏭️  Skipped (drafted but not recommended)`);
    out.push("");
    for (const b of skipped) out.push(formatBounty(b));
  }

  if (undrafted.length > 0) {
    out.push(`## 📋 Scored but not drafted (cost cap reached)`);
    out.push("");
    out.push(
      "| Score | Reward | Repo | Title |",
      "|------:|-------:|------|-------|",
    );
    for (const b of undrafted.slice(0, 30)) {
      const reward = b.reward_usd !== null ? `$${b.reward_usd}` : "?";
      out.push(
        `| ${b.score.toFixed(1)} | ${reward} | ${b.repo_full_name} | [${b.title.replace(/\|/g, "\\|").slice(0, 80)}](${b.source_url}) |`,
      );
    }
  }

  return out.join("\n");
}

export function writeReport(md: string): string {
  mkdirSync(config.reportsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(config.reportsDir, `${date}.md`);
  writeFileSync(path, md);
  const latest = join(config.reportsDir, "latest.md");
  writeFileSync(latest, md);
  return path;
}

export async function postWebhook(summary: string): Promise<void> {
  if (!config.webhookUrl) return;
  try {
    await request(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: summary, text: summary }),
    });
  } catch (err) {
    console.warn(`[webhook] failed: ${(err as Error).message}`);
  }
}
