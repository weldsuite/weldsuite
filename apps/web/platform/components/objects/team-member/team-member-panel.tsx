/**
 * Team-member object panel — composes the standard EntityDetailView shell so
 * it stacks identically with Customer and Contact. Loads its data from the
 * new app-api (`GET /api/team-members/:userId`).
 *
 * Scope for "for now":
 *   - Overview tab with profile fields (title, bio, email, phone, location,
 *     pronouns, timezone, links).
 * Notes / common-concepts tabs will land later — the endpoints are already
 * wired in app-api, just not surfaced here yet.
 */

import { useState } from 'react';
import { Mail, Phone, EllipsisVertical, LayoutGrid, ExternalLink } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  ObjectPanelTabs,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { StatusDot } from '@weldsuite/ui/components/status-dot';
import { usePresence } from '@/contexts/presence-context';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { MemberProfile } from '@weldsuite/core-api-client/schemas/member-profile';
import { useTeamMemberProfile } from './use-team-member-data';

const TEAM_MEMBER_PANEL_WIDTH = 400;

function getDisplayName(p: MemberProfile | undefined, fallbackLabel: string): string {
  if (!p) return '';
  return p.name || p.email || fallbackLabel;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function MemberAvatar({ profile }: { profile?: MemberProfile }) {
  const t = useTranslations();
  const { getStatus } = usePresence();
  const presence = profile ? getStatus(profile.userId) : undefined;

  if (!profile) return <div className="h-7 w-7 rounded-lg bg-muted animate-pulse" />;

  const displayName = getDisplayName(profile, t('sweep.entities.teamMemberFallback'));
  const inner = profile.picture ? (
    <img
      src={profile.picture}
      alt={displayName}
      className="h-7 w-7 rounded-lg object-cover"
    />
  ) : (
    <div className="h-7 w-7 rounded-lg flex items-center justify-center text-[11px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200">
      {getInitials(displayName) || '?'}
    </div>
  );

  return (
    <div className="relative inline-flex">
      {inner}
      <span className="absolute -bottom-0.5 -right-0.5">
        <StatusDot status={presence?.status ?? 'offline'} size="sm" showTooltip />
      </span>
    </div>
  );
}

function MemberTitle({ profile }: { profile?: MemberProfile }) {
  const t = useTranslations();
  const { getStatus } = usePresence();
  const presence = profile ? getStatus(profile.userId) : undefined;

  if (!profile) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;

  const customStatus = presence?.statusText || presence?.statusEmoji
    ? `${presence.statusEmoji ?? ''} ${presence.statusText ?? ''}`.trim()
    : null;

  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[15px] font-medium text-foreground truncate">
        {getDisplayName(profile, t('sweep.entities.teamMemberFallback'))}
      </span>
      {customStatus ? (
        <span className="text-xs text-muted-foreground truncate">{customStatus}</span>
      ) : null}
    </div>
  );
}

function MemberActions({ profile }: { profile?: MemberProfile }) {
  const t = useTranslations();
  if (!profile) return null;
  const phone = profile.phone;
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="ghost"
              className="p-1.5 hover:bg-muted rounded-md transition-colors disabled:opacity-50 h-auto w-auto"
              onClick={() => {
                if (profile.email) window.location.href = `mailto:${profile.email}`;
              }}
              disabled={!profile.email}
              aria-label={t('sweep.entities.composeEmail')}
            >
              <Mail className="h-4 w-4 text-muted-foreground" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {profile.email ? t('sweep.entities.composeEmail') : t('sweep.entities.noEmailOnRecord')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="ghost"
              className="p-1.5 hover:bg-muted rounded-md transition-colors disabled:opacity-50 h-auto w-auto"
              onClick={() => {
                if (phone) window.location.href = `tel:${phone}`;
              }}
              disabled={!phone}
              aria-label={t('sweep.entities.call')}
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{phone ? t('sweep.entities.call') : t('sweep.entities.noPhoneOnRecord')}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none h-auto w-auto"
            aria-label={t('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled>{t('sweep.entities.openFullPage')}</DropdownMenuItem>
          <DropdownMenuItem disabled>{t('sweep.entities.editProfile')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-foreground break-words">{value}</div>
    </div>
  );
}

function LinksList({ profile }: { profile: MemberProfile }) {
  const t = useTranslations();
  if (!profile.links || profile.links.length === 0) return null;
  return (
    <div className="pt-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
        {t('sweep.entities.links')}
      </div>
      <ul className="space-y-1">
        {profile.links.map((l, i) => (
          <li key={i}>
            <a
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OverviewTab({ profile }: { profile?: MemberProfile }) {
  const t = useTranslations();
  if (!profile) return null;
  return (
    <div className="p-4 space-y-1">
      <FieldRow label={t('sweep.entities.fieldEmail')} value={profile.email} />
      <FieldRow label={t('sweep.entities.fieldTitle')} value={profile.title} />
      <FieldRow label={t('sweep.entities.fieldRole')} value={profile.role} />
      <FieldRow label={t('sweep.entities.fieldStatus')} value={profile.status} />
      <FieldRow label={t('sweep.entities.fieldPhone')} value={profile.phone} />
      <FieldRow label={t('sweep.entities.fieldLocation')} value={profile.location} />
      <FieldRow label={t('sweep.entities.fieldPronouns')} value={profile.pronouns} />
      <FieldRow label={t('sweep.entities.fieldTimezone')} value={profile.timezone} />
      {profile.bio ? (
        <div className="pt-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
            {t('sweep.entities.bio')}
          </div>
          <div className={cn('text-sm whitespace-pre-wrap text-foreground')}>{profile.bio}</div>
        </div>
      ) : null}
      <LinksList profile={profile} />
    </div>
  );
}

export function TeamMemberPanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const profileQuery = useTeamMemberProfile(props.id);
  const profile = profileQuery.data;
  const shell = useObjectPanelShell({
    ...props,
    width: TEAM_MEMBER_PANEL_WIDTH,
    loading: profileQuery.isLoading && !profile,
  });

  const [activeTab, setActiveTab] = useState<string>(props.initialTab ?? 'overview');

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={<MemberAvatar profile={profile} />}
      title={<MemberTitle profile={profile} />}
      actions={<MemberActions profile={profile} />}
      tabs={
        <ObjectPanelTabs
          tabs={[{ id: 'overview', label: t('sweep.entities.overviewTab'), icon: LayoutGrid }]}
          activeTab={activeTab}
          onChange={setActiveTab}
        />
      }
    >
      <OverviewTab profile={profile} />
    </EntityDetailView>
  );
}
