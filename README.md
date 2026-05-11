# bounty-triage

A pipeline that discovers funded open-source bounties, scores them, and drafts an analysis for each — so a human reviewer can scan a curated queue once a day and pick what to actually pursue.

## What this is

A **reviewer aid**, not an autonomous bounty submitter.

The pipeline does the work that scales poorly for humans:
1. Pulls open bounties from Algora and GitHub issue search (labels like `bounty`, `$`, `💰`).
2. Scores each on a heuristic (reward, language match, freshness, comment crowding, already-claimed signals).
3. Drafts a structured analysis for the top N candidates using Claude — summary, technical approach, complexity estimate, risks, draft PR description, pursue/skip verdict.
4. Writes a markdown report (`reports/YYYY-MM-DD.md`) and optionally posts a webhook ping.

What you do:
- Read the report.
- Pick what's worth your time.
- Submit under your own GitHub identity, with your own code review, on your own account.

## What this is not

This is **not** a tool that submits PRs autonomously on your behalf. It does not run `git push`. It does not auth as you against arbitrary repos. The drafted PR description is a starting point for *you* to refine — not something to copy-paste verbatim.

This is also not a "find vulnerabilities and report them to bug bounty programs" tool. The "AI grinds security bounties" pattern is a known problem in 2025–2026 — curl, Python, and others have publicly complained about being flooded with confident-sounding AI-generated reports. This tool deliberately down-weights security-labeled issues unless `SKILLS` explicitly includes `security`.

## Why a human in the loop

Two reasons, in order of importance:

1. **Ethical.** Bounty platforms and maintainers respond to a human, with skin in the game and reputation on the line. An AI submitting unreviewed PRs at scale is exactly the failure mode that gets the whole pattern shut down.
2. **Practical.** The model has not read the codebase. Its draft is *triage*, not *implementation*. The 10 minutes you spend reading the actual code is what makes the difference between a merged PR and noise.

## Quickstart

```bash
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY and GITHUB_TOKEN
npm run dev -- run
```

That runs the full pipeline: `discover → score → draft → report`. The output is `reports/latest.md`.

To run stages individually:
```bash
npm run discover   # fetch candidates
npm run score      # apply heuristic
npm run draft      # call Claude on top N (costs API tokens)
npm run report     # generate markdown
```

## Configuration

All via `.env` (see `.env.example`):
- `ANTHROPIC_API_KEY` — for drafting (uses Claude Opus 4.7).
- `GITHUB_TOKEN` — any PAT with `public_repo` scope; raises search rate limits.
- `SKILLS` — comma-separated language allowlist for scoring (default: `typescript,javascript,python`).
- `MIN_BOUNTY_USD` — drops candidates below this reward (default: `50`).
- `MAX_DRAFTS_PER_RUN` — caps Claude API spend per run (default: `10`).
- `WEBHOOK_URL` — optional Discord/Slack incoming-webhook for daily summary.

## Running on a schedule

Two options.

**GitHub Actions (recommended for hands-off).** A workflow is included at `.github/workflows/triage.yml`. It runs daily at 13:00 UTC, commits the report to the repo, and pings your webhook. You need to set repo secrets: `ANTHROPIC_API_KEY`, `GH_PAT`, `WEBHOOK_URL` (optional).

**Anywhere else.** It's a Node 20 script. Cron it on a VPS, a Render cron job, a Fly machine, whatever. The state DB (`state.db`) is the only persistent file — keep it around across runs so we don't re-process bounties.

## What the report looks like

Each entry contains:
- **Verdict** — pursue or skip, with one-sentence reason.
- **Summary** — what the issue is actually asking for.
- **Effort** — complexity bucket + hour estimate + confidence.
- **Approach** — specific files/modules to touch and what to change.
- **Risks** — maintainer-preference risk, ambiguity, inactive-project risk, etc.
- **Draft PR description** — markdown skeleton.

Items the model flags `skip` are kept in the report (under a separate header) so you can see *why* something was deprioritized.

## Cost shape

Claude Opus 4.7 with adaptive thinking and `effort: "high"` is ~$5 input / $25 output per 1M tokens. A drafted candidate typically uses ~2K input + ~1K output tokens. With prompt caching on the system prompt, repeat-run cost is roughly $0.03–$0.05 per draft. `MAX_DRAFTS_PER_RUN=10` keeps a daily run under ~$0.50.

## Architecture

```
sources/algora.ts  ─┐
sources/github.ts  ─┤→ db.ts (SQLite) → score.ts → draft.ts (Claude) → report.ts → markdown + webhook
                    │
                    └─ state survives across runs; bounties are upserted by id
```

- `discover` is idempotent — bounties are upserted by source-prefixed id.
- `draft` skips anything already drafted; re-drafting requires deleting the row (intentional, to control cost).
- `score` re-scores every run, which is cheap.

## When this tool doesn't help

- You haven't set up a GitHub account capable of submitting PRs to the projects you'd be working on.
- You're not willing to read actual code before submitting.
- The economics for you require autonomous mass-submission. (Don't do that.)
- You're hoping for "passive income". This is power tools for someone who already does (or could do) freelance OSS work. The value is multiplying reviewer throughput, not creating money from nothing.

## License

MIT.
