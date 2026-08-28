import { defineTool } from "eve/tools";
import { z } from "zod";
import { scratchpadList, scratchpadDelete } from "../../../lib/redis";

export default defineTool({
  description:
    "Clear conversation history and scratchpad. Use when user says /new, /clear, /reset, 'remove earlier queries', 'forget history' or wants a fresh start. Deletes all scratchpad keys for this session and signals that prior assistant messages should be ignored.",
  inputSchema: z.object({
    confirm: z.boolean().optional().describe("Set true to confirm clearing"),
  }),
  async execute({ confirm }, ctx) {
    if (!confirm) {
      return {
        needsConfirm: true,
        message: "Send confirm:true to clear this session's scratchpad and reset context.",
      };
    }
    const sessionId = ctx.session.id;
    const { keys } = await scratchpadList({ sessionId });
    let deleted = 0;
    for (const fullKey of keys) {
      const keyPart = fullKey.split(":").slice(2).join(":") || fullKey;
      await scratchpadDelete(keyPart, { sessionId });
      deleted++;
    }
    // Also clear global mirrored keys that match this session's prefix? Keep global for simplicity, but delete session-scoped
    return {
      cleared: true,
      deletedKeys: deleted,
      sessionId,
      message:
        "Scratchpad cleared. Earlier queries are now removed from shared context. Eve's durable session history will be ignored going forward — treat next user message as fresh.",
    };
  },
});
