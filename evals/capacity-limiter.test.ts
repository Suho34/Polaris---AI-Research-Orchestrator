// LLM Gateway capacity tests. Run with: npm test
import { CapacityTracker, estimateCallTokens } from "../agent/lib/capacity.js";
import { LLMBudgetManager } from "../agent/lib/gateway.js";
import { createRoutedLanguageModel } from "../agent/lib/routed-model.js";
import {
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ ${message}`);
}

/** Extract readable text from a V4 generate result. */
function resultText(r: LanguageModelV4GenerateResult): string {
  const part = r.content.find((c) => c.type === "text");
  return part && part.type === "text" ? part.text : "";
}

async function runTests() {
  // Isolate from any other suite sharing this process — the budget manager is a singleton.
  LLMBudgetManager.resetForTests();

  console.log("\n=========================================");
  console.log("TEST SUITE: Dual-Capacity LLM Gateway");
  console.log("=========================================\n");

  // TEST 1: Token Capacity (TPM) vs Request Capacity (RPM) Bottleneck
  console.log("--- Test 1: TPM Bottleneck Detection & Pre-reservation ---");
  const tracker = new CapacityTracker("test-groq", {
    rpm: 30,
    rpd: 1000,
    tpm: 8000,
    tpd: 200000,
  });

  // Check 1st request with 5,000 tokens
  const check1 = tracker.hasCapacity(5000);
  assert(check1.available === true, "5,000 tokens admitted under 8K TPM ceiling");

  // Reserve 5,000 tokens (simulating an in-flight request)
  const release1 = tracker.reserve(5000);
  const usageAfterReserve = tracker.getUsage();
  assert(usageAfterReserve.tpmUsed === 5000, "In-flight reservation recorded (5,000 TPM used)");
  assert(usageAfterReserve.rpmUsed === 1, "In-flight request recorded (1 RPM used)");

  // Attempt 2nd concurrent request with 4,000 tokens (5,000 + 4,000 = 9,000 > 8,000 TPM)
  const check2 = tracker.hasCapacity(4000);
  assert(check2.available === false, "2nd request blocked because 9,000 tokens > 8K TPM");
  assert(
    check2.reason?.includes("TPM limit reached") === true,
    `Bottleneck correctly identified: ${check2.reason}`
  );

  // Complete 1st request with actual usage of 4,800 tokens
  tracker.recordActual(4800, release1);
  const usageAfterCompletion = tracker.getUsage();
  assert(usageAfterCompletion.tpmUsed === 4800, "Actual tokens reconciled to 4,800");

  // TEST 2: Single-Call Burst Allowance (No Deadlock on Prompts > TPM Ceiling)
  console.log("\n--- Test 2: Single-Call Burst Allowance (No Deadlock on >8K Prompts) ---");
  const freshTracker = new CapacityTracker("test-groq-burst", {
    rpm: 30,
    rpd: 1000,
    tpm: 8000,
    tpd: 200000,
  });

  // A prompt with 8,426 tokens on an 8,000 TPM limit must NOT deadlock when bucket is clear!
  const burstCheck = freshTracker.hasCapacity(8426);
  assert(
    burstCheck.available === true,
    "Single call exceeding TPM ceiling (8,426 > 8,000) allowed as atomic burst on empty bucket"
  );

  // Once reserved and completed, subsequent requests must be blocked
  const releaseBurst = freshTracker.reserve(8426);
  freshTracker.recordActual(8426, releaseBurst);

  const blockedAfterBurst = freshTracker.hasCapacity(1000);
  assert(
    blockedAfterBurst.available === false,
    "Subsequent request blocked because 8,426/8,000 tokens used"
  );
  assert(
    (blockedAfterBurst.waitMs ?? 0) > 50000,
    `Accurate wait time computed for rolling window: ${blockedAfterBurst.waitMs}ms`
  );

  // TEST 3: In-Flight Reservation TTL Auto-Reclaim
  console.log("\n--- Test 3: In-Flight Reservation TTL Auto-Reclaim ---");
  const ttlTracker = new CapacityTracker("test-ttl", {
    rpm: 30,
    rpd: 1000,
    tpm: 8000,
    tpd: 200000,
  });

  // Create a reservation with a short 50ms TTL (simulating leaked/unreleased stream)
  ttlTracker.reserve(3000, 50);
  assert(ttlTracker.getUsage().tpmUsed === 3000, "Reservation active initially");

  // Wait 70ms for TTL to expire
  await new Promise((r) => setTimeout(r, 70));
  assert(ttlTracker.getUsage().tpmUsed === 0, "Expired in-flight reservation automatically reclaimed");

  // TEST 4: Heuristic Token Estimator
  console.log("\n--- Test 4: Heuristic Token Estimator ---");
  const dummyOptions: LanguageModelV4CallOptions = {
    prompt: [
      { role: "system", content: "You are Polaris orchestrator." },
      {
        role: "user",
        content: [{ type: "text", text: "Please conduct deep research on quantum computing." }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "web_search",
        description: "Search web for information",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
    maxOutputTokens: 800,
  };

  const estimated = estimateCallTokens(dummyOptions, 500);
  assert(estimated > 800, `Estimated call tokens calculated: ${estimated}`);

  // TEST 5: Proactive Routing for Oversized Requests (8.5K tokens -> Gemma 16K)
  console.log("\n--- Test 5: Proactive Fallback Routing for Oversized Requests ---");
  let primaryCallCount = 0;
  let fallbackCallCount = 0;

  const mockPrimary: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "groq",
    modelId: "openai/gpt-oss-120b",
    supportedUrls: {},
    async doGenerate() {
      primaryCallCount++;
      return {
        content: [{ type: "text", text: "Response from Primary GPT-OSS 120B" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 2000, noCache: 2000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 500, text: 500, reasoning: 0 } },
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
    async doStream() { throw new Error("not implemented"); },
  };

  const mockFallback: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "google",
    modelId: "gemma-4-31b-it",
    supportedUrls: {},
    async doGenerate() {
      fallbackCallCount++;
      return {
        content: [{ type: "text", text: "Response from Fallback Gemma 4 31B" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 8500, noCache: 8500, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 500, text: 500, reasoning: 0 } },
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
    async doStream() { throw new Error("not implemented"); },
  };

  const routedModel = createRoutedLanguageModel(mockPrimary, mockFallback);

  // Request with ~8,500 estimated tokens (exceeds Groq's 8K ceiling, fits Gemma's 16K ceiling)
  const longPrompt = "a".repeat(32000); // ~8,421 tokens
  const resLarge = await routedModel.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: longPrompt }] }],
    maxOutputTokens: 200,
  });

  assert(
    resultText(resLarge) === "Response from Fallback Gemma 4 31B",
    "8.5K token request proactively routed directly to Fallback Gemma 4 31B (16K TPM)"
  );
  assert(fallbackCallCount === 1, "Fallback model called");
  assert(primaryCallCount === 0, "Primary model not burdened with oversized request");

  // TEST 6: Stream Cancellation / Abort Reservation Cleanup
  console.log("\n--- Test 6: Stream Cancellation Reservation Cleanup ---");
  const budgetManager = LLMBudgetManager.getInstance();
  const initialUsage = budgetManager.getModelTracker("openai/gpt-oss-120b").getUsage().tpmUsed;

  const mockStreamingPrimary: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "groq",
    modelId: "openai/gpt-oss-120b",
    supportedUrls: {},
    async doGenerate() { throw new Error("not implemented"); },
    async doStream() {
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Hello" });
          // Simulating stream abortion or early cancellation before finish chunk
        },
        cancel() {},
      });
      return { stream, rawCall: { rawPrompt: null, rawSettings: {} }, warnings: [] };
    },
  };

  const streamingRouted = createRoutedLanguageModel(mockStreamingPrimary, mockFallback);
  const streamResult = await streamingRouted.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Stream test" }] }],
    maxOutputTokens: 500,
  });

  // Consume one chunk then immediately cancel the stream (simulating eve tool-loop empty response or cancel)
  const reader = streamResult.stream.getReader();
  await reader.read();
  await reader.cancel("Abort early");

  // Verify reservation was cleanly released on cancel!
  const usageAfterCancel = budgetManager.getModelTracker("openai/gpt-oss-120b").getUsage().tpmUsed;
  assert(
    usageAfterCancel <= initialUsage + 600,
    `In-flight reservation was released on stream cancellation (tpmUsed: ${usageAfterCancel})`
  );

  // TEST 7: Researcher Fallback to Gemini 3.5 Flash Lite (250K TPM, 15 RPM, 500 RPD)
  console.log("\n--- Test 7: Researcher Fallback to Gemini 3.5 Flash Lite (250K TPM) ---");
  const flashLiteTracker = budgetManager.getModelTracker("gemini-3.5-flash-lite");
  const flashLimits = flashLiteTracker.getLimits();
  assert(flashLimits.rpm === 15, `Gemini 3.5 Flash Lite RPM is 15 (got ${flashLimits.rpm})`);
  assert(flashLimits.tpm === 250000, `Gemini 3.5 Flash Lite TPM is 250,000 (got ${flashLimits.tpm})`);
  assert(flashLimits.rpd === 500, `Gemini 3.5 Flash Lite RPD is 500 (got ${flashLimits.rpd})`);

  let gemmaCallCount = 0;
  let flashLiteCallCount = 0;

  const mockGemmaPrimary: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "google",
    modelId: "gemma-4-31b-it",
    supportedUrls: {},
    async doGenerate() {
      gemmaCallCount++;
      return {
        content: [{ type: "text", text: "Response from Gemma 4 31B" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 5000, noCache: 5000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 500, text: 500, reasoning: 0 } },
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
    async doStream() { throw new Error("not implemented"); },
  };

  const mockFlashLiteFallback: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "google",
    modelId: "gemini-3.5-flash-lite",
    supportedUrls: {},
    async doGenerate() {
      flashLiteCallCount++;
      return {
        content: [{ type: "text", text: "Response from Gemini 3.5 Flash Lite (250K TPM)" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 22000, noCache: 22000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1000, text: 1000, reasoning: 0 } },
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
    async doStream() { throw new Error("not implemented"); },
  };

  const researchRouted = createRoutedLanguageModel(mockGemmaPrimary, mockFlashLiteFallback);

  // Prompt with ~20,000 tokens (exceeds Gemma's 16K ceiling, well within Flash Lite's 250K ceiling)
  const hugePrompt = "x".repeat(80000); // ~21,000 tokens
  const resHuge = await researchRouted.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: hugePrompt }] }],
    maxOutputTokens: 500,
  });

  assert(
    resultText(resHuge) === "Response from Gemini 3.5 Flash Lite (250K TPM)",
    "20K token research prompt proactively routed to Gemini 3.5 Flash Lite"
  );
  assert(flashLiteCallCount === 1, "Gemini 3.5 Flash Lite called");
  assert(gemmaCallCount === 0, "Gemma 4 31B not choked with 20K tokens");

  console.log("\n=========================================");
  console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
  console.log("=========================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
