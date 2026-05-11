import { config } from "./config.js";
import type { Bounty } from "./types.js";

export function scoreBounty(b: Bounty): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Reward — log-ish weighting so a $5000 bounty isn't 50x a $100 one.
  if (b.reward_usd && b.reward_usd > 0) {
    if (b.reward_usd < config.minBountyUsd) {
      return {
        score: 0,
        reasons: [`reward $${b.reward_usd} below MIN_BOUNTY_USD ($${config.minBountyUsd})`],
      };
    }
    const rewardScore = Math.min(40, 10 + Math.log10(b.reward_usd) * 8);
    score += rewardScore;
    reasons.push(`reward $${b.reward_usd} (+${rewardScore.toFixed(1)})`);
  } else {
    score += 5;
    reasons.push("no reward parsed; speculative (+5)");
  }

  // Language match
  if (b.language && config.skills.includes(b.language.toLowerCase())) {
    score += 20;
    reasons.push(`language ${b.language} matches skills (+20)`);
  } else if (b.language) {
    score -= 5;
    reasons.push(`language ${b.language} not in skills (-5)`);
  }

  // Freshness — newer is better, decay over 60 days
  const ageDays =
    (Date.now() - new Date(b.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 7) {
    score += 15;
    reasons.push(`fresh (<7d, +15)`);
  } else if (ageDays < 30) {
    score += 8;
    reasons.push(`recent (<30d, +8)`);
  } else if (ageDays > 90) {
    score -= 10;
    reasons.push(`stale (>90d, -10)`);
  }

  // Crowded — many comments means many people may already be working on it
  if (b.comments_count > 20) {
    score -= 10;
    reasons.push(`crowded (${b.comments_count} comments, -10)`);
  } else if (b.comments_count > 5) {
    score -= 3;
    reasons.push(`active discussion (${b.comments_count} comments, -3)`);
  }

  // Body length — too short = poorly specified, too long = probably complex/political
  const bodyLen = b.body.length;
  if (bodyLen < 80) {
    score -= 8;
    reasons.push(`body too short (${bodyLen} chars, -8)`);
  } else if (bodyLen > 200 && bodyLen < 4000) {
    score += 5;
    reasons.push(`well-specified body (+5)`);
  } else if (bodyLen > 8000) {
    score -= 4;
    reasons.push(`very long body, likely complex (-4)`);
  }

  // Labels — `good first issue`, `help wanted` are positive signals
  const labelText = b.labels.join(" ").toLowerCase();
  if (/good first issue|help wanted|hacktoberfest/.test(labelText)) {
    score += 8;
    reasons.push(`positive label signal (+8)`);
  }
  if (/wip|do not work|claimed|in progress|assigned/.test(labelText)) {
    score -= 30;
    reasons.push(`already-claimed signal (-30)`);
  }
  if (/security|cve|exploit|0day/.test(labelText)) {
    // Security bounties are the slop-flood category. Down-weight unless we
    // explicitly opt in via skills.
    if (!config.skills.includes("security")) {
      score -= 15;
      reasons.push(`security label, skill not opted in (-15)`);
    }
  }

  return { score: Math.round(score * 10) / 10, reasons };
}
