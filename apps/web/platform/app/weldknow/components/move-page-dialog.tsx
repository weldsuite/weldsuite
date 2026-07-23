import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { getTranslations } from '@/lib/i18n';
import {
  useKnowledgePageTree,
  useKnowledgeSpaces,
  useMoveKnowledgePage,
} from '@/hooks/queries/use-knowledge-queries';

interface MovePageDialogProps {
  pageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** IDs of `rootId` and all of its descendants — these can't be a valid move target. */
function subtreeIds(nodes: { id: string; parentId: string | null }[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {
        ids.add(n.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function MovePageDialog({ pageId, open, onOpenChange }: MovePageDialogProps) {
  const t = getTranslations('weldknow');
  const { data: spacesData } = useKnowledgeSpaces();
  const { data: treeData } = useKnowledgePageTree();
  const movePage = useMoveKnowledgePage();

  const spaces = spacesData?.data ?? [];
  const allNodes = treeData?.data ?? [];
  const currentNode = allNodes.find((n) => n.id === pageId);

  const [spaceId, setSpaceId] = useState(currentNode?.spaceId ?? '');
  const [parentId, setParentId] = useState<string>(currentNode?.parentId ?? '__root__');

  useEffect(() => {
    if (open && currentNode) {
      setSpaceId(currentNode.spaceId);
      setParentId(currentNode.parentId ?? '__root__');
    }
  }, [open, currentNode]);

  const excluded = useMemo(() => subtreeIds(allNodes, pageId), [allNodes, pageId]);

  const parentOptions = useMemo(
    () => allNodes.filter((n) => n.spaceId === spaceId && !excluded.has(n.id)),
    [allNodes, spaceId, excluded],
  );

  const handleSubmit = async () => {
    try {
      await movePage.mutateAsync({
        id: pageId,
        data: {
          parentId: parentId === '__root__' ? null : parentId,
          spaceId,
        },
      });
      toast.success(t.page.moveSuccess);
      onOpenChange(false);
    } catch {
      toast.error(t.page.moveError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.move.title}</DialogTitle>
          <DialogDescription>{t.move.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t.move.spaceLabel}</Label>
            <Select
              value={spaceId}
              onValueChange={(v) => {
                setSpaceId(v);
                setParentId('__root__');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t.move.parentLabel}</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__root__">{t.move.noParent}</SelectItem>
                {parentOptions.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.title || t.sidebar.untitled}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={movePage.isPending}>
            {t.common.cancel}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={movePage.isPending || !spaceId}>
            {t.move.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
