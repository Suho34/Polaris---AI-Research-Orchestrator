import { telegramChannel } from "eve/channels/telegram";

type ProgressState = {
  progressMessageId?: string | null;
  progressText?: string | null;
};

function getProgressId(state: Record<string, unknown>): string | null {
  return (state as ProgressState).progressMessageId ?? null;
}

function setProgressId(state: Record<string, unknown>, id: string | null, text?: string) {
  (state as ProgressState).progressMessageId = id;
  if (text !== undefined) (state as ProgressState).progressText = text;
}

function clearProgress(state: Record<string, unknown>) {
  (state as ProgressState).progressMessageId = null;
  (state as ProgressState).progressText = null;
}

function formatSubagentStatus(actions: readonly { kind: string; subagentName?: string; toolName?: string }[]): string | null {
  const labels: Record<string, string> = {
    researcher: "🔍 Researching… searching web & retrieving documents",
    planner: "🗺️ Planning… breaking down steps",
    analyst: "📊 Analyzing data & calculations",
    writer: "✍️ Writing report… synthesizing findings",
  };
  const parts: string[] = [];
  for (const a of actions) {
    if (a.kind === "subagent-call" && a.subagentName && labels[a.subagentName]) {
      parts.push(labels[a.subagentName]);
    } else if (a.kind === "tool-call" && a.toolName) {
      if (a.toolName === "web_search" || a.toolName === "web_search") parts.push("🔍 Searching web");
      if (a.toolName === "document_retrieval") parts.push("📄 Retrieving document");
      if (a.toolName === "calculate") parts.push("🧮 Calculating");
      if (a.toolName === "analyze_data") parts.push("📊 Analyzing dataset");
      if (a.toolName === "scratchpad") parts.push("💾 Updating shared scratchpad");
    }
  }
  if (parts.length === 0) return null;
  // Deduplicate
  return [...new Set(parts)].join("\n");
}

export default telegramChannel({
  botUsername: "getpolaris_bot",
  events: {
    async "turn.started"(_event, channel) {
      await channel.telegram.startTyping().catch(() => {});
      // Post initial progress message; this will be edited as subagents run
      try {
        const res = await channel.telegram.post("⏳ Polaris is working on your request…\n\n_Orchestrator will delegate to specialists as needed._");
        if (res.id) setProgressId(channel.state as unknown as Record<string, unknown>, res.id, "⏳ Started");
      } catch {
        // Fallback to typing only if post fails (e.g., missing permissions)
      }
    },

    async "actions.requested"(event, channel) {
      await channel.telegram.startTyping().catch(() => {});
      const state = channel.state as unknown as Record<string, unknown>;
      const progressId = getProgressId(state);
      if (!progressId) return;

      // Extract subagent/tool names – runtime actions are heterogeneous
      const actions = (event as { actions?: readonly unknown[] }).actions as
        | readonly { kind: string; subagentName?: string; toolName?: string }[]
        | undefined;
      if (!actions || actions.length === 0) return;

      const status = formatSubagentStatus(actions);
      if (!status) return;

      const nextText = `${status}\n\n_This message will update live…_`;
      // Avoid redundant edits
      if ((state as ProgressState).progressText === nextText) return;

      try {
        await channel.telegram.editMessageText({
          messageId: progressId,
          text: nextText,
        });
        setProgressId(state, progressId, nextText);
      } catch {
        // Ignore edit failures (e.g., same content, 429)
      }
    },

    async "message.completed"(event, channel) {
      const state = channel.state as unknown as Record<string, unknown>;
      const progressId = getProgressId(state);
      const finishReason = (event as { finishReason?: string }).finishReason;
      const message = (event as { message?: string | null }).message;

      // Only handle final assistant messages, not tool-call intermediates
      if (finishReason === "tool-calls" || !message) {
        // Still keep typing indicator off? No action needed – another turn will continue
        return;
      }

      // Prefer editing the progress message to deliver the final answer (live update)
      if (progressId) {
        try {
          // Telegram caps at 4096 chars; channel.telegram.post splits, but edit does not – we mimic splitting by truncating
          // The underlying handle's editMessageText also handles splitting via multiple edits? We'll ensure we don't exceed cap
          const text = message.length > 4096 ? message.slice(0, 4092) + "…" : message;
          await channel.telegram.editMessageText({
            messageId: progressId,
            text,
          });
          clearProgress(state);
          return;
        } catch {
          // Fall through to post if edit fails (e.g., message too old)
        }
      }

      // Fallback: post as new message (default behavior, with splitting)
      await channel.telegram.post(message);
      if (progressId) clearProgress(state);
    },

    async "turn.failed"(event, channel) {
      const state = channel.state as unknown as Record<string, unknown>;
      const progressId = getProgressId(state);
      const hint = (event as { details?: unknown }).details ? "" : "";
      const text = `⚠️ I hit an error while handling your request${hint}.\n\nPlease try again or rephrase.`;
      if (progressId) {
        try {
          await channel.telegram.editMessageText({ messageId: progressId, text });
          clearProgress(state);
          return;
        } catch {}
      }
      await channel.telegram.post(text);
    },

    async "session.failed"(event, channel) {
      const state = channel.state as unknown as Record<string, unknown>;
      const progressId = getProgressId(state);
      const text = `⚠️ This session encountered an unrecoverable error. Please send a new message to start fresh.`;
      if (progressId) {
        try {
          await channel.telegram.editMessageText({ messageId: progressId, text });
          clearProgress(state);
          return;
        } catch {}
      }
      await channel.telegram.post(text);
    },
  },
});
