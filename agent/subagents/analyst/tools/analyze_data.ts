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
    let rows: Record<string, unknown>[] = [];

    const trimmed = data.trim();
    const detectedFormat = format ?? (trimmed.startsWith("[") || trimmed.startsWith("{") ? "json" : "csv");

    if (detectedFormat === "json") {
      const parsed = JSON.parse(trimmed);
      rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
    } else {
      // Minimal CSV parser
      const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) throw new Error("CSV needs header + at least one row");
      const headers = lines[0].split(",").map((h) => h.trim());
      rows = lines.slice(1).map((line) => {
        const vals = line.split(",").map((v) => v.trim());
        const row: Record<string, unknown> = {};
        headers.forEach((h, i) => {
          const v = vals[i] ?? "";
          const num = Number(v);
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
