import { z } from "zod";

/**
 * Validated Environment Configuration
 * Fails fast with clear human-readable error messages if required API keys are missing.
 */

const envSchema = z.object({
  // Required for primary orchestrator, analyst, planner, writer routing
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is missing. Required for primary model routing."),

  // Required for primary researcher (Gemma 4 31B) & fallback model routing
  GOOGLE_GENERATIVE_AI_API_KEY: z
    .string()
    .min(1, "GOOGLE_GENERATIVE_AI_API_KEY is missing. Required for Gemma 4 31B and Gemini 3.5 Flash Lite."),

  // Optional: Upstash Redis (falls back to in-process memory if not provided)
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Optional: Search APIs for researcher subagent
  TAVILY_API_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),

  // Optional: Telegram Channel
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().optional(),

  // Optional locally; production access fails closed when absent.
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  TELEGRAM_PUBLIC_TRIAL_ENABLED: z.string().optional(),
  TELEGRAM_USER_RPM_LIMIT: z.string().optional(),
  TELEGRAM_USER_RPD_LIMIT: z.string().optional(),
  TELEGRAM_TRIAL_RPM_LIMIT: z.string().optional(),
  TELEGRAM_TRIAL_RPD_LIMIT: z.string().optional(),

  // Optional: Gateway limits
  GROQ_RPM_LIMIT: z.string().optional(),
  GROQ_TPM_LIMIT: z.string().optional(),
  GEMMA_RPM_LIMIT: z.string().optional(),
  GEMMA_TPM_LIMIT: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

/** True on Vercel production (or NODE_ENV=production). Used for fail-loud prod checks. */
export function isProduction(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

let parsedEnv: EnvConfig | null = null;

export function getEnv(): Partial<EnvConfig> {
  if (parsedEnv) return parsedEnv;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    if (process.env.NODE_ENV === "test" || process.env.SKIP_ENV_VALIDATION === "true") {
      console.warn(`\n⚠️ [Polaris Configuration Warning] Missing environment variables:\n${formatted}\n`);
      return process.env as unknown as Partial<EnvConfig>;
    }
    // Actionable fail-fast: thrown at import time (models.ts), so the message
    // must tell the deployer exactly where to fix it — not just what is missing.
    const remediation = isProduction()
      ? "Set them in the Vercel Dashboard (Project → Settings → Environment Variables) or via `vercel env add`, then redeploy."
      : "Add them to .env.local at the project root (see README Quick start), then restart `npm run dev`.";
    console.error(`\n❌ [Polaris Configuration Error] Invalid or missing environment variables:\n${formatted}\n${remediation}\n`);
    throw new Error(`[Polaris Configuration Error] Missing environment configuration:\n${formatted}\n${remediation}`);
  }

  parsedEnv = result.data;
  return parsedEnv;
}
