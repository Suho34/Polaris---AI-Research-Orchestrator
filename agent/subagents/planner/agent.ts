import { defineAgent } from "eve";
import { mistral } from "@ai-sdk/mistral";

export default defineAgent({
  description: "Planning specialist for creating step-by-step plans, task breakdowns, and execution roadmaps.",
  model: mistral("mistral-small-2603"),
  modelContextWindowTokens: 32000,
});
