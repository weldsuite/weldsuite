/**
 * What the App Store needs to know about a partner-managed workspace: which
 * apps its licence leaves out, and how to ask the partner to add one.
 */

import { useCallback } from 'react';
import { useOrganization } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { useManagedBilling } from '@/hooks/queries/use-partner-queries';
import { useI18n } from '@/lib/i18n/provider';
import { safeHttpUrl } from '@/lib/partner/safe-url';
import { supportMailto } from './partner-contact';

export function useAppLicence() {
  const { t, format } = useI18n();
  const { organization } = useOrganization();
  const { data: managed } = useManagedBilling();

  /** True when this workspace is partner-managed and its licence leaves the app out. */
  const isUnlicensed = useCallback(
    (appCode: string): boolean => {
      if (!managed) return false;
      const allowed = managed.licence.allowedApps;
      return !allowed.includes('*') && !allowed.includes(appCode);
    },
    [managed],
  );

  /** Open the partner's support email (prefilled) or support page. */
  const askPartner = useCallback(
    (app: { code: string; name: string }) => {
      if (!managed) return;
      const { partner } = managed;
      const ta = t.partner.appStore;
      if (partner.supportEmail) {
        const subject = format(ta.mailSubject, { app: app.name });
        const body = format(ta.mailBody, { app: app.name, workspace: organization?.name ?? '' });
        window.location.href = supportMailto(partner.supportEmail, subject, body);
        return;
      }
      const url = safeHttpUrl(partner.supportUrl) ?? safeHttpUrl(partner.websiteUrl);
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      toast.info(format(ta.notLicensedHint, { partner: partner.name }));
    },
    [managed, organization?.name, t, format],
  );

  return { managed: managed ?? null, isUnlicensed, askPartner };
}
