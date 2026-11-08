/**
 * Self-service in the messenger: articles that may answer the visitor's
 * question before they send it (deflection), and the team's announcements.
 *
 * Both are reads anyone may make; the visitor token goes along only when the
 * session already holds one (never opened just for this), so a known visitor
 * also sees what is meant for signed-in readers or their company.
 */

import { useEffect, useRef, useState } from 'react';
import type { DeskPublicAnnouncement, DeskPublicArticleHit } from '@weldsuite/app-api-client/schemas/desk-knowledge';
import { widgetApi } from '@/lib/api/client';
import { locale } from '@/lib/i18n';
import { getVisitorSession } from '@/lib/visitor-session';

const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_MIN_LENGTH = 3;
const SEARCH_MAX_LENGTH = 200;
const SEARCH_LIMIT = 3;

const currentToken = (widgetId: string) => getVisitorSession(widgetId).currentToken();

/**
 * Up to three articles for what the visitor is typing, debounced; the latest
 * answer wins and an earlier request in flight is aborted. Empty while
 * `enabled` is off or the text is too short.
 */
export function useArticleSuggestions(widgetId: string, text: string, enabled: boolean): DeskPublicArticleHit[] {
  const [hits, setHits] = useState<DeskPublicArticleHit[]>([]);
  const query = enabled ? text.trim().slice(0, SEARCH_MAX_LENGTH) : '';

  useEffect(() => {
    if (query.length < SEARCH_MIN_LENGTH) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      widgetApi
        .searchArticles(widgetId, { q: query, locale, limit: SEARCH_LIMIT }, currentToken(widgetId), controller.signal)
        .then((found) => {
          if (!controller.signal.aborted) setHits(Array.isArray(found) ? found.slice(0, SEARCH_LIMIT) : []);
        })
        .catch(() => {
          // No suggestions is fine: the visitor can still send the message.
          if (!controller.signal.aborted) setHits([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [widgetId, query]);

  return hits;
}

/** Wait this long after a visitor change before asking, so opening the session doesn't ask twice. */
const ANNOUNCEMENTS_SETTLE_MS = 250;

/**
 * The announcements this visitor may see, fetched again when the visitor
 * changes (the session opens, or the site signs someone in or out). A failed
 * read shows no banners.
 */
export function useAnnouncements(widgetId: string, visitorId: string | null): DeskPublicAnnouncement[] {
  const [announcements, setAnnouncements] = useState<DeskPublicAnnouncement[]>([]);
  const latest = useRef(0);

  useEffect(() => {
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      widgetApi
        .listAnnouncements(widgetId, currentToken(widgetId))
        .then((found) => {
          if (ticket === latest.current) setAnnouncements(Array.isArray(found) ? found : []);
        })
        .catch(() => {
          if (ticket === latest.current) setAnnouncements([]);
        });
    }, ANNOUNCEMENTS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [widgetId, visitorId]);

  return announcements;
}
