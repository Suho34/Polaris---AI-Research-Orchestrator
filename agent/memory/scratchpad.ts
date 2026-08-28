import { defineMemory, defineMemoryProvider } from "eve/memory";
import { scratchpadList, scratchpadRead } from "../lib/redis";

// Redis-backed shared scratchpad memory provider for inter-agent context sharing.
// Uses Upstash Redis when configured, otherwise the in-process fallback Map from lib/redis.
// Scope is per-session (session.id) so each durable session shares a scratchpad
// across orchestrator and subagents via explicit tool calls, but also recalls
// automatically at turn start.

const redisScratchpadProvider = defineMemoryProvider({
  recall: {
    "turn.started": async (ctx) => {
      // ctx.memory.scope is opaque; we use session id directly for scratchpad namespace
      const sessionId = ctx.session.id;
      try {
        const { keys } = await scratchpadList({ sessionId });
        if (keys.length === 0) return null;
        const messages = [];
        for (const fullKey of keys.slice(0, 20)) {
          // fullKey is e.g. polaris:<sessionId>:<key> – extract user key
          const keyPart = fullKey.split(":").slice(2).join(":") || fullKey;
          const { value } = await scratchpadRead(keyPart, { sessionId });
          if (value) messages.push({ id: `scratchpad:${keyPart}`, content: `[scratchpad:${keyPart}] ${value.slice(0, 2000)}` });
        }
        return messages.length ? { messages } : null;
      } catch {
        return null;
      }
    },
  },
  // No capture needed – writes happen via the `scratchpad` tool
});

export default defineMemory({
  description: "Shared scratchpad for inter-agent context (Redis/Upstash). Stores research findings, plans, and intermediate results for orchestrator ↔ subagents.",
  provider: redisScratchpadProvider,
  scope: (ctx) => ctx.session.id,
});
