
import React from 'react';
import { useParams, useRouter } from '@/lib/router';
import { useSpaces } from '@/contexts/spaces-context';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  PenTool,
  ClipboardList,
  StickyNote,
  TrendingUp,
  BarChart3,
  Calendar,
  FileText,
  MessageSquare,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import { ModuleType } from '@/contexts/spaces-context';
import { useTranslations } from '@weldsuite/i18n/client';

const moduleIcons: Record<ModuleType, React.ElementType> = {
  whiteboard: PenTool,
  tasks: ClipboardList,
  notes: StickyNote,
  pipeline: TrendingUp,
  analytics: BarChart3,
  calendar: Calendar,
  chat: MessageSquare,
  documents: FileText,
};

export default function SpaceOverviewPage() {
  const st = useTranslations();
  const params = useParams();
  const router = useRouter();
  const { spaces, addModuleToSpace, deleteSpace } = useSpaces();
  const spaceId = params.spaceId as string;

  const moduleDescriptions: Record<ModuleType, string> = {
    whiteboard: st('sweep.weldflow.spaceOverview.moduleDescriptions.whiteboard'),
    tasks: st('sweep.weldflow.spaceOverview.moduleDescriptions.tasks'),
    notes: st('sweep.weldflow.spaceOverview.moduleDescriptions.notes'),
    pipeline: st('sweep.weldflow.spaceOverview.moduleDescriptions.pipeline'),
    analytics: st('sweep.weldflow.spaceOverview.moduleDescriptions.analytics'),
    calendar: st('sweep.weldflow.spaceOverview.moduleDescriptions.calendar'),
    chat: st('sweep.weldflow.spaceOverview.moduleDescriptions.chat'),
    documents: st('sweep.weldflow.spaceOverview.moduleDescriptions.documents'),
  };

  const moduleNames: Record<ModuleType, string> = {
    whiteboard: st('sweep.weldflow.spaceOverview.moduleNames.whiteboard'),
    tasks: st('sweep.weldflow.spaceOverview.moduleNames.tasks'),
    notes: st('sweep.weldflow.spaceOverview.moduleNames.notes'),
    pipeline: st('sweep.weldflow.spaceOverview.moduleNames.pipeline'),
    analytics: st('sweep.weldflow.spaceOverview.moduleNames.analytics'),
    calendar: st('sweep.weldflow.spaceOverview.moduleNames.calendar'),
    chat: st('sweep.weldflow.spaceOverview.moduleNames.chat'),
    documents: st('sweep.weldflow.spaceOverview.moduleNames.documents'),
  };

  const space = spaces.find(s => s.id === spaceId);

  if (!space) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <h2 className="text-2xl font-semibold mb-2">{st('sweep.weldflow.spaceOverview.spaceNotFound')}</h2>
          <p className="text-muted-foreground mb-4">{st('sweep.weldflow.spaceOverview.spaceNotFoundDesc')}</p>
          <Button onClick={() => router.push('/weldcrm')}>
            {st('sweep.weldflow.spaceOverview.goToDashboard')}
          </Button>
        </div>
      </div>
    );
  }

  const availableModules: ModuleType[] = [
    'whiteboard', 'tasks', 'notes', 'pipeline', 
    'analytics', 'calendar', 'chat'
  ];

  const unusedModules = availableModules.filter(
    type => !space.modules.some(m => m.type === type)
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{space.name}</h1>
          <p className="text-muted-foreground mt-1">
            {st('sweep.weldflow.spaceOverview.manageModulesDesc')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm">
            <Settings className="h-4 w-4 mr-0.5" />
            {st('sweep.weldflow.spaceOverview.settings')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-red-600"
            onClick={() => {
              if (confirm(st('sweep.weldflow.spaceOverview.deleteSpaceConfirm'))) {
                deleteSpace(spaceId);
                router.push('/weldcrm');
              }
            }}
          >
            <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
            {st('sweep.weldflow.spaceOverview.deleteSpace')}
          </Button>
        </div>
      </div>

      {/* Active Modules */}
      {space.modules.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">{st('sweep.weldflow.spaceOverview.activeModules')}</h2>
          <div className="grid grid-cols-4 gap-4">
            {space.modules.map((module) => {
              const Icon = moduleIcons[module.type];
              return (
                <Card 
                  key={module.id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => router.push(`/weldcrm/space/${spaceId}/${module.type}`)}
                >
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {React.createElement(Icon, { className: "h-5 w-5" })}
                      {module.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {moduleDescriptions[module.type]}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Modules */}
      {unusedModules.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">{st('sweep.weldflow.spaceOverview.availableModules')}</h2>
          <div className="grid grid-cols-4 gap-4">
            {unusedModules.map((type) => {
              const Icon = moduleIcons[type];
              return (
                <Card 
                  key={type}
                  className="border-dashed cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => {
                    addModuleToSpace(spaceId, type);
                  }}
                >
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
                      <Plus className="h-5 w-5" />
                      {React.createElement(Icon, { className: "h-5 w-5" })}
                      {moduleNames[type]}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {st('sweep.weldflow.spaceOverview.clickToAddModule')}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty State */}
      {space.modules.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <h3 className="text-lg font-medium mb-2">{st('sweep.weldflow.spaceOverview.noModulesYet')}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {st('sweep.weldflow.spaceOverview.addModulesDesc')}
            </p>
            <div className="flex flex-wrap gap-2">
              {unusedModules.slice(0, 4).map((type) => {
                const Icon = moduleIcons[type];
                return (
                  <Button
                    key={type}
                    variant="outline"
                    size="sm"
                    onClick={() => addModuleToSpace(spaceId, type)}
                  >
                    {React.createElement(Icon, { className: "h-4 w-4 mr-0.5" })}
                    {st('sweep.weldflow.spaceOverview.addModuleButton', { module: moduleNames[type] })}
                  </Button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}