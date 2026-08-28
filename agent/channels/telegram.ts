import { telegramChannel } from "eve/channels/telegram";
import { markdownToTelegramHtml } from "../lib/telegram-format";

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
      if (a.toolName === "web_search") parts.push("🔍 Searching web");
      if (a.toolName === "document_retrieval") parts.push("📄 Retrieving document");
      if (a.toolName === "calculate") parts.push("🧮 Calculating");
      if (a.toolName === "analyze_data") parts.push("📊 Analyzing dataset");
      if (a.toolName === "scratchpad") parts.push("💾 Updating shared scratchpad");
      if (a.toolName === "clear_history") parts.push("🗑️ Clearing history");
    }
  }
  if (parts.length === 0) return null;
  return [...new Set(parts)].join("\n");
}

// Helper to send/edit with HTML parse_mode, falling back to plain post
async function sendHtml(channel: { telegram: { chatId: string; request: (m: string, b: Record<string, unknown>) => Promise<unknown>; post: (m: string) => Promise<{ id: string }> } }, textHtml: string): Promise<{ id: string } | null> {
  try {
    const res = (await channel.telegram.request("sendMessage", {
      chat_id: channel.telegram.chatId,
      text: textHtml,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })) as { ok: boolean; body: unknown };
    // Telegram returns result with message_id
    const body = res.body as { result?: { message_id?: number } } | null;
    const mid = body?.result?.message_id ? String(body.result.message_id) : null;
    if (mid) return { id: mid };
    // Fallback: try post
    return await channel.telegram.post(textHtml.replace(/<[^>]+>/g, ""));
  } catch {
    try {
      return await channel.telegram.post(textHtml.replace(/<[^>]+>/g, ""));
    } catch {
      return null;
    }
  }
}

async function editHtml(channel: { telegram: { chatId: string; request: (m: string, b: Record<string, unknown>) => Promise<unknown>; editMessageText: (o: { messageId: string; text: string }) => Promise<unknown> } }, messageId: string, textHtml: string): Promise<boolean> {
  try {
    await channel.telegram.request("editMessageText", {
      chat_id: channel.telegram.chatId,
      message_id: Number(messageId) || messageId,
      text: textHtml,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch {
    try {
      await channel.telegram.editMessageText({ messageId, text: textHtml.replace(/<[^>]+>/g, "") });
      return true;
    } catch {
      return false;
    }
  }
}

export default telegramChannel({
  botUsername: "getpolaris_bot",
  events: {
    async "turn.started"(_event, channel) {
      await channel.telegram.startTyping().catch(() => {});
      try {
        const res = await sendHtml(channel as unknown as { telegram: { chatId: string; request: (m: string, b: Record<string, unknown>) => Promise<unknown>; post: (m: string) => Promise<{ id: string }> } }, "<b>⏳ Polaris is working on your request…</b>\n<i>Orchestrator will delegate to specialists as needed.</i>");
        if (res?.id) setProgressId(channel.state as unknown as Record<string, unknown>, res.id, "⏳ Started");
      } catch {}
    },

    async "actions.requested"(event, channel) {
      await channel.telegram.startTyping().catch(() => {});
      const state = channel.state as unknown as Record<string, unknown>;
      const progressId = getProgressId(state);
      if (!progressId) return;
      const actions = (event as { actions?: readonly unknown[] }).actions as
        | readonly { kind: string; subagentName?: string; toolName?: string }[]
        | undefined;
      if (!actions || actions.length === 0) return;
      const status = formatSubagentStatus(actions);
      if (!status) return;
      const nextHtml = `${status.split("\n").map((s) => `<b>${s}</b>`).join("\n")}\n\n<i>This message will update live…</i>`;
      if ((state as ProgressState).progressText === nextHtml) return;
      const ok = await editHtml(channel as unknown as { telegram: { chatId: string; request: (m: string, b: Record<string, unknown>) => Promise<unknown>; editMessageText: (o: { messageId: string; text: string }) => Promise<unknown> } }, progressId, nextHtml);
      if (ok) setProgressId(state, progressId, nextHtml);
    },

    async "message.completed"(event, channel) {
      const state = channel.state as unknown as Record<string, unknown>;
      const progressId = getProgressId(state);
      const finishReason = (event as { finishReason?: string }).finishReason;
      const message = (event as { message?: string | null }).message;
      if (finishReason === "tool-calls" || !message) return;

      // Convert markdown to Telegram HTML for proper bold/italic/code rendering
      // Also supports Streamdown-style markdown — Streamdown renders the same markdown on web, we render it as HTML for Telegram
      let html = markdownToTelegramHtml(message);
      // Telegram limit 4096 chars (HTML tags count). Truncate safely
      if (html.length > 4000) html = html.slice(0, 3996) + "…";

      if (progressId) {
        const ok = await editHtml(channel as unknown as { telegram: { chatId: string; request: (m: string, b: Record<string, unknown>) => Promise<unknown>; editMessageText: (o: { messageId: string; text: string }) => Promise<unknown> } }, progressId, html);
        if (ok) {
          clearProgress(state);
          return;
        }
      }
      await sendHtml(channel as unknown as { telegram: { chatId: string; request: (m: string, b: Record<string, unknown>) => Promise<unknown>; post: (m: string) => Promise<{ id: string }> } }, html);
      if (progressId) clearProgress(state);
    },

    async "turn.failed"(event, channel) {
      const state = channel.state as unknown as Record<string, unknown>;
      const progressId = getProgressId(state);
      const text = `⚠️ I hit an error while handling your request.\n\nPlease try again or rephrase.`;
      const html = `<b>⚠️ I hit an error while handling your request.</b>\n\nPlease try again or rephrase.`;
      if (progressId) {
        const ok = await editHtml(channel as unknown as { telegram: { chatId: string; request: (m: string, b: Record<string, unknown>) => Promise<unknown>; editMessageText: (o: { messageId: string; text: string }) => Promise<unknown> } }, progressId, html);
        if (ok) {
          clearProgress(state);
          return;
        }
      }
      await channel.telegram.post(text);
    },

    async "session.failed"(_event, channel) {
      const state = channel.state as unknown as Record<string, unknown>;
      const progressId = getProgressId(state);
      const html = `<b>⚠️ This session encountered an unrecoverable error.</b>\nPlease send <code>/new</code> to start fresh.`;
      if (progressId) {
        const ok = await editHtml(channel as unknown as { telegram: { chatId: string; request: (m: string, b: Record<string, unknown>) => Promise<unknown>; editMessageText: (o: { messageId: string; text: string }) => Promise<unknown> } }, progressId, html);
        if (ok) {
          clearProgress(state);
          return;
        }
      }
      await channel.telegram.post("⚠️ This session encountered an unrecoverable error. Please send /new to start fresh.");
    },
  },
});
