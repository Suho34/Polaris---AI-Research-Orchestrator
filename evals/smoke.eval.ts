import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Basic smoke test: agent responds to a simple question and delegates to researcher.",
  timeoutMs: 120000,
  async test(t) {
    await t.send(
      "What is 2 + 2? Then delegate to your researcher subagent and ask it to search the web for 'largest prime number 2026'. Report both answers.",
    );
    t.succeeded();
    t.check(t.reply, includes("4"));
  },
});
