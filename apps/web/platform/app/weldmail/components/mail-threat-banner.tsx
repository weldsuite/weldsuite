import type { MailThreat } from '@weldsuite/app-api-client/schemas/mail-messages';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useI18n } from '@/lib/i18n/provider';
import { summarizeThreats } from '../lib/mail-threats';

/**
 * Shown above a received message whose `threats` is not empty: danger when a
 * file is infected or a link is known-malicious (the server moved the message
 * to Spam), a warning when there are only suspicious links.
 */
export function MailThreatBanner({ threats, className }: Readonly<{
  threats: readonly MailThreat[] | null | undefined;
  className?: string;
}>) {
  const { t } = useI18n();
  const summary = summarizeThreats(threats);
  if (!summary) return null;

  const copy = t.mail.messageDetail;
  return (
    <InfoBanner
      variant={summary.severity}
      title={summary.severity === 'danger' ? copy.threatBannerDanger : copy.threatBannerWarning}
      className={className}
      data-testid="mail-threat-banner"
    >
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
        {summary.files.map((file) => (
          <li key={`${file.fileName}|${file.signature}`} className="break-all">
            {copy.threatBlockedFile.replace('{fileName}', file.fileName).replace('{signature}', file.signature)}
          </li>
        ))}
        {summary.links.map((link) => (
          <li key={`${link.verdict}|${link.host}`} className="break-all">
            {(link.verdict === 'malicious' ? copy.threatDangerousLink : copy.threatSuspiciousLink).replace(
              '{host}',
              link.host,
            )}
          </li>
        ))}
      </ul>
    </InfoBanner>
  );
}
