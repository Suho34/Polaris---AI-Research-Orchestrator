import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Retrieve and extract text content from a URL or document path. Use for fetching articles, docs, and web pages discovered via web_search.",
  inputSchema: z.object({
    url: z.string().min(1).describe("URL to retrieve"),
    maxChars: z.number().int().min(500).max(50000).optional().describe("Max characters to return (default 15000)"),
  }),
  async execute({ url, maxChars = 15000 }) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("url must start with http:// or https://");
    }

    const res = await fetch(url, {
      headers: { "User-Agent": "polaris-researcher/1.0" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();

    // Naive HTML to text stripping when needed
    let content = text;
    if (contentType.includes("text/html")) {
      content = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n\n[truncated]";
    }

    return {
      url,
      contentType,
      content,
      chars: content.length,
    };
  },
});
