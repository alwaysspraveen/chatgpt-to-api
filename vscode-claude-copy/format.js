// Formatting for the clipboard: Markdown -> plain text, and Markdown -> HTML
// (rich text, so Teams / Google Chat paste real bold and bullets, not "**").

// Markdown -> plain text for apps that don't render Markdown.
function toPlain(md) {
  return md
    .replace(/```[\w-]*\n([\s\S]*?)```/g, '$1')         // fenced code -> contents
    .replace(/`([^`]+)`/g, '$1')                         // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')            // images -> alt
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')      // links -> text (url)
    .replace(/^#{1,6}\s+/gm, '')                         // headings
    .replace(/^>\s?/gm, '')                              // blockquotes
    .replace(/(\*\*|__)(.+?)\1/g, '$2')                  // bold
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2') // italic *x*
    .replace(/^\s*[-*+]\s+/gm, '• ')                     // bullets
    .replace(/^\|?\s*:?-{3,}.*$/gm, '')                  // table separator rows
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(\*\*|__)(.+?)\1/g, '<b>$2</b>')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

// Markdown -> simple HTML: paragraphs, line breaks, bold/italic/code/links,
// bullet and numbered lists, headings (as bold), code blocks.
function toHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```/);
    if (fence) {
      flushPara(); flushList();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    flushList();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushPara();
      out.push(`<p><b>${inline(heading[1])}</b></p>`);
    } else if (!line.trim()) {
      flushPara();
    } else {
      para.push(line.replace(/^>\s?/, ''));
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}

module.exports = { toPlain, toHtml };
