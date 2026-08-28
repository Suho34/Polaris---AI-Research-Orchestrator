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

export function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
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
  const redis = getRedis();
  if (redis) {
    if (opts.ttlSeconds) await redis.set(fullKey, value, { ex: opts.ttlSeconds });
    else await redis.set(fullKey, value);
    return { key: fullKey, persisted: true };
  }
  getFallback().set(fullKey, value);
  return { key: fullKey, persisted: false };
}

export async function scratchpadRead(
  key: string,
  opts: { sessionId?: string } = {},
): Promise<{ key: string; value: string | null; persisted: boolean }> {
  const fullKey = scratchpadKey(opts.sessionId, key);
  const redis = getRedis();
  if (redis) {
    const v = await redis.get<string>(fullKey);
    return { key: fullKey, value: v ?? null, persisted: true };
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
    // Upstash supports SCAN via Redis protocol; use keys for simplicity with small cardinalities
    const keys = await redis.keys(`${prefix}*`);
    return { keys, persisted: true };
  }
  const all = [...getFallback().keys()].filter((k) => k.startsWith(prefix));
  return { keys: all, persisted: false };
}

export async function scratchpadDelete(key: string, opts: { sessionId?: string } = {}): Promise<void> {
  const fullKey = scratchpadKey(opts.sessionId, key);
  const redis = getRedis();
  if (redis) await redis.del(fullKey);
  else getFallback().delete(fullKey);
}
