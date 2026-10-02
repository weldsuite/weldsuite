import { useMemo, useState } from 'react';
import { Check, Loader2, Mail, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@weldsuite/ui/lib/utils';
import { useInviteToMeeting, useMeeting } from '@/hooks/queries/use-weldmeet-queries';
import {
  useWorkspaceMembers,
  useWorkspaceMemberSearch,
  type WorkspaceMember,
} from '@/hooks/queries/use-settings-queries';
import { usePersonSearch } from '@/hooks/queries/use-people-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { getTranslations } from '@/lib/i18n';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteCandidate {
  key: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
  /** The "Invite <typed email>" row for an address that matched nobody. */
  typed?: boolean;
}

/**
 * "Add people" for a meeting (TASK-717): search workspace members and CRM
 * people, or type any email address, and invite them. Inviting adds the
 * person to the meeting's attendees and emails them the join link
 * (meet-api `POST /meetings/:id/invitations`).
 *
 * Used by the "meeting ready" card, the in-room Add people dialog and invite
 * popover, and the meeting detail page. Renders only the search + results;
 * the caller provides the surrounding dialog or popover.
 */
export function MeetingInvitePicker({
  meetingId,
  compact = false,
}: Readonly<{ meetingId: string; compact?: boolean }>) {
  const t = getTranslations('weldmeet').invitePeople;
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 250);
  const [invitedEmails, setInvitedEmails] = useState<Set<string>>(new Set());
  const [pendingEmails, setPendingEmails] = useState<Set<string>>(new Set());

  const { data: meeting } = useMeeting(meetingId);
  const { data: firstMembers } = useWorkspaceMembers(1, 50);
  const { data: memberResults, isFetching: membersFetching } = useWorkspaceMemberSearch(debounced);
  const { data: peopleResults, isFetching: peopleFetching } = usePersonSearch(debounced);
  const invite = useInviteToMeeting();

  const alreadyOnMeeting = useMemo(() => {
    const emails = new Set<string>();
    for (const a of meeting?.attendees ?? []) if (a.email) emails.add(a.email.toLowerCase());
    return emails;
  }, [meeting?.attendees]);

  const members: InviteCandidate[] = useMemo(() => {
    const source: WorkspaceMember[] = debounced ? (memberResults?.data ?? []) : (firstMembers?.data ?? []);
    return source.map((m) => ({
      key: `member:${m.userId}`,
      name: m.name ?? null,
      email: m.email ?? null,
      avatar: m.picture ?? null,
    }));
  }, [debounced, memberResults, firstMembers]);

  const people: InviteCandidate[] = useMemo(() => {
    if (!debounced) return [];
    const memberEmails = new Set(members.map((m) => m.email?.toLowerCase()).filter(Boolean));
    return (peopleResults?.data ?? [])
      .filter((p) => p.email && !memberEmails.has(p.email.toLowerCase()))
      .map((p) => ({
        key: `person:${p.id}`,
        name: p.displayName || null,
        email: p.email ?? null,
        avatar: (p as { avatarUrl?: string | null }).avatarUrl ?? null,
      }));
  }, [debounced, peopleResults, members]);

  const typedEmail = EMAIL_RE.test(search.trim()) ? search.trim().toLowerCase() : null;
  const typedEmailListed =
    typedEmail !== null &&
    [...members, ...people].some((c) => c.email?.toLowerCase() === typedEmail);
  const showTypedEmail = typedEmail !== null && !typedEmailListed;
  const searching = debounced !== search.trim() || membersFetching || peopleFetching;

  const isInvited = (email: string | null) =>
    !!email && (invitedEmails.has(email.toLowerCase()) || alreadyOnMeeting.has(email.toLowerCase()));

  const handleInvite = async (email: string, name?: string | null) => {
    const normalized = email.toLowerCase();
    setPendingEmails((prev) => new Set(prev).add(normalized));
    try {
      const result = await invite.mutateAsync({
        meetingId,
        invitees: [{ email: normalized, ...(name ? { name } : {}) }],
      });
      setInvitedEmails((prev) => new Set(prev).add(normalized));
      const added = result.invited.find((i) => i.email === normalized);
      if (!added) {
        toast.info(t.alreadyInvited.replace('{email}', email));
      } else if (added.emailSent) {
        toast.success(t.invitationSent.replace('{email}', email));
      } else {
        toast.warning(t.addedNoEmail.replace('{email}', email));
      }
      if (normalized === typedEmail) setSearch('');
    } catch (err) {
      toast.error(t.failed.replace('{email}', email), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setPendingEmails((prev) => {
        const next = new Set(prev);
        next.delete(normalized);
        return next;
      });
    }
  };

  const renderRow = (candidate: InviteCandidate) => {
    const invited = isInvited(candidate.email);
    const pending = !!candidate.email && pendingEmails.has(candidate.email.toLowerCase());
    return (
      <div key={candidate.key} className={cn('flex items-center gap-3', compact ? 'py-2' : 'py-2.5')}>
        <Avatar className="h-7 w-7 !rounded-[8px]">
          {candidate.avatar && <AvatarImage src={candidate.avatar} alt="" />}
          <AvatarFallback className="text-[10px] !rounded-[8px]">
            {candidate.typed ? (
              <Mail className="h-3.5 w-3.5" />
            ) : (
              (candidate.name ?? candidate.email ?? '?').charAt(0).toUpperCase()
            )}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className={cn('font-medium truncate', compact ? 'text-[13px]' : 'text-sm')}>
            {candidate.name ?? candidate.email ?? t.unknown}
          </p>
          {candidate.email && candidate.name && !candidate.typed && (
            <p className="text-xs text-muted-foreground truncate">{candidate.email}</p>
          )}
        </div>
        <Button
          size="sm"
          variant={invited ? 'ghost' : compact ? 'secondary' : 'outline'}
          className={cn('shrink-0', compact && 'h-7 text-xs')}
          onClick={() =>
            candidate.email && handleInvite(candidate.email, candidate.typed ? undefined : candidate.name)
          }
          disabled={invited || pending || !candidate.email}
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {!pending && invited && (
            <>
              <Check className="h-3.5 w-3.5" /> {t.invited}
            </>
          )}
          {!pending && !invited && t.invite}
        </Button>
      </div>
    );
  };

  const sectionLabel = (label: string) => (
    <p className="pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
  );

  const nothingFound =
    !!search.trim() && !showTypedEmail && members.length === 0 && people.length === 0 && !searching;

  return (
    <>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder={t.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && showTypedEmail && typedEmail && !isInvited(typedEmail)) {
              e.preventDefault();
              void handleInvite(typedEmail);
            }
          }}
          className={cn('text-xs pl-8', compact ? 'h-8' : 'h-[35px]')}
          type="search"
          autoComplete="off"
          autoFocus
        />
        {searching && search.trim() && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className={cn('overflow-y-auto', compact ? 'max-h-[240px] mt-2' : 'max-h-[300px] -mx-4 px-4 -mt-2')}>
        {showTypedEmail &&
          typedEmail &&
          renderRow({
            key: `email:${typedEmail}`,
            name: t.inviteEmail.replace('{email}', typedEmail),
            email: typedEmail,
            avatar: null,
            typed: true,
          })}

        {members.length > 0 && (
          <>
            {debounced && sectionLabel(t.members)}
            {members.map(renderRow)}
          </>
        )}

        {people.length > 0 && (
          <>
            {sectionLabel(t.crmPeople)}
            {people.map(renderRow)}
          </>
        )}

        {nothingFound && (
          <p className="text-xs text-muted-foreground text-center py-6 px-2">{t.noResults}</p>
        )}
      </div>
    </>
  );
}
