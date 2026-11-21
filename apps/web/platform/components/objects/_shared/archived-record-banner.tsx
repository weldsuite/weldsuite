/**
 * Shown under the header of an archived company or person: archiving only
 * changed the kebab menu to "Unarchive", so an archived record looked like
 * any other (TASK-1462).
 */

import { Archive } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';

export function ArchivedRecordBanner({
  message,
  onUnarchive,
  pending = false,
}: Readonly<{ message: string; onUnarchive: () => void; pending?: boolean }>) {
  const st = useTranslations();
  return (
    <InfoBanner
      variant="neutral"
      icon={Archive}
      className="mx-4 mt-2"
      action={
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onUnarchive}>
          {st('sweep.entities.unarchive')}
        </Button>
      }
    >
      {message}
    </InfoBanner>
  );
}
