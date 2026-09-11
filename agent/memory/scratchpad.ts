import { defineMemory, defineMemoryProvider } from "eve/memory";
import { scratchpadList, scratchpadRead } from "../lib/redis";

// Redis-backed shared scratchpad memory provider for inter-agent context sharing.
// Token-efficient index recall: Injects an index of available keys and short previews
// rather than full content dumps, protecting the 8K/16K TPM budget.
// Full contents are fetched on-demand by agents via the `scratchpad` tool.

const redisScratchpadProvider = defineMemoryProvider({
  recall: {
    "turn.started": async (ctx) => {
      const sessionId = ctx.session.id;
      try {
        const { keys } = await scratchpadList({ sessionId });
        if (keys.length === 0) return null;

        const keyNames = keys.map((k) => k.split(":").slice(2).join(":") || k);
        const previews: string[] = [];

        // Sample short previews for at most 3 recent keys (max 150 chars each) to keep TPM < 200 tokens
        for (const key of keyNames.slice(0, 3)) {
          const { value } = await scratchpadRead(key, { sessionId });
          if (value) {
            const trimmed = value.trim().replace(/\s+/g, " ");
            const snippet = trimmed.length > 150 ? trimmed.slice(0, 150) + "…" : trimmed;
            previews.push(`- ${key}: "${snippet}"`);
          }
        }

        let indexContent = `[scratchpad index] Available keys: ${keyNames.join(", ")}`;
        if (previews.length > 0) {
          indexContent += `\nRecent previews:\n${previews.join("\n")}`;
        }
        indexContent += `\n(Use the 'scratchpad' tool with operation="read" to retrieve full contents on demand).`;

        return {
          messages: [{ id: `scratchpad:index`, content: indexContent }],
        };
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
