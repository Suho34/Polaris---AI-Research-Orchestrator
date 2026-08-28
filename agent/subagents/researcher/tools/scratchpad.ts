import { defineTool } from "eve/tools";
import { z } from "zod";
import { scratchpadDelete, scratchpadList, scratchpadRead, scratchpadWrite } from "../../../lib/redis";

export default defineTool({
  description:
    "Shared scratchpad backed by Redis (Upstash) for inter-agent context sharing. Use to read/write shared state between orchestrator and subagents across turns. Falls back to in-memory when Redis env vars are not set.",
  inputSchema: z.object({
    operation: z.enum(["read", "write", "append", "list", "delete"]).describe("Operation to perform"),
    key: z.string().min(1).optional().describe("Scratchpad key (required for read/write/append/delete)"),
    value: z.string().optional().describe("Value to write/append (required for write/append)"),
    ttlSeconds: z.number().int().min(60).max(86400).optional().describe("TTL in seconds for write (optional)"),
  }),
  async execute({ operation, key, value, ttlSeconds }, ctx) {
    const sessionId = ctx.session.id;

    if (operation === "list") {
      const res = await scratchpadList({ sessionId });
      const globalRes = await scratchpadList({ sessionId: undefined });
      return { sessionKeys: res.keys, globalKeys: globalRes.keys, persisted: res.persisted };
    }

    if (!key) throw new Error("key is required for this operation");

    if (operation === "read") {
      const res = await scratchpadRead(key, { sessionId });
      // Also try global namespace if session-scoped miss
      if (res.value === null) {
        const g = await scratchpadRead(key, { sessionId: undefined });
        if (g.value !== null) return { key: g.key, value: g.value, scope: "global", persisted: g.persisted };
      }
      return { key: res.key, value: res.value, scope: "session", persisted: res.persisted };
    }

    if (operation === "write") {
      if (value === undefined) throw new Error("value is required for write");
      const res = await scratchpadWrite(key, value, { sessionId, ttlSeconds });
      // Also mirror to global for cross-session visibility when useful (e.g., research findings)
      await scratchpadWrite(key, value, { sessionId: undefined, ttlSeconds });
      return { key: res.key, ok: true, persisted: res.persisted, sessionId };
    }

    if (operation === "append") {
      if (value === undefined) throw new Error("value is required for append");
      const existing = await scratchpadRead(key, { sessionId });
      const next = existing.value ? `${existing.value}\n${value}` : value;
      const res = await scratchpadWrite(key, next, { sessionId, ttlSeconds });
      return { key: res.key, ok: true, persisted: res.persisted, appended: true };
    }

    if (operation === "delete") {
      await scratchpadDelete(key, { sessionId });
      return { key, deleted: true };
    }

    throw new Error(`Unknown operation: ${operation}`);
  },
});
