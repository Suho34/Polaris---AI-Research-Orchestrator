/**
 * Budget Manager & LLM Gateway
 * Coordinates model capacity, organization limits, and bidirectional
 * provider fallback (Groq <-> Google).
 */

import { type LanguageModelV4 } from "@ai-sdk/provider";
import {
  CapacityTracker,
  getGatewayConfig,
  gatewayLog,
  type CapacityLimits,
  type GatewayConfig,
} from "./capacity.js";

/**
 * Budget Manager & LLM Gateway
 * Coordinates model capacity, organization limits, and bidirectional provider fallback (Groq <-> Google).
 */
export class LLMBudgetManager {
  private static instance: LLMBudgetManager;
  private config: GatewayConfig;
  private orgTracker: CapacityTracker;
  private modelTrackers: Map<string, CapacityTracker> = new Map();
  private gemmaTracker: CapacityTracker;

  private constructor() {
    this.config = getGatewayConfig();
    this.orgTracker = new CapacityTracker("groq-org", this.config.groqOrgLimits);
    this.gemmaTracker = new CapacityTracker("gemma-4-31b", this.config.gemmaLimits);
  }

  public static getInstance(): LLMBudgetManager {
    if (!LLMBudgetManager.instance) {
      LLMBudgetManager.instance = new LLMBudgetManager();
    }
    return LLMBudgetManager.instance;
  }

  /** Reset singleton — for tests only. */
  public static resetForTests(): void {
    // @ts-expect-error test-only reset
    LLMBudgetManager.instance = undefined;
  }

  public getModelTracker(modelId: string, customLimits?: Partial<CapacityLimits>): CapacityTracker {
    let tracker = this.modelTrackers.get(modelId);
    if (!tracker) {
      const isGeminiFlashLite = modelId.includes("flash-lite") || modelId.includes("gemini-3.5-flash-lite");
      const isGemma = modelId.includes("gemma");
      let baseLimits: CapacityLimits;
      if (isGeminiFlashLite) {
        baseLimits = this.config.geminiFlashLiteLimits;
      } else if (isGemma) {
        baseLimits = this.config.gemmaLimits;
      } else {
        baseLimits = this.config.groqOrgLimits;
      }
      const limits: CapacityLimits = {
        ...baseLimits,
        ...customLimits,
      };
      tracker = new CapacityTracker(modelId, limits);
      this.modelTrackers.set(modelId, tracker);
    }
    return tracker;
  }

  public getGemmaTracker(): CapacityTracker {
    return this.gemmaTracker;
  }

  public getOrgTracker(): CapacityTracker {
    return this.orgTracker;
  }

  /**
   * Helper to check capacity for a given model and provider.
   */
  public checkCapacity(model: LanguageModelV4, estimatedTokens: number): {
    available: boolean;
    reason?: string;
    waitMs?: number;
    reserve: () => () => void;
    recordActual: (tokens: number, release: () => void) => void;
  } {
    const isGoogle =
      model.provider === "google" ||
      model.provider === "google.generative-ai" ||
      model.modelId.includes("gemma") ||
      model.modelId.includes("gemini");
    const modelTracker = this.getModelTracker(model.modelId);

    if (isGoogle) {
      const check = modelTracker.hasCapacity(estimatedTokens);
      return {
        ...check,
        reserve: () => modelTracker.reserve(estimatedTokens),
        recordActual: (tokens, rel) => modelTracker.recordActual(tokens, rel),
      };
    } else {
      const modelCheck = modelTracker.hasCapacity(estimatedTokens);
      const orgCheck = this.orgTracker.hasCapacity(estimatedTokens);

      if (!modelCheck.available) {
        return {
          ...modelCheck,
          reserve: () => modelTracker.reserve(estimatedTokens),
          recordActual: (tokens, rel) => modelTracker.recordActual(tokens, rel),
        };
      }
      if (!orgCheck.available) {
        return {
          ...orgCheck,
          reserve: () => this.orgTracker.reserve(estimatedTokens),
          recordActual: (tokens, rel) => this.orgTracker.recordActual(tokens, rel),
        };
      }

      return {
        available: true,
        reserve: () => {
          const relModel = modelTracker.reserve(estimatedTokens);
          const relOrg = this.orgTracker.reserve(estimatedTokens);
          return () => {
            relModel();
            relOrg();
          };
        },
        recordActual: (tokens, rel) => {
          rel();
          modelTracker.recordActual(tokens, () => {});
          this.orgTracker.recordActual(tokens, () => {});
        },
      };
    }
  }

  /**
   * Decide routing and reserve capacity for any primary <-> fallback model pair.
   */
  public async acquireCapacityForModels(
    primaryModel: LanguageModelV4,
    fallbackModel: LanguageModelV4,
    estimatedTokens: number
  ): Promise<{
    route: "primary" | "fallback";
    release: (actualTokens?: number) => void;
  }> {
    const start = Date.now();

    const primaryLimits = this.getModelTracker(primaryModel.modelId).getLimits();
    const fallbackLimits = this.getModelTracker(fallbackModel.modelId).getLimits();

    // If request size exceeds primary TPM ceiling but fits within fallback TPM ceiling,
    // evaluate fallback first to avoid choking the lower-capacity pool
    const preferFallbackFirst = estimatedTokens > primaryLimits.tpm && estimatedTokens <= fallbackLimits.tpm;

    while (Date.now() - start < this.config.maxQueueWaitMs) {
      if (preferFallbackFirst) {
        const fallbackCheck = this.checkCapacity(fallbackModel, estimatedTokens);
        if (fallbackCheck.available) {
          gatewayLog(
            `Request size (${estimatedTokens} tokens) exceeds ${primaryModel.modelId} limit (${primaryLimits.tpm} TPM). Routing directly to fallback ${fallbackModel.modelId} (${fallbackLimits.tpm} TPM).`
          );
          const releaseFallback = fallbackCheck.reserve();
          return {
            route: "fallback",
            release: (actualTokens?: number) => {
              const tokens = typeof actualTokens === "number" ? actualTokens : estimatedTokens;
              fallbackCheck.recordActual(tokens, releaseFallback);
            },
          };
        }
      }

      // 1. Check Primary Model
      const primaryCheck = this.checkCapacity(primaryModel, estimatedTokens);
      if (primaryCheck.available) {
        const releasePrimary = primaryCheck.reserve();
        return {
          route: "primary",
          release: (actualTokens?: number) => {
            const tokens = typeof actualTokens === "number" ? actualTokens : estimatedTokens;
            primaryCheck.recordActual(tokens, releasePrimary);
          },
        };
      }

      // 2. Primary bottleneck hit! Check Fallback Model (if not already checked)
      const fallbackCheck = this.checkCapacity(fallbackModel, estimatedTokens);
      if (fallbackCheck.available) {
        gatewayLog(
          `Primary model ${primaryModel.modelId} capacity bottleneck (${primaryCheck.reason}). Rerouting to fallback ${fallbackModel.modelId}.`
        );
        const releaseFallback = fallbackCheck.reserve();
        return {
          route: "fallback",
          release: (actualTokens?: number) => {
            const tokens = typeof actualTokens === "number" ? actualTokens : estimatedTokens;
            fallbackCheck.recordActual(tokens, releaseFallback);
          },
        };
      }

      // 3. Both Primary and Fallback currently out of capacity! Wait in queue in 15-second intervals.
      const baseWait = Math.min(
        primaryCheck.waitMs ?? 15000,
        fallbackCheck.waitMs ?? 15000
      );
      const waitTime = Math.max(15000, baseWait);

      gatewayLog(
        `Both models out of capacity (${primaryCheck.reason || "cooling down"} / ${fallbackCheck.reason || "cooling down"}). Pausing for ${Math.ceil(waitTime / 1000)}s before next check...`
      );

      await new Promise((res) => setTimeout(res, waitTime));
    }

    throw new Error(
      `[LLM Gateway] Request timeout: Primary (${primaryModel.modelId}) and Fallback (${fallbackModel.modelId}) capacity limits exhausted after ${this.config.maxQueueWaitMs}ms.`
    );
  }
}
