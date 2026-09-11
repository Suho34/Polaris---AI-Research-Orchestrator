import { isTelegramUserAllowed } from "../agent/lib/telegram-guard.js";
import { scratchpadRead, scratchpadWrite } from "../agent/lib/redis.js";
import {
  isBlockedHost,
  readResponseText,
} from "../agent/subagents/researcher/tools/document_retrieval.js";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`PASS: ${message}`);
}

async function run() {
  process.env.NODE_ENV = "production";
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  assert(
    isTelegramUserAllowed("public-user"),
    "an empty production allowlist permits public access",
  );

  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  assert(isTelegramUserAllowed(42), "configured Telegram user is allowed");
  assert(!isTelegramUserAllowed(43), "unconfigured Telegram user is denied");

  await scratchpadWrite("private.value", "secret", { sessionId: "session-a" });
  const otherSession = await scratchpadRead("private.value", {
    sessionId: "session-b",
  });
  assert(
    otherSession.value === null,
    "scratchpad values stay in their session namespace",
  );

  assert(isBlockedHost("127.0.0.1"), "loopback IPv4 is blocked");
  assert(
    isBlockedHost("::ffff:7f00:1"),
    "IPv4-mapped IPv6 loopback is blocked",
  );
  assert(isBlockedHost("fc00::1"), "unique-local IPv6 is blocked");
  assert(!isBlockedHost("8.8.8.8"), "public IPv4 is allowed");

  const oversized = new Response("x".repeat(2_000_001));
  let rejected = false;
  try {
    await readResponseText(oversized);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("2000000-byte");
  }
  assert(
    rejected,
    "oversized response bodies are rejected at the streaming cap",
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
