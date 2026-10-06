/**
 * Caption translation with the browser's built-in Translator API.
 *
 * The model runs on the viewer's device: no caption text leaves the browser,
 * nothing is metered, and the translation is private to whoever turned it on.
 * The API only exists in some browsers (desktop Chrome at the time of
 * writing), so everything here feature-detects and the UI says so when it is
 * missing.
 */
import { useEffect, useRef, useState } from 'react';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface TranslatorInstance {
  translate: (text: string) => Promise<string>;
}

interface DownloadMonitor {
  addEventListener: (type: 'downloadprogress', listener: (event: { loaded: number }) => void) => void;
}

interface TranslatorFactory {
  availability: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<Availability>;
  create: (options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: DownloadMonitor) => void;
  }) => Promise<TranslatorInstance>;
}

function translatorFactory(): TranslatorFactory | null {
  const factory = (globalThis as { Translator?: TranslatorFactory }).Translator;
  return factory && typeof factory.create === 'function' ? factory : null;
}

export function isTranslationSupported(): boolean {
  return translatorFactory() !== null;
}

/** Languages offered in the pickers (BCP 47). The browser decides which pairs work. */
export const TRANSLATION_LANGUAGES = [
  'en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'sv', 'da', 'no', 'fi',
  'cs', 'ro', 'hu', 'el', 'tr', 'uk', 'ru', 'ar', 'hi', 'id', 'ja', 'ko', 'zh',
] as const;

/** The language's name in the viewer's own language, e.g. `nl` → "Dutch". */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'language' }).of(code);
    if (name) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    /* fall through to the code */
  }
  return code;
}

// ─── Translators, one per language pair for the life of the page ─────────────

const translators = new Map<string, Promise<TranslatorInstance | null>>();
const downloadPercent = new Map<string, number>();
const downloadListeners = new Set<() => void>();

function pairKey(from: string, to: string): string {
  return `${from}>${to}`;
}

/**
 * Loads the translator for a language pair (null when the browser cannot
 * translate between the two). The first use of a pair downloads a language
 * pack, which the browser only allows right after a click, so call this from
 * the click handler that turns translation on or changes a language.
 */
export function prepareTranslation(from: string, to: string): Promise<TranslatorInstance | null> {
  const key = pairKey(from, to);
  const existing = translators.get(key);
  if (existing) return existing;

  const factory = translatorFactory();
  const created: Promise<TranslatorInstance | null> = (async () => {
    if (!factory) return null;
    if (from === to) return { translate: async (text: string) => text };
    const availability = await factory.availability({ sourceLanguage: from, targetLanguage: to });
    if (availability === 'unavailable') return null;
    return factory.create({
      sourceLanguage: from,
      targetLanguage: to,
      monitor: (monitor) => {
        monitor.addEventListener('downloadprogress', (event) => {
          downloadPercent.set(key, Math.round(event.loaded * 100));
          for (const listener of downloadListeners) listener();
        });
      },
    });
  })();
  translators.set(key, created);
  // A failed load (e.g. the download was refused) must be retryable.
  created.catch(() => translators.delete(key));
  return created;
}

export type TranslationStatus =
  | { phase: 'off' }
  | { phase: 'unsupported' }
  | { phase: 'preparing' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready' }
  | { phase: 'pair-unavailable' }
  | { phase: 'failed' };

export interface CaptionTranslation {
  status: TranslationStatus;
  /** The translated text for a caption, or the original until it is ready. */
  translate: (text: string) => string;
}

const MAX_CACHE_ENTRIES = 600;

/**
 * Translates caption text as it arrives. `texts` is whatever is on screen
 * right now; results are cached per source string. Partial captions change
 * several times a second, so one string is translated at a time (newest
 * first) and a fast talker cannot queue up stale work.
 */
export function useCaptionTranslation(options: {
  enabled: boolean;
  from: string;
  to: string;
  texts: string[];
}): CaptionTranslation {
  const { enabled, from, to, texts } = options;
  const key = pairKey(from, to);
  const [status, setStatus] = useState<TranslationStatus>({ phase: 'off' });
  const [translator, setTranslator] = useState<{ key: string; instance: TranslatorInstance } | null>(null);
  const [tick, setTick] = useState(0);
  const cacheRef = useRef<{ key: string; entries: Map<string, string> }>({ key, entries: new Map() });
  const busyRef = useRef(false);

  // Load the translator for the chosen pair and report how that goes.
  useEffect(() => {
    if (!enabled) {
      setStatus({ phase: 'off' });
      return;
    }
    if (!isTranslationSupported()) {
      setStatus({ phase: 'unsupported' });
      return;
    }
    let cancelled = false;
    const reportDownload = () => {
      const percent = downloadPercent.get(key);
      if (!cancelled && percent !== undefined && percent < 100) setStatus({ phase: 'downloading', percent });
    };
    setStatus({ phase: 'preparing' });
    downloadListeners.add(reportDownload);
    prepareTranslation(from, to)
      .then((instance) => {
        if (cancelled) return;
        if (!instance) {
          setStatus({ phase: 'pair-unavailable' });
          return;
        }
        setTranslator({ key, instance });
        setStatus({ phase: 'ready' });
      })
      .catch((err: unknown) => {
        console.error('[WeldMeet] caption translation could not start:', err);
        if (!cancelled) setStatus({ phase: 'failed' });
      });
    return () => {
      cancelled = true;
      downloadListeners.delete(reportDownload);
    };
  }, [enabled, from, to, key]);

  const active = enabled && translator?.key === key ? translator.instance : null;
  const textsKey = texts.join('\u0001');

  useEffect(() => {
    if (!active || busyRef.current) return;
    if (cacheRef.current.key !== key) cacheRef.current = { key, entries: new Map() };
    const cache = cacheRef.current;
    const pending = textsKey.split('\u0001').filter((text) => text.trim() && !cache.entries.has(text));
    const text = pending[pending.length - 1];
    if (!text) return;

    busyRef.current = true;
    active
      .translate(text)
      .then((translated) => {
        if (cache.entries.size >= MAX_CACHE_ENTRIES) cache.entries.clear();
        cache.entries.set(text, translated);
      })
      .catch((err: unknown) => {
        console.error('[WeldMeet] caption translation failed:', err);
        // Keep the original for this string so it is not retried in a loop.
        cache.entries.set(text, text);
      })
      .finally(() => {
        busyRef.current = false;
        // Show the result and pick up whatever arrived in the meantime.
        setTick((value) => value + 1);
      });
  }, [active, key, textsKey, tick]);

  const translate = (text: string): string => {
    if (!active || cacheRef.current.key !== key) return text;
    return cacheRef.current.entries.get(text) ?? text;
  };
  return { status, translate };
}
