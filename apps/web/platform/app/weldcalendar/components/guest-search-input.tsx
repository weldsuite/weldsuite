import { useEffect, useMemo, useState } from 'react';
import { Mail } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Separator } from '@weldsuite/ui/components/separator';
import { usePeople, type Person } from '@/components/objects/person/use-person-data';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { inviteEmailFromQuery, inviteGuestId } from './guest-invite';

/** Minimal shape this field reads off `/team-members` rows (the query itself is untyped). */
interface WorkspaceMemberLite {
  id: string;
  name?: string;
  email?: string;
  picture?: string;
}

// Guest Search Input (search team members and contacts by name/email, or invite
// any email address)

interface GuestResult {
  id: string;
  name: string;
  email: string;
  initial: string;
  type: 'member' | 'contact' | 'invite';
}

export function GuestSearchInput({
  value,
  onChange,
  selectedIds,
  selectedEmails = [],
  allowInvite = true,
  onSelect,
  onBlurAway,
}: {
  value: string;
  onChange: (v: string) => void;
  selectedIds: string[];
  /** Emails already on the list, so a person is not offered twice under another id. */
  selectedEmails?: string[];
  /** Offer "Invite <email>" for a typed address that is not a member or contact. */
  allowInvite?: boolean;
  onSelect: (guest: { id: string; name: string; email: string }) => void;
  /** Called when focus leaves the input (click away) — collapses the row. */
  onBlurAway?: () => void;
}) {
  const t = getTranslations('weldcalendar');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const { data: peopleData } = usePeople(
    value.length >= 1 ? { search: value, limit: 6 } : { limit: 6 },
  );
  const { data: membersData } = useWorkspaceMembers(1, 50);

  const contacts = useMemo(() => (peopleData?.data || []) as Person[], [peopleData]);
  const members = useMemo<WorkspaceMemberLite[]>(
    () =>
      (membersData?.data || []).map((m) => ({
        id: m.id ?? m.userId,
        name: m.name ?? undefined,
        email: m.email ?? undefined,
        picture: m.picture ?? undefined,
      })),
    [membersData],
  );

  // Build unified results: members, then contacts, then the invite option.
  const results = useMemo(() => {
    const search = value.toLowerCase();
    const taken = new Set(selectedEmails.map((e) => e.trim().toLowerCase()));
    const items: GuestResult[] = [];

    // A guest needs an address to be invited, so people without one are not listed.
    const take = (email: string): boolean => {
      const key = email.trim().toLowerCase();
      if (!key || taken.has(key)) return false;
      taken.add(key);
      return true;
    };

    // Team members first
    for (const m of members) {
      if (selectedIds.includes(`member-${m.id}`)) continue;
      const name = m.name || m.email || '';
      const email = m.email || '';
      if (search && !name.toLowerCase().includes(search) && !email.toLowerCase().includes(search)) continue;
      if (!take(email)) continue;
      items.push({
        id: `member-${m.id}`,
        name,
        email,
        initial: (name[0] || email[0] || '?').toUpperCase(),
        type: 'member',
      });
    }

    // Then contacts
    for (const c of contacts) {
      if (selectedIds.includes(`contact-${c.id}`)) continue;
      const email = c.email ?? '';
      if (!take(email)) continue;
      const name = c.fullName || `${c.firstName} ${c.lastName}`.trim() || email;
      items.push({
        id: `contact-${c.id}`,
        name,
        email,
        initial: (c.firstName?.[0] || email[0] || '?').toUpperCase(),
        type: 'contact',
      });
    }

    const listed = items.slice(0, 8);

    if (allowInvite) {
      const inviteEmail = inviteEmailFromQuery(value, [
        ...selectedEmails,
        ...items.map((r) => r.email),
      ]);
      if (inviteEmail) {
        listed.push({
          id: inviteGuestId(inviteEmail),
          name: inviteEmail,
          email: inviteEmail,
          initial: inviteEmail[0]!.toUpperCase(),
          type: 'invite',
        });
      }
    }
    return listed;
  }, [allowInvite, contacts, members, selectedEmails, selectedIds, value]);

  // The first option is the highlighted one again whenever the list changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [results.length, value]);

  const pick = (item: GuestResult) => {
    onSelect({ id: item.id, name: item.name, email: item.email });
    setOpen(false);
  };

  const pickWithMouse = (e: React.MouseEvent, item: GuestResult) => {
    e.preventDefault();
    pick(item);
  };

  const showDropdown = open && value.length >= 1 && results.length > 0;

  // Enter picks the highlighted option and never reaches the card (which would
  // otherwise treat it as "save"); arrows move the highlight, Escape closes the list.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const item = results[activeIndex] ?? results[0];
      if (showDropdown && item) pick(item);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.length === 0) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => (i + step + results.length) % results.length);
      return;
    }
    if (e.key === 'Escape' && showDropdown) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const renderGroup = (type: GuestResult['type'], label: string | null, tint: string) => {
    const group = results.filter((r) => r.type === type);
    if (group.length === 0) return null;
    return (
      <>
        {label && (
          <div className="px-3 pt-2 pb-1">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
          </div>
        )}
        {group.map((item) => (
          <Button
            variant="ghost"
            key={item.id}
            role="option"
            aria-selected={results[activeIndex]?.id === item.id}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors',
              results[activeIndex]?.id === item.id && 'bg-accent',
            )}
            onMouseDown={(e) => pickWithMouse(e, item)}
            onMouseEnter={() => setActiveIndex(results.findIndex((r) => r.id === item.id))}
          >
            <div className={cn('h-[24px] w-[24px] rounded-[5.5px] flex items-center justify-center shrink-0', tint)}>
              {item.type === 'invite' ? (
                <Mail className="h-3.5 w-3.5 text-primary" />
              ) : (
                <span className="text-xs font-medium">{item.initial}</span>
              )}
            </div>
            <div className="min-w-0">
              {item.type === 'invite' ? (
                <p className="text-sm font-medium truncate">
                  {t.eventPreview.inviteGuest.replace('{email}', item.email)}
                </p>
              ) : (
                <>
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{item.email}</p>
                </>
              )}
            </div>
          </Button>
        ))}
      </>
    );
  };

  const hasMembers = results.some((r) => r.type === 'member');
  const hasContacts = results.some((r) => r.type === 'contact');
  const hasInvite = results.some((r) => r.type === 'invite');

  return (
    <div className="relative">
      <Input
        placeholder={allowInvite ? t.eventPreview.searchMembersContacts : t.eventPreview.searchMembersContactsOnly}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); onBlurAway?.(); }, 150)}
        onKeyDown={handleKeyDown}
        className="h-7 text-sm shadow-none border-0 px-0 focus-visible:ring-0"
        autoFocus
      />
      {showDropdown && (
        <div
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-lg shadow-lg z-50 max-h-[240px] overflow-y-auto"
        >
          {renderGroup('member', t.eventPreview.teamMembersGroup, 'bg-blue-500/10 text-blue-600')}
          {hasMembers && hasContacts && <Separator />}
          {renderGroup('contact', t.eventPreview.contactsGroup, 'bg-primary/10 text-primary')}
          {(hasMembers || hasContacts) && hasInvite && <Separator />}
          {renderGroup('invite', null, 'bg-primary/10 text-primary')}
        </div>
      )}
    </div>
  );
}
