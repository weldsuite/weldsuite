import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { File, FileImage, FileText, FileVideo, FileAudio, Paperclip } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  EntityList,
  type ActiveFilter,
  type FilterConfig,
} from '@/components/entity-list';
import type { ChatMessage, ChatAttachment } from '@/hooks/queries/use-weldchat-queries';

interface ChannelAttachmentsTabProps {
  channelId: string;
  messages: ChatMessage[];
}

type AttachmentItem = {
  id: string;
  messageId: string;
  channelId: string;
  fileName: string;
  mimeType?: string | null;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  size?: number | null;
  url?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  createdAt?: string | null;
};

function classify(mimeType?: string | null): AttachmentItem['kind'] {
  if (!mimeType) return 'other';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (
    mimeType.startsWith('text/') ||
    mimeType.includes('pdf') ||
    mimeType.includes('word') ||
    mimeType.includes('sheet') ||
    mimeType.includes('presentation') ||
    mimeType.includes('document')
  )
    return 'document';
  return 'other';
}

function iconFor(kind: AttachmentItem['kind']) {
  switch (kind) {
    case 'image': return FileImage;
    case 'video': return FileVideo;
    case 'audio': return FileAudio;
    case 'document': return FileText;
    default: return File;
  }
}

function formatBytes(bytes?: number | null): string | null {
  if (!bytes || !Number.isFinite(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function jumpToMessage(messageId: string) {
  let attempts = 0;
  const tick = () => {
    const el = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prevBg = el.style.backgroundColor;
      el.style.transition = 'background-color 0.3s';
      el.style.backgroundColor = 'rgba(59, 130, 246, 0.15)';
      setTimeout(() => {
        el.style.backgroundColor = prevBg;
      }, 2500);
      return;
    }
    if (attempts++ < 40) setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
}

function getKindLabels(
  t: (path: string) => string,
): Record<AttachmentItem['kind'], string> {
  return {
    image: t('sweep.entities.attachmentKindImages'),
    video: t('sweep.entities.attachmentKindVideos'),
    audio: t('sweep.entities.attachmentKindAudio'),
    document: t('sweep.entities.attachmentKindDocuments'),
    other: t('sweep.entities.attachmentKindOther'),
  };
}

export function ChannelAttachmentsTab({ channelId, messages }: ChannelAttachmentsTabProps) {
  const t = useTranslations();
  const navigate = useNavigate();
  const kindLabels = useMemo(() => getKindLabels(t), [t]);

  const rows: AttachmentItem[] = useMemo(() => {
    const out: AttachmentItem[] = [];
    for (const m of messages) {
      const list: ChatAttachment[] = m.attachments ?? [];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        out.push({
          id: a.id ?? `${m.id}-${i}`,
          messageId: m.id,
          channelId,
          fileName: a.fileName ?? a.name ?? t('sweep.entities.attachmentFallbackName'),
          mimeType: a.mimeType,
          kind: classify(a.mimeType),
          size: a.size ?? a.fileSize,
          url: a.url,
          authorId: m.authorId,
          authorName: m.authorName,
          createdAt: m.createdAt,
        });
      }
    }
    return out.sort(
      (a, b) =>
        new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
    );
  }, [messages, channelId, t]);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const filterConfigs: FilterConfig[] = useMemo(() => {
    const configs: FilterConfig[] = [];

    const kindsPresent = new Set(rows.map((r) => r.kind));
    if (kindsPresent.size > 0) {
      configs.push({
        field: 'kind',
        label: t('sweep.entities.fieldType'),
        options: (Object.keys(kindLabels) as AttachmentItem['kind'][])
          .filter((k) => kindsPresent.has(k))
          .map((k) => ({ value: k, label: kindLabels[k] })),
      });
    }

    const byAuthor = new Map<string, string>();
    for (const r of rows) {
      const key = r.authorId ?? r.authorName;
      const label = r.authorName ?? r.authorId;
      if (key && label && !byAuthor.has(key)) byAuthor.set(key, label);
    }
    if (byAuthor.size > 0) {
      configs.push({
        field: 'authorId',
        label: t('sweep.entities.sharedBy'),
        options: Array.from(byAuthor.entries()).map(([value, label]) => ({
          value,
          label,
        })),
      });
    }

    return configs;
  }, [rows, t, kindLabels]);

  const filteredItems = useMemo(() => {
    let items = rows;
    const kindFilter = activeFilters.find((f) => f.field === 'kind' && f.operator === 'is');
    if (kindFilter && typeof kindFilter.value === 'string') {
      items = items.filter((r) => r.kind === kindFilter.value);
    }
    const authorFilter = activeFilters.find(
      (f) => f.field === 'authorId' && f.operator === 'is',
    );
    if (authorFilter && typeof authorFilter.value === 'string') {
      items = items.filter(
        (r) => r.authorId === authorFilter.value || r.authorName === authorFilter.value,
      );
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (r) =>
          r.fileName.toLowerCase().includes(q) ||
          r.authorName?.toLowerCase().includes(q),
      );
    }
    return items;
  }, [rows, searchQuery, activeFilters]);

  const renderRow = useCallback(
    (r: AttachmentItem) => {
      const Icon = iconFor(r.kind);
      const sizeLabel = formatBytes(r.size);
      const handleOpen = () => {
        navigate({ to: '/weldchat/$channelId', params: { channelId: r.channelId } });
        jumpToMessage(r.messageId);
      };
      return (
        <div
          key={r.id}
          role="button"
          tabIndex={0}
          onClick={handleOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleOpen();
            }
          }}
          className="flex items-start gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border"
        >
          <div className="flex-1 min-w-0 flex items-start gap-3">
            <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden">
              {r.kind === 'image' && r.url ? (
                <img src={r.url} alt="" className="h-full w-full object-cover" />
              ) : (
                <Icon className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground truncate">{r.fileName}</div>
              <div className="text-[11px] text-muted-foreground truncate">
                {r.authorName}
                {sizeLabel ? ` · ${sizeLabel}` : ''}
              </div>
            </div>
          </div>
        </div>
      );
    },
    [navigate],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto relative">
        {filteredItems.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-muted-foreground pointer-events-none z-10">
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center mb-2">
              <Paperclip className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{t('sweep.entities.noAttachmentsYet')}</p>
            <p className="text-xs mt-1 text-center">
              {t('sweep.entities.noAttachmentsYetDescription')}
            </p>
          </div>
        )}
        <EntityList<AttachmentItem>
          items={filteredItems}
          isLoading={false}
          error={null}
          filters={filterConfigs}
          maxFilters={2}
          renderRow={renderRow}
          searchPlaceholder={t('sweep.entities.searchAttachmentsPlaceholder')}
          searchFields={['fileName', 'authorName'] as (keyof AttachmentItem)[]}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
        />
      </div>
    </div>
  );
}
