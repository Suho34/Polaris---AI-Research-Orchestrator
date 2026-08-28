import { defineAgent } from "eve";

export default defineAgent({
  description: "Research specialist for web search and document retrieval. Use for gathering facts, searching the web, and retrieving document contents.",
  model: "deepseek/deepseek-v4-flash-0731",
});
