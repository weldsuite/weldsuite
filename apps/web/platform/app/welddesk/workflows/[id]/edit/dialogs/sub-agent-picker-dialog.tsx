import React from 'react';
import { Bot } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';

interface SubAgentPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: any;
  stepId: string | null;
  savedAgents: Array<{ id: string; name: string; description?: string }> | undefined;
  onSelectAgent: (agentId: string, agentName: string) => void;
}

export function SubAgentPickerDialog({
  open,
  onOpenChange,
  workflow,
  stepId,
  savedAgents,
  onSelectAgent,
}: SubAgentPickerDialogProps) {
  const { t } = useI18n();
  const sapd = t.helpdesk.subAgentPickerDialog;

  const step = stepId ? workflow.steps.find((s: any) => s.id === stepId) : null;
  const currentSubIds: string[] = (step?.config as any)?.subAgentIds || [];
  const headAgentId = (step?.config as any)?.agentDefinitionId;
  const available = (savedAgents || []).filter(
    (a) => a.id !== headAgentId && !currentSubIds.includes(a.id)
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{sapd.title}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 max-h-[400px] overflow-y-auto">
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center col-span-2">
              {sapd.noAgents}{' '}
              <Link href="/welddesk/weldagent" className="text-primary underline underline-offset-2">
                {sapd.createAgents}
              </Link>{' '}
              {sapd.createAgentsFirst}
            </p>
          ) : (
            available.map((agent) => (
              <Button
                key={agent.id}
                type="button"
                variant="ghost"
                onClick={() => onSelectAgent(agent.id, agent.name)}
                className="flex items-center gap-2.5 w-full rounded-md p-2.5 hover:bg-muted/80 transition-colors text-left"
              >
                <Bot className="w-4 h-4 text-violet-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{agent.name}</p>
                  {agent.description && (
                    <p className="text-xs text-muted-foreground truncate">{agent.description}</p>
                  )}
                </div>
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
