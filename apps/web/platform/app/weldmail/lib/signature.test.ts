import { describe, it, expect } from 'vitest';
import {
  applySignature,
  currentSignatureId,
  pickDefaultSignature,
  replaceBodyKeepingSignature,
  sanitizeSignatureHtml,
  signaturesForAccount,
  userWrittenText,
  type MailSignature,
} from './signature';
import { isDraftBlank } from './draft-autosave';

function sig(overrides: Partial<MailSignature> & { id: string }): MailSignature {
  return {
    name: overrides.id,
    content: `<b>${overrides.id}</b>`,
    isDefault: false,
    type: 'personal',
    accountIds: null,
    includeInReplies: true,
    includeInForwards: true,
    ...overrides,
  };
}

function editorWith(html = ''): HTMLDivElement {
  const editor = document.createElement('div');
  editor.innerHTML = html;
  return editor;
}

describe('sanitizeSignatureHtml', () => {
  it('drops scripts, event handlers and javascript: links', () => {
    const html = sanitizeSignatureHtml(
      '<b onclick="x()">Jo</b><script>alert(1)</script><a href="javascript:alert(1)">bad</a><img src="x" onerror="alert(1)">',
    );
    expect(html).not.toMatch(/script|onclick|onerror|javascript:/i);
    expect(html).toContain('<b>Jo</b>');
  });

  it('keeps styling but not positioning that could cover the app', () => {
    const html = sanitizeSignatureHtml('<span style="color: red; position: fixed; z-index: 9">Jo</span>');
    expect(html).toContain('color: red');
    expect(html).not.toMatch(/position|z-index/);
  });

  it('opens links in a new tab', () => {
    expect(sanitizeSignatureHtml('<a href="https://acme.test">site</a>')).toContain('target="_blank"');
  });
});

describe('pickDefaultSignature', () => {
  const shared = sig({ id: 'company', type: 'company', isDefault: true });
  const mineEverywhere = sig({ id: 'mine', isDefault: true });
  const mineForA = sig({ id: 'mine-a', isDefault: true, accountIds: ['acc_a'] });
  const notDefault = sig({ id: 'other' });

  it('prefers the user’s own, and one for this account over one for every account', () => {
    const all = [shared, mineEverywhere, mineForA, notDefault];
    expect(pickDefaultSignature(all, 'acc_a', 'new')?.id).toBe('mine-a');
    expect(pickDefaultSignature(all, 'acc_b', 'new')?.id).toBe('mine');
    expect(pickDefaultSignature([shared, notDefault], 'acc_b', 'new')?.id).toBe('company');
    expect(pickDefaultSignature([notDefault], 'acc_b', 'new')).toBeNull();
  });

  it('leaves replies and forwards out when the signature says so', () => {
    const newOnly = sig({ id: 'n', isDefault: true, includeInReplies: false, includeInForwards: false });
    expect(pickDefaultSignature([newOnly], 'acc_a', 'reply')).toBeNull();
    expect(pickDefaultSignature([newOnly], 'acc_a', 'forward')).toBeNull();
    expect(pickDefaultSignature([newOnly, shared], 'acc_a', 'reply')?.id).toBe('company');
  });
});

describe('signaturesForAccount', () => {
  it('lists what applies to the account, own signatures first', () => {
    const list = signaturesForAccount(
      [
        sig({ id: 'z-shared', type: 'company' }),
        sig({ id: 'b-mine' }),
        sig({ id: 'a-mine-elsewhere', accountIds: ['acc_b'] }),
        sig({ id: 'a-mine' }),
      ],
      'acc_a',
    );
    expect(list.map((s) => s.id)).toEqual(['a-mine', 'b-mine', 'z-shared']);
  });
});

describe('applySignature', () => {
  it('gives a blank editor a line to write on above the signature', () => {
    const editor = editorWith('');
    applySignature(editor, sig({ id: 'one' }));
    expect(editor.firstElementChild?.outerHTML).toBe('<div><br></div>');
    expect(currentSignatureId(editor)).toBe('one');
    expect(userWrittenText(editor.innerHTML)).toBe('');
  });

  it('swaps the signature without touching the text, and removes it', () => {
    const editor = editorWith('<div>Hello</div>');
    applySignature(editor, sig({ id: 'one' }));
    applySignature(editor, sig({ id: 'two' }));
    expect(editor.querySelectorAll('[data-weld-signature]')).toHaveLength(1);
    expect(currentSignatureId(editor)).toBe('two');
    expect(editor.textContent).toContain('Hello');

    applySignature(editor, null);
    expect(currentSignatureId(editor)).toBeNull();
    expect(editor.innerHTML).toBe('<div>Hello</div>');
  });

  it('sanitizes the signature it inserts', () => {
    const editor = editorWith('');
    applySignature(editor, { id: 'x', content: '<img src="x" onerror="alert(1)">Jo' });
    expect(editor.innerHTML).not.toContain('onerror');
  });
});

describe('replaceBodyKeepingSignature', () => {
  it('keeps the signature below a rewritten body', () => {
    const editor = editorWith('<div>old</div>');
    applySignature(editor, sig({ id: 'one' }));
    replaceBodyKeepingSignature(editor, '<p>new</p>');
    expect(editor.textContent).not.toContain('old');
    expect(editor.firstElementChild?.outerHTML).toBe('<p>new</p>');
    expect(currentSignatureId(editor)).toBe('one');
  });

  it('keeps the signature the new HTML brings instead of adding a second one', () => {
    const editor = editorWith('<div>old</div>');
    applySignature(editor, sig({ id: 'one' }));
    replaceBodyKeepingSignature(editor, '<p>draft</p><div data-weld-signature="two">Two</div>');
    expect(editor.querySelectorAll('[data-weld-signature]')).toHaveLength(1);
    expect(currentSignatureId(editor)).toBe('two');
  });
});

describe('userWrittenText', () => {
  it('ignores the signature, so a signature-only body is blank', () => {
    const editor = editorWith('');
    applySignature(editor, sig({ id: 'one', content: 'Jo Smith<br>ACME' }));
    expect(userWrittenText(editor.innerHTML)).toBe('');

    editor.firstElementChild!.textContent = 'Hi there';
    expect(userWrittenText(editor.innerHTML)).toBe('Hi there');
  });

  it('makes a signature-only form a blank draft', () => {
    const editor = editorWith('');
    applySignature(editor, sig({ id: 'one', content: 'Jo Smith' }));
    const fields = {
      subject: '',
      to: [],
      cc: [],
      bcc: [],
      body: 'Jo Smith',
      htmlBody: editor.innerHTML,
      contentText: userWrittenText(editor.innerHTML),
    };
    expect(isDraftBlank(fields)).toBe(true);
    expect(isDraftBlank({ ...fields, contentText: undefined })).toBe(false);
  });
});
