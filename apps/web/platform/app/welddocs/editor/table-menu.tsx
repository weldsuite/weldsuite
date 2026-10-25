import type { ReactNode } from 'react';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { formatCell, formatCurrentTable, runTableAction, tableContext, type TableAction } from './model/table-actions';
import { PALETTE } from './ui';

/** The table commands for the cell the caret is in (Format > Table, and the right-click menu). */
export function TableMenuItems({ controller }: { controller: DocController }) {
  const { t } = useI18n();
  const tt = t.welddocs.table;
  const ctx = tableContext(controller);
  if (!ctx || controller.readOnly) return null;
  const item = (action: TableAction, label: ReactNode, disabled = false) => (
    <DropdownMenuItem key={action} disabled={disabled} onSelect={() => runTableAction(controller, action)}>
      {label}
    </DropdownMenuItem>
  );
  return (
    <>
      {item('rowAbove', tt.rowAbove)}
      {item('rowBelow', tt.rowBelow)}
      {item('colLeft', tt.colLeft)}
      {item('colRight', tt.colRight)}
      <DropdownMenuSeparator />
      {item('deleteRow', tt.deleteRow)}
      {item('deleteCol', tt.deleteCol)}
      {item('deleteTable', tt.deleteTable)}
      <DropdownMenuSeparator />
      {item('mergeRight', tt.mergeRight, ctx.col >= ctx.cols - 1)}
      {item('mergeDown', tt.mergeDown, ctx.row >= ctx.rows - 1)}
      {item('unmerge', tt.unmerge, !ctx.merged)}
      {item('distribute', tt.distribute)}
      {item('headerRow', ctx.headerRows > 0 ? tt.unpinHeader : tt.pinHeader)}
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{tt.cellBackground}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="p-2">
          <button type="button" className="mb-2 w-full rounded px-2 py-1 text-left text-sm hover:bg-accent" onClick={() => formatCell(controller, { background: null })}>
            {tt.noColor}
          </button>
          <div className="grid grid-cols-10 gap-1">
            {PALETTE.map((c) => (
              <button key={c} type="button" aria-label={c} className="h-5 w-5 rounded-sm border" style={{ background: c }} onClick={() => formatCell(controller, { background: c })} />
            ))}
          </div>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{tt.verticalAlign}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={() => formatCell(controller, { vAlign: null })}>{tt.top}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => formatCell(controller, { vAlign: 'middle' })}>{tt.middle}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => formatCell(controller, { vAlign: 'bottom' })}>{tt.bottom}</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{tt.tableAlign}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={() => formatCurrentTable(controller, { align: null })}>{tt.left}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => formatCurrentTable(controller, { align: 'center' })}>{tt.center}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => formatCurrentTable(controller, { align: 'right' })}>{tt.right}</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{tt.borders}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {[0, 0.5, 0.75, 1.5, 3].map((w) => (
            <DropdownMenuItem key={w} onSelect={() => formatCurrentTable(controller, { border: { width: w, color: '#000000' } })}>
              {w === 0 ? tt.noBorders : `${w} pt`}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
