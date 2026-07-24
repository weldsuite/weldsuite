import React from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger as SelectTriggerUI,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@weldsuite/ui/components/dialog';
import { AVAILABLE_MODELS, getHelpdeskAgentTools } from '../helpdesk-workflow-constants';

export interface SubAgentFormState {
  name: string;
  description: string;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  maxTotalTokens: number;
  enabledBuiltinTools: string[];
  integrationIds: string[];
  integrationToolPermissions: Record<string, string[]>;
  escalationRules: { escalateOnFailure: boolean; escalateOnMaxIterations: boolean };
}

interface SubAgentEditDialogProps {
  editSubAgentId: string | null;
  subAgentForm: SubAgentFormState | null;
  setSubAgentForm: React.Dispatch<React.SetStateAction<SubAgentFormState | null>>;
  mcpConnections: Array<{
    id: string;
    name: string;
    provider: string;
    status: string;
    settings: { discoveredTools?: Array<{ name: string; description: string }>; [key: string]: unknown };
  }> | undefined;
  onClose: () => void;
  onSave: () => void;
  isSaving: boolean;
}

export function SubAgentEditDialog({
  editSubAgentId,
  subAgentForm,
  setSubAgentForm,
  mcpConnections,
  onClose,
  onSave,
  isSaving,
}: SubAgentEditDialogProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const wc = t.helpdesk.workflowConstants;
  const sd = t.helpdesk.subAgentEditDialog;
  const agentTools = React.useMemo(() => getHelpdeskAgentTools(wc), [wc]);
  return (
    <Dialog
      open={!!editSubAgentId}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.helpdesk.subAgentEditDialog.title}</DialogTitle>
        </DialogHeader>
        {subAgentForm ? (
          <div className="grid grid-cols-2 gap-6">
            {/* Left column */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{sd.labelName}</label>
                  <Input
                    value={subAgentForm.name}
                    onChange={(e) => setSubAgentForm({ ...subAgentForm, name: e.target.value })}
                    placeholder={st('sweep.welddesk.subAgentEditDialog.namePlaceholder')}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{sd.labelDescription}</label>
                  <Input
                    value={subAgentForm.description}
                    onChange={(e) => setSubAgentForm({ ...subAgentForm, description: e.target.value })}
                    placeholder={st('sweep.welddesk.subAgentEditDialog.descriptionPlaceholder')}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">{sd.labelSystemPrompt}</label>
                <Textarea
                  value={subAgentForm.systemPrompt}
                  onChange={(e) => setSubAgentForm({ ...subAgentForm, systemPrompt: e.target.value })}
                  placeholder={st('sweep.welddesk.subAgentEditDialog.systemPromptPlaceholder')}
                  rows={6}
                  className="mt-1"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{sd.labelModel}</label>
                  <Select
                    value={subAgentForm.modelId}
                    onValueChange={(v) => setSubAgentForm({ ...subAgentForm, modelId: v })}
                  >
                    <SelectTriggerUI className="mt-1"><SelectValue /></SelectTriggerUI>
                    <SelectContent>
                      <SelectItem value="inherit">{sd.inheritFromParent}</SelectItem>
                      {AVAILABLE_MODELS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{sd.labelTemperature}</label>
                  <Input
                    type="number"
                    value={subAgentForm.temperature}
                    onChange={(e) => setSubAgentForm({ ...subAgentForm, temperature: parseFloat(e.target.value) || 0.7 })}
                    min={0}
                    max={2}
                    step={0.1}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{sd.labelMaxIterations}</label>
                  <Input
                    type="number"
                    value={subAgentForm.maxIterations}
                    onChange={(e) => setSubAgentForm({ ...subAgentForm, maxIterations: parseInt(e.target.value) || 10 })}
                    min={1}
                    max={50}
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{sd.labelMaxTokens}</label>
                  <Input
                    type="number"
                    value={subAgentForm.maxTokens}
                    onChange={(e) => setSubAgentForm({ ...subAgentForm, maxTokens: parseInt(e.target.value) || 1024 })}
                    min={100}
                    max={16384}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{sd.labelTokenBudget}</label>
                  <Input
                    type="number"
                    value={subAgentForm.maxTotalTokens}
                    onChange={(e) => setSubAgentForm({ ...subAgentForm, maxTotalTokens: parseInt(e.target.value) || 20000 })}
                    min={1000}
                    max={100000}
                    step={1000}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">{sd.labelTools}</label>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1.5">
                  {agentTools.map((tool) => (
                    <label key={tool.name} className="flex items-center gap-2 cursor-pointer py-1">
                      <Checkbox
                        checked={subAgentForm.enabledBuiltinTools.includes(tool.name)}
                        onCheckedChange={() => {
                          setSubAgentForm((prev) => {
                            if (!prev) return prev;
                            const tools = prev.enabledBuiltinTools.includes(tool.name)
                              ? prev.enabledBuiltinTools.filter((t) => t !== tool.name)
                              : [...prev.enabledBuiltinTools, tool.name];
                            return { ...prev, enabledBuiltinTools: tools };
                          });
                        }}
                      />
                      <span className="text-sm">{tool.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">{sd.labelEscalation}</label>
                <div className="space-y-1 mt-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={subAgentForm.escalationRules.escalateOnFailure}
                      onCheckedChange={(checked) =>
                        setSubAgentForm({ ...subAgentForm, escalationRules: { ...subAgentForm.escalationRules, escalateOnFailure: !!checked } })
                      }
                    />
                    <span className="text-sm">{sd.escalateOnError}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={subAgentForm.escalationRules.escalateOnMaxIterations}
                      onCheckedChange={(checked) =>
                        setSubAgentForm({ ...subAgentForm, escalationRules: { ...subAgentForm.escalationRules, escalateOnMaxIterations: !!checked } })
                      }
                    />
                    <span className="text-sm">{sd.escalateAtMaxIterations}</span>
                  </label>
                </div>
              </div>

              {/* Integrations (MCP Servers) */}
              {(mcpConnections || []).length > 0 && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{sd.labelIntegrations}</label>
                  <div className="space-y-2 mt-1.5">
                    {(mcpConnections || []).map((conn) => {
                      const isEnabled = subAgentForm.integrationIds.includes(conn.id);
                      const discoveredTools = conn.settings?.discoveredTools || [];
                      const allowedTools = subAgentForm.integrationToolPermissions[conn.id] || [];
                      return (
                        <div key={conn.id} className="rounded-md border p-2.5 space-y-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <Checkbox
                              checked={isEnabled}
                              onCheckedChange={(checked) => {
                                setSubAgentForm((prev) => {
                                  if (!prev) return prev;
                                  if (checked) {
                                    const allToolNames = discoveredTools.map((t) => t.name);
                                    return {
                                      ...prev,
                                      integrationIds: [...prev.integrationIds, conn.id],
                                      integrationToolPermissions: { ...prev.integrationToolPermissions, [conn.id]: allToolNames },
                                    };
                                  } else {
                                    const restPerms = Object.fromEntries(
                                      Object.entries(prev.integrationToolPermissions).filter(([key]) => key !== conn.id)
                                    );
                                    return {
                                      ...prev,
                                      integrationIds: prev.integrationIds.filter((id) => id !== conn.id),
                                      integrationToolPermissions: restPerms,
                                    };
                                  }
                                });
                              }}
                            />
                            <span className="text-sm font-medium">{conn.name}</span>
                            {isEnabled && discoveredTools.length > 0 && (
                              <span className="text-xs text-muted-foreground ml-auto">{allowedTools.length}/{discoveredTools.length}</span>
                            )}
                          </label>
                          {isEnabled && discoveredTools.length > 0 && (
                            <div className="ml-6 space-y-0.5">
                              {discoveredTools.map((tool) => (
                                <label key={tool.name} className="flex items-center gap-2 cursor-pointer">
                                  <Checkbox
                                    checked={allowedTools.includes(tool.name)}
                                    onCheckedChange={(checked) => {
                                      setSubAgentForm((prev) => {
                                        if (!prev) return prev;
                                        const current = prev.integrationToolPermissions[conn.id] || [];
                                        const next = checked
                                          ? [...current, tool.name]
                                          : current.filter((t) => t !== tool.name);
                                        return {
                                          ...prev,
                                          integrationToolPermissions: { ...prev.integrationToolPermissions, [conn.id]: next },
                                        };
                                      });
                                    }}
                                  />
                                  <span className="text-xs">{tool.name}</span>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-violet-500" />
          </div>
        )}
        {subAgentForm && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t.helpdesk.actions.cancel}
            </Button>
            <Button
              onClick={() => {
                if (!subAgentForm.name.trim() || !subAgentForm.systemPrompt.trim()) {
                  toast.error(t.helpdesk.workflowsPage.nameAndPromptRequired);
                  return;
                }
                onSave();
              }}
              disabled={isSaving}
            >
              {isSaving ? sd.saving : sd.saveChanges}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
