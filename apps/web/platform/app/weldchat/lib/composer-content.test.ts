import { afterEach, describe, expect, it } from 'vitest';
import {
  contentToFragment,
  contentToHtml,
  editorToContent,
  extractMentions,
  getMentionQueryAtCaret,
  htmlToContent,
  loadContentIntoEditor,
  replaceMentionQuery,
} from './composer-content';

const members = new Map([['user_1', 'Gert']]);

function makeEditor(html: string): HTMLDivElement {
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.innerHTML = html;
  document.body.appendChild(editor);
  return editor;
}

/** Collapse the caret at `offset` inside the editor's `index`-th child (a text node). */
function setCaret(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('htmlToContent', () => {
  it('serialises plain text', () => {
    expect(htmlToContent('hello')).toBe('hello');
  });

  it('serialises formatting as markdown markers', () => {
    expect(htmlToContent('<b>b</b> <i>i</i> <u>u</u> <s>s</s> <code>c</code>')).toBe('**b** *i* __u__ ~~s~~ `c`');
  });

  it('keeps nested formatting (bold + italic)', () => {
    expect(htmlToContent('<b><i>x</i></b>')).toBe('***x***');
    expect(htmlToContent('<i><b>x</b></i>')).toBe('***x***');
    expect(htmlToContent('<b>a <i>b</i> c</b>')).toBe('**a *b* c**');
    expect(htmlToContent('<b><u>x</u></b>')).toBe('**__x__**');
  });

  it('keeps surrounding whitespace outside the markers so they stay valid', () => {
    expect(htmlToContent('<b>hello </b>world')).toBe('**hello** world');
    expect(htmlToContent('a<b> hi</b>')).toBe('a **hi**');
  });

  it('merges adjacent runs of the same format so they round-trip as one run', () => {
    expect(htmlToContent('<b>a</b><b>b</b>')).toBe('**ab**');
    expect(htmlToContent('<i>a</i><i>b</i>')).toBe('*ab*');
    expect(htmlToContent('<b>a</b><b>b</b><b>c</b>')).toBe('**abc**');
    expect(htmlToContent('<b>a</b> <b>b</b>')).toBe('**a** **b**');
    expect(htmlToContent('<b>a</b><i>b</i>')).toBe('**a***b*');
  });

  it('drops empty formatting wrappers', () => {
    expect(htmlToContent('<b></b>x<i> </i>')).toBe('x ');
    expect(htmlToContent('<code>\u200B</code>')).toBe('');
  });

  it('serialises mention chips back to tokens', () => {
    const html =
      '<span class="mention-badge" contenteditable="false" data-userid="user_1">@Gert</span> ' +
      '<span class="entity-mention-badge" contenteditable="false" data-entity="customer:cus_1" data-label="Acme">Acme</span>';
    expect(htmlToContent(html)).toBe('<@user_1> <@customer:cus_1|Acme>');
  });

  it('serialises line breaks and lists', () => {
    expect(htmlToContent('a<br>b')).toBe('a\nb');
    expect(htmlToContent('<ul><li>x</li><li>y</li></ul>')).toBe('• x\n• y\n');
    expect(htmlToContent('<ol><li><b>x</b></li><li>y</li></ol>')).toBe('1. **x**\n2. y\n');
  });

  it('normalises non-breaking spaces', () => {
    expect(htmlToContent('a&nbsp;b')).toBe('a b');
  });

  it('ignores images', () => {
    expect(htmlToContent('a<img src="x">b')).toBe('ab');
  });
});

describe('contentToHtml / contentToFragment', () => {
  it('turns tokens into chips', () => {
    const html = contentToHtml('hi <@user_1> and <@customer:cus_1|Acme> and <@everyone>', members);
    expect(html).toContain('class="mention-badge"');
    expect(html).toContain('data-userid="user_1">@Gert</span>');
    expect(html).toContain('data-entity="customer:cus_1"');
    expect(html).toContain('data-label="Acme"');
    expect(html).toContain('data-userid="everyone">@everyone</span>');
  });

  it('falls back to the id when the member is unknown, and honours a name override', () => {
    expect(contentToHtml('<@u9>', members)).toContain('>@u9</span>');
    expect(contentToHtml('<@u9:Override>', members)).toContain('data-userid="u9:Override">@Override</span>');
  });

  it('can never inject markup from typed text', () => {
    const html = contentToHtml('<img src=x onerror=window.__xss=1> <b>x</b> & "q"', members);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=window.__xss=1&gt;');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('img')).toBeNull();
  });

  it('escapes hostile token labels and ids', () => {
    const html = contentToHtml('<@customer:c"1|<img src=x>>', members);
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('img')).toBeNull();
  });

  it('round-trips content with tokens and markdown markers losslessly', () => {
    const content = 'hello <@user_1> **bold** and *it* <@customer:cus_1|Acme>\nsecond line `code` <@everyone>';
    const editor = document.createElement('div');
    loadContentIntoEditor(editor, content, members);
    expect(editorToContent(editor)).toBe(content);
  });

  it('round-trips a user mention with a name override', () => {
    const editor = document.createElement('div');
    editor.appendChild(contentToFragment('<@u9:Override> hi', members));
    expect(editorToContent(editor)).toBe('<@u9:Override> hi');
  });

  it('round-trips literal angle brackets typed by the user', () => {
    const content = '<img src=x onerror=1> & <b>';
    const editor = document.createElement('div');
    loadContentIntoEditor(editor, content, members);
    expect(editor.querySelector('img')).toBeNull();
    expect(editorToContent(editor)).toBe(content);
  });
});

describe('extractMentions', () => {
  it('lists users, entities and everyone once each', () => {
    expect(extractMentions('<@u1> <@u1:Name> <@customer:cus_1|Acme> <@everyone> plain')).toEqual([
      'u1',
      'entity:customer:cus_1',
      'everyone',
    ]);
  });

  it('is empty without tokens', () => {
    expect(extractMentions('just text')).toEqual([]);
  });
});

describe('mention query at the caret', () => {
  it('finds the query after an @', () => {
    const editor = makeEditor('hi @Ge');
    const text = editor.firstChild as Text;
    setCaret(text, text.length);
    expect(getMentionQueryAtCaret(editor)).toBe('Ge');
  });

  it('returns an empty query right after a bare @', () => {
    const editor = makeEditor('@');
    setCaret(editor.firstChild as Text, 1);
    expect(getMentionQueryAtCaret(editor)).toBe('');
  });

  it('ignores an @ inside a word (email addresses)', () => {
    const editor = makeEditor('me@exam');
    setCaret(editor.firstChild as Text, 7);
    expect(getMentionQueryAtCaret(editor)).toBeNull();
  });

  it('ends at whitespace', () => {
    const editor = makeEditor('@Ger and more');
    setCaret(editor.firstChild as Text, 13);
    expect(getMentionQueryAtCaret(editor)).toBeNull();
  });

  it('uses the caret, not the last @ in the whole editor', () => {
    const editor = makeEditor('@Ger and @Zed');
    setCaret(editor.firstChild as Text, 4);
    expect(getMentionQueryAtCaret(editor)).toBe('Ger');
  });
});

describe('replaceMentionQuery', () => {
  it('replaces only the @query and keeps everything else untouched', () => {
    const editor = makeEditor(
      '<b>bold</b> <span class="mention-badge" contenteditable="false" data-userid="user_2">@Zed</span> hi @Ge',
    );
    const text = editor.lastChild as Text;
    setCaret(text, text.length);
    const chip = contentToFragment('<@user_1>', members).firstChild as Node;

    expect(replaceMentionQuery(editor, chip)).toBe(true);

    // Earlier chip and bold survive as elements, not text.
    expect(editor.querySelector('b')?.textContent).toBe('bold');
    expect(editor.querySelectorAll('.mention-badge')).toHaveLength(2);
    expect(editorToContent(editor)).toBe('**bold** <@user_2> hi <@user_1> ');
  });

  it('keeps text after the caret and puts the caret behind the chip and its space', () => {
    const editor = makeEditor('a @Ge tail');
    const text = editor.firstChild as Text;
    setCaret(text, 5);
    const chip = contentToFragment('<@user_1>', members).firstChild as Node;

    expect(replaceMentionQuery(editor, chip)).toBe(true);
    expect(editorToContent(editor)).toBe('a <@user_1>  tail');

    const range = window.getSelection()?.getRangeAt(0);
    expect(range?.startContainer.nodeType).toBe(3);
    expect(range?.startOffset).toBe(1);
    expect(range?.startContainer.previousSibling).toBe(chip);
  });

  it('never executes typed markup', () => {
    const editor = makeEditor('');
    editor.appendChild(document.createTextNode('<img src=x onerror=window.__xss=1> @Ger'));
    const text = editor.firstChild as Text;
    setCaret(text, text.length);
    const chip = contentToFragment('<@user_1>', members).firstChild as Node;

    expect(replaceMentionQuery(editor, chip)).toBe(true);
    expect(editor.querySelector('img')).toBeNull();
    expect(editorToContent(editor)).toBe('<img src=x onerror=window.__xss=1> <@user_1> ');
  });

  it('does nothing when the caret is not in a mention query', () => {
    const editor = makeEditor('plain text');
    setCaret(editor.firstChild as Text, 5);
    const chip = contentToFragment('<@user_1>', members).firstChild as Node;
    expect(replaceMentionQuery(editor, chip)).toBe(false);
    expect(editor.textContent).toBe('plain text');
  });
});
