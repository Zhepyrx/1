#!/usr/bin/env node
import { config } from "./config.js";
import {
  close,
  listOpenBounties,
  listTopUndrafted,
  saveDraft,
  saveScore,
  upsertBounty,
} from "./db.js";
import { draftBounty } from "./draft.js";
import { buildReport, postWebhook, writeReport } from "./report.js";
import { scoreBounty } from "./score.js";
import { fetchAlgoraBounties } from "./sources/algora.js";
import { fetchGitHubBounties } from "./sources/github.js";

async function discover(): Promise<void> {
  console.log("[discover] fetching sources...");
  const [algora, github] = await Promise.all([
    fetchAlgoraBounties(),
    fetchGitHubBounties(),
  ]);
  console.log(
    `[discover] algora=${algora.length} github=${github.length}`,
  );
  const all = [...algora, ...github];
  for (const b of all) upsertBounty(b);
  console.log(`[discover] persisted ${all.length} bounties (upserted)`);
}

function score(): void {
  const open = listOpenBounties();
  let n = 0;
  for (const b of open) {
    const { score, reasons } = scoreBounty(b);
    saveScore(b.id, score, reasons);
    n++;
  }
  console.log(`[score] scored ${n} open bounties`);
}

async function draft(): Promise<void> {
  const candidates = listTopUndrafted(config.maxDraftsPerRun);
  if (candidates.length === 0) {
    console.log("[draft] nothing to draft");
    return;
  }
  console.log(
    `[draft] drafting top ${candidates.length} candidates (max ${config.maxDraftsPerRun})`,
  );
  let succeeded = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  for (const b of candidates) {
    try {
      const d = await draftBounty(b);
      saveDraft(d);
      succeeded++;
      totalInput += d.input_tokens;
      totalOutput += d.output_tokens;
      totalCacheRead += d.cache_read_input_tokens;
      const verdict = d.recommend_pursue ? "PURSUE" : "skip";
      console.log(
        `[draft] ${b.id} score=${b.score.toFixed(1)} → ${verdict} (${d.complexity}, conf=${d.confidence})`,
      );
    } catch (err) {
      console.warn(
        `[draft] ${b.id} failed: ${(err as Error).message}`,
      );
    }
  }
  console.log(
    `[draft] ${succeeded}/${candidates.length} drafted · tokens in=${totalInput} out=${totalOutput} cache_read=${totalCacheRead}`,
  );
}

function report(): void {
  const md = buildReport();
  const path = writeReport(md);
  console.log(`[report] wrote ${path}`);
}

async function notify(): Promise<void> {
  if (!config.webhookUrl) return;
  const md = buildReport();
  const lines = md.split("\n").slice(0, 6).join("\n");
  await postWebhook(`Bounty triage report ready:\n\n${lines}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  try {
    switch (cmd) {
      case "discover":
        await discover();
        break;
      case "score":
        score();
        break;
      case "draft":
        await draft();
        break;
      case "report":
        report();
        break;
      case "run":
        await discover();
        score();
        await draft();
        report();
        await notify();
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.error(`Usage: bounty-triage {discover|score|draft|report|run}`);
        process.exitCode = 1;
    }
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
