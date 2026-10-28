import { useEffect, useState } from 'react';
import { formatRange } from '@weldsuite/sheets-engine';
import { usePageAgentContext } from '@/components/weldagent-wrapper';
import { useI18n } from '@/lib/i18n/provider';
import type { SheetController } from '../editor/model/sheet-controller';

/** How long the selection rests before the agent panel hears of it. */
const SETTLE_MS = 300;
/** Ranges of a ctrl+click selection named to the agent. */
const MAX_RANGES = 5;

interface Where {
  tab: string;
  selection: string;
}

function whereOf(controller: SheetController): Where {
  return {
    tab: controller.sheet.name,
    selection: controller.selection.ranges.slice(-MAX_RANGES).map(formatRange).join(','),
  };
}

/**
 * Tells the WeldAgent panel which spreadsheet is open, on which tab and which
 * cells are selected, so the agent works on this sheet (ADR AGENT-015).
 * Renders nothing; a component of its own so a moving selection re-renders
 * only this.
 */
export function SheetAgentContext({
  controller,
  sheetId,
  name,
}: Readonly<{ controller: SheetController; sheetId: string; name: string }>) {
  const t = useI18n().t.weldsheets.agent;
  const [where, setWhere] = useState(() => whereOf(controller));

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = controller.subscribe(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const next = whereOf(controller);
        setWhere((prev) => (prev.tab === next.tab && prev.selection === next.selection ? prev : next));
      }, SETTLE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [controller]);

  usePageAgentContext({
    type: 'sheet',
    id: sheetId,
    title: name,
    data: { tab: where.tab, selection: where.selection },
    suggestedPrompts: [t.suggestions.summarize, t.suggestions.totals, t.suggestions.explain],
  });
  return null;
}
