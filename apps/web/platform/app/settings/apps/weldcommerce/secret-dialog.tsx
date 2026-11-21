/**
 * Shows a new storefront key's secret, once. The API returns the secret only
 * when a key is created or rotated and never again, so the dialog does not
 * close by accident: Escape, a click outside and the corner button are off,
 * and Done is the way out. The secret lives in the caller's state and is
 * dropped when the dialog closes.
 *
 * The copy field and button are the shared `CopyBox` (`lib/copy-box.tsx`),
 * which follows the Modern Web Guidance copy-button guide.
 */

import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import type { ChannelKeySecret } from '@/hooks/queries/use-commerce-channels-queries';
import { getTranslations } from '@/lib/i18n';
import { CopyBox } from '@/app/weldcommerce/lib/copy-box';
import { fill } from '@/app/weldcommerce/lib/text';

export function SecretDialog({
  secret,
  rotated,
  onClose,
}: Readonly<{
  /** The key and its secret; null closes the dialog. */
  secret: ChannelKeySecret | null;
  /** The secret is a rotated key's replacement. */
  rotated?: boolean;
  onClose: () => void;
}>) {
  const t = getTranslations('commerce').channels.keys.secret;

  return (
    <Dialog open={secret !== null} onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        className="max-w-xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{rotated ? t.rotatedTitle : t.title}</DialogTitle>
          <DialogDescription>{secret ? fill(t.description, { name: secret.key.name }) : ''}</DialogDescription>
        </DialogHeader>
        <InfoBanner variant="warning">
          <strong className="block">{t.warningTitle}</strong>
          {t.warning}
        </InfoBanner>
        {secret && <CopyBox value={secret.secret} label={secret.key.name} labels={t} testId="key-secret" />}
        {secret && rotated && <p className="text-sm text-muted-foreground">{t.rotatedHint}</p>}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
