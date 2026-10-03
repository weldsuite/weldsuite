import { useMemo, useState } from 'react';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Separator } from '@weldsuite/ui/components/separator';
import { usePeople, type Person } from '@/components/objects/person/use-person-data';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';

/** Minimal shape this field reads off `/team-members` rows (the query itself is untyped). */
interface WorkspaceMemberLite {
  id: string;
  name?: string;
  email?: string;
  picture?: string;
}

// Guest Search Input (search team members and contacts by name/email)

interface GuestResult {
  id: string;
  name: string;
  email: string;
  initial: string;
  type: 'member' | 'contact';
}

export function GuestSearchInput({
  value,
  onChange,
  selectedIds,
  onSelect,
  onBlurAway,
}: {
  value: string;
  onChange: (v: string) => void;
  selectedIds: string[];
  onSelect: (guest: { id: string; name: string; email: string }) => void;
  /** Called when focus leaves the input (click away) — collapses the row. */
  onBlurAway?: () => void;
}) {
  const t = getTranslations('weldcalendar');
  const [open, setOpen] = useState(false);

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

  // Build unified results
  const results = useMemo(() => {
    const search = value.toLowerCase();
    const items: GuestResult[] = [];

    // Team members first
    for (const m of members) {
      if (selectedIds.includes(`member-${m.id}`)) continue;
      const name = m.name || m.email || '';
      const email = m.email || '';
      if (search && !name.toLowerCase().includes(search) && !email.toLowerCase().includes(search)) continue;
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
      const name = c.fullName || `${c.firstName} ${c.lastName}`.trim();
      items.push({
        id: `contact-${c.id}`,
        name,
        email: c.email ?? '',
        initial: (c.firstName?.[0] || c.email?.[0] || '?').toUpperCase(),
        type: 'contact',
      });
    }

    return items.slice(0, 8);
  }, [contacts, members, selectedIds, value]);

  const pickGuest = (e: React.MouseEvent, item: GuestResult) => {
    e.preventDefault();
    onSelect({ id: item.id, name: item.name, email: item.email });
    setOpen(false);
  };

  const showDropdown = open && value.length >= 1 && results.length > 0;
  const hasMembers = results.some((r) => r.type === 'member');
  const hasContacts = results.some((r) => r.type === 'contact');

  return (
    <div className="relative">
      <Input
        placeholder={t.eventPreview.searchMembersContacts}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); onBlurAway?.(); }, 150)}
        className="h-7 text-sm shadow-none border-0 px-0 focus-visible:ring-0"
        autoFocus
      />
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-lg shadow-lg z-50 max-h-[240px] overflow-y-auto">
          {hasMembers && (
            <div className="px-3 pt-2 pb-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t.eventPreview.teamMembersGroup}</span>
            </div>
          )}
          {results.filter((r) => r.type === 'member').map((item) => (
            <Button
              variant="ghost"
              key={item.id}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors"
              onMouseDown={(e) => pickGuest(e, item)}
            >
              <div className="h-[24px] w-[24px] rounded-[5.5px] bg-blue-500/10 flex items-center justify-center shrink-0">
                <span className="text-xs font-medium text-blue-600">{item.initial}</span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{item.name}</p>
                <p className="text-xs text-muted-foreground truncate">{item.email}</p>
              </div>
            </Button>
          ))}
          {hasMembers && hasContacts && <Separator />}
          {hasContacts && (
            <div className="px-3 pt-2 pb-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t.eventPreview.contactsGroup}</span>
            </div>
          )}
          {results.filter((r) => r.type === 'contact').map((item) => (
            <Button
              variant="ghost"
              key={item.id}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors"
              onMouseDown={(e) => pickGuest(e, item)}
            >
              <div className="h-[24px] w-[24px] rounded-[5.5px] bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-xs font-medium text-primary">{item.initial}</span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{item.name}</p>
                <p className="text-xs text-muted-foreground truncate">{item.email}</p>
              </div>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
