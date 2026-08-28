import { defineAgent } from "eve";

export default defineAgent({
  description: "Planning specialist for creating step-by-step plans, task breakdowns, and execution roadmaps.",
  model: "minimax/minimax-m3-free",
});
