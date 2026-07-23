import React, { useState, useMemo } from 'react';
import { Plus, X, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Label } from '@weldsuite/ui/components/label';
import {
  getAvailableActions,
  getHelpdeskActionTypes,
  getHelpdeskActionCategories,
  getHelpdeskCategoryLabels,
} from '../helpdesk-workflow-constants';
import { useI18n } from '@/lib/i18n/provider';

interface AddActionPanelProps {
  trigger?: { entityType?: string; eventType?: string } | null;
  onAddAction: (actionType: string) => void;
  onClose: () => void;
}

export function AddActionPanel({
  trigger,
  onAddAction,
  onClose,
}: AddActionPanelProps) {
  const { t } = useI18n();
  const aap = t.helpdesk.addActionPanel;
  const wc = t.helpdesk.workflowConstants;
  const actionTypes = useMemo(() => getHelpdeskActionTypes(wc), [wc]);
  const actionCategories = useMemo(() => getHelpdeskActionCategories(wc), [wc]);
  const categoryLabels = useMemo(() => getHelpdeskCategoryLabels(wc), [wc]);
  const availableActions = useMemo(() => getAvailableActions(trigger, actionTypes), [trigger, actionTypes]);
  const [search, setSearch] = useState('');
  const needle = search.toLowerCase();

  return (
    <>
      <div className="pl-4 pt-3 pb-3 pr-3 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-[5px] rounded-md bg-teal-100 dark:bg-teal-900/30">
              <Plus className="h-3.5 w-3.5 text-teal-600" />
            </div>
            <h3 className="font-semibold text-sm">{aap.title}</h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 px-1 py-1.5 rounded-md border bg-background">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={aap.searchPlaceholder}
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </div>
          {actionCategories.map(({ id: category }) => {
            let actionsInCategory = availableActions.filter((a) => a.category === category);
            if (needle) {
              actionsInCategory = actionsInCategory.filter(
                (a) => a.name.toLowerCase().includes(needle) || a.description.toLowerCase().includes(needle),
              );
            }
            if (actionsInCategory.length === 0) return null;
            return (
              <div key={category} className="space-y-1">
                <Label className="text-xs font-medium">
                  {categoryLabels[category]}
                </Label>
                <div>
                  {actionsInCategory.map((action) => {
                    const Icon = action.icon;
                    return (
                      <Button
                        key={action.id}
                        type="button"
                        variant="ghost"
                        onClick={() => onAddAction(action.id)}
                        className="flex items-center gap-3 py-2 -mx-4 px-4 transition-all text-left hover:bg-muted"
                        style={{ width: 'calc(100% + 2rem)' }}
                      >
                        <div className="w-8 h-8 rounded-md border border-border/70 flex items-center justify-center flex-shrink-0">
                          <Icon className="w-4 h-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground">{action.name}</p>
                          <p className="text-xs text-muted-foreground truncate">{action.description}</p>
                        </div>
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );
}
