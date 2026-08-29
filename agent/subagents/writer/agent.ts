import { defineAgent } from "eve";
import { mistral } from "@ai-sdk/mistral";

export default defineAgent({
  description: "Writing specialist for synthesising reports, summaries, and polished documents from research and analysis outputs.",
  model: mistral("mistral-small-2603"),
  modelContextWindowTokens: 256000,
});
