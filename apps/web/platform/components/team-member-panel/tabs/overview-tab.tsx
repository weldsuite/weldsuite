import * as React from 'react';
import { Phone, MapPin, Link as LinkIcon, Briefcase, Save, X, Copy, Check } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { useUpdateMemberProfile } from '@/hooks/queries/use-team-queries';
import { toast } from 'sonner';
import type { MemberProfile, UpdateMemberProfileInput } from '@weldsuite/core-api-client/schemas/member-profile';
import { NotesTab } from './notes-tab';
import { useComposeSafe } from '@/contexts/compose-context';
import { useNow, formatLocalTime, formatTimezoneOffset } from '../use-now';

interface OverviewTabProps {
  profile: MemberProfile;
}

interface Draft {
  title: string;
  bio: string;
  phone: string;
  location: string;
  pronouns: string;
  hoursPerWeek: string;
}

function fromProfile(p: MemberProfile): Draft {
  return {
    title: p.title ?? '',
    bio: p.bio ?? '',
    phone: p.phone ?? '',
    location: p.location ?? '',
    pronouns: p.pronouns ?? '',
    hoursPerWeek: p.hoursPerWeek ?? '',
  };
}

export function OverviewTab({ profile }: OverviewTabProps) {
  const t = useTranslations();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(() => fromProfile(profile));
  const update = useUpdateMemberProfile(profile.userId);
  const now = useNow(30_000);
  const localTime = formatLocalTime(now, profile.timezone);
  const tzOffset = formatTimezoneOffset(now, profile.timezone);

  React.useEffect(() => {
    if (!editing) setDraft(fromProfile(profile));
  }, [profile, editing]);

  const handleSave = async () => {
    const patch: UpdateMemberProfileInput = {
      title: draft.title.trim() || null,
      bio: draft.bio.trim() || null,
      phone: draft.phone.trim() || null,
      location: draft.location.trim() || null,
      pronouns: draft.pronouns.trim() || null,
      hoursPerWeek: draft.hoursPerWeek.trim() ? Number(draft.hoursPerWeek) : null,
    };
    try {
      await update.mutateAsync(patch);
      setEditing(false);
      toast.success(t('sweep.shared.profileSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sweep.shared.failedToSaveProfile'));
    }
  };

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

  if (editing) {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t('sweep.shared.editProfile')}</h3>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={update.isPending}>
              <X className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={handleSave} disabled={update.isPending}>
              <Save className="h-4 w-4 mr-1" />
              {t('sweep.shared.save')}
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <Field label={t('sweep.shared.title')}>
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder={t('sweep.shared.titlePlaceholderExample')}
            />
          </Field>
          <Field label={t('sweep.shared.bio')}>
            <Textarea
              value={draft.bio}
              onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
              rows={4}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('sweep.shared.phone')}>
              <Input
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              />
            </Field>
            <Field label={t('sweep.shared.location')}>
              <Input
                value={draft.location}
                onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              />
            </Field>
            <Field label={t('sweep.shared.pronouns')}>
              <Input
                value={draft.pronouns}
                onChange={(e) => setDraft({ ...draft, pronouns: e.target.value })}
              />
            </Field>
            <Field label={t('sweep.shared.hoursPerWeek')}>
              <Input
                type="number"
                min={0}
                max={168}
                value={draft.hoursPerWeek}
                onChange={(e) => setDraft({ ...draft, hoursPerWeek: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">{t('sweep.shared.about')}</h3>
        </div>
        {profile.bio ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{profile.bio}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('sweep.shared.noBioYet')}</p>
        )}
      </div>

      <dl className="space-y-2 text-sm">
        {profile.email && (
          <InfoRow icon={null} label={t('sweep.shared.email')}>
            <CopyableEmail email={profile.email} />
          </InfoRow>
        )}
        {profile.phone && (
          <InfoRow icon={<Phone className="h-4 w-4" />} label={t('sweep.shared.phone')}>
            <a href={`tel:${profile.phone}`} className="hover:underline">{profile.phone}</a>
          </InfoRow>
        )}
        {profile.location && (
          <InfoRow icon={<MapPin className="h-4 w-4" />} label={t('sweep.shared.location')}>
            {profile.location}
          </InfoRow>
        )}
        {profile.pronouns && (
          <InfoRow icon={null} label={t('sweep.shared.pronouns')}>
            {profile.pronouns}
          </InfoRow>
        )}
        {profile.hoursPerWeek && (
          <InfoRow icon={<Briefcase className="h-4 w-4" />} label={t('sweep.shared.hoursPerWeek')}>
            {profile.hoursPerWeek}
          </InfoRow>
        )}
        <InfoRow icon={null} label={t('sweep.shared.role')}>
          {profile.role}
        </InfoRow>
        <InfoRow icon={null} label={t('sweep.shared.timezone')}>
          <span className="inline-flex items-center gap-1.5">
            <span>{profile.timezone}</span>
            <span className="text-muted-foreground">·</span>
            <span className="tabular-nums">{localTime}</span>
            {tzOffset && <span className="text-muted-foreground/70">({tzOffset})</span>}
          </span>
        </InfoRow>
      </dl>

      {workingHoursSchedule && (
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('sweep.shared.workingHours')}
          </h4>
          <ul className="divide-y divide-border/50 text-sm">
            {workingHoursSchedule.map((d) => (
              <li key={d.key} className="flex items-center justify-between py-2">
                <span className="text-foreground">{d.label}</span>
                {d.hours?.isOpen ? (
                  <span className="tabular-nums text-muted-foreground">
                    {d.hours.openTime ?? '—'}
                    {' – '}
                    {d.hours.closeTime ?? '—'}
                    {d.hours.breaks?.length ? (
                      <span className="ml-2 text-xs">
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
                  <span className="tabular-nums text-muted-foreground">{t('sweep.shared.notWorking')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {profile.links && profile.links.length > 0 && (
        <div>
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

      <NotesTab userId={profile.userId} embedded />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
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

  return (
    <span className="group inline-flex items-center gap-1.5">
      <Button
        type="button"
        variant="ghost"
        onClick={handleCompose}
        className="hover:underline text-left"
      >
        {email}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleCopy}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded-[6px] hover:bg-muted"
        title={copied ? t('sweep.shared.copied') : t('sweep.shared.copyEmail')}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </span>
  );
}

function InfoRow({
  icon,
  label,
  children,
}: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="flex w-28 shrink-0 items-center gap-2 text-muted-foreground">
        {icon}
        <span>{label}</span>
      </dt>
      <dd className="flex-1 break-words">{children}</dd>
    </div>
  );
}
