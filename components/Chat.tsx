"use client";

import { useEveAgent } from "eve/client"; // Eve helper (or use your Eve hook)
import { Streamdown } from "streamdown";
import { useState } from "react";

// Example chat UI that renders Eve streaming messages beautifully with Streamdown.
// Streamdown handles markdown, tables, code blocks, charts (via markdown tables/mermaid ascii) streaming.
// Install already done: npm i streamdown

export function Chat({ sessionId }: { sessionId: string }) {
  const [input, setInput] = useState("");
  // Replace with your actual Eve hook — this is illustrative
  // const { messages, send, status } = useEveAgent({ sessionId });

  // Mock messages for preview — replace with real hook
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "assistant", content: "**Polaris ready** — try:\n- `Write a 500-word report on AI trends`\n- `/new` to clear history\n\n| Agent | Model |\n|---|---|\n| Planner | mistral-small-2603 |" },
  ];

  return (
    <div className="mx-auto max-w-3xl p-4 space-y-4">
      {messages.map((m, i) => (
        <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
          <div className="rounded-xl border bg-white p-4 shadow-sm">
            {/* Streamdown renders markdown with shadcn styling, supports streaming */}
            <Streamdown>{m.content}</Streamdown>
          </div>
        </div>
      ))}
      {/* Input omitted for brevity — wire to send() */}
    </div>
  );
}

// Usage in Next.js / Vite:
// <Chat sessionId={chatId} />
// Eve's telegram channel already converts the same markdown to HTML via agent/lib/telegram-format.ts
// so web (Streamdown) and Telegram (HTML) stay in sync — no commas, proper **bold**.
