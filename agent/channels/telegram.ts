import { defaultTelegramAuth, telegramChannel } from "eve/channels/telegram";
import type { TelegramMessage } from "eve/channels/telegram";
import {
  balanceTelegramTags,
  markdownToTelegramHtml,
  safeTruncateMarkdown,
} from "../lib/telegram-format.js";
import {
  checkTelegramRateLimit,
  isPublicTrialEnabled,
  isTelegramUserAllowed,
} from "../lib/telegram-guard.js";
import { log } from "../lib/log.js";

type ProgressState = {
  progressMessageId?: string | null;
  progressText?: string | null;
};

interface TelegramClient {
  chatId: string;
  request: (method: string, body: Record<string, unknown>) => Promise<unknown>;
  post: (text: string) => Promise<{ id: string }>;
  editMessageText: (options: {
    messageId: string;
    text: string;
  }) => Promise<unknown>;
  startTyping: () => Promise<unknown>;
}

interface ChannelContext {
  telegram: TelegramClient;
  state: Record<string, unknown>;
}

function getProgressId(state: Record<string, unknown>): string | null {
  return (state as ProgressState).progressMessageId ?? null;
}

function setProgressId(
  state: Record<string, unknown>,
  id: string | null,
  text?: string,
) {
  (state as ProgressState).progressMessageId = id;
  if (text !== undefined) (state as ProgressState).progressText = text;
}

function clearProgress(state: Record<string, unknown>) {
  (state as ProgressState).progressMessageId = null;
  (state as ProgressState).progressText = null;
}

function formatSubagentStatus(
  actions: readonly {
    kind: string;
    subagentName?: string;
    toolName?: string;
  }[],
): string | null {
  const labels: Record<string, string> = {
    researcher: "🔍 Researching… scanning sources",
    planner: "🗺️ Planning… breaking into steps",
    analyst: "📊 Analyzing data & calculations",
    writer: "✍️ Writing report… synthesizing findings",
  };
  const parts: string[] = [];
  for (const a of actions) {
    if (
      a.kind === "subagent-call" &&
      a.subagentName &&
      labels[a.subagentName]
    ) {
      parts.push(labels[a.subagentName]);
    } else if (a.kind === "tool-call" && a.toolName) {
      if (a.toolName === "web_search") parts.push("🔍 Searching web");
      if (a.toolName === "document_retrieval")
        parts.push("📄 Retrieving document");
      if (a.toolName === "calculate") parts.push("🧮 Calculating");
      if (a.toolName === "analyze_data") parts.push("📊 Analyzing dataset");
      if (a.toolName === "scratchpad")
        parts.push("💾 Updating shared scratchpad");
    }
  }
  if (parts.length === 0) return null;
  return [...new Set(parts)].join("\n");
}

// Single request path for all Telegram HTML sends/edits: transient-error
// retry (once) + plain-text fallback when Telegram rejects the HTML.
async function telegramHtmlRequest(
  telegram: TelegramClient,
  method: "sendMessage" | "editMessageText",
  messageId: string | null,
  textHtml: string,
  attempt = 0,
): Promise<{ id: string } | boolean | null> {
  const plain = textHtml.replace(/<[^>]+>/g, "");
  try {
    if (method === "sendMessage") {
      const res = (await telegram.request("sendMessage", {
        chat_id: telegram.chatId,
        text: textHtml,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      })) as { ok: boolean; body: unknown };
      const body = res?.body as { result?: { message_id?: number } } | null;
      const mid = body?.result?.message_id
        ? String(body.result.message_id)
        : null;
      if (mid) return { id: mid };
      return await telegram.post(plain);
    }
    await telegram.request("editMessageText", {
      chat_id: telegram.chatId,
      message_id: Number(messageId) || messageId,
      text: textHtml,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Retry once on transient errors (429 rate limit / 5xx / timeout)
    if (
      attempt === 0 &&
      /(429|502|503|504|timeout|timed out|ECONNRESET)/i.test(msg)
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      return telegramHtmlRequest(telegram, method, messageId, textHtml, 1);
    }
    try {
      if (method === "sendMessage") return await telegram.post(plain);
      await telegram.editMessageText({
        messageId: messageId as string,
        text: plain,
      });
      return true;
    } catch {
      return method === "sendMessage" ? null : false;
    }
  }
}

// Helper to send message with HTML formatting, falling back safely to plain text.
async function sendHtml(
  telegram: TelegramClient,
  textHtml: string,
): Promise<{ id: string } | null> {
  return (await telegramHtmlRequest(
    telegram,
    "sendMessage",
    null,
    balanceTelegramTags(textHtml),
  )) as { id: string } | null;
}

// Helper to edit message with HTML formatting, falling back safely to plain text
async function editHtml(
  telegram: TelegramClient,
  messageId: string,
  textHtml: string,
): Promise<boolean> {
  return (await telegramHtmlRequest(
    telegram,
    "editMessageText",
    messageId,
    textHtml,
  )) as boolean;
}

/**
 * Guard-first inbound hook: allowlist + per-user rate limit run BEFORE any
 * LLM spend (return null = drop the update). Passed messages fall through to
 * the default dispatch gating + Telegram user auth.
 *
 * Group gating approximation of eve's default: private chats always pass;
 * groups need a command, an @bot mention, or a reply to the bot. (Reply
 * detection uses the sender username vs botUsername — no extra API call.)
 */
async function guardedOnMessage(
  ctx: {
    telegram: {
      botUsername: string | undefined;
      post: (text: string) => Promise<unknown>;
    };
  },
  message: TelegramMessage,
) {
  const userId = message.from?.id;

  if (!isTelegramUserAllowed(userId)) {
    const notice = isPublicTrialEnabled()
      ? "⛔ The public trial is not available right now."
      : "⛔ This bot is private. Your user id is not on the allowlist.";
    await ctx.telegram.post(notice).catch(() => {});
    log.warn("telegram-guard", "blocked unauthorized user", { userId });
    return null;
  }

  const rl = await checkTelegramRateLimit(String(userId), message.chat.id);
  if (!rl.allowed) {
    await ctx.telegram
      .post(`⏳ ${rl.notice ?? "Slow down, then try again."}`)
      .catch(() => {});
    log.warn("telegram-guard", "rate-limited chat", {
      chatId: message.chat.id,
      userId,
    });
    return null;
  }

  if (message.chat.type !== "private") {
    const botUsername = ctx.telegram.botUsername;
    const text = `${message.text} ${message.caption}`.trim();
    const cmdMatch = text.match(/^\/[a-zA-Z0-9_]+(@([a-zA-Z0-9_]+))?/);
    const isCommand =
      !!cmdMatch && (!cmdMatch[2] || cmdMatch[2] === botUsername);
    const isMention = !!botUsername && text.includes(`@${botUsername}`);
    const isReplyToBot =
      !!botUsername && message.replyToMessage?.from?.username === botUsername;
    if (!isCommand && !isMention && !isReplyToBot) return null;
  }

  const auth = defaultTelegramAuth(message);
  if (!auth) return null;
  return { auth };
}

export default telegramChannel({
  botUsername: "getpolaris_bot",
  onMessage: guardedOnMessage,
  events: {
    async "turn.started"(_event, channel) {
      const ctx = channel as unknown as ChannelContext;
      await ctx.telegram.startTyping().catch(() => {});
      try {
        const res = await sendHtml(
          ctx.telegram,
          "<b>✨ Enhancing your request…</b>\n<i>Polaris is coordinating specialists and planning execution.</i>",
        );
        if (res?.id) setProgressId(ctx.state, res.id, "✨ Enhancing");
      } catch {}
    },

    async "actions.requested"(event, channel) {
      const ctx = channel as unknown as ChannelContext;
      await ctx.telegram.startTyping().catch(() => {});
      const progressId = getProgressId(ctx.state);
      if (!progressId) return;

      const actions = (event as { actions?: readonly unknown[] }).actions as
        | readonly { kind: string; subagentName?: string; toolName?: string }[]
        | undefined;
      if (!actions || actions.length === 0) return;

      const status = formatSubagentStatus(actions);
      if (!status) return;

      const nextHtml = `${status
        .split("\n")
        .map((s) => `<b>${s}</b>`)
        .join("\n")}\n\n<i>This message will update live…</i>`;
      if ((ctx.state as ProgressState).progressText === nextHtml) return;

      const ok = await editHtml(ctx.telegram, progressId, nextHtml);
      if (ok) setProgressId(ctx.state, progressId, nextHtml);
    },

    async "message.completed"(event, channel) {
      const ctx = channel as unknown as ChannelContext;
      const progressId = getProgressId(ctx.state);
      const finishReason = (event as { finishReason?: string }).finishReason;
      const message = (event as { message?: string | null }).message;
      if (finishReason === "tool-calls" || !message) return;

      // Edge cases: empty / whitespace-only / oversized model output
      const trimmed = message.trim();
      if (!trimmed) {
        const html = `<b>🤔 I don't have an answer yet.</b>\n\n<i>Try rephrasing — e.g. add a topic, timeframe, or format ("500-word report").</i>`;
        if (progressId) {
          const ok = await editHtml(ctx.telegram, progressId, html);
          if (ok) {
            clearProgress(ctx.state);
            return;
          }
        }
        await sendHtml(ctx.telegram, html);
        if (progressId) clearProgress(ctx.state);
        return;
      }

      // Safe truncate markdown BEFORE conversion to prevent slicing through HTML tags.
      const safeMd = safeTruncateMarkdown(trimmed, 3500);
      const html = markdownToTelegramHtml(safeMd);

      if (progressId) {
        const ok = await editHtml(ctx.telegram, progressId, html);
        if (ok) {
          clearProgress(ctx.state);
          return;
        }
      }

      await sendHtml(ctx.telegram, html);
      if (progressId) clearProgress(ctx.state);
    },

    async "turn.failed"(event, channel) {
      const ctx = channel as unknown as ChannelContext;
      const progressId = getProgressId(ctx.state);
      const raw = (event as { error?: unknown }).error;
      const msg =
        raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
      // Specific, actionable errors — never a bare "Error occurred".
      let html: string;
      if (/429|rate limit|too many requests/i.test(msg)) {
        html =
          `<b>⏳ I'm rate-limited right now.</b>\n\n` +
          `<i>Please wait ~1 minute and try again. For big reports, try a narrower topic.</i>`;
      } else if (/timeout|timed out|504/i.test(msg)) {
        html =
          `<b>🐢 That took too long and timed out.</b>\n\n` +
          `<i>Try a smaller request (fewer sources, shorter report) or try again.</i>`;
      } else if (/401|unauthorized|forbidden|403/i.test(msg)) {
        html =
          `<b>🔒 I couldn't reach a data source.</b>\n\n` +
          `<i>Search keys may be misconfigured. Try again — if it persists, contact the bot admin.</i>`;
      } else if (/network|fetch failed|ECONN|offline/i.test(msg)) {
        html =
          `<b>📡 Network hiccup.</b>\n\n` +
          `<i>Check your connection and send the message again — your history is preserved.</i>`;
      } else {
        html = `<b>⚠️ I hit an error while handling your request.</b>\n\n<i>Please try again or rephrase. If it keeps failing, send /new to start fresh.</i>`;
      }
      if (progressId) {
        const ok = await editHtml(ctx.telegram, progressId, html);
        if (ok) {
          clearProgress(ctx.state);
          return;
        }
      }
      await ctx.telegram.post(html.replace(/<[^>]+>/g, ""));
    },

    async "session.failed"(_event, channel) {
      const ctx = channel as unknown as ChannelContext;
      const progressId = getProgressId(ctx.state);
      const html = `<b>⚠️ This session encountered an unrecoverable error.</b>\nPlease send <code>/new</code> to start fresh.`;
      if (progressId) {
        const ok = await editHtml(ctx.telegram, progressId, html);
        if (ok) {
          clearProgress(ctx.state);
          return;
        }
      }
      await ctx.telegram.post(
        "⚠️ This session encountered an unrecoverable error. Please send /new to start fresh.",
      );
    },
  },
});
