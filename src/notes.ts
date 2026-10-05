/** Release notes as a release writes them -- a few headings, bulleted lines and
 *  bold words -- turned into markup for the Software Update window. Everything
 *  is escaped before anything is made of it, so the notes can only ever be
 *  text: nothing a manifest says can become a link, an image or a script. */
export function notesHtml(markdown: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list = false;
  const flush = () => { if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; };
  const close = () => { if (list) out.push('</ul>'); list = false; };
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (!line) { flush(); close(); }
    else if (heading) { flush(); close(); out.push(`<h3>${inline(heading[1])}</h3>`); }
    else if (item) { flush(); if (!list) out.push('<ul>'); list = true; out.push(`<li>${inline(item[1])}</li>`); }
    // A line under a bullet, indented or not, carries that bullet on.
    else if (list) out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line)}</li>`);
    else paragraph.push(line);
  }
  flush(); close();
  return out.join('');
}

function inline(text: string): string {
  return escape(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
