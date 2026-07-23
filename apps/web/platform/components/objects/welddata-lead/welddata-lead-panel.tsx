import { useAtomValue } from 'jotai';
import { ExternalLink, Globe, Linkedin } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  SimpleObjectPanel,
  SectionHeader,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { welddataLeadCacheAtom, type WelddataLeadPanelData } from './welddata-lead-data';

/** Profile photo / company logo, falling back to the domain favicon. */
function leadAvatarUrl(lead: WelddataLeadPanelData): string | undefined {
  if (lead.avatarUrl) return lead.avatarUrl;
  if (lead.domain) {
    const clean = lead.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (clean) {
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(clean)}&sz=64`;
    }
  }
  return undefined;
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

function LinkRow({
  icon: Icon,
  label,
  href,
}: {
  icon: typeof Globe;
  label: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

export function WelddataLeadPanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id } = props;
  const cache = useAtomValue(welddataLeadCacheAtom);
  const lead = cache[id] ?? null;

  const isCompany = lead?.kind === 'company';
  const displayName =
    lead?.name?.trim() ||
    lead?.companyName?.trim() ||
    lead?.email ||
    (isCompany ? t('sweep.entities.companyLabel') : t('sweep.entities.leadFallbackTitle'));
  const subtitle = isCompany
    ? lead?.industry ?? lead?.domain ?? undefined
    : lead?.title ?? lead?.companyName ?? undefined;

  const avatarUrl = lead ? leadAvatarUrl(lead) : undefined;
  const initial = (displayName?.trim()[0] ?? '#').toUpperCase();

  const fields = lead
    ? isCompany
      ? [
          { label: t('sweep.entities.fieldIndustry'), value: lead.industry },
          { label: t('sweep.entities.fieldWebsite'), value: lead.domain },
          { label: t('sweep.entities.fieldCompanySize'), value: lead.companySize },
          { label: t('sweep.entities.fieldLocation'), value: lead.location },
          { label: t('sweep.entities.fieldCountry'), value: lead.country },
        ]
      : [
          { label: t('sweep.entities.fieldEmail'), value: lead.email },
          { label: t('sweep.entities.fieldTitle'), value: lead.title },
          { label: t('sweep.entities.fieldCompany'), value: lead.companyName },
          { label: t('sweep.entities.fieldIndustry'), value: lead.industry },
          { label: t('sweep.entities.fieldWebsite'), value: lead.domain },
          { label: t('sweep.entities.fieldLocation'), value: lead.location },
          { label: t('sweep.entities.fieldCountry'), value: lead.country },
          { label: t('sweep.entities.fieldCompanySize'), value: lead.companySize },
        ]
    : undefined;

  return (
    <SimpleObjectPanel
      {...props}
      objectType="welddata-lead"
      isLoading={false}
      hasData={!!lead}
      title={lead ? displayName : undefined}
      subtitle={subtitle ?? undefined}
      avatar={
        lead ? (
          <Avatar className="h-7 w-7 rounded-lg border border-border">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} className="rounded-lg object-cover" />}
            <AvatarFallback className="rounded-lg bg-muted text-[12px] font-medium">
              {initial}
            </AvatarFallback>
          </Avatar>
        ) : undefined
      }
      statusBadges={
        lead && (
          <>
            <Badge variant="outline" className="capitalize">
              {lead.kind}
            </Badge>
            {lead.companySize && <Badge variant="secondary">{lead.companySize}</Badge>}
          </>
        )
      }
      fields={fields}
      extras={
        lead && (lead.linkedinUrl || lead.domain) ? (
          <>
            <SectionHeader>{t('sweep.entities.links')}</SectionHeader>
            {lead.linkedinUrl && (
              <LinkRow icon={Linkedin} label="LinkedIn" href={normalizeUrl(lead.linkedinUrl)} />
            )}
            {lead.domain && (
              <LinkRow icon={Globe} label={lead.domain} href={normalizeUrl(lead.domain)} />
            )}
          </>
        ) : null
      }
    />
  );
}
