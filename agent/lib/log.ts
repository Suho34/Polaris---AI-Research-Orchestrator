/**
 * Minimal structured logger. Emits single-line JSON so Vercel log drains
 * can filter on `scope` / `level` without a logging dependency.
 */

type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...extra,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (scope: string, msg: string, extra?: Record<string, unknown>) => emit("info", scope, msg, extra),
  warn: (scope: string, msg: string, extra?: Record<string, unknown>) => emit("warn", scope, msg, extra),
  error: (scope: string, msg: string, extra?: Record<string, unknown>) => emit("error", scope, msg, extra),
};
