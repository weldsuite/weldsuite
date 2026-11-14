/**
 * The recording plugin: rrweb's `record()` (MIT), masked per the project's
 * masking level, cut into chunks and sent gzipped to `POST {collector}/r`.
 *
 * Built on its own as `dist/panel-recorder.global.js`, which the collector
 * serves as `/rec.js` and the core loads only for a consented, sampled
 * session on a page that isn't excluded. Apps that bundle the SDK can import
 * {@link createRecorder} from `@weldsuite/panel-sdk/recorder` and pass it to
 * `init()` instead.
 *
 * - A chunk is sent every 10 seconds, at about 64 KB of events, when the tab
 *   is hidden and on page hide. A full snapshot always starts a new chunk
 *   (`f=1`).
 * - Only a visible tab records: hidden, it sends what it has and stops; shown
 *   again, it starts over with a full snapshot. Two tabs of one session then
 *   don't interleave, and chunk numbers stay in order (they are counted per
 *   session in localStorage, across the session's pages and tabs).
 * - After 30 minutes without input the recording pauses; the core starts it
 *   again with the visitor's next event (a new session by then).
 * - Never recorded: password fields, canvas, video and audio, cross-origin
 *   iframes, anything inside `data-panel-block`.
 */

import { record } from '@rrweb/record';
import type { eventWithTime, recordOptions } from 'rrweb';
import type { PanelRecorder, RecorderOptions } from './recorder-api';
import { nextSeq, SESSION_TIMEOUT_MS } from './storage';
import { MAX_BLOB_BYTES, MAX_SEQ, type ClientConfig } from './wire';

export type { PanelRecorder, RecorderFactory, RecorderOptions } from './recorder-api';

/** Send a chunk at least this often while events come in… */
export const CHUNK_MS = 10000;
/** …or once this many characters of events are waiting. */
export const CHUNK_CHARS = 64 * 1024;
/**
 * Browsers cap the bodies of `keepalive` requests in flight at 64 KiB per
 * page (the event batches share it), so larger chunks go without.
 */
export const KEEPALIVE_BYTES = 48 * 1024;

/** rrweb event types. */
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
/** rrweb incremental sources that are the visitor doing something: mouse move, mouse interaction, scroll, input, touch. */
const INPUT_SOURCES = [1, 2, 3, 5, 6];

const BLOCK = '[data-panel-block]';
const MASK = '[data-panel-mask]';
const UNMASK = '[data-panel-unmask]';

/** Inside `data-panel-unmask`, and not inside a `data-panel-mask` within it. */
function unmasked(el: Element): boolean {
  const u = el.closest(UNMASK);
  const m = el.closest(MASK);
  return !!u && (!m || (m !== u && m.contains(u)));
}

/** Whether an input's value may be recorded at this level. Passwords never are. */
export function inputVisible(el: Element | null, level: ClientConfig['maskingLevel']): boolean {
  if (!el || (el as HTMLInputElement).type === 'password' || el.hasAttribute('data-rr-is-password')) return false;
  if (level !== 'relaxed') return unmasked(el);
  // Relaxed: fields marked sensitive, and card fields, still are masked.
  return (!el.closest(MASK) || unmasked(el)) && !/^cc-/.test(el.getAttribute('autocomplete') || '');
}

const stars = (text: string): string => text.replace(/\S/g, '*');

/**
 * rrweb's options for a masking level:
 * - strict: all text and every input masked, images blocked;
 * - balanced: every input masked, page text visible;
 * - relaxed: only passwords and fields marked sensitive masked.
 * `data-panel-mask` masks text and inputs inside it, `data-panel-unmask`
 * shows them (never a password), `data-panel-block` leaves the element out
 * (an empty box of the same size).
 */
export function recordingOptions(level: ClientConfig['maskingLevel']): recordOptions<eventWithTime> {
  const strict = level !== 'balanced' && level !== 'relaxed';
  return {
    blockSelector: `${BLOCK},video,audio${strict ? ',img,picture,image' : ''}`,
    maskTextSelector: strict ? '*' : MASK,
    maskTextFn: (text, el) => (el && unmasked(el) ? text : stars(text)),
    maskAllInputs: true,
    maskInputFn: (text, el) => (inputVisible(el, strict ? 'strict' : level) ? text : '*'.repeat(text.length)),
    recordCanvas: false,
    recordCrossOriginIframes: false,
    collectFonts: false,
    inlineImages: false,
    slimDOMOptions: true,
    sampling: { scroll: 150, media: 800, input: 'last' },
  };
}

/** Gzip with the browser's CompressionStream. */
export async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  writer.write(new TextEncoder().encode(text)).catch(() => undefined);
  writer.close().catch(() => undefined);
  return new Response(stream.readable).arrayBuffer();
}

interface Item {
  /** The event's JSON. */
  j: string;
  /** Its time. */
  t: number;
  /** A full snapshot. */
  f: boolean;
}

export function createRecorder(options: RecorderOptions): PanelRecorder {
  const { host, token } = options;
  const warn = (...args: unknown[]): void => {
    if (options.debug) console.warn('[weldpanel]', ...args);
  };
  const rrwebOptions = recordingOptions(options.maskingLevel);
  const q = encodeURIComponent;

  /** The session being recorded; null once the core stops the recording. */
  let session: string | null = null;
  /** rrweb's stop function while it runs. */
  let stopRrweb: (() => void) | undefined;
  let buffer: Item[] = [];
  let chars = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastInput = 0;
  /** Chunks go out one after the other, so their numbers follow the events' order. */
  let sending: Promise<void> = Promise.resolve();
  /** Set while {@link snapshot} waits for a full snapshot. */
  let onFullSnapshot: ((e: eventWithTime) => void) | null = null;
  /** This page can't be recorded (a full snapshot too big to send, or the session's chunk numbers ran out). */
  let broken = false;

  function send(url: string, body: ArrayBuffer): Promise<void> {
    const init = (keepalive: boolean): RequestInit => ({
      method: 'POST',
      body,
      keepalive,
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain' },
    });
    const small = body.byteLength <= KEEPALIVE_BYTES;
    return fetch(url, init(small)).then(
      () => undefined,
      // keepalive's quota may be used up by other requests: one more go without it.
      () => (small ? fetch(url, init(false)).then(() => undefined, () => warn('recording chunk not sent')) : warn('recording chunk not sent')),
    );
  }

  /** Compress and send `items` as one chunk, halving it while it is over the size limit. */
  async function upload(sessionId: string, items: Item[]): Promise<void> {
    const body = await gzip(`[${items.map((i) => i.j).join(',')}]`);
    if (body.byteLength > MAX_BLOB_BYTES) {
      if (items.length > 1) {
        const half = items.length >> 1;
        await upload(sessionId, items.slice(0, half));
        return upload(sessionId, items.slice(half));
      }
      warn('recording event too large to send');
      // Without its full snapshot the rest of this page's recording can't be replayed.
      if (items[0].f) halt();
      return;
    }
    const seq = nextSeq(token, sessionId);
    if (seq > MAX_SEQ) return halt();
    const full = items.some((i) => i.f) ? 1 : 0;
    const url = `${host}/r?t=${q(token)}&s=${q(sessionId)}&q=${seq}&a=${items[0].t}&b=${items[items.length - 1].t}&f=${full}`;
    return send(url, body);
  }

  /** Send what is buffered. */
  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    const items = buffer;
    const sessionId = session;
    buffer = [];
    chars = 0;
    if (!items.length || !sessionId) return;
    sending = sending.then(() => upload(sessionId, items)).catch((err) => warn(err));
  }

  function emit(e: eventWithTime): void {
    if (onFullSnapshot && e.type === FULL_SNAPSHOT) onFullSnapshot(e);
    // A snapshot-only run of rrweb (see snapshot()) records nothing.
    if (!stopRrweb || !session) return;
    // Meta comes right before a full snapshot: start a new chunk with them.
    if (e.type === META && buffer.length) flush();
    const j = JSON.stringify(e);
    buffer.push({ j, t: e.timestamp, f: e.type === FULL_SNAPSHOT });
    chars += j.length;
    if (e.type === INCREMENTAL && INPUT_SOURCES.indexOf((e.data as { source: number }).source) >= 0) lastInput = e.timestamp;
    if (e.timestamp - lastInput > SESSION_TIMEOUT_MS) pause();
    else if (chars >= CHUNK_CHARS) flush();
    else if (!timer) timer = setTimeout(flush, CHUNK_MS);
  }

  function begin(): void {
    if (stopRrweb || !session || broken || document.visibilityState === 'hidden') return;
    lastInput = Date.now();
    // The handle is set before rrweb runs: it emits the full snapshot synchronously.
    stopRrweb = () => undefined;
    try {
      stopRrweb = record({ ...rrwebOptions, emit }) || undefined;
    } catch (err) {
      stopRrweb = undefined;
      warn(err);
    }
  }

  /** Stop rrweb and send what it recorded; {@link begin} starts it again. */
  function pause(): void {
    const stop = stopRrweb;
    stopRrweb = undefined;
    if (stop) {
      try {
        stop();
      } catch (err) {
        warn(err);
      }
    }
    flush();
  }

  function halt(): void {
    broken = true;
    pause();
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') pause();
    else begin();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', pause);

  return {
    start(sessionId) {
      if (session !== sessionId) {
        // The old session's chunks leave under its id; the new one starts with a full snapshot.
        pause();
        session = sessionId;
        broken = false;
      }
      begin();
    },
    stop() {
      pause();
      session = null;
    },
    snapshot(pageGroupId, deviceClass) {
      let full: eventWithTime | null = null;
      onFullSnapshot = (e) => {
        full = e;
      };
      try {
        if (stopRrweb) {
          // Recording already: rrweb takes one more, which the recording keeps too.
          record.takeFullSnapshot();
        } else {
          const stop = record({ ...rrwebOptions, emit });
          if (stop) stop();
        }
      } catch (err) {
        warn(err);
      } finally {
        onFullSnapshot = null;
      }
      const event: eventWithTime | null = full;
      if (!event) return Promise.resolve();
      return gzip(JSON.stringify(event)).then((body) =>
        body.byteLength > MAX_BLOB_BYTES
          ? warn('snapshot too large to send')
          : send(`${host}/snap?t=${q(token)}&g=${q(pageGroupId)}&d=${deviceClass}`, body),
      );
    },
  };
}
