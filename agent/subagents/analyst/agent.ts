import { defineAgent } from "eve";
import { mistral } from "@ai-sdk/mistral";

export default defineAgent({
  description: "Analysis specialist for data analysis, calculations, quantitative reasoning, and interpreting datasets.",
  model: mistral("mistral-medium-2508"),
  modelContextWindowTokens: 128000,
});
