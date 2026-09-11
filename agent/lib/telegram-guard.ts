/**
 * Telegram abuse protection: allowlist + per-user sliding-window rate limit.
 *
 * Why this exists: the LLM gateway limits are global. Without a per-chat
 * gate, one abusive Telegram user can burn the whole 1000 Groq RPD budget.
 *
 * Enforced in `onMessage` (return null = drop the update before any LLM
 * spend). Callback queries (HITL button clicks) only resume existing
 * sessions, so they are out of scope here.
 */

/** Comma-separated Telegram user ids that may use the bot. */
export function getAllowedUserIds(): Set<string> {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isTelegramUserAllowed(
  userId: string | number | undefined,
): boolean {
  const allow = getAllowedUserIds();
  if (userId === undefined || userId === null || userId === "") return false;
  if (allow.size === 0) {
    return true;
  }
  return allow.has(String(userId).trim());
}
