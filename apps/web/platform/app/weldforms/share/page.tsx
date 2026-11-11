/**
 * Share tab of a form: the public link, a QR code, the embed configurator, the
 * prefill / hidden-field URL builder and email invitations. Sharing is switched
 * off with an explanation while the form is a draft, and a suspended or held
 * form says so first.
 */

import { useParams } from '@tanstack/react-router';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useI18n } from '@/lib/i18n/provider';
import { FormGate, FormTabFrame } from '../results/form-gate';
import { EmailSection } from './email-section';
import { EmbedCard } from './embed-card';
import { LinkCard } from './link-card';
import { PrefillCard } from './prefill-card';
import { QrCard } from './qr-card';

export default function ShareTabPage() {
  const { formId = '' } = useParams({ strict: false });
  return <FormGate formId={formId}>{(form) => <ShareContent key={form.id} form={form} />}</FormGate>;
}

function ShareContent({ form }: Readonly<{ form: FormDetail }>) {
  const { t, format } = useI18n();
  const ts = t.weldformsResults.share;
  const draft = form.status === 'draft' || form.publicUrl === null;
  const moderation = form.moderation;

  return (
    <FormTabFrame>
      {moderation && (
        <InfoBanner variant="danger">
          <p className="font-medium">
            {moderation.state === 'suspended' ? ts.moderationSuspendedTitle : ts.moderationHeldTitle}
          </p>
          <p>{moderation.state === 'suspended' ? ts.moderationSuspendedDescription : ts.moderationHeldDescription}</p>
          {moderation.reason && <p>{format(ts.moderationReason, { reason: moderation.reason })}</p>}
        </InfoBanner>
      )}
      {draft && (
        <InfoBanner variant="warning">
          <p className="font-medium">{ts.draftTitle}</p>
          <p>{ts.draftDescription}</p>
        </InfoBanner>
      )}
      {!draft && form.status === 'closed' && (
        <InfoBanner variant="neutral">
          <p className="font-medium">{ts.closedTitle}</p>
          <p>{ts.closedDescription}</p>
        </InfoBanner>
      )}

      <LinkCard form={form} shareable={!draft} />
      <QrCard form={form} shareable={!draft} />
      <EmbedCard form={form} shareable={!draft} />
      <PrefillCard form={form} shareable={!draft} />
      <EmailSection form={form} shareable={!draft} />
    </FormTabFrame>
  );
}
