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
    // Harden: normalize + bound inputs (LLMs love 2000-char queries + count=10 spam)
    const cleanQuery = query.trim().replace(/\s+/g, " ").slice(0, 500);
    if (!cleanQuery) {
      return { query: "", results: [], note: "Empty search query. Provide keywords, e.g. 'latest AI papers 2026'." };
    }
    const safeCount = Math.min(Math.max(Math.floor(count) || 5, 1), 10);
    const tavilyKey = process.env.TAVILY_API_KEY;
    const jinaKey = process.env.JINA_API_KEY;

    // Helper: Jina fallback via GET https://s.jina.ai/{query} with Accept: application/json
    async function jinaSearch(): Promise<{ title: string; url: string; snippet: string }[] | null> {
      if (!jinaKey) return null;
      const url = `https://s.jina.ai/${encodeURIComponent(cleanQuery)}?num=${safeCount}`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(10000),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${jinaKey}`,
          },
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new Error("Jina search timed out after 10s. Retry with a narrower query.");
        }
        throw err;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        if (res.status === 429) throw new Error("Jina search rate-limited (429). Wait a minute and retry.");
        if (res.status === 401 || res.status === 403) throw new Error("Jina search unauthorized — check JINA_API_KEY.");
        throw new Error(`Jina search failed: ${res.status} ${txt.slice(0, 200)}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      // Jina JSON shapes vary: { data: [{title,url,description,content}], results: [...], references: [...] }
      const raw: unknown[] =
        (Array.isArray(json.data) && (json.data as unknown[])) ||
        (Array.isArray((json as { results?: unknown[] }).results) && (json as { results: unknown[] }).results) ||
        (Array.isArray((json as { references?: unknown[] }).references) && (json as { references: unknown[] }).references) ||
        [];
      return raw.slice(0, safeCount).map((r: unknown) => {
        const o = r as Record<string, unknown>;
        return {
          title: String(o.title ?? o.name ?? "Untitled").slice(0, 300),
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
          signal: AbortSignal.timeout(10000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: tavilyKey, query: cleanQuery, max_results: safeCount, include_answer: true }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          if (res.status === 429) throw new Error("Tavily rate-limited (429). Wait a minute and retry.");
          if (res.status === 401 || res.status === 403) throw new Error("Tavily unauthorized — check TAVILY_API_KEY.");
          throw new Error(`Tavily search failed: ${res.status} ${txt.slice(0, 200)}`);
        }
        const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
        const results = (data.results ?? []).slice(0, safeCount).map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 500) }));
        if (results.length > 0) return { query: cleanQuery, provider: "tavily", results };
        // If Tavily returned 0 results, fall through to Jina
      } catch (err) {
        // Tavily failed / timed out — try Jina fallback before throwing
        if (err instanceof Error && err.name === "TimeoutError") {
          const jinaResults = await jinaSearch().catch(() => null);
          if (jinaResults && jinaResults.length > 0) {
            return { query: cleanQuery, provider: "jina (fallback after Tavily timeout)", results: jinaResults };
          }
          throw new Error("Search timed out after 10s on both providers. Retry with a narrower query.");
        }
        const jinaResults = await jinaSearch().catch(() => null);
        if (jinaResults && jinaResults.length > 0) {
          return { query: cleanQuery, provider: "jina (fallback after Tavily error)", results: jinaResults, note: `Tavily error: ${(err as Error).message}` };
        }
        throw err;
      }
      // No Tavily results — try Jina
      const jinaResults = await jinaSearch().catch(() => null);
      if (jinaResults && jinaResults.length > 0) {
        return { query: cleanQuery, provider: "jina (fallback — Tavily empty)", results: jinaResults };
      }
      return { query: cleanQuery, provider: "tavily", results: [], note: "Tavily returned no results and Jina fallback also empty. Broaden keywords or widen the date range." };
    }

    // No Tavily key — use Jina directly
    if (jinaKey) {
      const jinaResults = await jinaSearch();
      if (jinaResults && jinaResults.length > 0) return { query: cleanQuery, provider: "jina", results: jinaResults };
      return { query: cleanQuery, provider: "jina", results: [], note: "Jina returned no results. Broaden keywords or widen the date range." };
    }

    return {
      query: cleanQuery,
      results: [],
      note: "No search API key configured. Set TAVILY_API_KEY (primary) and JINA_API_KEY (fallback) in env for live search.",
    };
  },
});
