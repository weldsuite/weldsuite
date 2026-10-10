import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTE_SUBJECT, getNoteTitleText, noteSubjectFromContent } from './note-title';

describe('getNoteTitleText', () => {
  it('prefers the first heading, whatever its level', () => {
    expect(getNoteTitleText('<p>intro</p><h1>Kickoff call</h1><p>body</p>')).toBe('Kickoff call');
    expect(getNoteTitleText('<h3>Small <b>title</b></h3>')).toBe('Small title');
  });

  it('falls back to the first line of text, not the whole body', () => {
    expect(getNoteTitleText('<p>First line</p><p>Second line</p>')).toBe('First line');
    expect(getNoteTitleText('plain<br>text')).toBe('plain');
  });

  it('skips an empty heading and empty leading blocks', () => {
    expect(getNoteTitleText('<h1></h1><p></p><p>Actual text</p>')).toBe('Actual text');
  });

  it('decodes the entities the editor writes', () => {
    expect(getNoteTitleText('<h1>Q&amp;A &lt;draft&gt;&nbsp;1</h1>')).toBe('Q&A <draft> 1');
    expect(getNoteTitleText('<h1>&amp;lt;</h1>')).toBe('&lt;');
  });

  it('is null for empty or tag-only content', () => {
    expect(getNoteTitleText('')).toBeNull();
    expect(getNoteTitleText(undefined)).toBeNull();
    expect(getNoteTitleText('<p></p><br>')).toBeNull();
  });
});

describe('noteSubjectFromContent', () => {
  it('uses the title as the subject', () => {
    expect(noteSubjectFromContent('<h1>Pricing follow-up</h1><p>Send the quote.</p>')).toBe('Pricing follow-up');
  });

  it('is "Note" while the body has no text', () => {
    expect(noteSubjectFromContent('')).toBe(DEFAULT_NOTE_SUBJECT);
    expect(noteSubjectFromContent('<p></p>')).toBe(DEFAULT_NOTE_SUBJECT);
  });

  it('stays within the 255 character subject limit', () => {
    expect(noteSubjectFromContent(`<h1>${'x'.repeat(400)}</h1>`)).toHaveLength(255);
  });
});
