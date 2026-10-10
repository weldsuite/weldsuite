import { useAtomValue } from 'jotai';
import { ExternalLink, Globe, Linkedin } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  SimpleObjectPanel,
  SectionHeader,
  type ObjectPanelComponentProps,
  type SimpleObjectPanelProps,
} from '@/components/objects/_shared/simple-object-panel';
import { useCompanyLogo } from '@/lib/crm/company-logo';
import { welddataLeadCacheAtom } from './welddata-lead-data';

function normalizeUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

function LinkRow({
  icon: Icon,
  label,
  href,
}: Readonly<{
  icon: typeof Globe;
  label: string;
  href: string;
}>) {
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

export function WelddataLeadPanel(props: Readonly<ObjectPanelComponentProps>) {
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

  // Profile photo / company logo from the provider, else the logo our API found
  // on the company's own website (never a third-party favicon service).
  const companyLogo = useCompanyLogo(lead?.avatarUrl ? undefined : lead?.domain);
  const avatarUrl = lead?.avatarUrl || companyLogo || undefined;
  const initial = (displayName?.trim()[0] ?? '#').toUpperCase();

  let fields: SimpleObjectPanelProps['fields'];
  if (lead) {
    fields = isCompany
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
        ];
  }

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
