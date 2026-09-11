import { defineAgent } from "eve";
import { researcherModel, GROQ_CONTEXT_WINDOW_TOKENS } from "../../lib/models.js";

export default defineAgent({
  description: "Research specialist for web search and document retrieval. Use for gathering facts, searching the web, and retrieving document contents.",
  model: researcherModel,
  modelContextWindowTokens: GROQ_CONTEXT_WINDOW_TOKENS,
});
