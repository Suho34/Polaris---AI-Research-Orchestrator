/**
 * Routed LanguageModelV4 factory with budget management + automatic fallback.
 */

import {
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamResult,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  estimateCallTokens,
  extractTotalTokens,
  gatewayLog,
  isRateLimitError,
  isTpmExceededError,
  parseRetryDelay,
} from "./capacity.js";
import { LLMBudgetManager } from "./gateway.js";
import { getGatewayConfig, type CapacityLimits } from "./capacity.js";

const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_RETRY_INTERVAL_MS = 15000; // 15-second retry interval

/**
 * Single retry helper shared by doGenerate + doStream.
 * Returns the delay to wait before the next attempt, or null when the
 * error is not retryable / attempts are exhausted.
 */
function retryDelayFor(
  manager: LLMBudgetManager,
  targetModel: LanguageModelV4,
  err: unknown,
  attempt: number,
): number | null {
  if (!isRateLimitError(err) || attempt >= MAX_RATE_LIMIT_RETRIES) return null;
  const providerDelay = parseRetryDelay(err) || RATE_LIMIT_RETRY_INTERVAL_MS;
  const waitMs = Math.max(RATE_LIMIT_RETRY_INTERVAL_MS, providerDelay);
  manager.getModelTracker(targetModel.modelId).setCooldown(waitMs);
  gatewayLog(
    `${targetModel.modelId} hit rate limit (429). Waiting ${Math.ceil(waitMs / 1000)}s before retry attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}...`
  );
  return waitMs;
}

/**
 * Creates a routed LanguageModelV4 that automatically applies the LLM Gateway
 * budget management, pre-dispatch reservation, and bidirectional fallback.
 */
export function createRoutedLanguageModel(
  primaryModel: LanguageModelV4,
  fallbackModel: LanguageModelV4,
  customLimits?: Partial<CapacityLimits>
): LanguageModelV4 {
  const manager = LLMBudgetManager.getInstance();
  const config = getGatewayConfig();

  if (customLimits) {
    manager.getModelTracker(primaryModel.modelId, customLimits);
  }

  return {
    specificationVersion: "v4",
    provider: primaryModel.provider,
    modelId: primaryModel.modelId,
    supportedUrls: primaryModel.supportedUrls,

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const estimatedTokens = estimateCallTokens(options, config.defaultOutputReservation);

      for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        const { route, release } = await manager.acquireCapacityForModels(primaryModel, fallbackModel, estimatedTokens);
        const targetModel = route === "fallback" ? fallbackModel : primaryModel;

        try {
          const result = await targetModel.doGenerate(options);
          const totalTokens = extractTotalTokens(result.usage) ?? estimatedTokens;
          release(totalTokens);
          gatewayLog(`${targetModel.modelId} generate ok (route=${route}, tokens=${totalTokens}, est=${estimatedTokens})`);
          return result;
        } catch (err: unknown) {
          release(0);

          // TPM-exceeded (413 "request too large"): the prompt itself exceeds this model's
          // ceiling. Retrying with the same model won't help — force immediate fallback.
          if (isTpmExceededError(err) && targetModel === primaryModel) {
            gatewayLog(
              `Primary ${primaryModel.modelId} rejected prompt as too large (TPM exceeded). Forcing fallback to ${fallbackModel.modelId}.`
            );
            const fallbackRelease = (await manager.acquireCapacityForModels(primaryModel, fallbackModel, estimatedTokens)).release;
            try {
              const fallbackResult = await fallbackModel.doGenerate(options);
              const fallbackTokens = extractTotalTokens(fallbackResult.usage) ?? estimatedTokens;
              fallbackRelease(fallbackTokens);
              gatewayLog(`${fallbackModel.modelId} generate ok (forced fallback, tokens=${fallbackTokens})`);
              return fallbackResult;
            } catch (fallbackErr: unknown) {
              fallbackRelease(0);
              throw fallbackErr;
            }
          }

          const waitMs = retryDelayFor(manager, targetModel, err, attempt);
          if (waitMs !== null) {
            await new Promise((res) => setTimeout(res, waitMs));
            continue;
          }
          throw err;
        }
      }

      throw new Error(
        `[LLM Gateway] Exceeded ${MAX_RATE_LIMIT_RETRIES} rate limit retry attempts for ${primaryModel.modelId}.`
      );
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const estimatedTokens = estimateCallTokens(options, config.defaultOutputReservation);

      for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        const { route, release } = await manager.acquireCapacityForModels(primaryModel, fallbackModel, estimatedTokens);
        const targetModel = route === "fallback" ? fallbackModel : primaryModel;

        try {
          const result = await targetModel.doStream(options);

          let actualTokens = estimatedTokens;
          let releaseDone = false;
          let underlyingReader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined;

          // Reconcile exact token usage on stream end; always release on cancel.
          const finishRelease = (tokens: number) => {
            if (!releaseDone) {
              release(tokens);
              releaseDone = true;
            }
          };

          const wrappedStream = new ReadableStream<LanguageModelV4StreamPart>({
            async start(controller) {
              underlyingReader = result.stream.getReader();
              try {
                while (true) {
                  const { done, value } = await underlyingReader.read();
                  if (done) {
                    controller.close();
                    break;
                  }
                  if (value.type === "finish" && value.usage) {
                    actualTokens = extractTotalTokens(value.usage) ?? estimatedTokens;
                  }
                  controller.enqueue(value);
                }
                finishRelease(actualTokens);
              } catch (streamErr) {
                finishRelease(actualTokens);
                controller.error(streamErr);
              }
            },
            cancel(reason) {
              finishRelease(actualTokens);
              if (underlyingReader) {
                return underlyingReader.cancel(reason);
              } else if (!result.stream.locked) {
                return result.stream.cancel(reason);
              }
            },
          });

          return {
            ...result,
            stream: wrappedStream,
          };
        } catch (err: unknown) {
          release(0);

          // TPM-exceeded (413 "request too large"): force immediate fallback.
          if (isTpmExceededError(err) && targetModel === primaryModel) {
            gatewayLog(
              `Primary ${primaryModel.modelId} rejected stream as too large (TPM exceeded). Forcing fallback to ${fallbackModel.modelId}.`
            );
            const fallbackRelease = (await manager.acquireCapacityForModels(primaryModel, fallbackModel, estimatedTokens)).release;
            try {
              const fallbackResult = await fallbackModel.doStream(options);

              let fallbackActualTokens = estimatedTokens;
              let fallbackReleaseDone = false;
              let fallbackReader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined;

              const fallbackFinishRelease = (tokens: number) => {
                if (!fallbackReleaseDone) {
                  fallbackRelease(tokens);
                  fallbackReleaseDone = true;
                }
              };

              const fallbackWrappedStream = new ReadableStream<LanguageModelV4StreamPart>({
                async start(controller) {
                  fallbackReader = fallbackResult.stream.getReader();
                  try {
                    while (true) {
                      const { done, value } = await fallbackReader.read();
                      if (done) {
                        controller.close();
                        break;
                      }
                      if (value.type === "finish" && value.usage) {
                        fallbackActualTokens = extractTotalTokens(value.usage) ?? estimatedTokens;
                      }
                      controller.enqueue(value);
                    }
                    fallbackFinishRelease(fallbackActualTokens);
                  } catch (streamErr) {
                    fallbackFinishRelease(fallbackActualTokens);
                    controller.error(streamErr);
                  }
                },
                cancel(reason) {
                  fallbackFinishRelease(fallbackActualTokens);
                  if (fallbackReader) {
                    return fallbackReader.cancel(reason);
                  } else if (!fallbackResult.stream.locked) {
                    return fallbackResult.stream.cancel(reason);
                  }
                },
              });

              gatewayLog(`${fallbackModel.modelId} stream ok (forced fallback)`);
              return { ...fallbackResult, stream: fallbackWrappedStream };
            } catch (fallbackErr: unknown) {
              fallbackRelease(0);
              throw fallbackErr;
            }
          }

          const waitMs = retryDelayFor(manager, targetModel, err, attempt);
          if (waitMs !== null) {
            await new Promise((res) => setTimeout(res, waitMs));
            continue;
          }
          throw err;
        }
      }

      throw new Error(
        `[LLM Gateway] Exceeded ${MAX_RATE_LIMIT_RETRIES} stream rate limit retry attempts for ${primaryModel.modelId}.`
      );
    },
  };
}
