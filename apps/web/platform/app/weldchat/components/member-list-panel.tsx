import { useMemo, useState, useRef, useEffect } from 'react';
import { useChannelMembers, useWorkspaceMembers, useAddChannelMembers, useRemoveChannelMember, useChannel } from '@/hooks/queries/use-weldchat-queries';
import type { ChatChannelMember } from '@/hooks/queries/use-weldchat-queries';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { X, ShieldCheck, Crown, Plus, Search, UserMinus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { StatusDot } from '@weldsuite/ui/components/status-dot';
import { usePresence } from '@/contexts/presence-context';
import { useChatContext } from './chat-context';
import { useUser } from '@clerk/clerk-react';
import { InviteAgentDialog } from './invite-agent-dialog';
import { InviteExternalUserModal } from './invite-external-user-modal';
import { UserPlus } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';

interface MemberListPanelProps {
  channelId: string;
  embedded?: boolean;
}

const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2 };

function RoleIcon({ role }: { role: string | undefined }) {
  if (role === 'owner') return <Crown className="h-3 w-3 text-yellow-500" />;
  if (role === 'admin') return <ShieldCheck className="h-3 w-3 text-blue-500" />;
  return null;
}

export function MemberListPanel({ channelId, embedded = false }: MemberListPanelProps) {
  const { setRightPanel, openUserProfile, openAgentProfile } = useChatContext();
  const { user } = useUser();
  const { data } = useChannelMembers(channelId);
  const { data: channelData } = useChannel(channelId);
  const { presenceMap } = usePresence();
  const { data: workspaceMembersData } = useWorkspaceMembers();
  const { mutate: addMembers } = useAddChannelMembers();
  const { mutate: removeMember } = useRemoveChannelMember();

  const [showAddUI, setShowAddUI] = useState(false);
  const [inviteAgentOpen, setInviteAgentOpen] = useState(false);
  const [inviteExternalOpen, setInviteExternalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const canInviteExternal = useCan('team:invite_external');
  const { t } = useI18n();
  const guestStrings = t.weldchat.guest;
  const inviteExternalStrings = t.weldchat.inviteExternal;
  const dropdownRef = useRef<HTMLDivElement>(null);

  const members = useMemo(() => data?.data || [], [data]);
  const channel = channelData?.data;
  const isPrivate = channel?.type === 'private';
  const memberUserIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showAddUI) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowAddUI(false);
        setSearch('');
      }
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [showAddUI]);

  const statuses = presenceMap;

  // Non-members available to add
  const availableMembers = useMemo(() => {
    const all = workspaceMembersData?.data ?? [];
    const filtered = all.filter((m) => !memberUserIds.has(m.userId));
    if (!search) return filtered;
    const q = search.toLowerCase();
    return filtered.filter((m) => m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q));
  }, [workspaceMembersData, memberUserIds, search]);

  // Agents always count as online (they're not real users with presence).
  // Humans are grouped by actual presence status.
  const { onlineMembers, offlineMembers } = useMemo(() => {
    const online: ChatChannelMember[] = [];
    const offline: ChatChannelMember[] = [];
    for (const m of members) {
      if (m.memberType === 'agent') {
        online.push(m);
        continue;
      }
      const status = statuses[m.userId]?.status;
      if (status === 'online' || status === 'busy' || status === 'away' || status === 'dnd') {
        online.push(m);
      } else {
        offline.push(m);
      }
    }
    const sortByRole = (a: ChatChannelMember, b: ChatChannelMember) =>
      (ROLE_ORDER[a.role ?? ''] ?? 99) - (ROLE_ORDER[b.role ?? ''] ?? 99);
    online.sort(sortByRole);
    offline.sort(sortByRole);
    return { onlineMembers: online, offlineMembers: offline };
  }, [members, statuses]);

  return (
    <div className="flex flex-col h-full">
      {!embedded && (
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-semibold flex items-center gap-2">{t.weldchat.memberList.header} <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-[5px]" style={{ transform: 'translateY(0.5px)' }}>{members.length}</span></h3>
          <div className="flex items-center gap-1">
            {isPrivate && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => { setShowAddUI(!showAddUI); setSearch(''); }}
                title={t.weldchat.memberList.addMembers}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setInviteAgentOpen(true)}
              title={t.weldchat.memberList.inviteAgent}
            >
              <Plus className="h-4 w-4" />
            </Button>
            {canInviteExternal && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setInviteExternalOpen(true)}
                title={inviteExternalStrings?.buttonTooltip ?? 'Invite an external guest'}
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setRightPanel(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      {embedded && (
        <div className="flex items-center justify-end gap-1 px-3 py-2 border-b">
          {isPrivate && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => { setShowAddUI(!showAddUI); setSearch(''); }}
              title={t.weldchat.memberList.addMembers}
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setInviteAgentOpen(true)}
            title={t.weldchat.memberList.inviteAgent}
          >
            <Plus className="h-4 w-4" />
          </Button>
          {canInviteExternal && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setInviteExternalOpen(true)}
              title={inviteExternalStrings?.buttonTooltip ?? 'Invite an external guest'}
            >
              <UserPlus className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {/* Add members UI */}
      {showAddUI && (
        <div className="px-3 py-2 border-b" ref={dropdownRef}>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.weldchat.memberList.searchPeople}
              className="h-8 pl-7 text-sm"
              autoFocus
            />
          </div>
          <ScrollArea className="max-h-[200px] mt-1">
            <div className="py-1">
              {availableMembers.map((m) => (
                <Button
                  key={m.userId}
                  variant="ghost"
                  className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-sm hover:bg-accent transition-colors"
                  onClick={() => {
                    addMembers({ channelId, userIds: [m.userId] });
                    setSearch('');
                  }}
                >
                  <Avatar className="h-6 w-6 !rounded-[6px]">
                    {m.picture && <AvatarImage src={m.picture} className="!rounded-[6px]" />}
                    <AvatarFallback className="text-[9px] !rounded-[6px]">
                      {(m.name || m.email || '?')[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate">{m.name || m.email}</span>
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              ))}
              {availableMembers.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-3">
                  {search ? t.weldchat.memberList.noMembersFound : t.weldchat.memberList.everyoneInChannel}
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="py-2">
          {onlineMembers.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-1.5 px-4 py-1">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {t.weldchat.memberList.onlineSection} — {onlineMembers.length}
                </span>
              </div>
              {onlineMembers.map((member) => {
                const isAgent = member.memberType === 'agent';
                const userStatus = isAgent ? undefined : statuses[member.userId];
                const canRemove = isAgent
                  ? isPrivate
                  : isPrivate && member.role !== 'owner' && member.userId !== user?.id;
                return (
                  <div
                    key={member.userId}
                    data-testid="chat-member-row"
                    onClick={() => {
                      if (isAgent) openAgentProfile(member.userId);
                      else openUserProfile(member.userId);
                    }}
                    className="group/member flex items-center gap-2.5 px-4 py-2.5 hover:bg-muted/60 transition-colors cursor-pointer"
                  >
                    <div className="relative flex-shrink-0">
                      <Avatar className="h-7 w-7 !rounded-[10px]">
                        {member.picture && <AvatarImage src={member.picture} className="!rounded-[10px]" />}
                        <AvatarFallback className="text-[9px] !rounded-[10px]">
                          {isAgent
                            ? member.agentIcon || (member.name?.[0] ?? '?').toUpperCase()
                            : (member.name || member.email || '?')[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <StatusDot
                        status={isAgent ? 'online' : userStatus?.status}
                        showTooltip
                        className="absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] border-2"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">
                          {member.name || member.email}
                        </span>
                        {isAgent ? (
                          <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground">
                            {t.weldchat.memberList.agentBadge}
                          </span>
                        ) : member.workspaceMemberType === 'EXTERNAL_GUEST' ? (
                          <span
                            className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                            title={guestStrings?.tooltip ?? 'External guest — only sees channels they\'re invited to'}
                          >
                            {guestStrings?.badge ?? 'Guest'}
                          </span>
                        ) : (
                          <RoleIcon role={member.role} />
                        )}
                      </div>
                      {!isAgent && userStatus?.statusText && (
                        <p className="text-[11px] text-muted-foreground truncate">
                          {userStatus.statusEmoji && <span className="mr-1">{userStatus.statusEmoji}</span>}
                          {userStatus.statusText}
                        </p>
                      )}
                    </div>
                    {canRemove && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover/member:opacity-100 transition-opacity flex-shrink-0"
                        onClick={(e) => { e.stopPropagation(); removeMember({ channelId, userId: member.userId }); }}
                        title={isAgent ? t.weldchat.memberList.removeAgent : t.weldchat.memberList.removeFromChannel}
                      >
                        <UserMinus className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {offlineMembers.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-1.5 px-4 py-1">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {t.weldchat.memberList.offlineSection} — {offlineMembers.length}
                </span>
              </div>
              {offlineMembers.map((member) => {
                const userStatus = statuses[member.userId];
                const canRemove = isPrivate && member.role !== 'owner' && member.userId !== user?.id;
                return (
                  <div
                    key={member.userId}
                    data-testid="chat-member-row"
                    onClick={() => openUserProfile(member.userId)}
                    className="group/member flex items-center gap-2.5 px-4 py-2.5 hover:bg-muted/60 cursor-pointer transition-colors opacity-60"
                  >
                    <div className="relative flex-shrink-0">
                      <Avatar className="h-7 w-7 !rounded-[10px]">
                        {member.picture && <AvatarImage src={member.picture} className="!rounded-[10px]" />}
                        <AvatarFallback className="text-[9px] !rounded-[10px]">
                          {(member.name || member.email || '?')[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <StatusDot status={userStatus?.status} showTooltip className="absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] border-2" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">
                          {member.name || member.email}
                        </span>
                        {member.workspaceMemberType === 'EXTERNAL_GUEST' ? (
                          <span
                            className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                            title={guestStrings?.tooltip ?? 'External guest — only sees channels they\'re invited to'}
                          >
                            {guestStrings?.badge ?? 'Guest'}
                          </span>
                        ) : (
                          <RoleIcon role={member.role} />
                        )}
                      </div>
                      {userStatus?.statusText && (
                        <p className="text-[11px] text-muted-foreground truncate">
                          {userStatus.statusEmoji && <span className="mr-1">{userStatus.statusEmoji}</span>}
                          {userStatus.statusText}
                        </p>
                      )}
                    </div>
                    {canRemove && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover/member:opacity-100 transition-opacity flex-shrink-0"
                        onClick={(e) => { e.stopPropagation(); removeMember({ channelId, userId: member.userId }); }}
                        title={t.weldchat.memberList.removeFromChannel}
                      >
                        <UserMinus className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>

      <InviteAgentDialog
        channelId={channelId}
        open={inviteAgentOpen}
        onOpenChange={setInviteAgentOpen}
      />
      <InviteExternalUserModal
        channelId={channelId}
        open={inviteExternalOpen}
        onOpenChange={setInviteExternalOpen}
      />
    </div>
  );
}
