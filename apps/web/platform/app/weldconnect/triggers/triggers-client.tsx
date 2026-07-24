
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Input } from '@weldsuite/ui/components/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  Search,
  Zap,
  Database,
  Webhook,
  Play,
  Clock,
  Mail,
  ShoppingCart,
  Package,
  Users,
  FileText,
  Globe,
  type LucideIcon,
} from 'lucide-react';
import type { TriggerType } from '@/hooks/queries/use-automation-queries';

export interface EventTypeDefinition {
  id: string;
  name: string;
  description: string;
}

// The trigger-types endpoint doesn't currently report `isPremium`; keep it
// optional here so the UI can render the badge once the API adds it.
interface DisplayTriggerType extends TriggerType {
  isPremium?: boolean;
}

interface TriggersClientProps {
  triggerTypes: DisplayTriggerType[];
  entityEvents: Array<{ entityType: string; events: EventTypeDefinition[] }>;
}

const TRIGGER_ICONS: Record<string, LucideIcon> = {
  schedule: Clock,
  entity_event: Database,
  webhook: Webhook,
  manual: Play,
  api: Globe,
};

const ENTITY_ICONS: Record<string, LucideIcon> = {
  customer: Users,
  order: ShoppingCart,
  parcel: Package,
  invoice: FileText,
  product: Package,
  email: Mail,
};

export function TriggersClient({ triggerTypes, entityEvents }: TriggersClientProps) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.triggers },
  ]);

  const [search, setSearch] = useState('');
  const [selectedCategory] = useState<string>('all');

  // Filter trigger types
  const filteredTriggers = triggerTypes.filter((trigger) => {
    if (selectedCategory !== 'all' && trigger.category !== selectedCategory) {
      return false;
    }
    if (search) {
      const searchLower = search.toLowerCase();
      return (
        trigger.name.toLowerCase().includes(searchLower) ||
        trigger.description?.toLowerCase().includes(searchLower)
      );
    }
    return true;
  });

  // Group triggers by category
  const categories = Array.from(new Set(triggerTypes.map((t) => t.category)));
  const triggersByCategory = categories.reduce(
    (acc, category) => {
      acc[category] = filteredTriggers.filter((t) => t.category === category);
      return acc;
    },
    {} as Record<string, DisplayTriggerType[]>
  );

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'schedule':
        return 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300';
      case 'entity_event':
        return 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300';
      case 'webhook':
        return 'bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300';
      case 'manual':
        return 'bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-300';
      case 'api':
        return 'bg-pink-50 text-pink-700 dark:bg-pink-900/20 dark:text-pink-300';
      default:
        return 'bg-gray-50 text-gray-700 dark:bg-background/20 dark:text-muted-foreground';
    }
  };

  return (
    <>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{t.weldconnect.triggers.title}</h1>
          <p className="text-muted-foreground mt-1 md:mt-2 text-sm md:text-base">
            {t.weldconnect.triggers.subtitle}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-3 md:gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t.weldconnect.triggers.stats.totalTriggerTypes}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{triggerTypes.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t.weldconnect.triggers.stats.scheduleTriggers}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {triggerTypes.filter((tt) => tt.category === 'schedule').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t.weldconnect.triggers.stats.entityEvents}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{entityEvents.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t.weldconnect.triggers.stats.webhookTriggers}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {triggerTypes.filter((tt) => tt.category === 'webhook').length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <Tabs defaultValue="all" className="space-y-4 md:space-y-6">
        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          <TabsList className="inline-flex">
            <TabsTrigger value="all" className="text-xs md:text-sm whitespace-nowrap">{t.weldconnect.triggers.tabs.all}</TabsTrigger>
            <TabsTrigger value="schedule" className="text-xs md:text-sm whitespace-nowrap">{t.weldconnect.triggers.tabs.schedule}</TabsTrigger>
            <TabsTrigger value="entity_event" className="text-xs md:text-sm whitespace-nowrap">{t.weldconnect.triggers.tabs.entityEvent}</TabsTrigger>
            <TabsTrigger value="webhook" className="text-xs md:text-sm whitespace-nowrap">{t.weldconnect.triggers.tabs.webhook}</TabsTrigger>
          </TabsList>
        </div>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t.weldconnect.triggers.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-full md:w-[300px]"
            />
          </div>

          <TabsContent value="all" className="space-y-6">
            {categories.map((category) => {
              const triggers = triggersByCategory[category];
              if (!triggers || triggers.length === 0) return null;

              const Icon = TRIGGER_ICONS[category] || Zap;

              return (
                <div key={category} className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Icon className="h-5 w-5" />
                    <h3 className="text-lg font-semibold capitalize">
                      {t.weldconnect.triggersClient.categoryHeading.replace('{category}', category.replace('_', ' '))}
                    </h3>
                    <Badge variant="secondary">{triggers.length}</Badge>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {triggers.map((trigger) => {
                      const TriggerIcon = TRIGGER_ICONS[trigger.category] || Zap;
                      return (
                        <Card key={trigger.id} className="hover:shadow-md transition-shadow">
                          <CardHeader className="pb-3">
                            <div className="flex items-start justify-between">
                              <div className="flex items-center gap-3">
                                <div
                                  className={`p-2 rounded-lg ${getCategoryColor(trigger.category)}`}
                                >
                                  <TriggerIcon className="h-5 w-5" />
                                </div>
                                <div>
                                  <CardTitle className="text-base">{trigger.name}</CardTitle>
                                  <Badge
                                    variant="outline"
                                    className={`text-xs mt-1 ${getCategoryColor(trigger.category)}`}
                                  >
                                    {trigger.category.replace('_', ' ')}
                                  </Badge>
                                </div>
                              </div>
                            </div>
                          </CardHeader>
                          <CardContent>
                            <CardDescription className="text-xs line-clamp-2">
                              {trigger.description}
                            </CardDescription>
                            {trigger.isPremium && (
                              <Badge variant="secondary" className="mt-2 text-xs">
                                {t.weldconnect.actions.premium}
                              </Badge>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </TabsContent>

          <TabsContent value="schedule" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {triggersByCategory.schedule?.map((trigger) => (
                <Card key={trigger.id} className="hover:shadow-md transition-shadow">
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${getCategoryColor('schedule')}`}>
                        <Clock className="h-5 w-5" />
                      </div>
                      <CardTitle className="text-base">{trigger.name}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <CardDescription className="text-sm">{trigger.description}</CardDescription>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="entity_event" className="space-y-6">
            <div className="space-y-6">
              {entityEvents.map(({ entityType, events }) => {
                const EntityIcon = ENTITY_ICONS[entityType] || Database;
                return (
                  <div key={entityType} className="space-y-4">
                    <div className="flex items-center gap-2">
                      <EntityIcon className="h-5 w-5" />
                      <h3 className="text-lg font-semibold capitalize">{t.weldconnect.triggersClient.entityEventsHeading.replace('{entityType}', entityType)}</h3>
                      <Badge variant="secondary">{events.length}</Badge>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                      {events.map((event) => (
                        <Card key={event.id} className="hover:shadow-sm transition-shadow">
                          <CardHeader className="pb-3 pt-4">
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-2 rounded-full bg-green-500" />
                              <CardTitle className="text-sm font-medium">
                                {event.name}
                              </CardTitle>
                            </div>
                          </CardHeader>
                          <CardContent className="pt-0 pb-4">
                            <p className="text-xs text-muted-foreground">
                              {event.description}
                            </p>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="webhook" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {triggersByCategory.webhook?.map((trigger) => (
                <Card key={trigger.id} className="hover:shadow-md transition-shadow">
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${getCategoryColor('webhook')}`}>
                        <Webhook className="h-5 w-5" />
                      </div>
                      <CardTitle className="text-base">{trigger.name}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <CardDescription className="text-sm">{trigger.description}</CardDescription>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        </div>
      </Tabs>

      {/* Usage Guide */}
      <Card>
        <CardHeader className="px-4 md:px-6">
          <CardTitle className="text-lg md:text-xl">{t.weldconnect.triggers.howToUse.title}</CardTitle>
          <CardDescription className="text-xs md:text-sm">{t.weldconnect.triggers.howToUse.subtitle}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 md:px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-blue-600" />
                <h4 className="font-semibold">{t.weldconnect.triggers.howToUse.schedule.title}</h4>
              </div>
              <p className="text-sm text-muted-foreground">
                {t.weldconnect.triggers.howToUse.schedule.description}
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5 text-green-600" />
                <h4 className="font-semibold">{t.weldconnect.triggers.howToUse.entityEvent.title}</h4>
              </div>
              <p className="text-sm text-muted-foreground">
                {t.weldconnect.triggers.howToUse.entityEvent.description}
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Webhook className="h-5 w-5 text-purple-600" />
                <h4 className="font-semibold">{t.weldconnect.triggers.howToUse.webhook.title}</h4>
              </div>
              <p className="text-sm text-muted-foreground">
                {t.weldconnect.triggers.howToUse.webhook.description}
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Play className="h-5 w-5 text-orange-600" />
                <h4 className="font-semibold">{t.weldconnect.triggers.howToUse.manual.title}</h4>
              </div>
              <p className="text-sm text-muted-foreground">
                {t.weldconnect.triggers.howToUse.manual.description}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
