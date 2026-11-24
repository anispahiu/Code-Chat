import MarkdownIt from '/markdown-it.js';

export function createMarkdownRenderer() {
  const markdown = MarkdownIt('commonmark', { html: false, breaks: true })
    .disable(['image', 'link', 'autolink']);
  markdown.core.ruler.push('reply_headings', ({ tokens }) => {
    for (const token of tokens) {
      if (token.tag === 'h1' || token.tag === 'h2') token.tag = 'h3';
    }
  });
  return markdown;
}
