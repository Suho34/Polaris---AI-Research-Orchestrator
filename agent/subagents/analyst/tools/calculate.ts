import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Perform a mathematical calculation from an expression. Use for arithmetic, percentages, and formula evaluation.",
  inputSchema: z.object({
    expression: z.string().min(1).describe("Math expression to evaluate, e.g. '12 * 4.5 + 3' or 'Math.sqrt(16)'"),
  }),
  async execute({ expression }) {
    // Allow only safe math characters and Math.* calls; block arbitrary code.
    const allowed = /^[0-9+\-*/().,%\sA-Za-z_]+$/;
    if (!allowed.test(expression)) {
      throw new Error("Expression contains unsupported characters");
    }
    if (/(require|import|process|global|constructor|__proto__|prototype|fetch|eval|Function)/i.test(expression)) {
      throw new Error("Expression contains blocked pattern");
    }

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`"use strict"; return (${expression});`);
      const result = fn();
      if (typeof result !== "number" || !Number.isFinite(result)) {
        throw new Error("Expression did not evaluate to a finite number");
      }
      return { expression, result };
    } catch (err) {
      throw new Error(`Failed to evaluate expression: ${(err as Error).message}`);
    }
  },
});
