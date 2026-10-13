/**
 * Modified UTF-7 mailbox names (RFC 3501 section 5.1.3).
 *
 * Printable ASCII (0x20-0x7e) stands for itself, "&" is written "&-", and any
 * run of other characters is its UTF-16BE bytes in base64 (with "," in place of
 * "/" and no padding) between "&" and "-". Mailbox names travel over the wire
 * in this form; the rest of the package works with the decoded names.
 */

const AMPERSAND = 0x26;

/** Encodes a mailbox name for the wire. The result is printable ASCII. */
export function encodeMailboxName(name: string): string {
  let out = '';
  let runStart = -1;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart !== -1) {
      out += encodeRun(name.slice(runStart, i));
      runStart = -1;
    }
    out += code === AMPERSAND ? '&-' : name[i];
  }
  if (runStart !== -1) out += encodeRun(name.slice(runStart));
  return out;
}

/**
 * Decodes a mailbox name from the wire. Lenient: a "&..." sequence that is not
 * valid modified UTF-7 is kept as received, so a server's odd name never turns
 * into an exception.
 */
export function decodeMailboxName(encoded: string): string {
  let out = '';
  let pos = 0;
  while (pos < encoded.length) {
    const amp = encoded.indexOf('&', pos);
    if (amp === -1) {
      out += encoded.slice(pos);
      break;
    }
    out += encoded.slice(pos, amp);
    const end = encoded.indexOf('-', amp + 1);
    if (end === -1) {
      out += encoded.slice(amp);
      break;
    }
    out += decodeSequence(encoded.slice(amp + 1, end)) ?? encoded.slice(amp, end + 1);
    pos = end + 1;
  }
  return out;
}

/** UTF-16BE bytes of `text` as modified base64, wrapped in "&" and "-". */
function encodeRun(text: string): string {
  let binary = '';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    binary += String.fromCharCode(unit >> 8, unit & 0xff);
  }
  const base64 = btoa(binary);
  let end = base64.length;
  while (end > 0 && base64[end - 1] === '=') end -= 1;
  return `&${base64.slice(0, end).replaceAll('/', ',')}-`;
}

const BASE64_BODY = /^[A-Za-z0-9+,]+$/;

/** The text between "&" and "-": "" is a literal ampersand, otherwise base64; null when malformed. */
function decodeSequence(body: string): string | null {
  if (body === '') return '&';
  if (!BASE64_BODY.test(body)) return null;

  const standard = body.replaceAll(',', '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  if (binary.length % 2 !== 0) return null;

  let text = '';
  for (let i = 0; i < binary.length; i += 2) {
    text += String.fromCharCode((binary.charCodeAt(i) << 8) | binary.charCodeAt(i + 1));
  }
  return text;
}
