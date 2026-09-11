import { Redis } from "@upstash/redis";

// Shared scratchpad for inter-agent context sharing.
// Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set,
// otherwise falls back to an in-process Map so `eve dev` and tests still work.
// Eve subagents have isolated defineState, so this external store is the
// cross-agent boundary.

type FallbackStore = Map<string, string>;

const globalKey = "__polaris_redis_fallback__";
function getFallback(): FallbackStore {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[globalKey]) g[globalKey] = new Map<string, string>();
  return g[globalKey] as FallbackStore;
}

let redisClient: Redis | null = null;
let prodWarningLogged = false;

export function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // Fail loud in prod: the in-memory fallback does NOT survive serverless
    // invocations, so sessions silently lose scratchpad + rate-limit state.
    const isProd = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
    if (isProd && !prodWarningLogged) {
      prodWarningLogged = true;
      console.error(
        "[Polaris] UPSTASH_REDIS_REST_URL/TOKEN missing in production — scratchpad and Telegram rate limits are EPHEMERAL (per-instance memory). " +
          "Set them via `vercel env add` and redeploy."
      );
    }
    return null;
  }
  if (!redisClient) redisClient = new Redis({ url, token });
  return redisClient;
}

export function scratchpadKey(sessionId: string | undefined, key: string): string {
  // Namespace per-session when possible, global otherwise
  const ns = sessionId ? `polaris:${sessionId}` : "polaris:global";
  return `${ns}:${key}`;
}

export async function scratchpadWrite(
  key: string,
  value: string,
  opts: { sessionId?: string; ttlSeconds?: number } = {},
): Promise<{ key: string; persisted: boolean }> {
  const fullKey = scratchpadKey(opts.sessionId, key);
  // Guard: never let an oversized write OOM Redis / blow TPM on recall.
  const MAX_VALUE_CHARS = 50_000;
  const safeValue = value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) + "\n[truncated: value exceeded 50k chars]" : value;
  const redis = getRedis();
  if (redis) {
    try {
      if (opts.ttlSeconds) await redis.set(fullKey, safeValue, { ex: opts.ttlSeconds });
      else await redis.set(fullKey, safeValue);
      return { key: fullKey, persisted: true };
    } catch (err) {
      console.warn(`[scratchpad] Redis write failed, using memory fallback: ${(err as Error).message}`);
    }
  }
  getFallback().set(fullKey, safeValue);
  return { key: fullKey, persisted: false };
}

export async function scratchpadRead(
  key: string,
  opts: { sessionId?: string } = {},
): Promise<{ key: string; value: string | null; persisted: boolean }> {
  const fullKey = scratchpadKey(opts.sessionId, key);
  const redis = getRedis();
  if (redis) {
    try {
      const v = await redis.get<string>(fullKey);
      return { key: fullKey, value: v ?? null, persisted: true };
    } catch (err) {
      console.warn(`[scratchpad] Redis read failed, using memory fallback: ${(err as Error).message}`);
    }
  }
  const v = getFallback().get(fullKey) ?? null;
  return { key: fullKey, value: v, persisted: false };
}

export async function scratchpadList(opts: { sessionId?: string; pattern?: string } = {}): Promise<{
  keys: string[];
  persisted: boolean;
}> {
  const prefix = opts.sessionId ? `polaris:${opts.sessionId}:` : "polaris:";
  const redis = getRedis();
  if (redis) {
    try {
      // Upstash supports SCAN via Redis protocol; use keys for simplicity with small cardinalities
      const keys = await redis.keys(`${prefix}*`);
      return { keys: keys.slice(0, 100), persisted: true };
    } catch (err) {
      console.warn(`[scratchpad] Redis list failed, using memory fallback: ${(err as Error).message}`);
    }
  }
  const all = [...getFallback().keys()].filter((k) => k.startsWith(prefix));
  return { keys: all.slice(0, 100), persisted: false };
}

export async function scratchpadDelete(key: string, opts: { sessionId?: string } = {}): Promise<void> {
  const fullKey = scratchpadKey(opts.sessionId, key);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(fullKey);
      return;
    } catch (err) {
      console.warn(`[scratchpad] Redis delete failed, using memory fallback: ${(err as Error).message}`);
    }
  }
  getFallback().delete(fullKey);
}
