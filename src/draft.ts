import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.js";
import type { Bounty, Draft } from "./types.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const DraftSchema = z.object({
  summary: z
    .string()
    .describe(
      "2-3 sentence plain-English summary of what the issue is actually asking for.",
    ),
  approach: z
    .string()
    .describe(
      "Concrete technical approach: what files/modules to touch, what change to make, what to test. Be specific.",
    ),
  complexity: z
    .enum(["trivial", "small", "medium", "large", "unknown"])
    .describe(
      "trivial=<1hr fix; small=half-day; medium=1-3 days; large=week+; unknown=can't tell from issue alone.",
    ),
  estimated_hours: z
    .number()
    .nullable()
    .describe("Best estimate in hours; null if you can't tell."),
  risks: z
    .array(z.string())
    .describe(
      "Specific risks: 'maintainer may have specific design preferences not stated', 'requires reproducing on Windows', 'depends on a refactor in another PR', etc. Empty array if none apparent.",
    ),
  pr_description: z
    .string()
    .describe(
      "A draft PR description in markdown. Should reference the issue, describe the change, and propose a test plan.",
    ),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe(
      "How confident you are in this analysis. Low if the issue is ambiguous or you'd need to read the codebase first.",
    ),
  recommend_pursue: z
    .boolean()
    .describe(
      "Should the human spend time on this bounty? false if the reward-to-effort ratio is poor, the issue is ambiguous, the project shows signs of being inactive, or there's a clear blocker.",
    ),
  recommendation_reason: z
    .string()
    .describe("One sentence explaining the recommend_pursue verdict."),
});

const SYSTEM_PROMPT = `You are a senior open-source engineer triaging funded GitHub issue bounties for a human reviewer.

Your job: for each bounty, produce a sober technical analysis the reviewer can scan in 30 seconds to decide whether to invest time.

Optimize for the reviewer's time, not for closing the bounty. Specifically:
- Be honest about ambiguity. If the issue is underspecified, say so and recommend skipping.
- Don't oversell. "estimated_hours: 4, confidence: high" is far more valuable than "trivial, 30 minutes" when you don't actually know.
- Identify maintainer-preference risk. Many bounties have a "right" answer the maintainer already has in mind; if there's no design discussion, flag that.
- Identify already-claimed signals in comments or labels.
- Identify the inactive-project trap: if the repo hasn't been touched in months, even a perfect PR may not get merged.

Output strict JSON matching the provided schema. Do not include text outside the JSON.

When drafting the pr_description, write it as a maintainer would want to receive it: links to the issue, brief explanation, test plan. Do NOT include marketing language, emoji, or AI-disclosure boilerplate.

Length guidance: approach should be 4-8 sentences with specific file/function names where possible. summary should be 2-3 sentences. pr_description should be a tight markdown skeleton, not a full essay.`;

function buildUserContent(b: Bounty): string {
  const reward =
    b.reward_usd !== null
      ? `$${b.reward_usd} USD`
      : "(no reward amount parsed)";
  return `## Bounty candidate

**Repository:** ${b.repo_full_name}
**Language:** ${b.language ?? "unknown"}
**Reward:** ${reward}
**Source:** ${b.source} — ${b.source_url}
**Labels:** ${b.labels.join(", ") || "(none)"}
**Comments on issue:** ${b.comments_count}
**Issue updated:** ${b.updated_at}

### Issue title
${b.title}

### Issue body
${b.body || "(empty body)"}`;
}

export async function draftBounty(b: Bounty): Promise<Draft> {
  const response = await client.messages.parse({
    model: config.model,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: zodOutputFormat(DraftSchema),
    },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildUserContent(b) }],
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `Drafting failed for ${b.id}: model returned no parseable JSON`,
    );
  }

  return {
    bounty_id: b.id,
    summary: parsed.summary,
    approach: parsed.approach,
    complexity: parsed.complexity,
    estimated_hours: parsed.estimated_hours,
    risks: parsed.risks,
    pr_description: parsed.pr_description,
    confidence: parsed.confidence,
    recommend_pursue: parsed.recommend_pursue,
    recommendation_reason: parsed.recommendation_reason,
    drafted_at: new Date().toISOString(),
    model: response.model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
  };
}
