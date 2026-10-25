import { useRef, useState, useSyncExternalStore } from 'react';
import { TooltipProvider } from '@weldsuite/ui/components/tooltip';
import { ChartPanel } from './charts/chart-panel';
import { FormulaBar } from './formula-bar';
import { SheetGrid } from './grid/sheet-grid';
import type { SheetController } from './model/sheet-controller';
import { CreatePivotDialog } from './pivot/create-pivot-dialog';
import { PivotPanel } from './pivot/pivot-panel';
import { FormatsPanel } from './rules/formats-panel';
import { SortDialog } from './rules/sort-dialog';
import { ValidationPanel } from './rules/validation-panel';
import { SheetTabs } from './sheet-tabs';
import { Toolbar } from './toolbar';

/**
 * Toolbar, formula bar, grid with its side panel (conditional formatting,
 * data validation, chart and pivot table editors), and sheet tabs around one
 * controller. Read-only sheets have no toolbar and no panels.
 */
export function SheetEditor({ controller }: { controller: SheetController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const barInputRef = useRef<HTMLTextAreaElement>(null);
  const [sorting, setSorting] = useState(false);
  const [creatingPivot, setCreatingPivot] = useState(false);
  const panel = controller.readOnly ? null : controller.panel;
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        {!controller.readOnly && <Toolbar controller={controller} onSortRange={() => setSorting(true)} onCreatePivot={() => setCreatingPivot(true)} />}
        <FormulaBar controller={controller} inputRef={barInputRef} />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <SheetGrid controller={controller} barInputRef={barInputRef} onCreatePivot={() => setCreatingPivot(true)} />
          </div>
          {panel === 'formats' && <FormatsPanel controller={controller} />}
          {panel === 'validation' && <ValidationPanel controller={controller} />}
          {panel === 'chart' && <ChartPanel controller={controller} />}
          {panel === 'pivot' && <PivotPanel controller={controller} />}
        </div>
        <SheetTabs controller={controller} />
      </div>
      {sorting && <SortDialog controller={controller} onClose={() => setSorting(false)} />}
      {creatingPivot && <CreatePivotDialog controller={controller} onClose={() => setCreatingPivot(false)} />}
    </TooltipProvider>
  );
}
