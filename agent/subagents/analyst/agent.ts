import { defineAgent } from "eve";
import { analystModel, GROQ_CONTEXT_WINDOW_TOKENS } from "../../lib/models.js";

export default defineAgent({
  description: "Analysis specialist for data analysis, calculations, quantitative reasoning, and interpreting datasets.",
  model: analystModel,
  modelContextWindowTokens: GROQ_CONTEXT_WINDOW_TOKENS,
});
