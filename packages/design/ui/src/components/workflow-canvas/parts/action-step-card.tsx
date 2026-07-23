"use client"

import * as React from 'react';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../card';
import { Button } from '../../button';
import { Input } from '../../input';
import { Label } from '../../label';
import { Badge } from '../../badge';
import {
  ChevronDown,
  ChevronUp,
  Trash2,
  Settings,
  Mail,
  Globe,
  Webhook,
  Play,
  Code,
  Clock,
  GitBranch,
  FileText,
  Package,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../dialog';
import { cn } from '../../../lib/utils';

interface ActionStepCardProps {
  step: any;
  index: number;
  totalSteps: number;
  actionTypes: any[];
  onUpdate: (data: any) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Platform-provided: renders the action config form inside the dialog. */
  renderConfigForm?: (props: { actionType: string; config: Record<string, any>; onChange: (config: Record<string, any>) => void }) => React.ReactNode;
  /** Called when the user saves the config dialog. Useful for host-side notifications. */
  onSaved?: () => void;
  labels?: {
    needsConfig?: string;
    configureAction?: string;
    configureTitle?: string;
    defaultDescription?: string;
    actionName?: string;
    actionNamePlaceholder?: string;
    actionNameHint?: string;
    actionSettings?: string;
    cancel?: string;
    saveChanges?: string;
  };
}

const ACTION_ICONS: Record<string, any> = {
  email: Mail, send_email: Mail,
  http: Globe, http_request: Globe,
  webhook: Webhook, api_call: Globe,
  condition: GitBranch, if: GitBranch, branch: GitBranch,
  loop: RefreshCw, iterate: RefreshCw,
  delay: Clock, wait: Clock,
  transform: Code, transform_data: Code,
  log_message: FileText, log: FileText,
  set_variable: Settings, assign: Settings,
  create_record: Package, update_record: Settings, delete_record: Package,
};

const ACTION_COLORS: Record<string, string> = {
  send_email: 'bg-blue-500',
  http_request: 'bg-purple-500',
  condition: 'bg-orange-500',
  loop: 'bg-cyan-500',
  delay: 'bg-gray-500',
  transform_data: 'bg-pink-500',
  log_message: 'bg-slate-500',
  create_record: 'bg-green-500',
  update_record: 'bg-yellow-500',
  set_variable: 'bg-indigo-500',
};

function getConfigSummary(actionType: string, config: Record<string, any>): string[] {
  const summary: string[] = [];
  switch (actionType) {
    case 'send_email':
      if (config.to) summary.push(`To: ${config.to}`);
      if (config.subject) summary.push(`Subject: ${config.subject}`);
      break;
    case 'http_request':
      if (config.method && config.url) summary.push(`${config.method} ${config.url}`);
      break;
    case 'condition':
      if (config.field && config.operator) {
        const op = config.operator === 'eq' ? '==' : config.operator === 'ne' ? '!=' : config.operator;
        summary.push(`${config.field} ${op} ${config.value || ''}`);
      }
      break;
    case 'delay':
      if (config.seconds) summary.push(`Wait ${config.seconds} seconds`);
      else if (config.minutes) summary.push(`Wait ${config.minutes} minutes`);
      else if (config.hours) summary.push(`Wait ${config.hours} hours`);
      break;
    case 'log_message':
      if (config.level) summary.push(`Level: ${config.level}`);
      if (config.message) summary.push(config.message.substring(0, 50) + (config.message.length > 50 ? '...' : ''));
      break;
    case 'create_record':
    case 'update_record':
      if (config.entityType || config.entity) summary.push(`Entity: ${config.entityType || config.entity}`);
      break;
    case 'transform_data':
      if (config.transformation) summary.push(config.transformation.substring(0, 40) + '...');
      break;
    case 'loop':
      if (config.items) summary.push(`Items: ${config.items}`);
      break;
    case 'set_variable':
      if (config.name) summary.push(`${config.name} = ${JSON.stringify(config.value).substring(0, 30)}`);
      break;
  }
  return summary;
}

export function ActionStepCard({
  step,
  index,
  totalSteps,
  actionTypes,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  renderConfigForm,
  onSaved,
  labels = {},
}: ActionStepCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState(step.config || {});
  const [name, setName] = useState(step.name || '');

  const actionType = actionTypes.find(a => a.type === step.type);
  const Icon = ACTION_ICONS[step.type] || ACTION_ICONS[step.type?.toLowerCase()] || Play;
  const bgColor = ACTION_COLORS[step.type] || 'bg-primary';
  const configSummary = getConfigSummary(step.type, step.config || {});
  const hasConfig = Object.keys(step.config || {}).length > 0;

  const handleSaveConfig = () => {
    onUpdate({ name, config });
    setShowConfig(false);
    onSaved?.();
  };

  const handleOpenConfig = () => {
    setConfig(step.config || {});
    setName(step.name || '');
    setShowConfig(true);
  };

  return (
    <>
      <Card className={cn(
        "transition-all hover:shadow-md",
        !hasConfig && "border-dashed border-orange-300 bg-orange-50/50 dark:bg-orange-950/10"
      )}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn("flex items-center justify-center w-8 h-8 rounded-lg text-white text-sm font-semibold shadow-sm", bgColor)}>
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  {step.name}
                  {!hasConfig && (
                    <Badge variant="outline" className="text-xs bg-orange-100 text-orange-700 border-orange-300">
                      <AlertCircle className="h-3 w-3 mr-1" />
                      {labels.needsConfig || 'Needs config'}
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-xs text-muted-foreground capitalize mt-0.5">
                  {actionType?.name || step.type?.replace(/_/g, ' ')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={onMoveUp} disabled={index === 0} className="h-8 w-8 p-0">
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={onMoveDown} disabled={index === totalSteps - 1} className="h-8 w-8 p-0">
                <ChevronDown className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={handleOpenConfig} className="h-8 w-8 p-0">
                <Settings className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={onDelete} className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>

        {configSummary.length > 0 && (
          <CardContent className="pt-0 pb-3">
            <div className="pl-11 space-y-1">
              {configSummary.map((item, i) => (
                <p key={i} className="text-xs text-muted-foreground font-mono truncate">{item}</p>
              ))}
            </div>
          </CardContent>
        )}

        {!hasConfig && (
          <CardContent className="pt-0 pb-3">
            <Button variant="outline" size="sm" onClick={handleOpenConfig} className="w-full text-xs border-orange-300 text-orange-700 hover:bg-orange-100">
              <Settings className="h-3 w-3 mr-2" />
              {labels.configureAction || 'Configure action'}
            </Button>
          </CardContent>
        )}
      </Card>

      {/* Configuration Dialog */}
      <Dialog open={showConfig} onOpenChange={setShowConfig}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className={cn("flex items-center justify-center w-10 h-10 rounded-lg text-white shadow-sm", bgColor)}>
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle>
                  {(labels.configureTitle || 'Configure {name}').replace('{name}', actionType?.name || step.type)}
                </DialogTitle>
                <DialogDescription>
                  {actionType?.description || labels.defaultDescription || 'Configure the action settings.'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-4 space-y-6">
            <div className="space-y-2">
              <Label>{labels.actionName || 'Action Name'}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={labels.actionNamePlaceholder || 'Enter action name...'}
              />
              {labels.actionNameHint && (
                <p className="text-xs text-muted-foreground">{labels.actionNameHint}</p>
              )}
            </div>

            {renderConfigForm && (
              <div className="border-t pt-4">
                <h4 className="text-sm font-medium mb-4">{labels.actionSettings || 'Action Settings'}</h4>
                {renderConfigForm({ actionType: step.type, config, onChange: setConfig })}
              </div>
            )}
          </div>

          <DialogFooter className="border-t pt-4">
            <Button variant="outline" onClick={() => setShowConfig(false)}>
              {labels.cancel || 'Cancel'}
            </Button>
            <Button onClick={handleSaveConfig}>
              <CheckCircle2 className="h-4 w-4 mr-0.5" />
              {labels.saveChanges || 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
