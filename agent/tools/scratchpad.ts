import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  scratchpadDelete,
  scratchpadList,
  scratchpadRead,
  scratchpadWrite,
} from "../lib/redis";

export default defineTool({
  description:
    "Shared scratchpad backed by Redis (Upstash) for inter-agent context sharing. Use to read/write shared state between orchestrator and subagents across turns. Falls back to in-process memory when Redis env vars are not set.",
  inputSchema: z.object({
    operation: z
      .enum(["read", "write", "append", "list", "delete"])
      .describe("Operation to perform"),
    key: z
      .string()
      .min(1)
      .max(200)
      .regex(
        /^[a-zA-Z0-9._/-]+$/,
        "Key must contain only alphanumeric, dots, dashes, underscores, or slashes",
      )
      .optional()
      .describe("Scratchpad key (required for read/write/append/delete)"),
    value: z
      .string()
      .optional()
      .describe("Value to write/append (required for write/append)"),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(86400)
      .optional()
      .describe("TTL in seconds for write (optional)"),
  }),
  async execute({ operation, key, value, ttlSeconds }, ctx) {
    const sessionId = ctx.session.id;

    if (operation === "list") {
      const res = await scratchpadList({ sessionId: ctx.session.id });
      return { sessionKeys: res.keys, persisted: res.persisted };
    }

    if (!key) throw new Error("key is required for this operation");

    if (operation === "read") {
      const res = await scratchpadRead(key, { sessionId });
      return {
        key: res.key,
        value: res.value,
        scope: "session",
        persisted: res.persisted,
      };
    }

    if (operation === "write") {
      if (value === undefined) throw new Error("value is required for write");
      const res = await scratchpadWrite(key, value, { sessionId, ttlSeconds });
      return {
        key: res.key,
        ok: true,
        persisted: res.persisted,
        scope: "session",
        sessionId: ctx.session.id,
      };
    }

    if (operation === "append") {
      if (value === undefined) throw new Error("value is required for append");
      const existing = await scratchpadRead(key, { sessionId });
      const next = existing.value ? `${existing.value}\n${value}` : value;
      const res = await scratchpadWrite(key, next, { sessionId, ttlSeconds });
      return {
        key: res.key,
        ok: true,
        persisted: res.persisted,
        appended: true,
        scope: "session",
      };
    }

    if (operation === "delete") {
      await scratchpadDelete(key, { sessionId });
      return { key, deleted: true, scope: "session" };
    }

    throw new Error(`Unknown operation: ${operation}`);
  },
});
