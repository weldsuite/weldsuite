
import { useState, useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Search,
  Mail,
  MessageSquare,
  Bell,
  Database,
  Globe,
  Code,
  FileText,
  Users,
  Calendar,
  Clock,
  GitBranch,
  Zap,
  AlertCircle,
  CheckCircle,
  XCircle,
  PlayCircle,
  PauseCircle,
  RefreshCw,
  Plus,
  Settings,
  ShieldCheck,
  Cpu,
  Cloud,
  Server,
  Webhook,
  Terminal,
  Send,
  Download,
  Upload,
  Copy,
  Edit,
  Trash2,
  Package,
  DollarSign,
  ShoppingCart,
  CreditCard,
  TrendingUp,
  BarChart3,
  Sparkles,
  Lock,
  Key,
  Share2,
  Linkedin,
  Twitter,
  Book,
  type LucideIcon,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Switch } from '@weldsuite/ui/components/switch';

interface ActionTypeDto {
  id: string;
  // The action-types endpoint currently only returns id/name/description/
  // category/icon; the richer fields below are aspirational UI affordances
  // and stay optional until the backend carries them.
  typeKey?: string;
  name: string;
  description: string;
  category: string;
  icon?: string | null;
  inputs?: {
    name: string;
    type: string;
    description?: string | null;
    required: boolean;
  }[] | null;
  outputs?: {
    name: string;
    type: string;
    description?: string | null;
  }[] | null;
  isCustom?: boolean;
  isPremium?: boolean;
  isDeprecated?: boolean;
  deprecationMessage?: string | null;
  usageCount?: number;
  documentation?: string | null;
  tags?: string[] | null;
}

interface ActionCategory {
  id: string;
  name: string;
  count: number;
}

interface ActionsClientProps {
  initialActions: ActionTypeDto[];
  categories: ActionCategory[];
}

// Icon mapping helper
const getIconComponent = (iconName?: string | null) => {
  const iconMap: Record<string, LucideIcon> = {
    Mail, MessageSquare, Bell, Database, Globe, Code, FileText, Users,
    Calendar, Clock, GitBranch, Zap, AlertCircle, CheckCircle, XCircle,
    PlayCircle, PauseCircle, RefreshCw, Plus, Settings, ShieldCheck,
    Cpu, Cloud, Server, Webhook, Terminal, Send, Download, Upload,
    Copy, Edit, Trash2, Package, DollarSign, ShoppingCart, CreditCard,
    TrendingUp, BarChart3, Sparkles, Lock, Key, Share2, Linkedin,
    Twitter,
  };

  return iconName && iconMap[iconName] ? iconMap[iconName] : Zap;
};

// Category icon and color mapping
const categoryInfo: Record<string, { icon: LucideIcon; color: string }> = {
  all: { icon: Zap, color: 'text-gray-600' },
  communication: { icon: Mail, color: 'text-blue-600' },
  data: { icon: Database, color: 'text-green-600' },
  integration: { icon: Globe, color: 'text-purple-600' },
  logic: { icon: GitBranch, color: 'text-orange-600' },
  utility: { icon: Settings, color: 'text-yellow-600' },
  ai: { icon: Sparkles, color: 'text-pink-600' },
};

export function ActionsClient({ initialActions, categories }: ActionsClientProps) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.actions },
  ]);

  const [selectedCategory, setSelectedCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedAction, setSelectedAction] = useState<ActionTypeDto | null>(null);
  const [showOnlyPremium, setShowOnlyPremium] = useState(false);
  const [showOnlyDeprecated, setShowOnlyDeprecated] = useState(false);

  // Filter actions
  const filteredActions = useMemo(() => {
    return initialActions.filter(action => {
      if (selectedCategory !== 'all' && action.category.toLowerCase() !== selectedCategory) return false;
      if (showOnlyPremium && !action.isPremium) return false;
      if (showOnlyDeprecated && !action.isDeprecated) return false;
      if (search) {
        const searchLower = search.toLowerCase();
        return (
          action.name.toLowerCase().includes(searchLower) ||
          action.description.toLowerCase().includes(searchLower) ||
          action.tags?.some(tag => tag.toLowerCase().includes(searchLower))
        );
      }
      return true;
    });
  }, [initialActions, selectedCategory, showOnlyPremium, showOnlyDeprecated, search]);

  // Calculate stats
  const totalActions = initialActions.length;
  const premiumActions = initialActions.filter(a => a.isPremium).length;
  const deprecatedActions = initialActions.filter(a => a.isDeprecated).length;
  const totalUsage = initialActions.reduce((sum, a) => sum + (a.usageCount ?? 0), 0);

  // Prepare categories with 'all' option
  const allCategories = [
    { id: 'all', name: t.weldconnect.actions.allActions, count: totalActions },
    ...categories,
  ];

  const getCategoryColor = (category: string) => {
    const cat = category.toLowerCase();
    switch (cat) {
      case 'communication': return 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300 border-blue-200 dark:border-blue-800';
      case 'data': return 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800';
      case 'integration': return 'bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300 border-purple-200 dark:border-purple-800';
      case 'logic': return 'bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-300 border-orange-200 dark:border-orange-800';
      case 'utility': return 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800';
      case 'ai': return 'bg-pink-50 text-pink-700 dark:bg-pink-900/20 dark:text-pink-300 border-pink-200 dark:border-pink-800';
      default: return '';
    }
  };

  const handleCopyAction = (action: ActionTypeDto) => {
    navigator.clipboard.writeText(JSON.stringify(action, null, 2));
    toast.success(t.weldconnect.actions.toasts.copied.replace('{name}', action.name));
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 md:p-8 max-w-[1600px] space-y-6 md:space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{t.weldconnect.actions.title}</h1>
            <div className="flex flex-wrap items-center gap-2 md:gap-6 mt-2 md:mt-3">
              <div className="flex flex-wrap items-center gap-2 md:gap-4 text-xs md:text-sm">
                <span className="flex items-center gap-1">
                  <Zap className="h-3.5 w-3.5 md:h-4 md:w-4 text-blue-600" />
                  <span className="font-medium">{totalActions}</span> {t.weldconnect.breadcrumbs.actions}
                </span>
                <span className="text-muted-foreground hidden sm:inline">•</span>
                <span className="flex items-center gap-1">
                  <TrendingUp className="h-3.5 w-3.5 md:h-4 md:w-4 text-green-600" />
                  <span className="font-medium">{totalUsage.toLocaleString()}</span> {t.weldconnect.actions.uses}
                </span>
                {premiumActions > 0 && (
                  <>
                    <span className="text-muted-foreground hidden sm:inline">•</span>
                    <span className="flex items-center gap-1 text-purple-600">
                      <Lock className="h-3.5 w-3.5 md:h-4 md:w-4" />
                      <span className="font-medium">{premiumActions}</span> {t.weldconnect.actions.premium}
                    </span>
                  </>
                )}
                {deprecatedActions > 0 && (
                  <>
                    <span className="text-muted-foreground hidden sm:inline">•</span>
                    <span className="flex items-center gap-1 text-orange-600">
                      <AlertCircle className="h-3.5 w-3.5 md:h-4 md:w-4" />
                      <span className="font-medium">{deprecatedActions}</span> {t.weldconnect.actions.deprecated}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="h-8 text-xs md:text-sm px-2 md:px-3 flex items-center justify-center shadow-none"
              onClick={() => toast.info(t.weldconnect.actions.documentationComingSoon)}
            >
              <Book className="h-4 w-4 -mr-0.5" />
              <span className="hidden md:inline ml-1">{t.weldconnect.actions.documentation}</span>
            </Button>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 mt-6 md:mt-8">
          {/* Mobile Category Filter */}
          <div className="lg:hidden">
            <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-4 px-4">
              {allCategories.map(category => {
                const catInfo = categoryInfo[category.id.toLowerCase()] || categoryInfo.all;
                const Icon = catInfo.icon;
                return (
                  <Button
                    key={category.id}
                    variant="ghost"
                    onClick={() => setSelectedCategory(category.id)}
                    className={`
                      flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap flex-shrink-0 transition-colors
                      ${selectedCategory === category.id
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                      }
                    `}
                  >
                    <Icon className={`h-3.5 w-3.5 ${selectedCategory === category.id ? '' : catInfo.color}`} />
                    <span>{category.name}</span>
                    <span className="opacity-70">({category.count})</span>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Desktop Sidebar Categories */}
          <div className="hidden lg:block w-64 space-y-2 flex-shrink-0">
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">{t.weldconnect.actions.categories}</h3>
            {allCategories.map(category => {
              const catInfo = categoryInfo[category.id.toLowerCase()] || categoryInfo.all;
              const Icon = catInfo.icon;

              return (
                <Button
                  key={category.id}
                  variant="ghost"
                  onClick={() => setSelectedCategory(category.id)}
                  className={`
                    w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors
                    ${selectedCategory === category.id
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted'
                    }
                  `}
                >
                  <div className="flex items-center gap-2">
                    <Icon className={`h-4 w-4 ${selectedCategory === category.id ? '' : catInfo.color}`} />
                    <span>{category.name}</span>
                  </div>
                  <span className="text-xs opacity-70">{category.count}</span>
                </Button>
              );
            })}

            {/* Filters */}
            <div className="pt-4 space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground">{t.weldconnect.actions.filters}</h3>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={showOnlyPremium}
                    onCheckedChange={setShowOnlyPremium}
                  />
                  <span>{t.weldconnect.actions.premiumOnly}</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={showOnlyDeprecated}
                    onCheckedChange={setShowOnlyDeprecated}
                  />
                  <span>{t.weldconnect.actions.deprecatedOnly}</span>
                </label>
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 space-y-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
              <Input
                placeholder={t.weldconnect.actions.searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9 md:h-10"
              />
            </div>

            {/* Actions Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredActions.length === 0 ? (
                <div className="col-span-full">
                  <div className="text-center py-12">
                    <Zap className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                    <p className="text-lg font-medium">{t.weldconnect.actions.noActions}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t.weldconnect.actions.noActionsHint}
                    </p>
                  </div>
                </div>
              ) : (
                filteredActions.map((action) => {
                  const Icon = getIconComponent(action.icon);
                  return (
                    <Card
                      key={action.id}
                      className="hover:shadow-md transition-all duration-200 cursor-pointer border-border/50"
                      onClick={() => setSelectedAction(action)}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${getCategoryColor(action.category).split(' ')[0]}`}>
                              <Icon className="h-5 w-5" />
                            </div>
                            <div>
                              <CardTitle className="text-base flex items-center gap-2">
                                {action.name}
                                {action.isPremium && (
                                  <Badge variant="secondary" className="text-xs">
                                    <Lock className="h-3 w-3 mr-0.5" />
                                    {t.weldconnect.actions.premium}
                                  </Badge>
                                )}
                                {action.isDeprecated && (
                                  <Badge variant="outline" className="text-xs bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300">
                                    {t.weldconnect.actions.deprecated}
                                  </Badge>
                                )}
                                {action.isCustom && (
                                  <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                                    {t.weldconnect.actions.custom}
                                  </Badge>
                                )}
                              </CardTitle>
                              <Badge
                                variant="outline"
                                className={`text-xs mt-1 ${getCategoryColor(action.category)}`}
                              >
                                {action.category}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="pb-3">
                        <CardDescription className="text-xs line-clamp-2">
                          {action.description}
                        </CardDescription>
                        <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                          <span>{t.weldconnect.actions.inputs.replace('{count}', String(action.inputs?.length || 0))}</span>
                          <span>{t.weldconnect.actions.outputs.replace('{count}', String(action.outputs?.length || 0))}</span>
                          <span className="ml-auto">{t.weldconnect.actions.usageCount.replace('{count}', (action.usageCount ?? 0).toLocaleString())}</span>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Action Details Dialog */}
      <Dialog open={!!selectedAction} onOpenChange={() => setSelectedAction(null)}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
          {selectedAction && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className={`p-3 rounded-lg ${getCategoryColor(selectedAction.category).split(' ')[0]}`}>
                    {(() => {
                      const Icon = getIconComponent(selectedAction.icon);
                      return <Icon className="h-6 w-6" />;
                    })()}
                  </div>
                  <div>
                    <DialogTitle className="text-xl flex items-center gap-2">
                      {selectedAction.name}
                      {selectedAction.isPremium && (
                        <Badge variant="secondary">
                          <Lock className="h-3 w-3 mr-0.5" />
                          {t.weldconnect.actions.premium}
                        </Badge>
                      )}
                      {selectedAction.isCustom && (
                        <Badge variant="outline" className="bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                          {t.weldconnect.actions.custom}
                        </Badge>
                      )}
                    </DialogTitle>
                    <DialogDescription className="mt-1">
                      {selectedAction.description}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <Tabs defaultValue="configuration" className="flex-1 overflow-hidden flex flex-col mt-6">
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="configuration">{t.weldconnect.actions.tabs.configuration}</TabsTrigger>
                  <TabsTrigger value="inputs">{t.weldconnect.actions.tabs.inputs}</TabsTrigger>
                  <TabsTrigger value="outputs">{t.weldconnect.actions.tabs.outputs}</TabsTrigger>
                  <TabsTrigger value="documentation">{t.weldconnect.actions.tabs.documentation}</TabsTrigger>
                </TabsList>

                <div className="flex-1 overflow-auto">
                  <TabsContent value="configuration" className="mt-4 space-y-4">
                    <div>
                      <h4 className="text-sm font-medium mb-3">{t.weldconnect.actions.basicInformation}</h4>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-sm text-muted-foreground">{t.weldconnect.actions.categoryLabel}</label>
                          <p className="text-sm mt-1">
                            <Badge className={getCategoryColor(selectedAction.category)}>
                              {selectedAction.category}
                            </Badge>
                          </p>
                        </div>
                        <div>
                          <label className="text-sm text-muted-foreground">{t.weldconnect.actions.usageCountLabel}</label>
                          <p className="text-sm mt-1">{t.weldconnect.actions.usageCountTimes.replace('{count}', (selectedAction.usageCount ?? 0).toLocaleString())}</p>
                        </div>
                        <div>
                          <label className="text-sm text-muted-foreground">{t.weldconnect.actions.typeKeyLabel}</label>
                          <p className="text-sm mt-1 font-mono">{selectedAction.typeKey ?? selectedAction.id}</p>
                        </div>
                        <div>
                          <label className="text-sm text-muted-foreground">{t.weldconnect.actions.typeLabel}</label>
                          <p className="text-sm mt-1">
                            {selectedAction.isCustom ? t.weldconnect.actions.customAction : t.weldconnect.actions.builtInAction}
                          </p>
                        </div>
                      </div>
                    </div>

                    {selectedAction.tags && selectedAction.tags.length > 0 && (
                      <div>
                        <h4 className="text-sm font-medium mb-3">{t.weldconnect.actions.tagsLabel}</h4>
                        <div className="flex flex-wrap gap-1">
                          {selectedAction.tags.map(tag => (
                            <Badge key={tag} variant="secondary">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedAction.deprecationMessage && (
                      <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 border border-red-200 dark:border-red-800">
                        <div className="flex items-start gap-3">
                          <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
                          <div>
                            <h4 className="font-semibold text-red-900 dark:text-red-100 mb-1">{t.weldconnect.actions.deprecated}</h4>
                            <p className="text-sm text-red-700 dark:text-red-300">
                              {selectedAction.deprecationMessage}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="inputs" className="mt-4">
                    <div className="space-y-3">
                      {selectedAction.inputs && selectedAction.inputs.length > 0 ? (
                        selectedAction.inputs.map(input => (
                          <div key={input.name} className="p-3 bg-muted rounded-lg">
                            <div className="flex items-start justify-between">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-sm font-medium">{input.name}</span>
                                  {input.required && (
                                    <Badge variant="destructive" className="text-xs">{t.weldconnect.actions.required}</Badge>
                                  )}
                                </div>
                                {input.description && (
                                  <p className="text-xs text-muted-foreground mt-1">{input.description}</p>
                                )}
                              </div>
                              <Badge variant="outline" className="text-xs">
                                {input.type}
                              </Badge>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">{t.weldconnect.actions.noInputsDefined}</p>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="outputs" className="mt-4">
                    <div className="space-y-3">
                      {selectedAction.outputs && selectedAction.outputs.length > 0 ? (
                        selectedAction.outputs.map(output => (
                          <div key={output.name} className="p-3 bg-muted rounded-lg">
                            <div className="flex items-start justify-between">
                              <div>
                                <span className="font-mono text-sm font-medium">{output.name}</span>
                                {output.description && (
                                  <p className="text-xs text-muted-foreground mt-1">{output.description}</p>
                                )}
                              </div>
                              <Badge variant="outline" className="text-xs">
                                {output.type}
                              </Badge>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">{t.weldconnect.actions.noOutputsDefined}</p>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="documentation" className="mt-4">
                    <div className="space-y-4">
                      {selectedAction.documentation ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <div className="p-4 bg-muted rounded-lg">
                            <pre className="text-xs overflow-auto whitespace-pre-wrap">
                              {selectedAction.documentation}
                            </pre>
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-8">
                          <Book className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                          <p className="text-sm text-muted-foreground">
                            {t.weldconnect.actions.noDocumentation}
                          </p>
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </div>
              </Tabs>

              <DialogFooter className="mt-6">
                <Button variant="outline" onClick={() => setSelectedAction(null)}>
                  {t.weldconnect.actions.close}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleCopyAction(selectedAction)}
                  className="flex items-center gap-2"
                >
                  <Copy className="h-4 w-4" />
                  {t.weldconnect.actions.copyConfiguration}
                </Button>
                <Button className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  {t.weldconnect.actions.addToWorkflow}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
