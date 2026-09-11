/**
 * Telegram abuse protection: allowlist + per-user sliding-window rate limit.
 *
 * Why this exists: the LLM gateway limits are global. Without a per-chat
 * gate, one abusive Telegram user can burn the whole 1000 Groq RPD budget.
 *
 * Enforced in `onMessage` (return null = drop the update before any LLM
 * spend). Callback queries (HITL button clicks) only resume existing
 * sessions, so they are out of scope here.
 */

import { scratchpadRead, scratchpadWrite } from "./redis.js";
import { log } from "./log.js";

const DEFAULT_RPM = 10;
const DEFAULT_RPD = 200;
const DEFAULT_PUBLIC_RPD = 100;

function isProduction(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production"
  );
}

export function isPublicTrialEnabled(): boolean {
  return (
    process.env.TELEGRAM_PUBLIC_TRIAL_ENABLED === "1" ||
    process.env.TELEGRAM_PUBLIC_TRIAL_ENABLED === "true"
  );
}

/** Comma-separated Telegram user ids that may use the bot. */
export function getAllowedUserIds(): Set<string> {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isTelegramUserAllowed(
  userId: string | number | undefined,
): boolean {
  const allow = getAllowedUserIds();
  if (userId === undefined || userId === null || userId === "") return false;
  if (allow.size === 0) {
    return true;
  }
  return allow.has(String(userId).trim());
}

interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSec?: number;
  notice?: string;
}

// In-memory fallback when Redis is unavailable in local development.
const memoryHits = new Map<string, number[]>();

function checkMemory(
  key: string,
  rpm: number,
  rpd: number,
  now: number,
): RateLimitVerdict {
  const min = now - 60_000;
  const day = now - 86_400_000;
  const hits = (memoryHits.get(key) ?? []).filter((t) => t > day);
  const lastMin = hits.filter((t) => t > min).length;
  if (hits.length >= rpd) {
    return {
      allowed: false,
      retryAfterSec: 3600,
      notice: `Daily limit reached (${rpd}/day). Try again tomorrow.`,
    };
  }
  if (rpm > 0 && lastMin >= rpm) {
    return {
      allowed: false,
      retryAfterSec: 60,
      notice: `Slow down — max ${rpm} requests/minute. Try again in a minute.`,
    };
  }
  hits.push(now);
  memoryHits.set(key, hits);
  return { allowed: true };
}

/**
 * Sliding-window per-user rate limit. Redis-backed when configured.
 * Production fails closed when persistent rate limiting is unavailable.
 */
async function checkStoredRateLimit(
  key: string,
  rpm: number,
  rpd: number,
  now: number,
  context: { chatId?: string; userId: string },
): Promise<RateLimitVerdict> {
  try {
    const { value, persisted } = await scratchpadRead(key, {
      sessionId: undefined,
    });
    if (!persisted && isProduction()) {
      return {
        allowed: false,
        retryAfterSec: 60,
        notice:
          "Rate limiting is temporarily unavailable. Please try again shortly.",
      };
    }
    const hits: number[] = value ? (JSON.parse(value) as number[]) : [];
    const day = now - 86_400_000;
    const recent = hits.filter((t) => t > day);
    const lastMin = recent.filter((t) => t > now - 60_000).length;

    if (recent.length >= rpd) {
      return {
        allowed: false,
        retryAfterSec: 3600,
        notice: `Daily limit reached (${rpd}/day). Try again tomorrow.`,
      };
    }
    if (rpm > 0 && lastMin >= rpm) {
      return {
        allowed: false,
        retryAfterSec: 60,
        notice: `Slow down — max ${rpm} requests/minute. Try again in a minute.`,
      };
    }
    recent.push(now);
    const { persisted: writePersisted } = await scratchpadWrite(
      key,
      JSON.stringify(recent.slice(-500)),
      {
        sessionId: undefined,
        ttlSeconds: 86400,
      },
    );
    if (!writePersisted && isProduction()) {
      log.warn(
        "telegram-guard",
        "Redis unavailable in production — persistent Telegram rate limits are unavailable. Set UPSTASH_REDIS_REST_URL/TOKEN.",
        context,
      );
      return {
        allowed: false,
        retryAfterSec: 60,
        notice:
          "Rate limiting is temporarily unavailable. Please try again shortly.",
      };
    }
    if (!writePersisted) return checkMemory(key, rpm, rpd, now);
    return { allowed: true };
  } catch {
    if (isProduction()) {
      return {
        allowed: false,
        retryAfterSec: 60,
        notice:
          "Rate limiting is temporarily unavailable. Please try again shortly.",
      };
    }
    return checkMemory(key, rpm, rpd, now);
  }
}

export async function checkTelegramRateLimit(
  userId: string,
  chatId?: string,
): Promise<RateLimitVerdict> {
  const now = Date.now();
  const context = { chatId, userId };

  const publicAccess = getAllowedUserIds().size === 0;
  if (publicAccess) {
    const publicRpd =
      Number(process.env.TELEGRAM_PUBLIC_RPD_LIMIT) ||
      Number(process.env.TELEGRAM_TRIAL_RPD_LIMIT) ||
      DEFAULT_PUBLIC_RPD;
    const trialVerdict = await checkStoredRateLimit(
      "ratelimit:public:global",
      0,
      publicRpd,
      now,
      context,
    );
    if (!trialVerdict.allowed) return trialVerdict;
  }

  const rpm = Number(process.env.TELEGRAM_USER_RPM_LIMIT) || DEFAULT_RPM;
  const rpd = Number(process.env.TELEGRAM_USER_RPD_LIMIT) || DEFAULT_RPD;
  return checkStoredRateLimit(
    `ratelimit:user:${userId}`,
    rpm,
    rpd,
    now,
    context,
  );
}
