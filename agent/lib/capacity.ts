/**
 * Capacity tracking primitives for the LLM Gateway.
 * Extracted from rate-limiter.ts — pure accounting, no routing.
 */

import {
  type LanguageModelV4CallOptions,
  type LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { log } from "./log.js";

export interface CapacityLimits {
  rpm: number; // requests per minute
  rpd: number; // requests per day
  tpm: number; // tokens per minute
  tpd: number; // tokens per day
}

export interface ModelCapacityConfig {
  modelId: string;
  provider: "groq" | "google";
  limits: CapacityLimits;
}

export interface GatewayConfig {
  groqOrgLimits: CapacityLimits;
  gemmaLimits: CapacityLimits;
  geminiFlashLiteLimits: CapacityLimits;
  defaultOutputReservation: number;
  maxQueueWaitMs: number;
}

// Configurable defaults loaded from environment
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    console.warn(`[Polaris] Invalid value for ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return v;
}

export function getGatewayConfig(): GatewayConfig {
  return {
    groqOrgLimits: {
      rpm: envInt("GROQ_RPM_LIMIT", 30),
      rpd: envInt("GROQ_RPD_LIMIT", 1000),
      tpm: envInt("GROQ_TPM_LIMIT", 8000),
      tpd: envInt("GROQ_TPD_LIMIT", 200000),
    },
    gemmaLimits: {
      rpm: envInt("GEMMA_RPM_LIMIT", 30),
      rpd: envInt("GEMMA_RPD_LIMIT", 14400),
      tpm: envInt("GEMMA_TPM_LIMIT", 16000),
      tpd: envInt("GEMMA_TPD_LIMIT", 200000),
    },
    geminiFlashLiteLimits: {
      rpm: envInt("GEMINI_FLASH_LITE_RPM_LIMIT", 15),
      rpd: envInt("GEMINI_FLASH_LITE_RPD_LIMIT", 500),
      tpm: envInt("GEMINI_FLASH_LITE_TPM_LIMIT", 250000),
      tpd: envInt("GEMINI_FLASH_LITE_TPD_LIMIT", 1000000),
    },
    defaultOutputReservation: envInt("GROQ_DEFAULT_OUTPUT_RESERVATION", 500),
    maxQueueWaitMs: envInt("GROQ_MAX_QUEUE_WAIT_MS", 180000),
  };
}

/** Gateway debug logging — enabled via LLM_GATEWAY_DEBUG=1 or DEBUG containing "llm". */
export function gatewayLog(...args: unknown[]): void {
  if (
    process.env.LLM_GATEWAY_DEBUG === "1" ||
    (process.env.DEBUG ?? "").includes("llm")
  ) {
    log.info("llm-gateway", args.map(String).join(" "));
  }
}

interface UsageTimestamp {
  timestamp: number;
  tokens: number;
}

/**
 * Extracts wait delay in milliseconds from provider rate limit / 429 error messages.
 * e.g. "Please retry in 13.810444508s." -> 14310ms
 */
export function parseRetryDelay(err: unknown): number | undefined {
  if (!err) return undefined;
  const msg = err instanceof Error ? err.message : String(err);

  const match = msg.match(/(?:retry in|retry after|wait)\s+([0-9.]+)\s*s(?:econds?)?/i);
  if (match && match[1]) {
    const sec = parseFloat(match[1]);
    if (!isNaN(sec) && sec > 0) {
      return Math.ceil(sec * 1000) + 500; // 500ms safety cushion
    }
  }

  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.retryAfter === "number") {
      return Math.ceil(obj.retryAfter * 1000) + 500;
    }
  }

  return undefined;
}

/** Shared rate-limit predicate — single source of truth for retry decisions. */
export function isRateLimitError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("429") ||
      err.message.toLowerCase().includes("rate limit") ||
      err.message.toLowerCase().includes("tokens per minute") ||
      err.message.toLowerCase().includes("quota"))
  );
}

/**
 * Detect TPM-exceeded errors (413 / "request too large") where the prompt itself
 * exceeds the model's tokens-per-minute ceiling. These are NOT retryable with the
 * same model — the caller must fall back to a higher-capacity model.
 */
export function isTpmExceededError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("request too large") ||
    msg.includes("reduce your message size") ||
    (msg.includes("tokens per minute") && (msg.includes("413") || msg.includes("limit") && msg.includes("requested")))
  );
}

interface InFlightReservation {
  id: string;
  tokens: number;
  expiresAt: number;
}

export class CapacityTracker {
  private requests: number[] = [];
  private tokenHistory: UsageTimestamp[] = [];
  private reservations: Map<string, InFlightReservation> = new Map();
  private nextReservationId = 1;
  public readonly name: string;
  public limits: CapacityLimits;
  private cooldownUntil = 0;

  constructor(name: string, limits: CapacityLimits) {
    this.name = name;
    this.limits = limits;
  }

  public getLimits(): CapacityLimits {
    return this.limits;
  }

  public updateLimits(limits: Partial<CapacityLimits>) {
    this.limits = { ...this.limits, ...limits };
  }

  public setCooldown(ms: number, now = Date.now()) {
    this.cooldownUntil = Math.max(this.cooldownUntil, now + ms);
  }

  public getCooldownRemaining(now = Date.now()): number {
    return Math.max(0, this.cooldownUntil - now);
  }

  private clean(now = Date.now()): void {
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    this.requests = this.requests.filter((t) => t > oneDayAgo);
    this.tokenHistory = this.tokenHistory.filter((e) => e.timestamp > oneDayAgo);

    // Prune expired in-flight reservations (auto-reclaim leaks after 90 seconds)
    for (const [id, res] of this.reservations.entries()) {
      if (now > res.expiresAt) {
        this.reservations.delete(id);
      }
    }
  }

  public getUsage(now = Date.now()): {
    rpmUsed: number;
    rpdUsed: number;
    tpmUsed: number;
    tpdUsed: number;
  } {
    this.clean(now);
    const oneMinuteAgo = now - 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    let inFlightTokens = 0;
    for (const res of this.reservations.values()) {
      inFlightTokens += res.tokens;
    }
    const inFlightRequests = this.reservations.size;

    let tpmUsed = inFlightTokens;
    let tpdUsed = inFlightTokens;

    for (const item of this.tokenHistory) {
      if (item.timestamp > oneDayAgo) {
        tpdUsed += item.tokens;
        if (item.timestamp > oneMinuteAgo) {
          tpmUsed += item.tokens;
        }
      }
    }

    let rpmCount = inFlightRequests;
    let rpdCount = inFlightRequests;

    for (const reqTime of this.requests) {
      if (reqTime > oneDayAgo) {
        rpdCount++;
        if (reqTime > oneMinuteAgo) {
          rpmCount++;
        }
      }
    }

    return {
      rpmUsed: rpmCount,
      rpdUsed: rpdCount,
      tpmUsed,
      tpdUsed,
    };
  }

  /**
   * Check if the tracker currently has capacity for 1 request and `tokensNeeded`.
   */
  public hasCapacity(tokensNeeded: number, now = Date.now()): {
    available: boolean;
    reason?: string;
    waitMs?: number;
  } {
    // 1. Check active cooldown
    const cooldown = this.getCooldownRemaining(now);
    if (cooldown > 0) {
      return {
        available: false,
        reason: `Provider cooldown active (${Math.ceil(cooldown / 1000)}s remaining)`,
        waitMs: cooldown,
      };
    }

    const { rpmUsed, rpdUsed, tpmUsed, tpdUsed } = this.getUsage(now);

    if (rpdUsed + 1 > this.limits.rpd) {
      return { available: false, reason: `RPD limit reached (${rpdUsed}/${this.limits.rpd})`, waitMs: 3600000 };
    }
    if (tpdUsed + tokensNeeded > this.limits.tpd) {
      return { available: false, reason: `TPD limit reached (${tpdUsed + tokensNeeded}/${this.limits.tpd})`, waitMs: 3600000 };
    }

    if (rpmUsed + 1 > this.limits.rpm) {
      const oneMinuteAgo = now - 60 * 1000;
      const recentReqs = this.requests.filter((t) => t > oneMinuteAgo).sort((a, b) => a - b);
      const oldest = recentReqs[0] ?? now;
      const waitMs = Math.max(100, oldest + 60000 - now + 50);
      return { available: false, reason: `RPM limit reached (${rpmUsed}/${this.limits.rpm})`, waitMs };
    }

    if (tpmUsed + tokensNeeded > this.limits.tpm) {
      // Single-call burst allowance:
      // In LLM APIs, a prompt of e.g. 8,426 tokens cannot be split into smaller requests.
      // If the sliding window is empty (tpmUsed === 0) and RPM capacity exists,
      // allow this single request to execute as a burst. Its actual tokens will be recorded upon
      // completion, naturally enforcing the rate limit for subsequent requests.
      const isSingleBurst = tokensNeeded > this.limits.tpm;
      if (isSingleBurst && tpmUsed === 0 && rpmUsed < this.limits.rpm) {
        return { available: true };
      }

      const oneMinuteAgo = now - 60 * 1000;
      const recentTokens = this.tokenHistory
        .filter((e) => e.timestamp > oneMinuteAgo)
        .sort((a, b) => a.timestamp - b.timestamp);

      let targetWait = 1000;
      if (recentTokens.length > 0) {
        if (isSingleBurst) {
          // Needs the entire bucket to clear to 0
          const newest = recentTokens[recentTokens.length - 1];
          targetWait = Math.max(100, newest.timestamp + 60000 - now + 50);
        } else {
          let freed = 0;
          const deficit = tpmUsed + tokensNeeded - this.limits.tpm;
          for (const item of recentTokens) {
            freed += item.tokens;
            if (freed >= deficit) {
              targetWait = Math.max(100, item.timestamp + 60000 - now + 50);
              break;
            }
          }
        }
      }

      return {
        available: false,
        reason: `TPM limit reached (${tpmUsed + tokensNeeded}/${this.limits.tpm})`,
        waitMs: targetWait,
      };
    }

    return { available: true };
  }

  /**
   * Pre-reserve capacity in-flight before the request is dispatched.
   * Automatically expires after ttlMs (default 90s) to prevent leaks if a stream is aborted.
   */
  public reserve(estimatedTokens: number, ttlMs = 90000): () => void {
    const id = `${this.name}-${Date.now()}-${this.nextReservationId++}`;
    this.reservations.set(id, {
      id,
      tokens: estimatedTokens,
      expiresAt: Date.now() + ttlMs,
    });

    let released = false;
    return () => {
      if (!released) {
        this.reservations.delete(id);
        released = true;
      }
    };
  }

  /**
   * Record actual usage and release reservation.
   */
  public recordActual(actualTokens: number, releaseReservation: () => void, now = Date.now()) {
    releaseReservation();
    this.requests.push(now);
    this.tokenHistory.push({ timestamp: now, tokens: actualTokens });
    this.clean(now);
  }
}

/**
 * Heuristic Token Estimator
 * Analyzes prompt content, system instructions, tool calls, and schemas.
 */
export function estimateCallTokens(params: LanguageModelV4CallOptions, defaultOutputReservation = 500): number {
  let charCount = 0;

  if (params.prompt) {
    for (const msg of params.prompt) {
      if (typeof msg.content === "string") {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object") {
            if ("text" in part && typeof part.text === "string") {
              charCount += part.text.length;
            } else if ("toolName" in part) {
              charCount += (part.toolName?.length || 0) + JSON.stringify(part).length;
            } else {
              charCount += JSON.stringify(part).length;
            }
          }
        }
      }
    }
  }

  // Include tools schema overhead
  if (params.tools && Array.isArray(params.tools)) {
    for (const tool of params.tools) {
      charCount += tool.name?.length || 0;
      if ("description" in tool && typeof tool.description === "string") {
        charCount += tool.description.length;
      }
      if ("parameters" in tool && tool.parameters) {
        charCount += JSON.stringify(tool.parameters).length;
      }
    }
  }

  // Safe conservative token estimation: ~3.5 chars per token (undershoots less than 3.8)
  // plus a 20% safety margin to avoid underestimating prompt size for the capacity check.
  const estimatedInputTokens = Math.ceil(charCount / 3.5 * 1.2) + 15; // 15 tokens prompt framing overhead

  // Output reservation
  const reservedOutput = params.maxOutputTokens ? Math.min(params.maxOutputTokens, 1000) : defaultOutputReservation;

  return estimatedInputTokens + reservedOutput;
}

export function extractTotalTokens(usage?: LanguageModelV4Usage): number | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens?.total ?? 0;
  const output = usage.outputTokens?.total ?? 0;
  const sum = input + output;
  return sum > 0 ? sum : undefined;
}
