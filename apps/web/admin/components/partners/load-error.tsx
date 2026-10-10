import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { partnersCopy } from '@/lib/partners-copy';

/** Shown instead of a partner screen when the billing worker could not answer. */
export function LoadError({ code, message }: Readonly<{ code?: string; message: string }>) {
  const t = partnersCopy().common;
  return (
    <Alert variant="destructive">
      <AlertTitle>{t.loadFailed}</AlertTitle>
      <AlertDescription>{code === 'NOT_CONFIGURED' ? t.notConfigured : message}</AlertDescription>
    </Alert>
  );
}
