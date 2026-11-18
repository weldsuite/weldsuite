/** Add or edit a dashboard text tile: Markdown with a preview. */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { Label } from '@weldsuite/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useUpdateWeldPanelTextTile } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useAddWeldPanelDashboardTile } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { MarkdownText } from '../../components/markdown-text';
import { NEW_TILE_LAYOUT } from '../../components/report-actions';

const MAX_TEXT = 5000;

interface TextTileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardId: string;
  /** Edit this tile; left out: add a new one. */
  tile?: { id: string; text: string | null } | null;
}

export function TextTileDialog({ open, onOpenChange, dashboardId, tile }: Readonly<TextTileDialogProps>) {
  const { t } = useI18n();
  const tt = t.weldpanel.collab.dashboards.text;
  const tc = t.weldpanel.analytics.common;
  const add = useAddWeldPanelDashboardTile(dashboardId);
  const update = useUpdateWeldPanelTextTile(dashboardId);
  const [text, setText] = useState('');
  const [tab, setTab] = useState('write');
  const busy = add.isPending || update.isPending;

  useEffect(() => {
    if (open) {
      setText(tile?.text ?? '');
      setTab('write');
    }
  }, [open, tile]);

  async function submit() {
    try {
      if (tile) {
        await update.mutateAsync({ tileId: tile.id, text: text.trim() });
        toast.success(tt.saved);
      } else {
        await add.mutateAsync({ kind: 'text', text: text.trim(), layout: NEW_TILE_LAYOUT });
        toast.success(tt.added);
      }
      onOpenChange(false);
    } catch {
      toast.error(tt.failed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tile ? tt.editTitle : tt.addTitle}</DialogTitle>
          <DialogDescription>{tt.hint}</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="gap-3">
          <TabsList>
            <TabsTrigger value="write">{tt.write}</TabsTrigger>
            <TabsTrigger value="preview">{tt.preview}</TabsTrigger>
          </TabsList>
          <TabsContent value="write" className="grid gap-1.5">
            <Label htmlFor="weldpanel-text-tile" className="sr-only">
              {tt.label}
            </Label>
            <Textarea
              id="weldpanel-text-tile"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={10}
              maxLength={MAX_TEXT}
              placeholder={tt.placeholder}
              className="font-mono text-sm"
              disabled={busy}
            />
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {text.length} / {MAX_TEXT}
            </p>
          </TabsContent>
          <TabsContent value="preview" className="min-h-48 rounded-md border p-3">
            {text.trim() === '' ? <EmptyText>{tt.emptyPreview}</EmptyText> : <MarkdownText>{text}</MarkdownText>}
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {tc.cancel}
          </Button>
          <Button type="button" disabled={busy || text.trim() === ''} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />}
            {tile ? tc.save : tc.add}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
