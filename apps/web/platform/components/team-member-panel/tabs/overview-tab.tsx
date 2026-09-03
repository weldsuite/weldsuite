/**
 * Member profile "Details" tab.
 *
 * Laid out to match the WeldCRM person panel (components/objects/person/
 * person-panel.tsx): a `p-4 space-y-1` column of `PropertyRow`s — icon, label,
 * inline-editable value — rather than the old read-only `<dl>` plus a separate
 * full-form edit mode. Rows render even when empty so the panel shows a stable
 * field list with "Set …" affordances, exactly like the person panel.
 */

import * as React from 'react';
import {
  Briefcase,
  Clock,
  Globe,
  Link as LinkIcon,
  Mail,
  MapPin,
  Phone,
  Shield,
  Smile,
  StickyNote,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Copy, Check } from 'lucide-react';
import { useUpdateMemberProfile } from '@/hooks/queries/use-team-queries';
import { toast } from 'sonner';
import type { MemberProfile, UpdateMemberProfileInput } from '@weldsuite/core-api-client/schemas/member-profile';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { getRoleLabel } from '../role-label';
import { NotesTab } from './notes-tab';
import { useComposeSafe } from '@/contexts/compose-context';
import { useNow, formatLocalTime, formatTimezoneOffset } from '../use-now';

interface OverviewTabProps {
  profile: MemberProfile;
}

export function OverviewTab({ profile }: OverviewTabProps) {
  const t = useTranslations();
  const update = useUpdateMemberProfile(profile.userId);
  const now = useNow(30_000);
  const localTime = formatLocalTime(now, profile.timezone);
  const tzOffset = formatTimezoneOffset(now, profile.timezone);

  // Authoritative edit gate, computed server-side in services/team/profile.ts
  // as `viewer.userId === subjectUserId || viewer.isAdmin` — the exact rule
  // PATCH /user/:userId/profile enforces before writing. Read it off the
  // payload rather than recomputing here so the rows can never offer an edit
  // the API would reject with FORBIDDEN.
  const canEdit = profile.canEdit;

  // One shared committer for every inline row — mirrors the person panel's
  // single `handleUpdateField`. Each row sends only its own key.
  const saveField = React.useCallback(
    async (patch: UpdateMemberProfileInput) => {
      if (!canEdit) return;
      try {
        await update.mutateAsync(patch);
        toast.success(t('sweep.shared.profileSaved'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('sweep.shared.failedToSaveProfile'));
      }
    },
    [canEdit, update, t],
  );

  const workingHoursSchedule = React.useMemo(() => {
    const days: Array<{ key: keyof NonNullable<MemberProfile['workingHours']>; label: string }> = [
      { key: 'monday', label: t('sweep.shared.weekday.monday') },
      { key: 'tuesday', label: t('sweep.shared.weekday.tuesday') },
      { key: 'wednesday', label: t('sweep.shared.weekday.wednesday') },
      { key: 'thursday', label: t('sweep.shared.weekday.thursday') },
      { key: 'friday', label: t('sweep.shared.weekday.friday') },
      { key: 'saturday', label: t('sweep.shared.weekday.saturday') },
      { key: 'sunday', label: t('sweep.shared.weekday.sunday') },
    ];
    const wh = profile.workingHours;
    if (!wh) return null;
    const hasAnyOpen = days.some((d) => wh[d.key]?.isOpen);
    if (!hasAnyOpen) return null;
    return days.map((d) => ({ ...d, hours: wh[d.key] }));
  }, [profile.workingHours, t]);

  return (
    <div className="p-4 space-y-1">
      <PropertyRow
        icon={Briefcase}
        label={t('sweep.shared.title')}
        value={profile.title}
        readOnly={!canEdit}
        onSave={(v) => saveField({ title: v })}
      />
      <PropertyRow
        icon={StickyNote}
        label={t('sweep.shared.bio')}
        type="address"
        value={profile.bio}
        readOnly={!canEdit}
        onSave={(v) => saveField({ bio: v })}
      />
      <PropertyRow
        icon={Mail}
        label={t('sweep.shared.email')}
        type="email"
        value={profile.email}
        readOnly
        renderValue={(v) => (v ? <CopyableEmail email={v} /> : null)}
      />
      <PropertyRow
        icon={Phone}
        label={t('sweep.shared.phone')}
        type="phone"
        value={profile.phone}
        readOnly={!canEdit}
        onSave={(v) => saveField({ phone: v })}
      />
      <PropertyRow
        icon={MapPin}
        label={t('sweep.shared.location')}
        value={profile.location}
        readOnly={!canEdit}
        onSave={(v) => saveField({ location: v })}
      />
      <PropertyRow
        icon={Smile}
        label={t('sweep.shared.pronouns')}
        value={profile.pronouns}
        readOnly={!canEdit}
        onSave={(v) => saveField({ pronouns: v })}
      />
      <PropertyRow
        icon={Clock}
        label={t('sweep.shared.hoursPerWeek')}
        value={profile.hoursPerWeek}
        // The API takes a number; an unparseable entry clears the field rather
        // than sending NaN (which the Zod schema would reject).
        readOnly={!canEdit}
        onSave={(v) => {
          const trimmed = v?.trim();
          const parsed = trimmed ? Number(trimmed) : NaN;
          saveField({ hoursPerWeek: Number.isFinite(parsed) ? parsed : null });
        }}
      />
      <PropertyRow
        icon={Shield}
        label={t('sweep.shared.role')}
        // Humanised — the raw enum rendered as a shouted "OWNER" next to
        // sentence-case values everywhere else in the column.
        value={profile.role ? getRoleLabel(profile.role) : null}
        readOnly
      />
      <PropertyRow
        icon={Globe}
        label={t('sweep.shared.timezone')}
        value={profile.timezone}
        readOnly
        renderValue={(v) => (
          <span className="inline-flex items-center gap-1.5">
            <span>{v}</span>
            <span className="text-muted-foreground">·</span>
            <span className="tabular-nums">{localTime}</span>
            {tzOffset && <span className="text-muted-foreground/70">({tzOffset})</span>}
          </span>
        )}
      />

      {workingHoursSchedule && (
        <div className="pt-6">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('sweep.shared.workingHours')}
          </h4>
          {/* Same 120px label / 1fr value grid and 32px row height as
              PropertyRow above, so the day rows read as a continuation of the
              field column instead of a separate table. */}
          <ul className="space-y-1">
            {workingHoursSchedule.map((d) => (
              <li
                key={d.key}
                className="grid grid-cols-[120px_1fr] gap-2 items-center min-h-[32px] text-sm"
              >
                <span className="text-muted-foreground">{d.label}</span>
                {d.hours?.isOpen ? (
                  <span className="tabular-nums">
                    {d.hours.openTime ?? '—'}
                    {' – '}
                    {d.hours.closeTime ?? '—'}
                    {d.hours.breaks?.length ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({t(d.hours.breaks.length === 1 ? 'sweep.shared.breakCountOne' : 'sweep.shared.breakCountOther', { count: d.hours.breaks.length })}
                        {' '}
                        {d.hours.breaks
                          .map((b) => `${b.start}–${b.end}`)
                          .join(', ')}
                        )
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground/70">{t('sweep.shared.notWorking')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {profile.links && profile.links.length > 0 && (
        <div className="pt-6">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('sweep.shared.links')}</h4>
          <ul className="space-y-1 text-sm">
            {profile.links.map((link, i) => (
              <li key={i}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 hover:underline"
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="pt-6">
        <NotesTab userId={profile.userId} embedded />
      </div>
    </div>
  );
}

function CopyableEmail({ email }: { email: string }) {
  const t = useTranslations();
  const [copied, setCopied] = React.useState(false);
  const composeContext = useComposeSafe();

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      toast.success(t('sweep.shared.emailCopiedToClipboard'));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('sweep.shared.failedToCopy'));
    }
  };

  const handleCompose = (e: React.MouseEvent) => {
    e.preventDefault();
    composeContext?.openCompose({ to: email });
  };

  // Deliberately NOT <Button>: inside a PropertyRow value cell the ghost
  // Button's own padding and h-9 min-height pushed the address ~12px right of
  // every other value and made this row taller than its neighbours. Bare
  // elements keep the address on the same baseline and left edge as the rest
  // of the column.
  return (
    <span className="group/email inline-flex items-center gap-1.5 min-w-0">
      <button
        type="button"
        onClick={handleCompose}
        className="truncate text-left hover:underline focus-visible:outline-none focus-visible:underline"
      >
        {email}
      </button>
      <button
        type="button"
        onClick={handleCopy}
        className="flex-shrink-0 opacity-0 group-hover/email:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground rounded-[6px] p-0.5 hover:bg-muted"
        title={copied ? t('sweep.shared.copied') : t('sweep.shared.copyEmail')}
        aria-label={copied ? t('sweep.shared.copied') : t('sweep.shared.copyEmail')}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
