// Converts markdown to Telegram HTML (Telegram supports <b>, <i>, <code>, <pre>, <a>, <u>, <s>)
// Used for live-edited messages and final answers so **bold** renders correctly instead of literal ** or commas.
export function markdownToTelegramHtml(md: string): string {
  let html = md;

  // Escape HTML entities first (preserve already-intended tags by doing after code blocks ideally)
  // Protect code blocks and inline code before escaping
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, __, code) => {
    const placeholder = `__CODEBLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    return placeholder;
  });

  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `__INLINECODE_${inlineCodes.length}__`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // Now escape remaining HTML
  html = escapeHtml(html);

  // Restore code placeholders (already escaped)
  html = html.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => codeBlocks[Number(i)]);
  html = html.replace(/__INLINECODE_(\d+)__/g, (_, i) => inlineCodes[Number(i)]);

  // Markdown to HTML conversions (order matters)
  // Links: [text](url) -> <a href="url">text</a>
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2">$1</a>');

  // Bold: **text** -> <b>text</b> (also __text__)
  html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  html = html.replace(/__([^_]+)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ -> <i>text</i> (avoid inside bold already converted)
  html = html.replace(/(?<!<b>[^<]*)\*([^*\n]+)\*(?![^<]*<\/b>)/g, "<i>$1</i>");
  html = html.replace(/(?<!<b>[^<]*)\b_([^_\n]+)_\b/g, "<i>$1</i>");

  // Strikethrough: ~~text~~ -> <s>text</s>
  html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");

  // Headings: ### -> <b> (Telegram has no h1, use bold)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Blockquotes: > text -> <i>text</i> with line prefix
  html = html.replace(/^&gt;\s*(.+)$/gm, "<i>$1</i>");

  // Unescape placeholders for <b>,<i> etc already inserted
  // Lists: keep as • bullets (Telegram no <ul>)
  html = html.replace(/^\s*[-*]\s+(.+)$/gm, "• $1");
  html = html.replace(/^\s*\d+\.\s+(.+)$/gm, "• $1");

  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// For progress messages we want simple plain with HTML bold support but no full markdown
export function plainToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br/>");
}
