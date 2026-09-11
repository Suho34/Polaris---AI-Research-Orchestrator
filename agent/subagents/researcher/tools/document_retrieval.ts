import { defineTool } from "eve/tools";
import { z } from "zod";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const MAX_RESPONSE_BYTES = 2_000_000;

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function mappedIpv4FromIpv6(hostname: string): string | null {
  const groups = hostname.split(":");
  if (groups.length < 2 || groups.slice(0, -2).join(":") !== "::ffff")
    return null;
  const high = Number.parseInt(groups.at(-2) ?? "", 16);
  const low = Number.parseInt(groups.at(-1) ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || low < 0)
    return null;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isBlockedIp(address: string): boolean {
  const mapped = mappedIpv4FromIpv6(address.toLowerCase());
  if (mapped) return isBlockedIpv4(mapped);
  if (isIP(address) === 4) return isBlockedIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    /^(fc|fd)/.test(normalized) ||
    /^fe[89ab]/.test(normalized)
  );
}

/**
 * SSRF guard: refuse hosts that resolve to this machine / the cloud
 * metadata service / private networks. Applied before BOTH the Jina
 * primary and the direct-fetch fallback.
 *
 * Hostnames are resolved before every provider request and redirect. The
 * response body is streamed through a fixed byte cap before text processing.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (
    h === "metadata.google.internal" ||
    h === "metadata.google" ||
    h === "instance-data"
  )
    return true;
  return isIP(h) > 0 ? isBlockedIp(h) : false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (isBlockedHost(hostname))
    throw new Error(
      `Refusing to retrieve internal address (${hostname}). document_retrieval only fetches public URLs.`,
    );
  if (isIP(hostname) > 0) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve public host (${hostname}).`);
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isBlockedIp(address))
  ) {
    throw new Error(
      `Refusing to retrieve host resolving to an internal address (${hostname}).`,
    );
  }
}

export async function readResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response body exceeds the ${MAX_RESPONSE_BYTES}-byte retrieval limit.`,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(
          `Response body exceeds the ${MAX_RESPONSE_BYTES}-byte retrieval limit.`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export default defineTool({
  description:
    "Retrieve and extract clean markdown content from a URL or document path using Jina Reader (with direct fetch fallback). Use for fetching articles, docs, and web pages discovered via web_search.",
  inputSchema: z.object({
    url: z.string().min(1).describe("URL to retrieve"),
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(25000)
      .optional()
      .describe("Max characters to return (default 5000)"),
  }),
  async execute({ url, maxChars = 5000 }) {
    const cleanUrl = url.trim().slice(0, 2000);
    if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
      throw new Error("url must start with http:// or https://");
    }
    const safeMaxChars = Math.min(
      Math.max(Math.floor(maxChars) || 5000, 500),
      25000,
    );

    // Guard against retrieving search engine result pages instead of actual source content
    try {
      const parsed = new URL(cleanUrl);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      if (
        (host.includes("google.") &&
          (path.includes("/search") || path.includes("/url"))) ||
        (host.includes("bing.com") && path.includes("/search")) ||
        host.includes("duckduckgo.com") ||
        host.includes("search.yahoo.com")
      ) {
        throw new Error(
          `Cannot retrieve search engine result pages directly (${cleanUrl}). Use the 'web_search' tool to discover specific article/documentation URLs, and then call 'document_retrieval' with the direct webpage URL.`,
        );
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("Cannot retrieve search engine")
      ) {
        throw err;
      }
      throw new Error(`Invalid URL: ${cleanUrl.slice(0, 200)}`);
    }

    // SSRF guard: never fetch loopback / private / metadata addresses
    {
      const host = new URL(cleanUrl).hostname;
      await assertPublicHost(host);
    }

    const jinaKey = process.env.JINA_API_KEY;

    // 1. Primary: Jina Reader API (converts webpage to clean, LLM-optimized Markdown with JS rendered)
    try {
      const jinaUrl = `https://r.jina.ai/${cleanUrl}`;
      const headers: Record<string, string> = {
        Accept: "text/plain",
        "X-Return-Format": "markdown",
        "User-Agent": "polaris-researcher/1.0",
      };
      if (jinaKey) {
        headers["Authorization"] = `Bearer ${jinaKey}`;
      }

      // Use redirect:"manual" to validate each hop against the SSRF guard.
      let res = await fetch(jinaUrl, {
        headers,
        signal: AbortSignal.timeout(12000),
        redirect: "manual",
      });

      // Follow up to 5 redirects, validating each Location hostname
      let redirectCount = 0;
      while (res.status >= 300 && res.status < 400 && redirectCount < 5) {
        const location = res.headers.get("location");
        if (!location) break;
        let nextUrl: string;
        try {
          nextUrl = new URL(location, jinaUrl).href;
        } catch {
          break;
        }
        const nextHost = new URL(nextUrl).hostname;
        await assertPublicHost(nextHost);
        res = await fetch(nextUrl, {
          headers,
          signal: AbortSignal.timeout(12000),
          redirect: "manual",
        });
        redirectCount++;
      }

      if (res.ok) {
        let markdown = await readResponseText(res);
        if (markdown.trim().length > 0) {
          if (markdown.length > safeMaxChars) {
            markdown = markdown.slice(0, safeMaxChars) + "\n\n[truncated]";
          }
          return {
            url: cleanUrl,
            provider: "jina-reader",
            contentType: "text/markdown",
            content: markdown,
            chars: markdown.length,
          };
        }
      } else if (res.status === 429) {
        throw new Error(
          "Document retrieval rate-limited (429). Wait a minute and retry with fewer URLs.",
        );
      } else if (res.status === 404) {
        throw new Error(
          `Page not found (404): ${cleanUrl.slice(0, 200)}. Verify the URL from web_search results.`,
        );
      }
    } catch (err) {
      // Jina failed or timed out — fall through cleanly to direct fetch fallback,
      // unless it's an actionable error we already shaped above.
      if (err instanceof Error && /rate-limited|not found/.test(err.message))
        throw err;
    }

    // 2. Fallback: Direct fetch with noise/boilerplate stripping
    let res: Response;
    try {
      // Use redirect:"manual" to validate each hop against the SSRF guard.
      res = await fetch(cleanUrl, {
        headers: { "User-Agent": "polaris-researcher/1.0" },
        signal: AbortSignal.timeout(12000),
        redirect: "manual",
      });
      await assertPublicHost(new URL(cleanUrl).hostname);

      // Follow up to 5 redirects, validating each Location hostname
      let redirectCount = 0;
      while (res.status >= 300 && res.status < 400 && redirectCount < 5) {
        const location = res.headers.get("location");
        if (!location) break;
        let nextUrl: string;
        try {
          nextUrl = new URL(location, cleanUrl).href;
        } catch {
          break;
        }
        const nextHost = new URL(nextUrl).hostname;
        await assertPublicHost(nextHost);
        res = await fetch(nextUrl, {
          headers: { "User-Agent": "polaris-researcher/1.0" },
          signal: AbortSignal.timeout(12000),
          redirect: "manual",
        });
        redirectCount++;
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(
          `Retrieval timed out after 12s: ${cleanUrl.slice(0, 200)}. The site may be slow — try again or pick another source.`,
        );
      }
      throw new Error(
        `Network error retrieving ${cleanUrl.slice(0, 200)}: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      if (res.status === 404)
        throw new Error(`Page not found (404): ${cleanUrl.slice(0, 200)}`);
      if (res.status === 429)
        throw new Error(
          "Retrieval rate-limited (429). Wait a minute and retry.",
        );
      throw new Error(
        `Failed to fetch ${cleanUrl.slice(0, 200)}: ${res.status} ${res.statusText}`,
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (
      /pdf|msword|spreadsheet|zip|octet-stream|video|audio|image\//i.test(
        contentType,
      )
    ) {
      throw new Error(
        `Unsupported content type (${contentType}) for ${cleanUrl.slice(0, 200)}. Use HTML/articles, not binaries.`,
      );
    }
    const text = await readResponseText(res);

    let content = text;
    if (contentType.includes("text/html")) {
      content = text
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<header[\s\S]*?<\/header>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<aside[\s\S]*?<\/aside>/gi, "")
        .replace(/<form[\s\S]*?<\/form>/gi, "")
        .replace(/<svg[\s\S]*?<\/svg>/gi, "")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
    }

    if (!content.trim()) {
      return {
        url: cleanUrl,
        provider: "direct-fetch (fallback)",
        contentType,
        content: "",
        chars: 0,
        note: "Page retrieved but contained no readable text (JS-heavy or empty). Try another source.",
      };
    }

    if (content.length > safeMaxChars) {
      content = content.slice(0, safeMaxChars) + "\n\n[truncated]";
    }

    return {
      url: cleanUrl,
      provider: "direct-fetch (fallback)",
      contentType,
      content,
      chars: content.length,
    };
  },
});
