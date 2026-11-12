import { useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import type { FormDefinition, FormThemeTokens } from '@weldsuite/forms-engine';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useI18n } from '@/lib/i18n/provider';
import { FormPreview, type PreviewDevice } from './form-preview';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  definition: FormDefinition;
  theme?: FormThemeTokens;
}

/** Fills in the real form without storing anything. */
export function PreviewDialog({ open, onOpenChange, definition, theme }: Readonly<Props>) {
  const { t } = useI18n();
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] max-w-5xl flex-col gap-3 sm:max-w-5xl">
        <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 pr-8">
          <div className="min-w-0">
            <DialogTitle>{t.weldforms.preview.title}</DialogTitle>
            <DialogDescription>{t.weldforms.preview.description}</DialogDescription>
          </div>
          <ToggleGroup type="single" value={device} onValueChange={(v) => v && setDevice(v as PreviewDevice)} variant="outline" size="sm">
            <ToggleGroupItem value="desktop" aria-label={t.weldforms.preview.desktop}>
              <Monitor className="size-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="phone" aria-label={t.weldforms.preview.phone}>
              <Smartphone className="size-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </DialogHeader>
        <div className="min-h-0 flex-1 rounded-lg bg-muted/40 p-3">
          {/* Mounted only while open, so each opening starts a fresh run. */}
          {open && <FormPreview definition={definition} theme={theme} device={device} className="h-full" />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
