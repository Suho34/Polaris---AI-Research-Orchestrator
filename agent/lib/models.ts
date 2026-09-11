/**
 * Provider & Model Routing with LLM Gateway & Budget Manager
 *
 * Routing specification (matches README + code — Qwen references removed):
 * - GPT-OSS 120B (openai/gpt-oss-120b): Orchestrator + Analyst (primary, Groq)
 * - GPT-OSS 20B (openai/gpt-oss-20b): Planner, Writer, Extraction, Classification (primary, Groq)
 * - Gemma 4 31B (gemma-4-31b-it): Researcher primary + universal fallback (Google)
 * - Gemini 3.5 Flash Lite: Researcher fallback for 20K+ token prompts (Google, 250K TPM)
 */

import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createRoutedLanguageModel } from "./routed-model.js";
import { getEnv } from "./env.js";

const env = getEnv();

// Initialize Groq provider with API key from environment
export const groqProvider = createGroq({
  apiKey: env.GROQ_API_KEY || process.env.GROQ_API_KEY,
});

// Initialize Google provider for Gemma 4 31B fallback
export const googleProvider = createGoogleGenerativeAI({
  apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

// Standard context window for Groq models (128K)
export const GROQ_CONTEXT_WINDOW_TOKENS = 131072;

// Raw provider models
export const rawGptOss120b = groqProvider("openai/gpt-oss-120b");
export const rawGptOss20b = groqProvider("openai/gpt-oss-20b");
export const rawGemma4_31b = googleProvider("gemma-4-31b-it");
export const rawGemini35FlashLite = googleProvider("gemini-3.5-flash-lite");

// Routed models with automatic failover and tiered rate-limit retry
export const orchestratorModel = createRoutedLanguageModel(rawGptOss120b, rawGemma4_31b);
export const analystModel = createRoutedLanguageModel(rawGptOss120b, rawGemma4_31b);
export const researcherModel = createRoutedLanguageModel(rawGemma4_31b, rawGemini35FlashLite);
export const plannerModel = createRoutedLanguageModel(rawGptOss20b, rawGemma4_31b);
export const writerModel = createRoutedLanguageModel(rawGptOss20b, rawGemma4_31b);
