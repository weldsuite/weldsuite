/**
 * "N things to process": the way from the overview to the To process page. Shown
 * only where the edition serves the to-process counts (`books-todo`) and
 * something is waiting; it refreshes with the sidebar badge's query.
 */

import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { isTodoAvailable, useTodoSummary } from '@/hooks/queries/use-weldbooks-todo-queries';
import { useI18n } from '@/lib/i18n/provider';
import { getLocale } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { Link } from '@/lib/router';

export const TO_PROCESS_HREF = '/weldbooks/to-process';

export function TodoCallout() {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.dashboard;
  const { data } = useTodoSummary();
  if (!isTodoAvailable() || !data || data.total <= 0) return null;
  return (
    <InfoBanner
      variant="info"
      title={plural(data.total, copy.calloutTitle, getLocale())}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href={TO_PROCESS_HREF}>{copy.calloutAction}</Link>
        </Button>
      }
    >
      {copy.calloutDescription}
    </InfoBanner>
  );
}
