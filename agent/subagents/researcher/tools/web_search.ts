import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Search the web for current information on a query. Returns ranked results with titles, URLs, and snippets. Tavily is primary; Jina AI Search is automatic fallback.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Search query"),
    count: z.number().int().min(1).max(10).optional().describe("Number of results to return (default 5)"),
  }),
  async execute({ query, count = 5 }) {
    const tavilyKey = process.env.TAVILY_API_KEY;
    const jinaKey = process.env.JINA_API_KEY;

    // Helper: Jina fallback via GET https://s.jina.ai/{query} with Accept: application/json
    async function jinaSearch(): Promise<{ title: string; url: string; snippet: string }[] | null> {
      if (!jinaKey) return null;
      const url = `https://s.jina.ai/${encodeURIComponent(query)}?num=${count}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${jinaKey}`,
        },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Jina search failed: ${res.status} ${txt.slice(0, 500)}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      // Jina JSON shapes vary: { data: [{title,url,description,content}], results: [...], references: [...] }
      const raw: unknown[] =
        (Array.isArray(json.data) && (json.data as unknown[])) ||
        (Array.isArray((json as { results?: unknown[] }).results) && (json as { results: unknown[] }).results) ||
        (Array.isArray((json as { references?: unknown[] }).references) && (json as { references: unknown[] }).references) ||
        [];
      return raw.slice(0, count).map((r: unknown) => {
        const o = r as Record<string, unknown>;
        return {
          title: String(o.title ?? o.name ?? "Untitled"),
          url: String(o.url ?? o.link ?? ""),
          snippet: String(o.description ?? o.content ?? o.snippet ?? "").slice(0, 500),
        };
      });
    }

    // Primary: Tavily
    if (tavilyKey) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: tavilyKey, query, max_results: count, include_answer: true }),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Tavily search failed: ${res.status} ${txt.slice(0, 500)}`);
        }
        const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
        const results = (data.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
        if (results.length > 0) return { query, provider: "tavily", results };
        // If Tavily returned 0 results, fall through to Jina
      } catch (err) {
        // Tavily failed — try Jina fallback before throwing
        const jinaResults = await jinaSearch().catch(() => null);
        if (jinaResults && jinaResults.length > 0) {
          return { query, provider: "jina (fallback after Tavily error)", results: jinaResults, note: `Tavily error: ${(err as Error).message}` };
        }
        throw err;
      }
      // No Tavily results — try Jina
      const jinaResults = await jinaSearch().catch(() => null);
      if (jinaResults && jinaResults.length > 0) {
        return { query, provider: "jina (fallback — Tavily empty)", results: jinaResults };
      }
      return { query, provider: "tavily", results: [], note: "Tavily returned no results and Jina fallback also empty" };
    }

    // No Tavily key — use Jina directly
    if (jinaKey) {
      const jinaResults = await jinaSearch();
      if (jinaResults && jinaResults.length > 0) return { query, provider: "jina", results: jinaResults };
      return { query, provider: "jina", results: [], note: "Jina returned no results" };
    }

    return {
      query,
      results: [],
      note: "No search API key configured. Set TAVILY_API_KEY (primary) and JINA_API_KEY (fallback) in env for live search.",
    };
  },
});
