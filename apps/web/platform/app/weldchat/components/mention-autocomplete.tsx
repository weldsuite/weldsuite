/**
 * Federated mention picker for the WeldChat composer.
 *
 * Two stacked sections, single keyboard model (Arrow keys walk both,
 * Enter selects, Escape dismisses):
 *  1. People  — workspace members + channel-agent members (existing)
 *  2. Records — federated search across all 13 entity types (NEW)
 *
 * Records section is gated on `query.length >= 2` to avoid noise when
 * the user has just typed `@`.
 *
 * `onSelect` receives a tagged union — the composer (`message-input.tsx`)
 * branches on `kind` to insert the right inline token shape.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Bot, Loader2 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  useWorkspaceMembers,
  useChannelMembers,
  useChannel,
} from '@/hooks/queries/use-weldchat-queries';
import { useGlobalSearch } from '@/hooks/queries/use-global-search-queries';
import { RESULT_TYPE_ICON, RESULT_TYPE_LABEL } from '@/lib/search/result-types';
import type { EntitySheetType } from '@/components/entity-sheet/types';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';

export type MentionSelection =
  | { kind: 'user'; userId: string; name: string }
  | { kind: 'entity'; type: EntitySheetType; id: string; title: string }
  | { kind: 'everyone' };

interface MentionAutocompleteProps {
  query: string;
  channelId?: string;
  onSelect: (selection: MentionSelection) => void;
  onDismiss?: () => void;
}

type PersonItem = {
  kind: 'user';
  userId: string;
  name: string;
  picture?: string | null;
  email?: string | null;
  isAgent?: boolean;
  agentIcon?: string | null;
};

type EntityItem = {
  kind: 'entity';
  type: EntitySheetType;
  id: string;
  title: string;
  subtitle?: string | null;
};

type EveryoneItem = { kind: 'everyone' };

type FlatItem = PersonItem | EntityItem | EveryoneItem;

const PEOPLE_LIMIT = 5;
const ENTITY_QUERY_MIN = 2;
const ENTITY_PER_GROUP_LIMIT = 4;

export function MentionAutocomplete({
  query,
  channelId,
  onSelect,
  onDismiss,
}: MentionAutocompleteProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const { data: membersData } = useWorkspaceMembers();
  const { data: channelMembersData } = useChannelMembers(channelId || '');
  const { data: channelData } = useChannel(channelId || '');
  const members = membersData?.data ?? [];
  const channelMembers = channelMembersData?.data ?? [];
  const channelType: string | undefined = channelData?.data?.type;
  const ref = useRef<HTMLDivElement>(null);

  // Trim/normalize query for use both on people-side filtering and as the
  // federated-search input.
  const trimmed = query.trim();
  const showRecords = trimmed.length >= ENTITY_QUERY_MIN;

  // @everyone is available in any non-DM channel. Match on empty query or on
  // a prefix of "everyone" so `@<enter>` and `@e<enter>` both fire it, but
  // committing to a more specific name like `@al` hides it.
  const showEveryone =
    !!channelId &&
    !!channelType &&
    channelType !== 'dm' &&
    (trimmed === '' || 'everyone'.startsWith(trimmed.toLowerCase()));

  const { data: searchData, isFetching: isSearching } = useGlobalSearch(
    showRecords ? trimmed : '',
    { limit: ENTITY_PER_GROUP_LIMIT, enabled: showRecords },
  );

  // -- People section ------------------------------------------------------
  const agentSuggestions: PersonItem[] = useMemo(
    () =>
      channelMembers
        .filter((m: { memberType?: string }) => m.memberType === 'agent')
        .map(
          (m: { userId?: string; name?: string; agentIcon?: string | null }): PersonItem => ({
            kind: 'user' as const,
            userId: m.userId ?? '',
            name: m.name || t.weldchat.mentionAutocomplete.agent,
            isAgent: true,
            agentIcon: m.agentIcon ?? null,
          }),
        )
        .filter((m: PersonItem) => !!m.userId),
    [channelMembers],
  );

  const userSuggestions: PersonItem[] = useMemo(
    () =>
      members.map((m: { userId?: string; name?: string; picture?: string; email?: string }) => ({
        kind: 'user' as const,
        userId: m.userId ?? '',
        name: m.name ?? '',
        picture: m.picture,
        email: m.email,
      })),
    [members],
  );

  const filteredPeople = useMemo(() => {
    const all: PersonItem[] = [...agentSuggestions, ...userSuggestions];
    if (!trimmed) return all.slice(0, 8);
    const q = trimmed.toLowerCase();
    return all
      .filter((s) => s.name.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q))
      .slice(0, PEOPLE_LIMIT);
  }, [agentSuggestions, userSuggestions, trimmed]);

  // -- Records section -----------------------------------------------------
  const groups = searchData?.data ?? [];
  const entityGroups = useMemo(
    () =>
      groups
        .map((g) => ({
          type: g.type as EntitySheetType,
          items: g.items.map<EntityItem>((it) => ({
            kind: 'entity' as const,
            type: g.type as EntitySheetType,
            id: it.id,
            title: it.title,
            subtitle: it.subtitle ?? null,
          })),
        }))
        .filter((g) => g.items.length > 0),
    [groups],
  );

  // -- Flat list for keyboard nav -----------------------------------------
  const flatItems: FlatItem[] = useMemo(() => {
    const out: FlatItem[] = [];
    if (showEveryone) out.push({ kind: 'everyone' });
    out.push(...filteredPeople);
    for (const g of entityGroups) out.push(...g.items);
    return out;
  }, [showEveryone, filteredPeople, entityGroups]);

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed, flatItems.length]);

  // -- Keyboard --------------------------------------------------------------
  useEffect(() => {
    if (!onDismiss && flatItems.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss?.();
        return;
      }
      if (flatItems.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % flatItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + flatItems.length) % flatItems.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const item = flatItems[activeIndex];
        if (!item) return;
        e.preventDefault();
        if (item.kind === 'user') {
          onSelect({ kind: 'user', userId: item.userId, name: item.name });
        } else if (item.kind === 'entity') {
          onSelect({ kind: 'entity', type: item.type, id: item.id, title: item.title });
        } else {
          onSelect({ kind: 'everyone' });
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [flatItems, activeIndex, onSelect, onDismiss]);

  // -- Click outside to dismiss --------------------------------------------
  useEffect(() => {
    if (!onDismiss) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onDismiss]);

  const hasAnything =
    showEveryone || filteredPeople.length > 0 || entityGroups.length > 0 || isSearching;
  if (!hasAnything) return null;

  let runningIndex = 0;
  const everyoneIndex = showEveryone ? runningIndex++ : -1;
  const peopleStart = runningIndex;
  runningIndex += filteredPeople.length;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-lg shadow-lg max-h-72 overflow-y-auto z-50"
    >
      {(showEveryone || filteredPeople.length > 0) && (
        <div>
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {st('sweep.weldchat.mentionAutocomplete.people')}
          </div>
          {showEveryone && (
            <Button
              key="everyone"
              type="button"
              variant="ghost"
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left ${
                everyoneIndex === activeIndex ? 'bg-muted' : 'hover:bg-muted'
              }`}
              onMouseEnter={() => setActiveIndex(everyoneIndex)}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect({ kind: 'everyone' });
              }}
            >
              <div className="h-5 w-5 rounded-[7px] bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                <AtSign className="h-3 w-3" />
              </div>
              <span className="font-medium">@everyone</span>
              <span className="text-muted-foreground text-xs truncate">
                {st('sweep.weldchat.mentionAutocomplete.notifyEveryone')}
              </span>
            </Button>
          )}
          {filteredPeople.map((s, i) => {
            const idx = peopleStart + i;
            const active = idx === activeIndex;
            return (
              <Button
                key={`p-${s.userId}`}
                type="button"
                variant="ghost"
                className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left ${
                  active ? 'bg-muted' : 'hover:bg-muted'
                }`}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect({ kind: 'user', userId: s.userId, name: s.name });
                }}
              >
                {s.isAgent ? (
                  <div className="h-5 w-5 rounded-[7px] bg-muted flex items-center justify-center text-[11px]">
                    {s.agentIcon || <Bot className="h-3 w-3 text-muted-foreground" />}
                  </div>
                ) : (
                  <Avatar className="h-5 w-5 rounded-[7px]">
                    {s.picture && <AvatarImage src={s.picture} className="rounded-[7px]" />}
                    <AvatarFallback className="text-[10px] rounded-[7px]">
                      {(s.name || '?')[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                )}
                <span className="font-medium truncate">{s.name}</span>
                {s.isAgent ? (
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
                    {t.weldchat.mentionAutocomplete.agent}
                  </span>
                ) : s.email ? (
                  <span className="text-muted-foreground text-xs truncate">{s.email}</span>
                ) : null}
              </Button>
            );
          })}
        </div>
      )}

      {showRecords && (
        <div>
          {entityGroups.map((group) => {
            const Icon = RESULT_TYPE_ICON[group.type];
            const heading = RESULT_TYPE_LABEL[group.type] ?? group.type;
            const groupStart = runningIndex;
            runningIndex += group.items.length;

            return (
              <div key={group.type}>
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {heading}
                </div>
                {group.items.map((item, i) => {
                  const idx = groupStart + i;
                  const active = idx === activeIndex;
                  return (
                    <Button
                      key={`e-${item.type}-${item.id}`}
                      type="button"
                      variant="ghost"
                      className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left ${
                        active ? 'bg-muted' : 'hover:bg-muted'
                      }`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onSelect({
                          kind: 'entity',
                          type: item.type,
                          id: item.id,
                          title: item.title,
                        });
                      }}
                    >
                      {Icon ? (
                        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <div className="h-4 w-4" />
                      )}
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="font-medium truncate">{item.title}</span>
                        {item.subtitle && (
                          <span className="text-xs text-muted-foreground truncate">
                            {item.subtitle}
                          </span>
                        )}
                      </div>
                    </Button>
                  );
                })}
              </div>
            );
          })}

          {isSearching && entityGroups.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {st('sweep.weldchat.mentionAutocomplete.searchingRecords')}
            </div>
          )}

          {!isSearching && entityGroups.length === 0 && filteredPeople.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">{st('sweep.weldchat.mentionAutocomplete.noMatches')}</div>
          )}
        </div>
      )}
    </div>
  );
}
