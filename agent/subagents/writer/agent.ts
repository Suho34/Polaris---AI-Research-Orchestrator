import { defineAgent } from "eve";
import { writerModel, GROQ_CONTEXT_WINDOW_TOKENS } from "../../lib/models.js";

export default defineAgent({
  description: "Writing specialist for synthesising reports, summaries, and polished documents from research and analysis outputs.",
  model: writerModel,
  modelContextWindowTokens: GROQ_CONTEXT_WINDOW_TOKENS,
});
