import type { AnswerError, FieldBlock, FormChoice } from '@weldsuite/forms-engine';
import type { FormRendererLabels } from './types';

/** `{name}` placeholders replaced; an unknown placeholder stays as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/** cyrb128-ish string hash to a 32-bit seed. */
function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffle that is the same for the same seed (stable per session, so a re-render never reorders). */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const rand = mulberry32(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/** The choices in display order: stable shuffle when `randomize`, A-Z when `alphabetical`. */
export function orderedChoices(
  choices: FormChoice[],
  options: { randomize?: boolean; alphabetical?: boolean },
  seed: string,
): FormChoice[] {
  if (options.randomize) return seededShuffle(choices, seed);
  if (options.alphabetical) return [...choices].sort((a, b) => a.label.localeCompare(b.label));
  return choices;
}

/** A, B, C … Z, then AA, AB …: the key hint next to a choice. */
export function choiceLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Whether a keyboard event comes from something the user types in. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** The message for an answer error, with the limits of the field filled in. */
export function errorMessage(labels: FormRendererLabels, error: AnswerError, field: FieldBlock): string {
  const template = labels.errors[error.code] ?? labels.errors.invalid;
  const values: Record<string, string | number> = {};
  const p = field.properties as Record<string, unknown>;
  const num = (v: unknown): string | number | undefined => (typeof v === 'number' || typeof v === 'string' ? v : undefined);
  switch (error.code) {
    case 'too_long':
      values.max = num(p.maxLength) ?? '';
      break;
    case 'too_small':
      values.min = num(p.min) ?? '';
      break;
    case 'too_large':
      values.max = num(p.max) ?? '';
      break;
    case 'too_few_choices':
      values.min = num(p.minSelections) ?? '';
      break;
    case 'too_many_choices':
      values.max = field.type === 'dropdown' || p.multiple !== true ? 1 : (num(p.maxSelections) ?? '');
      break;
    case 'too_many_files':
      values.max = num(p.maxFiles) ?? '';
      break;
    case 'date_too_early':
      values.min = num(p.min) ?? '';
      break;
    case 'date_too_late':
      values.max = num(p.max) ?? '';
      break;
    case 'too_many_decimals':
      values.decimals = num(p.decimals) ?? '';
      break;
    default:
      break;
  }
  return fill(template, values);
}

/** A YouTube or Vimeo link as an embeddable URL; null for anything else. */
export function videoEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = u.searchParams.get('v') ?? (u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : null);
      return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : null;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1);
      return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : null;
    }
    if (host === 'vimeo.com') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** The accept attribute of a file input for the field's `accept` setting. */
export function acceptAttribute(accept: 'any' | 'images' | 'documents' | 'pdf'): string | undefined {
  switch (accept) {
    case 'images':
      return 'image/*';
    case 'pdf':
      return 'application/pdf,.pdf';
    case 'documents':
      return '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.txt,.csv,.rtf';
    default:
      return undefined;
  }
}

/** Whether a file matches the field's `accept` setting (the input's accept is only a hint). */
export function fileMatchesAccept(file: File, accept: 'any' | 'images' | 'documents' | 'pdf'): boolean {
  if (accept === 'any') return true;
  const name = file.name.toLowerCase();
  if (accept === 'images') return file.type.startsWith('image/');
  if (accept === 'pdf') return file.type === 'application/pdf' || name.endsWith('.pdf');
  return /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|txt|csv|rtf)$/.test(name);
}

/** Only web links (and mail / phone) may be put in an href: an author-controlled `javascript:` URL must never run. */
export function isSafeHref(url: string): boolean {
  try {
    const protocol = new URL(url, 'https://placeholder.invalid').protocol;
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:' || protocol === 'tel:';
  } catch {
    return false;
  }
}
