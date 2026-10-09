import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { useI18n } from '@/lib/i18n/provider';

interface MissingSettingsProps {
  /** What the server says is missing: `nextCheckNumber`, `immediateDestination`, ... */
  missing: readonly string[];
  bankAccountId: string;
  /** What the missing settings are needed for. */
  title: string;
  /** A person who can't change settings is told whom to ask instead of offered a link. */
  canEdit: boolean;
}

/** The settings of a bank account that a check run or an ACH file still needs, with the way to the settings page. */
export function MissingSettings({ missing, bankAccountId, title, canEdit }: Readonly<MissingSettingsProps>) {
  const { t } = useI18n();
  const ts = t.weldbooksUs.payments.settings;
  const labels: Readonly<Record<string, string>> = ts.missing;

  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-0.5 pl-4">
          {missing.map((code) => (
            <li key={code}>{labels[code] ?? code}</li>
          ))}
        </ul>
        {canEdit ? (
          <Link
            to="/weldbooks/payment-runs/settings/$bankAccountId"
            params={{ bankAccountId }}
            className="mt-2 inline-block font-medium underline underline-offset-2"
          >
            {ts.openSettings}
          </Link>
        ) : (
          <p className="mt-2">{ts.askManager}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
