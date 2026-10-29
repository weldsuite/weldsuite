/**
 * Federated mention picker for the WeldChat composer.
 *
 * Stacked sections, single keyboard model (Arrow keys walk all of them,
 * Enter selects, Escape dismisses):
 *  0. @everyone — a headerless first row, in any channel that is not a DM
 *  1. Agents  — agent members of the channel, then agents the viewer may bring
 *               in (picking one adds it to the channel first, so it answers the
 *               mention). Listed before people: a chat has few of them, and
 *               below eight people they would be scrolled out of sight.
 *  2. People  — workspace members
 *  3. Records — federated search across every record type (spreadsheets included)
 *
 * Records are gated on `query.length >= 2` to avoid noise when the user has
 * just typed `@`.
 *
 * `onSelect` receives a tagged union — the composer (`message-input.tsx`)
 * branches on `kind` to insert the right inline token shape.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useCan } from '@weldsuite/permissions/react';
import { useCanInviteAgents, useInvitableAgents, useInviteAgent } from './invite-agent-picker';

export type MentionSelection =
  | { kind: 'user'; userId: string; name: string }
  | { kind: 'entity'; type: EntitySheetType; id: string; title: string }
  | { kind: 'everyone' };

interface MentionAutocompleteProps {
  query: string;
  channelId?: string;
  /**
   * No channel yet (a record chat's first message): offer every agent the
   * viewer can use, and insert its mention directly; the message brings it in.
   */
  agentsJoinOnSend?: boolean;
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
  /** An agent the viewer may use that is not in the channel yet. */
  notInChannel?: boolean;
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
/** Agents outside the channel shown before anything is typed. */
const INVITABLE_AGENTS_IDLE_LIMIT = 3;

// Overrides the Button base (justify-center, h-9, rounded-md, font-medium) so
// rows read as a left-aligned list instead of centered buttons.
const ROW_CLASS =
  'flex items-center justify-start gap-2 w-full h-auto px-3 py-2 rounded-none text-sm font-normal text-left';
const SECTION_HEADING_CLASS =
  'px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground';
const ENTITY_QUERY_MIN = 2;
const ENTITY_PER_GROUP_LIMIT = 4;
/** How long after the list changes a click is held back (see `pickWithPointer`). */
const LIST_SETTLE_MS = 300;
/** The popup never grows taller than this, however much room there is. */
const POPUP_MAX_HEIGHT = 288;
/** ...nor shrinks below this, even where the composer sits in a short, clipped region. */
const POPUP_MIN_HEIGHT = 96;
/** Space the composer's popup wrapper keeps between itself and the composer, plus its border. */
const POPUP_OFFSET = 28;

/** A stable identity for a row, to tell "the same row" across list changes. */
function rowKey(item: FlatItem): string {
  if (item.kind === 'everyone') return 'everyone';
  if (item.kind === 'user') return `p-${item.userId}`;
  return `e-${item.type}-${item.id}`;
}

/**
 * Room above the composer inside whatever clips it. The popup opens upward, so
 * in a short region (a record panel's chat, a thread) its top rows would sit
 * behind the clip edge, and the agents, listed first, would be the ones cut off.
 */
function spaceAboveComposer(composer: Element): number {
  const top = composer.getBoundingClientRect().top;
  let node = composer.parentElement;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY && overflowY !== 'visible') return top - node.getBoundingClientRect().top;
    node = node.parentElement;
  }
  return top;
}

export function MentionAutocomplete({
  query,
  channelId,
  agentsJoinOnSend = false,
  onSelect,
  onDismiss,
}: Readonly<MentionAutocompleteProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const { data: membersData } = useWorkspaceMembers();
  const { data: channelMembersData } = useChannelMembers(channelId || '');
  const { data: channelData } = useChannel(channelId || '');
  const members = useMemo(() => membersData?.data ?? [], [membersData]);
  const channelMembers = useMemo(() => channelMembersData?.data ?? [], [channelMembersData]);
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

  // -- Agents + People sections ----------------------------------------------
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
    [channelMembers, t.weldchat.mentionAutocomplete.agent],
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

  const canInviteAgents = useCanInviteAgents(channelId);
  const canUseAgents = useCan('weldagent:use');
  const offerAgents = canInviteAgents || (agentsJoinOnSend && canUseAgents);
  const invitableAgents = useInvitableAgents(channelId, offerAgents);
  const inviteAgent = useInviteAgent(channelId || '');
  const invitableSuggestions: PersonItem[] = useMemo(
    () =>
      invitableAgents.map((a) => ({
        kind: 'user' as const,
        userId: a.id,
        name: a.name,
        isAgent: true,
        agentIcon: a.icon ?? null,
        notInChannel: true,
      })),
    [invitableAgents],
  );

  const filteredAgents = useMemo(() => {
    if (!trimmed) return [...agentSuggestions, ...invitableSuggestions.slice(0, INVITABLE_AGENTS_IDLE_LIMIT)];
    const q = trimmed.toLowerCase();
    return [...agentSuggestions, ...invitableSuggestions]
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, PEOPLE_LIMIT);
  }, [agentSuggestions, invitableSuggestions, trimmed]);

  const filteredPeople = useMemo(() => {
    if (!trimmed) return userSuggestions.slice(0, 8);
    const q = trimmed.toLowerCase();
    return userSuggestions
      .filter((s) => s.name.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q))
      .slice(0, PEOPLE_LIMIT);
  }, [userSuggestions, trimmed]);

  // An agent from outside the channel joins it before its mention is inserted,
  // so the message that mentions it is answered.
  const choosePerson = useCallback(
    (s: PersonItem) => {
      const selection: MentionSelection = { kind: 'user', userId: s.userId, name: s.name };
      if (!s.notInChannel || agentsJoinOnSend) {
        onSelect(selection);
        return;
      }
      void inviteAgent({ id: s.userId, name: s.name }).then((joined) => {
        if (joined) onSelect(selection);
      });
    },
    [onSelect, inviteAgent, agentsJoinOnSend],
  );

  const pickItem = useCallback(
    (item: FlatItem) => {
      if (item.kind === 'user') choosePerson(item);
      else if (item.kind === 'entity') onSelect({ kind: 'entity', type: item.type, id: item.id, title: item.title });
      else onSelect({ kind: 'everyone' });
    },
    [choosePerson, onSelect],
  );

  // -- Records section -----------------------------------------------------
  const groups = useMemo(() => searchData?.data ?? [], [searchData]);
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
    out.push(...filteredAgents, ...filteredPeople);
    for (const g of entityGroups) out.push(...g.items);
    return out;
  }, [showEveryone, filteredAgents, filteredPeople, entityGroups]);

  const [activeIndex, setActiveIndex] = useState(0);
  // Set by the arrow keys only: a row hovered with the mouse must not make the list scroll.
  const keyboardMovedRef = useRef(false);
  useEffect(() => {
    setActiveIndex(0);
    // A new list starts at its top, where the agents are.
    if (ref.current) ref.current.scrollTop = 0;
  }, [trimmed, flatItems.length]);

  useEffect(() => {
    if (!keyboardMovedRef.current) return;
    keyboardMovedRef.current = false;
    ref.current?.querySelector(`[data-mention-index="${activeIndex}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  // Record results land a moment after the people rows, and the popup grows
  // upward from the composer, so a different row slides under a still
  // pointer. A click in that instant picked a record instead of the person
  // aimed at, so a click right after the list changes is held back instead of
  // acted on (see `pickWithPointer`).
  const listChangedAtRef = useRef(0);
  const flatItemsRef = useRef(flatItems);
  useEffect(() => {
    flatItemsRef.current = flatItems;
    listChangedAtRef.current = performance.now();
  }, [flatItems]);

  const pendingPickRef = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelPendingPick = useCallback(() => {
    if (pendingPickRef.current) clearTimeout(pendingPickRef.current.timer);
    pendingPickRef.current = null;
  }, []);
  useEffect(() => cancelPendingPick, [cancelPendingPick]);

  /**
   * A click on a row. Once the list has settled it picks the row. Inside the
   * settle window it must neither pick a row that may have slid under the
   * pointer nor close the popup: it waits for the window to end and then
   * picks the row only if the pointer is still on it and it is still listed.
   * Moving to another row (or off this one) drops the held click.
   */
  const pickWithPointer = (item: FlatItem) => {
    cancelPendingPick();
    const wait = LIST_SETTLE_MS - (performance.now() - listChangedAtRef.current);
    if (wait <= 0) {
      pickItem(item);
      return;
    }
    const key = rowKey(item);
    const timer = setTimeout(() => {
      pendingPickRef.current = null;
      const current = flatItemsRef.current.find((candidate) => rowKey(candidate) === key);
      if (current) pickItem(current);
    }, wait);
    pendingPickRef.current = { key, timer };
  };
  const enterRow = (index: number, item: FlatItem) => {
    setActiveIndex(index);
    if (pendingPickRef.current && pendingPickRef.current.key !== rowKey(item)) cancelPendingPick();
  };
  const leaveRow = (item: FlatItem) => {
    if (pendingPickRef.current?.key === rowKey(item)) cancelPendingPick();
  };

  // -- Keyboard --------------------------------------------------------------
  // Listens in the CAPTURE phase on `document`, ahead of the composer's own
  // (React) key handler. Enter / Tab / arrows are consumed here with
  // stopPropagation, so Enter picks the highlighted item instead of also
  // sending the half-typed message. Escape closes the popup (see below).
  useEffect(() => {
    if (!onDismiss && flatItems.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only react to keys typed in the composer this popup belongs to.
      const composer = ref.current?.closest('[data-chat-composer-root]');
      if (composer && e.target instanceof Node && !composer.contains(e.target)) return;

      if (e.key === 'Escape') {
        // Consumed while the popup is showing, so it doesn't also cancel a
        // pending reply/edit; a second Escape (popup gone) reaches the composer.
        if (ref.current) {
          e.preventDefault();
          e.stopPropagation();
        }
        onDismiss?.();
        return;
      }
      if (flatItems.length === 0 || e.isComposing) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        keyboardMovedRef.current = true;
        setActiveIndex((i) => (i + 1) % flatItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        keyboardMovedRef.current = true;
        setActiveIndex((i) => (i - 1 + flatItems.length) % flatItems.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const item = flatItems[activeIndex];
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        pickItem(item);
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [flatItems, activeIndex, onDismiss, pickItem]);

  // -- Click outside to dismiss --------------------------------------------
  useEffect(() => {
    if (!onDismiss) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // A row that was swapped out by a re-render mid-click is gone from the
      // document: that is not a click outside the popup.
      if (!target.isConnected) return;
      if (ref.current && !ref.current.contains(target)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onDismiss]);

  const hasAnything =
    showEveryone ||
    filteredAgents.length > 0 ||
    filteredPeople.length > 0 ||
    entityGroups.length > 0 ||
    isSearching;

  // Cap the height to the room above the composer (see `spaceAboveComposer`).
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const composer = ref.current?.closest('[data-chat-composer-root]');
    if (!composer) return;
    const measure = () => {
      const room = spaceAboveComposer(composer) - POPUP_OFFSET;
      setMaxHeight(Math.round(Math.min(POPUP_MAX_HEIGHT, Math.max(POPUP_MIN_HEIGHT, room))));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [hasAnything, flatItems]);

  if (!hasAnything) return null;

  let runningIndex = 0;
  const everyoneIndex = showEveryone ? runningIndex++ : -1;
  const agentsStart = runningIndex;
  runningIndex += filteredAgents.length;
  const peopleStart = runningIndex;
  runningIndex += filteredPeople.length;

  const renderPersonRow = (s: PersonItem, idx: number) => {
    const active = idx === activeIndex;
    let trailing: ReactNode = null;
    if (s.isAgent) {
      trailing = (
        <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
          {s.notInChannel ? t.weldchat.mentionAutocomplete.addToChat : t.weldchat.mentionAutocomplete.agent}
        </span>
      );
    } else if (s.email) {
      trailing = <span className="text-muted-foreground text-xs truncate">{s.email}</span>;
    }
    return (
      <Button
        key={`p-${s.userId}`}
        type="button"
        variant="ghost"
        data-mention-index={idx}
        className={`${ROW_CLASS} ${active ? 'bg-muted' : 'hover:bg-muted'}`}
        onMouseEnter={() => enterRow(idx, s)}
        onMouseLeave={() => leaveRow(s)}
        onMouseDown={(e) => {
          e.preventDefault();
          pickWithPointer(s);
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
        {trailing}
      </Button>
    );
  };

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-lg shadow-lg max-h-72 overflow-y-auto z-50"
      style={maxHeight === null ? undefined : { maxHeight }}
    >
      {showEveryone && (
        <Button
          key="everyone"
          type="button"
          variant="ghost"
          data-mention-index={everyoneIndex}
          className={`${ROW_CLASS} ${everyoneIndex === activeIndex ? 'bg-muted' : 'hover:bg-muted'}`}
          onMouseEnter={() => enterRow(everyoneIndex, { kind: 'everyone' })}
          onMouseLeave={() => leaveRow({ kind: 'everyone' })}
          onMouseDown={(e) => {
            e.preventDefault();
            pickWithPointer({ kind: 'everyone' });
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

      {filteredAgents.length > 0 && (
        <div>
          <div className={SECTION_HEADING_CLASS}>{t.weldchat.mentionAutocomplete.agentsHeading}</div>
          {filteredAgents.map((s, i) => renderPersonRow(s, agentsStart + i))}
        </div>
      )}

      {filteredPeople.length > 0 && (
        <div>
          <div className={SECTION_HEADING_CLASS}>{st('sweep.weldchat.mentionAutocomplete.people')}</div>
          {filteredPeople.map((s, i) => renderPersonRow(s, peopleStart + i))}
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
                <div className={SECTION_HEADING_CLASS}>{heading}</div>
                {group.items.map((item, i) => {
                  const idx = groupStart + i;
                  const active = idx === activeIndex;
                  return (
                    <Button
                      key={`e-${item.type}-${item.id}`}
                      type="button"
                      variant="ghost"
                      data-mention-index={idx}
                      className={`${ROW_CLASS} ${active ? 'bg-muted' : 'hover:bg-muted'}`}
                      onMouseEnter={() => enterRow(idx, item)}
                      onMouseLeave={() => leaveRow(item)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickWithPointer(item);
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

          {!isSearching &&
            entityGroups.length === 0 &&
            filteredAgents.length === 0 &&
            filteredPeople.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">{st('sweep.weldchat.mentionAutocomplete.noMatches')}</div>
            )}
        </div>
      )}
    </div>
  );
}
