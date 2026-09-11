import { describe, expect, it } from 'bun:test';
import { htmlToText } from './html-text.ts';

describe('reading what an HTML body says, without the markup', () => {
  it('paragraphs, divisions and headings become lines, and a line break inside one is kept', () => {
    expect(htmlToText('<div><h2>Agenda</h2><p>First</p><p>Second<br>still second</p></div>')).toBe('Agenda\nFirst\nSecond\nstill second');
  });

  it('a link keeps its address the way markdown writes one, whatever else its tag carries, and a picture reads as a link to itself', () => {
    expect(htmlToText('<p>See <a href="https://example.com/doc">the doc</a> now</p>')).toBe('See [the doc](https://example.com/doc) now');
    expect(htmlToText('<a class="x" data-id="1" href="https://example.com/doc" target="_blank">the doc</a>')).toBe('[the doc](https://example.com/doc)');
    expect(htmlToText('<p><img src="https://example.com/a.png" alt="the chart"></p>')).toBe('[the chart](https://example.com/a.png)');
    expect(htmlToText('<p><img src="cid:logo"></p>')).toBe('[image](cid:logo)');
    expect(htmlToText('<p><img alt="no source"></p>')).toBe('');
  });

  it('a list reads as one, one item per line, whatever the items carry, and a table row as its cells with a bar between them', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
    expect(htmlToText('<ul><li class="x">one two</li><li>three\nfour</li></ul>')).toBe('- one two\n- three\nfour');
    expect(htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')).toBe('a | b\nc | d');
  });

  it('what the head, a style block and a script say to the browser is not said to the reader, however long or spaced', () => {
    expect(htmlToText('<html><head><title>x</title><style>p{color:red}</style></head><body><script>alert(1)</script><p>Text</p></body></html>')).toBe('Text');
    expect(htmlToText('<style type="text/css">\n  p { color: red; }\n  div > span { display: none; }\n</style><p>Text</p>')).toBe('Text');
    expect(htmlToText('<script type="text/javascript">\n  if (a > b) { alert(1); }\n</script><p>Text</p>')).toBe('Text');
  });

  it('bold, italics and the rest of the markup go, and the words stay', () => {
    expect(htmlToText('<p><b>Bold</b> and <em>soft</em> and <span style="x">plain</span></p>')).toBe('Bold and soft and plain');
  });

  it('what HTML had to escape reads back as itself, a non-breaking space as an ordinary one', () => {
    expect(htmlToText('<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39; &nbsp;G &#8217;H &#x2019;I &unknown; &apos;J&apos;</p>')).toBe(
      "A & B < C > D \"E\" 'F'  G ’H ’I &unknown; 'J'"
    );
  });

  it('a line break written with a space before its slash still breaks, and trailing spaces on a line go', () => {
    expect(htmlToText('<p>one<br />two</p>')).toBe('one\ntwo');
    expect(htmlToText('<p>text   </p><p>  more</p>')).toBe('text\nmore');
  });

  it('a body that was plain text all along comes back untouched, and blank lines the markup left are folded', () => {
    expect(htmlToText('just words, no markup')).toBe('just words, no markup');
    expect(htmlToText('<div>\n<p>One</p>\n\n<p></p><p>Two</p>\n</div>')).toBe('One\nTwo');
  });

  it('an HTML comment, whatever it holds, and a run of angle brackets that never closes, cost nothing but themselves', () => {
    expect(htmlToText('<p>Before<!-- hidden --> after</p>')).toBe('Before after');
    expect(htmlToText('<p>Before<!-- a > b, and\n more --> after</p>')).toBe('Before after');
    expect(htmlToText('<<<<<< not a tag')).toBe('<<<<<< not a tag');
  });
});
