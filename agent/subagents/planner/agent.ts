import { defineAgent } from "eve";
import { plannerModel, GROQ_CONTEXT_WINDOW_TOKENS } from "../../lib/models.js";

export default defineAgent({
  description: "Planning specialist for creating step-by-step plans, task breakdowns, and execution roadmaps.",
  model: plannerModel,
  modelContextWindowTokens: GROQ_CONTEXT_WINDOW_TOKENS,
});
