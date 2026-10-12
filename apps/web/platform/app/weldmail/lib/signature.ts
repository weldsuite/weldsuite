/**
 * Email signatures in the compose editors.
 *
 * A signature sits in the editor as one block, `<div data-weld-signature="id">`,
 * after what the user writes. Marking it lets compose swap or remove it, keep it
 * when AI rewrites the body, and tell a body that only holds a signature from one
 * the user actually wrote (no send, no draft for the former).
 *
 * Signature HTML is written by other members (shared signatures) and lands in
 * this user's editor, so it is reduced to an allowlist before it gets there.
 */
import DOMPurify from 'dompurify';
import type { MailSignatureRow } from '@weldsuite/app-api-client';
import { htmlToPlainText } from './compose-body';

export const SIGNATURE_ATTRIBUTE = 'data-weld-signature';
const SIGNATURE_SELECTOR = `[${SIGNATURE_ATTRIBUTE}]`;

/** What is being written, which decides whether a signature goes in on its own. */
export type SignatureMode = 'new' | 'reply' | 'forward';

export type MailSignature = Pick<
  MailSignatureRow,
  'id' | 'name' | 'content' | 'isDefault' | 'type' | 'accountIds' | 'includeInReplies' | 'includeInForwards'
>;

// What a signature needs: text formatting, links, images (logos) and the
// tables signature generators lay them out with.
const ALLOWED_TAGS = [
  'a', 'b', 'br', 'div', 'em', 'font', 'hr', 'i', 'img', 'li', 'ol', 'p', 's', 'small',
  'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr',
  'u', 'ul',
];
const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'width', 'height', 'style', 'color', 'face', 'size',
  'align', 'valign', 'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border',
];
// http(s), mailto, tel and relative URLs; images may also be inline data URLs.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|data:image\/(?:png|gif|jpeg|webp);|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
// Inline styles stay (signatures are styled), except what could lift the
// signature out of the editor and over the rest of the app.
const BLOCKED_STYLE_PROPERTIES = ['position', 'z-index', 'inset', 'top', 'left', 'right', 'bottom', 'transform'];

let purifier: ReturnType<typeof DOMPurify> | null = null;

function getPurifier() {
  if (purifier) return purifier;
  // Own instance, so these hooks never reach another DOMPurify user.
  purifier = DOMPurify(window);
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    const style = (node as HTMLElement).style;
    if (style && node.hasAttribute('style')) {
      for (const property of BLOCKED_STYLE_PROPERTIES) style.removeProperty(property);
      if (!style.cssText) node.removeAttribute('style');
    }
  });
  return purifier;
}

export function sanitizeSignatureHtml(html: string): string {
  return getPurifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

/** Whether a signature may be used with the account; no accounts means every account. */
export function signatureAppliesTo(signature: Pick<MailSignature, 'accountIds'>, accountId: string | undefined): boolean {
  if (!signature.accountIds?.length) return true;
  return accountId !== undefined && signature.accountIds.includes(accountId);
}

const isPersonal = (signature: Pick<MailSignature, 'type'>) => signature.type === 'personal';

/** The signatures the picker offers for an account: the user's own first, then by name. */
export function signaturesForAccount<T extends MailSignature>(signatures: T[], accountId: string | undefined): T[] {
  return signatures
    .filter((signature) => signatureAppliesTo(signature, accountId))
    .sort((a, b) => Number(isPersonal(b)) - Number(isPersonal(a)) || a.name.localeCompare(b.name));
}

function allowedIn(signature: MailSignature, mode: SignatureMode): boolean {
  if (mode === 'reply') return signature.includeInReplies;
  if (mode === 'forward') return signature.includeInForwards;
  return true;
}

/**
 * The signature compose inserts on its own, if any: a default that applies to
 * the account and is allowed for this kind of mail. The user's own beats a
 * shared one, and one set up for this account beats one for every account.
 */
export function pickDefaultSignature<T extends MailSignature>(
  signatures: T[],
  accountId: string | undefined,
  mode: SignatureMode,
): T | null {
  const rank = (signature: T) => (isPersonal(signature) ? 0 : 2) + (signature.accountIds?.length ? 0 : 1);
  const candidates = signatures
    .filter((signature) => signature.isDefault && signatureAppliesTo(signature, accountId) && allowedIn(signature, mode))
    .sort((a, b) => rank(a) - rank(b));
  return candidates[0] ?? null;
}

/** The signature block's id, or null when the editor has none. */
export function currentSignatureId(editor: HTMLElement | null): string | null {
  return editor?.querySelector(SIGNATURE_SELECTOR)?.getAttribute(SIGNATURE_ATTRIBUTE) ?? null;
}

function buildSignatureBlock(signature: Pick<MailSignature, 'id' | 'content'>): HTMLDivElement {
  const block = document.createElement('div');
  block.setAttribute(SIGNATURE_ATTRIBUTE, signature.id);
  // The empty line keeps the signature apart from the text above it.
  block.innerHTML = `<br>${sanitizeSignatureHtml(signature.content)}`;
  return block;
}

const isBlankEditor = (editor: HTMLElement) =>
  !editor.textContent?.trim() && !editor.querySelector('img, li, hr, table');

/**
 * Puts the signature in the editor, replacing the one already there, or takes
 * it out when `signature` is null. A blank editor gets an empty line to write on
 * above the signature, with the caret on it when the editor has focus.
 */
export function applySignature(
  editor: HTMLElement,
  signature: Pick<MailSignature, 'id' | 'content'> | null,
): void {
  const existing = editor.querySelector(SIGNATURE_SELECTOR);
  if (!signature) {
    existing?.remove();
    return;
  }
  const block = buildSignatureBlock(signature);
  if (existing) {
    existing.replaceWith(block);
    return;
  }
  if (isBlankEditor(editor)) {
    editor.innerHTML = '<div><br></div>';
    editor.appendChild(block);
    if (document.activeElement === editor) placeCaretAtStart(editor);
    return;
  }
  editor.appendChild(block);
}

function placeCaretAtStart(editor: HTMLElement) {
  const selection = window.getSelection();
  const first = editor.firstChild;
  if (!selection || !first) return;
  const range = document.createRange();
  range.setStart(first, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Replaces what the user wrote (e.g. with an AI draft) and keeps the signature
 * below it. HTML that brings its own signature (a saved draft) keeps that one.
 */
export function replaceBodyKeepingSignature(editor: HTMLElement, html: string): void {
  const block = editor.querySelector(SIGNATURE_SELECTOR);
  editor.innerHTML = html;
  if (block && !editor.querySelector(SIGNATURE_SELECTOR)) editor.appendChild(block);
}

/** The editor HTML without the signature block. */
export function stripSignatureHtml(html: string): string {
  if (!html.includes(SIGNATURE_ATTRIBUTE)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(SIGNATURE_SELECTOR).forEach((block) => block.remove());
  return doc.body.innerHTML;
}

/** The text the user wrote, signature left out. Empty means there is nothing to send or keep. */
export function userWrittenText(html: string): string {
  return htmlToPlainText(stripSignatureHtml(html));
}
