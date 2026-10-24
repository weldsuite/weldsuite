/**
 * WeldDesk auto-assignment — who gets new conversations, and how.
 *
 * Rules: `/api/desk/assignment` (desk-api). The assignment itself happens
 * where customer messages arrive (widget, email), through the per-workspace
 * AssignmentRouter (ADR DESK-005).
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Switch } from '@weldsuite/ui/components/switch';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';
import {
  useDeskAssignment,
  useSetDeskAway,
  useUpdateDeskAssignment,
  type DeskAssignmentMode,
  type DeskAssignmentUpdate,
} from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';

const MODES: DeskAssignmentMode[] = ['off', 'round_robin', 'balanced'];
const DEFAULT_CAP = 10;

function sameRules(a: DeskAssignmentUpdate, b: DeskAssignmentUpdate): boolean {
  return (
    a.mode === b.mode &&
    a.maxOpenPerMember === b.maxOpenPerMember &&
    a.memberIds.length === b.memberIds.length &&
    a.memberIds.every((id) => b.memberIds.includes(id))
  );
}

export default function DeskAssignmentSettingsPage() {
  const t = getTranslations('deskInbox2');
  const ta = t.assignment;
  const canEdit = useCan('welddesk:settings:update');
  const { data: settings, isLoading } = useDeskAssignment();
  const { data: members = [], isLoading: membersLoading } = useDeskWorkspaceMembers();
  const update = useUpdateDeskAssignment();
  const setAway = useSetDeskAway();
  const [draft, setDraft] = useState<DeskAssignmentUpdate | null>(null);
  const [query, setQuery] = useState('');

  useBreadcrumbs([
    { label: t.breadcrumb.home, href: '/welddesk/inbox' },
    { label: ta.title },
  ]);

  useEffect(() => {
    if (settings) {
      setDraft({ mode: settings.mode, memberIds: settings.memberIds, maxOpenPerMember: settings.maxOpenPerMember });
    }
  }, [settings]);

  const visibleMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = members.filter((m) => m.status?.toUpperCase() !== 'REMOVED');
    return q ? list.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(q)) : list;
  }, [members, query]);

  if (isLoading || !settings || !draft) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const saved: DeskAssignmentUpdate = {
    mode: settings.mode,
    memberIds: settings.memberIds,
    maxOpenPerMember: settings.maxOpenPerMember,
  };
  const dirty = !sameRules(draft, saved);
  const away = new Set(settings.awayMemberIds);
  const disabled = !canEdit || update.isPending;

  const toggleMember = (userId: string, on: boolean) =>
    setDraft((d) =>
      d && { ...d, memberIds: on ? [...d.memberIds, userId] : d.memberIds.filter((id) => id !== userId) },
    );

  const save = async () => {
    try {
      await update.mutateAsync(draft);
      toast.success(ta.saved);
    } catch {
      toast.error(ta.saveError);
    }
  };

  const toggleAway = async (nextAway: boolean) => {
    try {
      await setAway.mutateAsync(nextAway);
      toast.success(nextAway ? ta.nowAway : ta.nowAvailable);
    } catch {
      toast.error(ta.awayError);
    }
  };

  const modeLabel: Record<DeskAssignmentMode, { title: string; description: string }> = {
    off: { title: ta.modeOff, description: ta.modeOffDescription },
    round_robin: { title: ta.modeRoundRobin, description: ta.modeRoundRobinDescription },
    balanced: { title: ta.modeBalanced, description: ta.modeBalancedDescription },
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="container max-w-3xl mx-auto p-4 md:p-6 space-y-6" data-testid="desk-assignment-settings">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{ta.title}</h1>
            <p className="text-sm text-muted-foreground">{ta.description}</p>
          </div>
          {canEdit && (
            <Button onClick={() => void save()} disabled={!dirty || update.isPending} data-testid="desk-assignment-save">
              {update.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {ta.save}
            </Button>
          )}
        </div>

        {settings.me.inRotation && (
          <Card>
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-medium">{ta.yourStatus}</p>
                <p className="text-sm text-muted-foreground">
                  {settings.me.away ? ta.yourStatusAway : ta.yourStatusAvailable}
                </p>
              </div>
              <Switch
                checked={!settings.me.away}
                disabled={setAway.isPending}
                onCheckedChange={(available) => void toggleAway(!available)}
                aria-label={ta.yourStatus}
                data-testid="desk-assignment-away-switch"
              />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ta.modeTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={draft.mode}
              onValueChange={(value) => setDraft((d) => d && { ...d, mode: value as DeskAssignmentMode })}
              disabled={disabled}
              className="gap-3"
            >
              {MODES.map((mode) => (
                <Label
                  key={mode}
                  htmlFor={`desk-assignment-${mode}`}
                  className="flex items-start gap-3 rounded-lg border border-border p-3 font-normal cursor-pointer has-[:checked]:border-primary"
                >
                  <RadioGroupItem id={`desk-assignment-${mode}`} value={mode} className="mt-0.5" />
                  <span>
                    <span className="block font-medium">{modeLabel[mode].title}</span>
                    <span className="block text-sm text-muted-foreground">{modeLabel[mode].description}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </CardContent>
        </Card>

        <Card className={draft.mode === 'off' ? 'opacity-60' : undefined}>
          <CardHeader>
            <CardTitle className="text-base">{ta.membersTitle}</CardTitle>
            <CardDescription>{ta.membersDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {members.length > 8 && (
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={ta.searchMembers}
                  className="pl-8"
                />
              </div>
            )}
            {membersLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <ul className="divide-y divide-border rounded-lg border border-border">
              {visibleMembers.map((member) => {
                const checked = draft.memberIds.includes(member.userId);
                return (
                  <li key={member.userId}>
                    <Label className="flex items-center gap-3 px-3 py-2.5 font-normal cursor-pointer">
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={(on) => toggleMember(member.userId, on === true)}
                        data-testid="desk-assignment-member"
                      />
                      <Avatar className="h-7 w-7">
                        {member.picture && <AvatarImage src={member.picture} />}
                        <AvatarFallback className="text-xs">{member.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{member.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
                      </span>
                      {checked && away.has(member.userId) && <Badge variant="secondary">{ta.awayBadge}</Badge>}
                    </Label>
                  </li>
                );
              })}
            </ul>
            {draft.mode !== 'off' && draft.memberIds.length === 0 && (
              <p className="text-sm text-amber-700 dark:text-amber-400">{ta.noMembersWarning}</p>
            )}
          </CardContent>
        </Card>

        <Card className={draft.mode === 'off' ? 'opacity-60' : undefined}>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">{ta.capTitle}</p>
                <p className="text-sm text-muted-foreground">{ta.capDescription}</p>
              </div>
              <Switch
                checked={draft.maxOpenPerMember !== null}
                disabled={disabled}
                onCheckedChange={(on) => setDraft((d) => d && { ...d, maxOpenPerMember: on ? DEFAULT_CAP : null })}
                aria-label={ta.capTitle}
              />
            </div>
            {draft.maxOpenPerMember !== null && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={draft.maxOpenPerMember}
                  disabled={disabled}
                  onChange={(e) => {
                    const value = Number.parseInt(e.target.value, 10);
                    setDraft((d) => d && { ...d, maxOpenPerMember: Number.isFinite(value) && value > 0 ? Math.min(value, 1000) : 1 });
                  }}
                  className="w-24"
                  aria-label={ta.capTitle}
                />
                <span className="text-sm text-muted-foreground">{ta.capUnit}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
