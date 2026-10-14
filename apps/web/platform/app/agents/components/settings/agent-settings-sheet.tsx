'use client';

import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { getTranslations } from '@/lib/i18n';
import type { AgentWithRuns } from '@/hooks/queries/use-agent-queries';
import { AgentAvatar } from '../agent-avatar';
import { errorMessage } from '../chat/labels';
import { AccessTab } from './access-tab';
import { ActivityTab } from './activity-tab';
import { GeneralTab } from './general-tab';
import { KnowledgeTab } from './knowledge-tab';
import { RoutinesTab } from './routines-tab';
import { useAgentForm } from './use-agent-form';

export const SETTINGS_TABS = ['general', 'access', 'routines', 'knowledge', 'activity'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

interface AgentSettingsSheetProps {
  agent: AgentWithRuns;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}

export function AgentSettingsSheet({ agent, open, onOpenChange, tab, onTabChange }: Readonly<AgentSettingsSheetProps>) {
  const t = getTranslations('common').agents.detail.settings;
  const form = useAgentForm(agent);

  const save = async () => {
    try {
      await form.save();
      toast.success(t.saved);
    } catch (err) {
      toast.error(errorMessage(err, t.saveFailed));
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="space-y-0 border-b px-5 py-4 text-left">
          <div className="flex items-center gap-3 pr-6">
            <AgentAvatar agent={agent} size="sm" />
            <div className="min-w-0">
              <SheetTitle className="truncate text-base">{agent.name}</SheetTitle>
              <SheetDescription className="text-xs">{t.description}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as SettingsTab)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="border-b px-5">
            <TabsList className="h-11 w-full justify-start gap-4 rounded-none bg-transparent p-0">
              {SETTINGS_TABS.map((key) => (
                <TabsTrigger
                  key={key}
                  value={key}
                  className="h-11 flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent px-0 text-[13px] shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  {t.tabs[key]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
            <TabsContent value="general" className="mt-0">
              <GeneralTab agent={agent} form={form} />
            </TabsContent>
            <TabsContent value="access" className="mt-0">
              <AccessTab form={form} />
            </TabsContent>
            <TabsContent value="routines" className="mt-0">
              <RoutinesTab agent={agent} />
            </TabsContent>
            <TabsContent value="knowledge" className="mt-0">
              <KnowledgeTab agentId={agent.id} />
            </TabsContent>
            <TabsContent value="activity" className="mt-0">
              <ActivityTab agent={agent} />
            </TabsContent>
          </div>
        </Tabs>

        {form.dirty && (
          <div className="flex items-center justify-between gap-3 border-t bg-background px-5 py-3 animate-in fade-in slide-in-from-bottom-1">
            <span className="text-xs text-muted-foreground">{t.unsaved}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={form.saving} onClick={form.reset}>
                {t.discard}
              </Button>
              <Button size="sm" disabled={form.saving} onClick={() => void save()}>
                {form.saving ? t.saving : t.save}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
