import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { useLead } from '@/hooks/queries/use-leads-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  SectionHeader,
  ProseBlock,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';

export function LeadPanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id } = props;
  const { data, isLoading, error } = useLead(id);
  const lead = data?.data ?? null;

  const displayName =
    lead?.fullName?.trim() ||
    [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim() ||
    lead?.email ||
    t('sweep.entities.leadFallbackTitle');
  const subtitle = lead?.companyName ?? lead?.title ?? lead?.email ?? undefined;

  return (
    <SimpleObjectPanel
      {...props}
      objectType="lead"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!lead}
      title={lead ? displayName : undefined}
      subtitle={subtitle ?? undefined}
      statusBadges={lead && (
        <>
          {lead.status && <Badge variant="outline" className="capitalize">{lead.status}</Badge>}
          {lead.rating && (
            <Badge variant="outline" className="capitalize">
              {t('sweep.entities.ratingLabel', { rating: lead.rating })}
            </Badge>
          )}
          {lead.isQualified && <Badge variant="secondary">{t('sweep.entities.qualifiedLabel')}</Badge>}
        </>
      )}
      fields={
        lead
          ? [
              { label: t('sweep.entities.fieldEmail'), value: lead.email },
              { label: t('sweep.entities.fieldPhone'), value: lead.phone },
              { label: t('sweep.entities.fieldMobile'), value: lead.mobile },
              { label: t('sweep.entities.fieldTitle'), value: lead.title },
              { label: t('sweep.entities.fieldCompany'), value: lead.companyName },
              { label: t('sweep.entities.fieldWebsite'), value: lead.website },
              { label: t('sweep.entities.fieldSource'), value: lead.source },
              { label: t('sweep.entities.fieldChannel'), value: lead.channel },
              { label: t('sweep.entities.fieldCampaign'), value: lead.campaign },
              { label: t('sweep.entities.fieldScore'), value: lead.score?.toString() },
              { label: t('sweep.entities.fieldTimeline'), value: lead.timeline },
              { label: t('sweep.entities.fieldQualified'), value: formatPanelDate(lead.qualifiedAt) },
              { label: t('sweep.entities.fieldCreated'), value: formatPanelDate(lead.createdAt) },
            ]
          : undefined
      }
      extras={
        lead && (
          <>
            {lead.notes && (
              <>
                <SectionHeader>{t('sweep.entities.fieldNotes')}</SectionHeader>
                <ProseBlock>{lead.notes}</ProseBlock>
              </>
            )}
            {lead.nextAction && (
              <>
                <SectionHeader>{t('sweep.entities.nextAction')}</SectionHeader>
                <ProseBlock>{lead.nextAction}</ProseBlock>
              </>
            )}
          </>
        )
      }
    />
  );
}
