import { defineAgent } from "eve";
import { mistral } from "@ai-sdk/mistral";

export default defineAgent({
  description: "Research specialist for web search and document retrieval. Use for gathering facts, searching the web, and retrieving document contents.",
  model: mistral("mistral-small-2603"),
  modelContextWindowTokens: 256000,
});
