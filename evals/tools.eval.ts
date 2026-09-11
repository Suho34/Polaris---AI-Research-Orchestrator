import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Verify the agent can use the scratchpad tool.",
  async test(t) {
    await t.send("Write 'hello world' to the scratchpad under key 'test.key', then read it back and tell me what value you read.");
    t.succeeded();
    t.check(t.reply, includes("hello world"));
  },
});
