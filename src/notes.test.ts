import { describe, expect, it } from 'vitest';
import { notesHtml } from './notes';

describe('release notes', () => {
  it('reads headings, bullets and bold words', () => {
    expect(notesHtml("## What's new\n\n- **Copy and paste a mark.** Select it, ⌘C, ⌘V.\n- A Close button."))
      .toBe("<h3>What&#39;s new</h3><ul><li><strong>Copy and paste a mark.</strong> Select it, ⌘C, ⌘V.</li><li>A Close button.</li></ul>");
  });

  it('carries a wrapped bullet on, and keeps paragraphs apart', () => {
    expect(notesHtml('- One line\n  and its second\n\nAfter the list,\nstill one paragraph.\n\nAnd another.'))
      .toBe('<ul><li>One line and its second</li></ul><p>After the list, still one paragraph.</p><p>And another.</p>');
  });

  it('can only ever be text', () => {
    const html = notesHtml('## <img src=x onerror=alert(1)>\n- [a link](https://example.com) <script>alert(1)</script>\n- "quoted" & done');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; done');
  });

  it('is empty for no notes', () => {
    expect(notesHtml('')).toBe('');
    expect(notesHtml('\n\n')).toBe('');
  });
});
