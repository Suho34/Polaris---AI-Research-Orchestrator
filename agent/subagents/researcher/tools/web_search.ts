import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Search the web for current information on a query. Returns ranked results with titles, URLs, and snippets.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Search query"),
    count: z.number().int().min(1).max(10).optional().describe("Number of results to return (default 5)"),
  }),
  async execute({ query, count = 5 }) {
    // Use fetch with a search API if configured, otherwise return a structured placeholder.
    // This tool is intentionally environment-agnostic; wire SERPAPI_KEY / BRAVE_API_KEY etc. via env when available.
    const apiKey = process.env.SERPAPI_KEY || process.env.BRAVE_SEARCH_API_KEY || process.env.TAVILY_API_KEY;

    if (!apiKey) {
      return {
        query,
        results: [],
        note: "No search API key configured (SERPAPI_KEY / BRAVE_SEARCH_API_KEY / TAVILY_API_KEY). Returning empty results; configure a key for live search.",
      };
    }

    // Example: Tavily fallback
    if (process.env.TAVILY_API_KEY) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, max_results: count, include_answer: true }),
      });
      if (!res.ok) throw new Error(`Tavily search failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
      return {
        query,
        results: (data.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
      };
    }

    // Generic placeholder for other providers – extend as needed
    return {
      query,
      results: [],
      note: `Search API key present but no handler implemented for this provider. Query was: ${query}`,
    };
  },
});
