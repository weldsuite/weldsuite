import { useCallback, useMemo, useState } from 'react';
import { Crown, Plus, ShieldCheck, UserMinus, Users } from 'lucide-react';
import { useUser } from '@clerk/clerk-react';
import {
  useChannel,
  useChannelMembers,
  useRemoveChannelMember,
  type ChatChannelMember,
} from '@/hooks/queries/use-weldchat-queries';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { StatusDot } from '@weldsuite/ui/components/status-dot';
import { usePresence } from '@/contexts/presence-context';
import { useChatContext } from '@/app/weldchat/components/chat-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  EntityList,
  type ActiveFilter,
  type FilterConfig,
  type GroupConfig,
} from '@/components/entity-list';
import { InvitePeopleDialog } from './invite-people-dialog';

interface ChannelPeopleTabProps {
  channelId: string;
}

type Role = 'owner' | 'admin' | 'member';
type MemberType = 'human' | 'agent' | 'guest';
type Presence = 'online' | 'offline';

interface PeopleRow {
  id: string;
  userId: string;
  name: string;
  email?: string | null;
  picture?: string | null;
  role: Role;
  memberType: MemberType;
  presence: Presence;
  presenceLabel?: string | null;
  presenceEmoji?: string | null;
  agentIcon?: string | null;
  workspaceMemberType?: string | null;
}

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

function RoleIcon({ role }: { role: Role }) {
  if (role === 'owner') return <Crown className="h-3 w-3 text-yellow-500" />;
  if (role === 'admin') return <ShieldCheck className="h-3 w-3 text-blue-500" />;
  return null;
}

export function ChannelPeopleTab({ channelId }: ChannelPeopleTabProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const { user } = useUser();
  const { data: membersData, isLoading } = useChannelMembers(channelId);
  const { data: channelData } = useChannel(channelId);
  const { presenceMap } = usePresence();
  const { mutate: removeMember } = useRemoveChannelMember();
  const { openUserProfile, openAgentProfile } = useChatContext();

  const channel = channelData?.data;
  const isPrivate = channel?.type === 'private';

  const [inviteOpen, setInviteOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const rows: PeopleRow[] = useMemo(() => {
    const raw: ChatChannelMember[] = membersData?.data ?? [];
    return raw.map((m) => {
      const isAgent = m.memberType === 'agent';
      const isGuest = m.workspaceMemberType === 'EXTERNAL_GUEST';
      const status = isAgent ? 'online' : presenceMap[m.userId]?.status;
      const online =
        status === 'online' || status === 'busy' || status === 'away' || status === 'dnd';
      return {
        id: m.userId,
        userId: m.userId,
        name: m.name || m.email || '?',
        email: m.email,
        picture: m.picture,
        role: (m.role ?? 'member') as Role,
        memberType: isAgent ? 'agent' : isGuest ? 'guest' : 'human',
        presence: online ? 'online' : 'offline',
        presenceLabel: presenceMap[m.userId]?.statusText,
        presenceEmoji: presenceMap[m.userId]?.statusEmoji,
        agentIcon: m.agentIcon,
        workspaceMemberType: m.workspaceMemberType,
      } satisfies PeopleRow;
    });
  }, [membersData, presenceMap]);

  const filterConfigs: FilterConfig[] = useMemo(() => {
    const configs: FilterConfig[] = [];
    const presences = new Set(rows.map((r) => r.presence));
    if (presences.size > 1) {
      configs.push({
        field: 'presence',
        label: st('sweep.entities.fieldStatus'),
        options: [
          { value: 'online', label: st('sweep.entities.online') },
          { value: 'offline', label: st('sweep.entities.offline') },
        ],
      });
    }
    const roles = new Set(rows.map((r) => r.role));
    if (roles.size > 1) {
      configs.push({
        field: 'role',
        label: st('sweep.entities.fieldRole'),
        options: [
          { value: 'owner', label: st('sweep.entities.roleOwner') },
          { value: 'admin', label: st('sweep.entities.roleAdmin') },
          { value: 'member', label: st('sweep.entities.roleMember') },
        ].filter((o) => roles.has(o.value as Role)),
      });
    }
    const types = new Set(rows.map((r) => r.memberType));
    if (types.size > 1) {
      configs.push({
        field: 'memberType',
        label: st('sweep.entities.fieldType'),
        options: [
          { value: 'human', label: st('sweep.entities.membersLabel') },
          { value: 'agent', label: st('sweep.entities.agentsLabel') },
          { value: 'guest', label: st('sweep.entities.guestsLabel') },
        ].filter((o) => types.has(o.value as MemberType)),
      });
    }
    return configs;
  }, [rows, st]);

  const filteredItems = useMemo(() => {
    let items = rows;
    for (const f of activeFilters) {
      if (f.operator !== 'is' || typeof f.value !== 'string') continue;
      items = items.filter((r) => r[f.field as keyof PeopleRow] === f.value);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (r) => r.name.toLowerCase().includes(q) || r.email?.toLowerCase().includes(q),
      );
    }
    // EntityList groups don't get their own sort hook — items keep their
    // source order inside each group. Sort by role here so the visible order
    // inside Online / Offline is owner → admin → member.
    return [...items].sort(
      (a, b) => (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99),
    );
  }, [rows, activeFilters, searchQuery]);

  const groupConfigs: GroupConfig<PeopleRow>[] = useMemo(() => {
    return [
      {
        id: 'online',
        label: st('sweep.entities.onlineCount', {
          count: filteredItems.filter((r) => r.presence === 'online').length,
        }),
        filter: (r) => r.presence === 'online',
        sortOrder: 0,
      },
      {
        id: 'offline',
        label: st('sweep.entities.offlineCount', {
          count: filteredItems.filter((r) => r.presence === 'offline').length,
        }),
        filter: (r) => r.presence === 'offline',
        sortOrder: 1,
      },
    ];
  }, [filteredItems, st]);

  const guestStrings = t.weldchat?.guest;

  const renderRow = useCallback(
    (r: PeopleRow) => {
      const isAgent = r.memberType === 'agent';
      const isOffline = r.presence === 'offline';
      const canRemove = isAgent
        ? isPrivate
        : isPrivate && r.role !== 'owner' && r.userId !== user?.id;
      const handleOpen = () => {
        if (isAgent) openAgentProfile(r.userId);
        else openUserProfile(r.userId);
      };
      return (
        <div
          key={r.id}
          data-testid="chat-member-row"
          onClick={handleOpen}
          className={`group/member flex items-center gap-2.5 px-4 py-2.5 hover:bg-muted/60 transition-colors cursor-pointer ${isOffline ? 'opacity-60' : ''}`}
        >
          <div className="relative flex-shrink-0">
            <Avatar className="h-7 w-7 !rounded-[10px]">
              {r.picture && <AvatarImage src={r.picture} className="!rounded-[10px]" />}
              <AvatarFallback className="text-[9px] !rounded-[10px]">
                {isAgent
                  ? r.agentIcon || (r.name[0] ?? '?').toUpperCase()
                  : (r.name[0] ?? '?').toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <StatusDot
              status={isAgent ? 'online' : presenceMap[r.userId]?.status}
              showTooltip
              className="absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] border-2"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium truncate">{r.name}</span>
              {isAgent ? (
                <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground">
                  {st('sweep.entities.agentLabel')}
                </span>
              ) : r.memberType === 'guest' ? (
                <span
                  className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                  title={guestStrings?.tooltip ?? st('sweep.entities.externalGuestTooltip')}
                >
                  {guestStrings?.badge ?? st('sweep.entities.guestLabel')}
                </span>
              ) : (
                <RoleIcon role={r.role} />
              )}
            </div>
            {!isAgent && r.presenceLabel && (
              <p className="text-[11px] text-muted-foreground truncate">
                {r.presenceEmoji && <span className="mr-1">{r.presenceEmoji}</span>}
                {r.presenceLabel}
              </p>
            )}
          </div>
          {canRemove && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 opacity-0 group-hover/member:opacity-100 transition-opacity flex-shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                removeMember({ channelId, userId: r.userId });
              }}
              title={isAgent ? st('sweep.entities.removeAgent') : st('sweep.entities.removeFromChannel')}
            >
              <UserMinus className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
        </div>
      );
    },
    [
      channelId, isPrivate, openAgentProfile, openUserProfile, presenceMap,
      removeMember, user?.id, guestStrings, st,
    ],
  );

  const actionButtons = (
    <Button size="sm" className="h-8 gap-1.5" onClick={() => setInviteOpen(true)}>
      <Plus className="h-3.5 w-3.5" />
      {st('sweep.entities.invitePeople')}
    </Button>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto relative">
        {!isLoading && filteredItems.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-muted-foreground pointer-events-none z-10">
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center mb-2">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{st('sweep.entities.noPeopleMatch')}</p>
            <p className="text-xs mt-1 text-center">
              {st('sweep.entities.adjustFiltersOrInvite')}
            </p>
          </div>
        )}
        <EntityList<PeopleRow>
          items={filteredItems}
          isLoading={isLoading}
          error={null}
          filters={filterConfigs}
          groups={groupConfigs}
          maxFilters={3}
          renderRow={renderRow}
          actionButtons={actionButtons}
          searchPlaceholder={st('sweep.entities.searchPeoplePlaceholderShort')}
          searchFields={['name', 'email'] as (keyof PeopleRow)[]}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
        />
      </div>

      <InvitePeopleDialog
        channelId={channelId}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
    </div>
  );
}
