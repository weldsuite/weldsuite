import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { useI18n } from '@/lib/i18n/provider';
import { chartRange, parseDataRange, rangeLabel } from '../model/charts';
import { createPivotTable, parseTargetCell } from '../model/pivots';
import type { SheetController } from '../model/sheet-controller';

/** "Create pivot table": the source (the selection, or the block around it) and where the table goes. */
export function CreatePivotDialog({ controller, onClose }: { controller: SheetController; onClose: () => void }) {
  const { t } = useI18n();
  const tp = t.weldsheets.pivot;
  const [source, setSource] = useState(() => rangeLabel(controller, { sheetId: controller.activeSheetId, range: chartRange(controller) }));
  const [where, setWhere] = useState<'new' | 'existing'>('new');
  const [target, setTarget] = useState('');

  const create = () => {
    const at = parseDataRange(controller, source);
    let cell = null;
    if (where === 'existing') {
      cell = parseTargetCell(controller, target);
      if (!cell) {
        toast.error(tp.targetInvalid);
        return;
      }
    }
    const problem = createPivotTable(controller, at, cell, tp.sheetName);
    if (problem) {
      toast.error(problem === 'noFields' ? tp.noFields : tp.sourceInvalid);
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{tp.create}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            {tp.source}
            <Input className="h-8 font-mono text-sm" value={source} onChange={(e) => setSource(e.target.value)} />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">{tp.insertTo}</span>
            <RadioGroup value={where} onValueChange={(v) => setWhere(v as 'new' | 'existing')} className="gap-2">
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="new" />
                {tp.newSheet}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="existing" />
                {tp.existingSheet}
              </label>
            </RadioGroup>
            {where === 'existing' && (
              <Input
                className="h-8 font-mono text-sm"
                value={target}
                placeholder={tp.targetPlaceholder}
                aria-label={tp.existingSheet}
                onChange={(e) => setTarget(e.target.value)}
                autoFocus
              />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {tp.cancel}
          </Button>
          <Button onClick={create}>{tp.createButton}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
