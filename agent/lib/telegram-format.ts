/**
 * Converts Markdown to Telegram-compatible HTML.
 * Supported Telegram tags: <b>, <i>, <code>, <pre>, <a>, <u>, <s>, <blockquote>
 *
 * NOTE: Telegram Bot API does NOT support <br> or <br/> tags. Newlines must be raw '\n'.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Truncates raw Markdown before HTML conversion to avoid slicing through HTML entities or open tags.
 * If within an open code fence, closes the code fence cleanly.
 */
export function safeTruncateMarkdown(md: string, maxLen = 3500): string {
  if (md.length <= maxLen) return md;

  // Truncate at paragraph or newline boundary
  let truncated = md.slice(0, maxLen);
  const lastDoubleNewline = truncated.lastIndexOf("\n\n");
  const lastNewline = truncated.lastIndexOf("\n");

  if (lastDoubleNewline > maxLen * 0.7) {
    truncated = truncated.slice(0, lastDoubleNewline);
  } else if (lastNewline > maxLen * 0.8) {
    truncated = truncated.slice(0, lastNewline);
  }

  // Count code fence occurrences to close any severed code block
  const codeBlockCount = (truncated.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    truncated += "\n```";
  }

  return truncated + "\n\n<i>…(truncated for Telegram message length)</i>";
}

/**
 * Ensures any open tags in a Telegram HTML snippet are properly closed in reverse order.
 */
export function balanceTelegramTags(html: string): string {
  const openTags: string[] = [];
  const tagRegex = /<\/?([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const full = match[0];
    const tag = match[1].toLowerCase();
    if (full.startsWith("</")) {
      // Closing tag: pop matching tag from stack
      const idx = openTags.lastIndexOf(tag);
      if (idx !== -1) {
        openTags.splice(idx, 1);
      }
    } else if (!full.endsWith("/>")) {
      // Self-closing not used in Telegram, push tag
      if (["b", "strong", "i", "em", "u", "s", "strike", "del", "code", "pre", "a", "blockquote"].includes(tag)) {
        openTags.push(tag);
      }
    }
  }

  // Close unclosed tags in reverse order
  let balanced = html;
  while (openTags.length > 0) {
    const unclosed = openTags.pop()!;
    balanced += `</${unclosed}>`;
  }
  return balanced;
}

/**
 * Converts Markdown text to Telegram HTML format.
 */
export function markdownToTelegramHtml(md: string): string {
  // 1. Isolate and escape code blocks
  const codeBlocks: string[] = [];
  let text = md.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `__CODEBLOCK_${codeBlocks.length}__`;
    const escaped = escapeHtml(code.trim());
    codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
    return placeholder;
  });

  // 2. Isolate and escape inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `__INLINECODE_${inlineCodes.length}__`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // 3. Escape raw HTML characters in prose
  text = escapeHtml(text);

  // 4. Restore code blocks & inline code
  text = text.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => codeBlocks[Number(i)]);
  text = text.replace(/__INLINECODE_(\d+)__/g, (_, i) => inlineCodes[Number(i)]);

  // 5. Transform standard markdown syntax to Telegram HTML
  // Links: [text](https://url)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // Bold: **text** or __text__
  text = text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_]+)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (excluding inside existing tags)
  text = text.replace(/(?<=^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "<i>$1</i>");
  text = text.replace(/(?<=^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  text = text.replace(/~~([^~]+)~~/g, "<s>$1</s>");

  // Headers: ### Header -> <b>Header</b>
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Blockquotes: > quote -> <blockquote>quote</blockquote>
  text = text.replace(/^&gt;\s*(.+)$/gm, "<blockquote>$1</blockquote>");

  // Unordered list bullets: * or - -> •
  text = text.replace(/^\s*[-*]\s+(.+)$/gm, "• $1");

  // Ensure all tags are safely closed
  return balanceTelegramTags(text);
}

/**
 * Plain text to safe Telegram HTML (escapes special chars without inserting invalid <br/> tags).
 */
export function plainToHtml(text: string): string {
  return escapeHtml(text);
}


