import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Analyze a dataset (CSV or JSON table). Returns row count, columns, basic stats, and optional summary. Runs sandboxed string parsing, no file I/O.",
  inputSchema: z.object({
    data: z.string().min(1).describe("CSV text or JSON array string"),
    format: z.enum(["csv", "json"]).optional().describe("Data format; auto-detected if omitted"),
    question: z.string().optional().describe("Specific analysis question to focus on"),
  }),
  async execute({ data, format, question }) {
    // Edge-case guards: empty, oversized, binary-ish input
    if (!data || !data.trim()) {
      return { rows: 0, columns: [], note: "No data provided. Send CSV (header + rows) or a JSON array." };
    }
    const MAX_INPUT_CHARS = 500_000; // ~500KB — beyond this, ask for a sample, don't OOM
    if (data.length > MAX_INPUT_CHARS) {
      throw new Error(
        `Dataset too large (${data.length} chars, max ${MAX_INPUT_CHARS}). Send a sample (first 500 rows) or aggregate first.`,
      );
    }
    let rows: Record<string, unknown>[] = [];

    const trimmed = data.trim();
    const detectedFormat = format ?? (trimmed.startsWith("[") || trimmed.startsWith("{") ? "json" : "csv");

    if (detectedFormat === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error("Invalid JSON: could not parse. Check for trailing commas or unquoted keys.");
      }
      rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
    } else {
      // Minimal CSV parser with quoted-field support ("a,b",c)
      const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) throw new Error("CSV needs header + at least one row");
      if (lines.length > 5000) {
        throw new Error(`CSV has ${lines.length} lines (max 5000). Send a sample or pre-aggregate.`);
      }
      const splitCsvLine = (line: string): string[] => {
        const matches = [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)];
        return matches.map((m) => (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]).trim());
      };
      const headers = splitCsvLine(lines[0]);
      if (new Set(headers).size !== headers.length) {
        throw new Error("CSV has duplicate column names. Rename duplicates before analysis.");
      }
      rows = lines.slice(1).map((line) => {
        const vals = splitCsvLine(line);
        const row: Record<string, unknown> = {};
        headers.forEach((h, i) => {
          const v = vals[i] ?? "";
          const num = Number(v.replace(/,/g, ""));
          row[h] = v !== "" && Number.isFinite(num) ? num : v;
        });
        return row;
      });
    }

    if (rows.length === 0) return { rows: 0, note: "No rows parsed" };

    const columns = Object.keys(rows[0]);
    const numericCols = columns.filter((c) => rows.every((r) => typeof r[c] === "number" || r[c] === "" || r[c] === null));
    // More permissive: columns where majority are numbers
    const stats: Record<string, { count: number; sum: number; min: number; max: number; mean: number }> = {};
    for (const col of columns) {
      const nums = rows.map((r) => r[col]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (nums.length > 0) {
        const sum = nums.reduce((a, b) => a + b, 0);
        stats[col] = { count: nums.length, sum, min: Math.min(...nums), max: Math.max(...nums), mean: sum / nums.length };
      }
    }

    return {
      rows: rows.length,
      columns,
      numericColumns: Object.keys(stats),
      stats,
      sample: rows.slice(0, 3),
      question: question ?? null,
    };
  },
});
