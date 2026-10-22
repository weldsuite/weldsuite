import { buildNoteHtml, htmlToText, isPlainNoteHtml, noteSubject, splitNote } from '@/lib/note-text';

describe('note text', () => {
  it('reads the title from the first heading and the rest as lines', () => {
    expect(splitNote('<h1>Call recap</h1><p>Budget is fine</p><p>Next: demo &amp; pricing</p>')).toEqual({
      title: 'Call recap',
      body: 'Budget is fine\nNext: demo & pricing',
    });
  });

  it('has no title when the note has no heading', () => {
    expect(splitNote('<p>Just a line</p>')).toEqual({ title: '', body: 'Just a line' });
    expect(splitNote(null)).toEqual({ title: '', body: '' });
  });

  it('writes the same shape the web editor uses, escaping text', () => {
    expect(buildNoteHtml({ title: 'Q4 <plan>', body: 'a & b\n\nc' })).toBe(
      '<h1>Q4 &lt;plan&gt;</h1><p>a &amp; b</p><p></p><p>c</p>',
    );
    expect(buildNoteHtml({ title: 'Only a title', body: '  ' })).toBe('<h1>Only a title</h1>');
    expect(buildNoteHtml({ title: '', body: 'x' })).toBe('<p>x</p>');
  });

  it('round-trips through split and build', () => {
    const parts = { title: 'Title', body: 'one\ntwo' };
    expect(splitNote(buildNoteHtml(parts))).toEqual(parts);
  });

  it('flags formatting the app would lose', () => {
    expect(isPlainNoteHtml('<h1>T</h1><p>x<br>y</p>')).toBe(true);
    expect(isPlainNoteHtml('<p>x <strong>bold</strong></p>')).toBe(false);
    expect(isPlainNoteHtml('<ul><li>a</li></ul>')).toBe(false);
    expect(isPlainNoteHtml('plain text')).toBe(true);
  });

  it('derives the subject from the title, then the first line', () => {
    expect(noteSubject({ title: 'T', body: 'b' })).toBe('T');
    expect(noteSubject({ title: '', body: '\n first \nsecond' })).toBe('first');
    expect(noteSubject({ title: '', body: '' })).toBe('Note');
    expect(noteSubject({ title: 'x'.repeat(300), body: '' })).toHaveLength(255);
  });

  it('turns block tags into line breaks', () => {
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\nb');
  });
});
