/**
 * WeldDesk knowledge and self-service on the platform: article suggestions in
 * the inbox composer, drafting an article from a conversation, an article's
 * language versions, and the announcements (status banners) admin.
 *
 * All of it is desk-api, reached through the app-api client.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DeskArticleSuggestions } from '@weldsuite/app-api-client/schemas/desk-knowledge';
import type { ArticleVersion } from '@weldsuite/core-api-client/schemas/articles';
import type {
  AnnouncementStatus,
  AnnouncementType,
  AnnouncementVisibility,
  CreateHelpdeskAnnouncementInput,
  UpdateHelpdeskAnnouncementInput,
} from '@weldsuite/core-api-client/schemas/helpdesk-announcements';

/** The article and announcement caches `use-helpdesk-queries` keeps, so a write here refreshes them too. */
const ARTICLES_KEY = ['helpdesk', 'articles'] as const;
const ANNOUNCEMENTS_KEY = ['helpdesk', 'announcements'] as const;

export const deskKnowledgeKeys = {
  suggestions: (conversationId: string, q: string) => ['desk-knowledge', 'suggestions', conversationId, q] as const,
  translations: (articleId: string) => [...ARTICLES_KEY, 'translations', articleId] as const,
  announcementList: (search: string) => [...ANNOUNCEMENTS_KEY, 'admin-list', search] as const,
  announcement: (id: string) => [...ANNOUNCEMENTS_KEY, 'admin-detail', id] as const,
};

// =============================================================================
// Inbox: suggestions and drafting an article
// =============================================================================

/** Articles for the composer: related to the conversation, or matching `q` when given. */
export function useDeskArticleSuggestions(conversationId: string, q: string, enabled: boolean) {
  const { getClient } = useAppApiClient();
  const query = q.trim();
  return useQuery({
    queryKey: deskKnowledgeKeys.suggestions(conversationId, query),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ limit: '8' });
      if (query) params.set('q', query);
      const res = await client.get<{ data: DeskArticleSuggestions }>(
        `/desk/conversations/${encodeURIComponent(conversationId)}/article-suggestions?${params.toString()}`,
      );
      return res.data;
    },
    enabled: enabled && !!conversationId,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** The draft article `POST …/draft-article` creates (a `helpdesk_articles` row). */
export interface DraftArticle {
  id: string;
  title: string;
  slug: string;
  status: string;
}

export function useCreateDraftArticle() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) => {
      const client = await getClient();
      const res = await client.post<{ data: DraftArticle }>(
        `/desk/conversations/${encodeURIComponent(conversationId)}/draft-article`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ARTICLES_KEY });
    },
  });
}

// =============================================================================
// Article language versions
// =============================================================================

/** The article's versions, the original first. `articleId` may be the original or a version. */
export function useArticleTranslations(articleId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKnowledgeKeys.translations(articleId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: ArticleVersion[] }>(`/articles/${encodeURIComponent(articleId)}/translations`);
      return res.data;
    },
    enabled: enabled && !!articleId && articleId !== 'new',
  });
}

export function useCreateArticleTranslation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ articleId, locale }: { articleId: string; locale: string }) => {
      const client = await getClient();
      const res = await client.post<{ data: { id: string } }>(
        `/articles/${encodeURIComponent(articleId)}/translations`,
        { locale },
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ARTICLES_KEY });
    },
  });
}

// =============================================================================
// Announcements (status banners)
// =============================================================================

/** A `helpdesk_announcements` row, as /api/helpdesk-announcements returns it. */
export interface DeskAnnouncement {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  content: string;
  excerpt: string | null;
  type: AnnouncementType | string;
  status: AnnouncementStatus | string;
  visibility: AnnouncementVisibility | string;
  targetGroups: string[] | null;
  featuredImage: string | null;
  authorId: string;
  authorName: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  isPinned: boolean | null;
  viewCount: number | null;
}

interface AnnouncementList {
  data: DeskAnnouncement[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

export function useDeskAnnouncements(search = '') {
  const { getClient } = useAppApiClient();
  const term = search.trim();
  return useQuery({
    queryKey: deskKnowledgeKeys.announcementList(term),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ limit: '100' });
      if (term) params.set('search', term);
      return client.get<AnnouncementList>(`/helpdesk-announcements?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });
}

export function useDeskAnnouncement(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKnowledgeKeys.announcement(id),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskAnnouncement }>(`/helpdesk-announcements/${encodeURIComponent(id)}`);
      return res.data;
    },
    enabled: enabled && !!id,
  });
}

export function useCreateDeskAnnouncement() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateHelpdeskAnnouncementInput) => {
      const client = await getClient();
      const res = await client.post<{ data: { id: string } }>('/helpdesk-announcements', data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ANNOUNCEMENTS_KEY });
    },
  });
}

export function useUpdateDeskAnnouncement() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateHelpdeskAnnouncementInput }) => {
      const client = await getClient();
      const res = await client.patch<{ data: { id: string } }>(`/helpdesk-announcements/${encodeURIComponent(id)}`, data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ANNOUNCEMENTS_KEY });
    },
  });
}

export function useDeleteDeskAnnouncement() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete(`/helpdesk-announcements/${encodeURIComponent(id)}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ANNOUNCEMENTS_KEY });
    },
  });
}
