import { readFileSync, existsSync } from "node:fs";

function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function envOptional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const config = {
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  githubToken: env("GITHUB_TOKEN"),
  skills: env("SKILLS", "typescript,javascript,python")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  minBountyUsd: Number(env("MIN_BOUNTY_USD", "50")),
  maxDraftsPerRun: Number(env("MAX_DRAFTS_PER_RUN", "10")),
  reportsDir: env("REPORTS_DIR", "./reports"),
  dbPath: env("DB_PATH", "./state.db"),
  webhookUrl: envOptional("WEBHOOK_URL"),
  model: "claude-opus-4-7",
};
