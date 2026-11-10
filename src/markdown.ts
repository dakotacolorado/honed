/**
 * Just enough Markdown to read a skill: headings, lists, quotes, code, bold and links. Everything is escaped first, so
 * what an agent wrote can only ever become these elements; links go to http(s) alone.
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inline(text: string): string {
  return text
    .split("`")
    .map((part, i) => {
      if (i % 2) return `<code>${escape(part)}</code>`;
      return escape(part)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
    })
    .join("");
}

/** A SKILL.md without its frontmatter, which the page shows as the title and description instead. */
export const withoutFrontmatter = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length + 2;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      if (paragraph.length) flush();
      const tag = /\d/.test(item[2]!) ? "ol" : "ul";
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, items: [] };
      }
      const nested = item[1]!.length >= 2;
      list.items.push(nested ? `<span class="sub">${inline(item[3]!)}</span>` : inline(item[3]!));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${inline(line.trim())}`;
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  flush();
  return out.join("\n");
}
