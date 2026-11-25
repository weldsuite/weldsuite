import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InsufficientCreditsNotice } from '@/app/weldmeet/components/recording-ai-options';
import { parseInsufficientCredits } from '@/lib/weldmeet/recording';
import { getTranslations } from '@/lib/i18n';
import { shippingErrorInfo } from '../lib/errors';

interface ShippingErrorNoticeProps {
  error: unknown;
  /** The headline for a failure that is not "not enough credits". */
  title: string;
}

/**
 * A failed carrier call: the credit top-up notice for a 402, otherwise the
 * headline, the carrier's explanation and the reasons it listed.
 */
export function ShippingErrorNotice({ error, title }: Readonly<ShippingErrorNoticeProps>) {
  const t = getTranslations('weldstash').shipping.errors;
  const credits = parseInsufficientCredits(error);
  if (credits) return <InsufficientCreditsNotice details={credits} />;

  const info = shippingErrorInfo(error, t, t.generic);
  return (
    <InfoBanner variant="danger" title={title}>
      <p>{info.message}</p>
      {info.messages.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {info.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </InfoBanner>
  );
}
