import { defineAgent } from "eve";
import { orchestratorModel, GROQ_CONTEXT_WINDOW_TOKENS } from "./lib/models.js";

export default defineAgent({
  model: orchestratorModel,
  modelContextWindowTokens: GROQ_CONTEXT_WINDOW_TOKENS,
});
