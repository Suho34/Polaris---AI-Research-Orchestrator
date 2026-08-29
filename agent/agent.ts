import { defineAgent } from "eve";
import { mistral } from "@ai-sdk/mistral";

export default defineAgent({
  model: mistral("mistral-small-2603"),
  modelContextWindowTokens: 256000,
});
