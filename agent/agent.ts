import { defineAgent } from "eve";
import { mistral } from "@ai-sdk/mistral";

export default defineAgent({
  model: mistral("ministral-8b-2512"),
  modelContextWindowTokens: 128000,
});
