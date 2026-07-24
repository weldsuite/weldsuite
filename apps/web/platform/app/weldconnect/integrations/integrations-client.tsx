import { useState, useMemo } from 'react';
import {
  Search,
  Plug,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Zap,
  Link2Off,
  FlaskConical,
  Globe,
  MessageSquare,
  Table2,
  Database,
  Code,
  Mail,
  Cloud,
  Bot,
  Calendar,
  MessageCircle,
  FileText,
  Table,
  Sheet,
  Github,
  CheckCircle,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useIntegrationCatalog,
  useWorkflowIntegrations,
  useConnectWorkflowProvider,
  useDisconnectWorkflowIntegration,
  useTestWorkflowIntegration,
  type IntegrationDef,
  type WorkflowIntegration,
} from '@/hooks/queries/use-workflow-integration-queries';

// ---------------------------------------------------------------------------
// Icon mapping — def.icon is a string key; fall back to Plug
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ElementType> = {
  Plug,
  Globe,
  MessageSquare,
  Table2,
  Database,
  Code,
  Mail,
  Cloud,
  Bot,
  Zap,
  // Catalog icon keys → lucide components (def.icon strings).
  slack: MessageSquare,
  sheet: Sheet,
  mail: Mail,
  calendar: Calendar,
  'message-square': MessageSquare,
  'message-circle': MessageCircle,
  'file-text': FileText,
  table: Table,
  github: Github,
  'check-circle': CheckCircle,
  google_sheets: Table2,
};

function getIcon(iconKey: string): React.ElementType {
  return ICON_MAP[iconKey] ?? Plug;
}

// Stable empty-array fallbacks so the loading/no-data state doesn't hand the
// memoized derivations below a brand-new array reference on every render.
const EMPTY_CATALOG: IntegrationDef[] = [];
const EMPTY_CONNECTIONS: WorkflowIntegration[] = [];

// ---------------------------------------------------------------------------
// Category colour helpers — mirrors actions-client.tsx conventions
// ---------------------------------------------------------------------------

function getCategoryClasses(category: string) {
  switch (category.toLowerCase()) {
    case 'communication':
      return 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300 border-blue-200 dark:border-blue-800';
    case 'productivity':
      return 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800';
    case 'data':
    case 'spreadsheets':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
    case 'integration':
      return 'bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300 border-purple-200 dark:border-purple-800';
    case 'storage':
      return 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800';
    case 'ai':
      return 'bg-pink-50 text-pink-700 dark:bg-pink-900/20 dark:text-pink-300 border-pink-200 dark:border-pink-800';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function getIconBgClass(category: string) {
  switch (category.toLowerCase()) {
    case 'communication':
      return 'bg-blue-50 dark:bg-blue-900/20';
    case 'productivity':
      return 'bg-green-50 dark:bg-green-900/20';
    case 'data':
    case 'spreadsheets':
      return 'bg-emerald-50 dark:bg-emerald-900/20';
    case 'integration':
      return 'bg-purple-50 dark:bg-purple-900/20';
    case 'storage':
      return 'bg-yellow-50 dark:bg-yellow-900/20';
    case 'ai':
      return 'bg-pink-50 dark:bg-pink-900/20';
    default:
      return 'bg-muted';
  }
}

// ---------------------------------------------------------------------------
// Integration card
// ---------------------------------------------------------------------------

interface IntegrationCardProps {
  def: IntegrationDef;
  connection: WorkflowIntegration | undefined;
  onConnect: (provider: string) => void;
  onDisconnect: (id: string) => void;
  onTest: (id: string) => void;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isTesting: boolean;
}

function IntegrationCard({
  def,
  connection,
  onConnect,
  onDisconnect,
  onTest,
  isConnecting,
  isDisconnecting,
  isTesting,
}: IntegrationCardProps) {
  const { t } = useI18n();
  const ti = t.weldconnect.integrations;
  const Icon = getIcon(def.icon || def.type);
  const isConnected = !!connection;
  const hasError = !!connection?.lastError;

  return (
    <Card className="flex flex-col hover:shadow-md transition-shadow duration-200 border-border/50">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div
            className={`p-2.5 rounded-lg flex-shrink-0 ${getIconBgClass(def.category)}`}
          >
            <Icon className="h-5 w-5 text-foreground/80" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-base leading-snug">{def.label}</CardTitle>
              {isConnected ? (
                hasError ? (
                  <Badge
                    variant="outline"
                    className="text-xs shrink-0 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800"
                  >
                    <AlertCircle className="h-3 w-3 mr-1" />
                    {ti.error}
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="text-xs shrink-0 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800"
                  >
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    {ti.connected}
                  </Badge>
                )
              ) : null}
            </div>
            <Badge
              variant="outline"
              className={`text-xs mt-1 ${getCategoryClasses(def.category)}`}
            >
              {def.category}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pb-3 flex-1">
        <CardDescription className="text-xs line-clamp-2">{def.description}</CardDescription>
        <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
          <span>
            {ti.actionCount.replace('{count}', String(def.actions.length))}
          </span>
          <span>
            {ti.triggerCount.replace('{count}', String(def.triggers.length))}
          </span>
        </div>
        {hasError && connection?.lastError && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400 line-clamp-1">
            {connection.lastError}
          </p>
        )}
      </CardContent>

      <CardFooter className="pt-0 flex gap-2">
        {isConnected && connection ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-8 flex-1 text-xs"
              disabled={isTesting}
              onClick={() => onTest(connection.id)}
            >
              {isTesting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5 mr-1" />
              )}
              {ti.test}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 flex-1 text-xs text-destructive hover:text-destructive"
              disabled={isDisconnecting}
              onClick={() => onDisconnect(connection.id)}
            >
              {isDisconnecting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Link2Off className="h-3.5 w-3.5 mr-1" />
              )}
              {ti.disconnect}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            className="h-8 w-full text-xs"
            disabled={isConnecting}
            onClick={() => onConnect(def.type)}
          >
            {isConnecting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                {ti.connecting}
              </>
            ) : (
              <>
                <Plug className="h-3.5 w-3.5 mr-1" />
                {ti.connect}
              </>
            )}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

export function IntegrationsClient() {
  const { t } = useI18n();
  const ti = t.weldconnect.integrations;

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: ti.breadcrumb },
  ]);

  const { data: catalogResult, isLoading: isCatalogLoading, error: catalogError } =
    useIntegrationCatalog();
  const { data: connectionsResult, isLoading: isConnectionsLoading } =
    useWorkflowIntegrations();

  const connectMutation = useConnectWorkflowProvider();
  const disconnectMutation = useDisconnectWorkflowIntegration();
  const testMutation = useTestWorkflowIntegration();

  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [disconnectTargetId, setDisconnectTargetId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

  const catalog = catalogResult?.data ?? EMPTY_CATALOG;
  const connections = connectionsResult?.data ?? EMPTY_CONNECTIONS;

  // Build a lookup: integration type → connected row
  const connectionByType = useMemo<Map<string, WorkflowIntegration>>(() => {
    const map = new Map<string, WorkflowIntegration>();
    for (const c of connections) {
      map.set(c.type, c);
    }
    return map;
  }, [connections]);

  // Derive unique categories
  const categories = useMemo(() => {
    const cats = Array.from(new Set(catalog.map((d) => d.category)));
    return [{ id: 'all', label: ti.allCategories }, ...cats.map((c) => ({ id: c, label: c }))];
  }, [catalog, ti.allCategories]);

  // Filter catalog
  const filtered = useMemo(() => {
    return catalog.filter((def) => {
      if (selectedCategory !== 'all' && def.category.toLowerCase() !== selectedCategory.toLowerCase()) {
        return false;
      }
      if (search) {
        const q = search.toLowerCase();
        return (
          def.label.toLowerCase().includes(q) ||
          def.description.toLowerCase().includes(q) ||
          def.type.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [catalog, selectedCategory, search]);

  // Group filtered by category for display
  const grouped = useMemo(() => {
    if (selectedCategory !== 'all') return { [selectedCategory]: filtered };
    const map: Record<string, IntegrationDef[]> = {};
    for (const def of filtered) {
      if (!map[def.category]) map[def.category] = [];
      map[def.category].push(def);
    }
    return map;
  }, [filtered, selectedCategory]);

  const handleConnect = (provider: string) => {
    setConnectingProvider(provider);
    connectMutation.mutate(
      { provider },
      {
        onError: () => {
          toast.error(ti.toasts.connectFailed);
          setConnectingProvider(null);
        },
        // onSuccess: redirect happens inside mutation fn — no cleanup needed here
      },
    );
  };

  const handleDisconnect = (id: string) => {
    setDisconnectTargetId(id);
  };

  const confirmDisconnect = () => {
    if (!disconnectTargetId) return;
    disconnectMutation.mutate(disconnectTargetId, {
      onSuccess: () => {
        toast.success(ti.toasts.disconnected);
        setDisconnectTargetId(null);
      },
      onError: () => {
        toast.error(ti.toasts.disconnectFailed);
        setDisconnectTargetId(null);
      },
    });
  };

  const handleTest = (id: string) => {
    setTestingId(id);
    testMutation.mutate(id, {
      onSuccess: (result) => {
        if (result.data.success) {
          toast.success(result.data.message || ti.toasts.testSuccess);
        } else {
          toast.error(result.data.message || ti.toasts.testFailed);
        }
        setTestingId(null);
      },
      onError: () => {
        toast.error(ti.toasts.testFailed);
        setTestingId(null);
      },
    });
  };

  const connectedCount = connections.length;

  return (
    <>
      <ConfirmDialog
        open={!!disconnectTargetId}
        onOpenChange={(open) => {
          if (!open) setDisconnectTargetId(null);
        }}
        title={ti.disconnectConfirm.title}
        description={ti.disconnectConfirm.description}
        confirmLabel={ti.disconnectConfirm.confirmLabel}
        variant="destructive"
        loading={disconnectMutation.isPending}
        onConfirm={confirmDisconnect}
      />

      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-6 md:p-8 max-w-[1600px] space-y-6 md:space-y-8">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{ti.title}</h1>
              <div className="flex flex-wrap items-center gap-2 md:gap-6 mt-2">
                <span className="flex items-center gap-1 text-xs md:text-sm">
                  <Plug className="h-3.5 w-3.5 md:h-4 md:w-4 text-blue-600" />
                  <span className="font-medium">{catalog.length}</span>{' '}
                  {ti.availableCount}
                </span>
                {connectedCount > 0 && (
                  <>
                    <span className="text-muted-foreground hidden sm:inline">•</span>
                    <span className="flex items-center gap-1 text-xs md:text-sm text-green-600">
                      <CheckCircle2 className="h-3.5 w-3.5 md:h-4 md:w-4" />
                      <span className="font-medium">{connectedCount}</span>{' '}
                      {ti.connectedCount}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Error state */}
          {catalogError && (
            <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/10 dark:border-red-800 p-4">
              <AlertCircle className="h-5 w-5 text-red-600 shrink-0" />
              <p className="text-sm text-red-700 dark:text-red-300">{ti.loadError}</p>
            </div>
          )}

          <div className="flex flex-col lg:flex-row gap-4 lg:gap-6">
            {/* Mobile categories */}
            <div className="lg:hidden">
              <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-4 px-4">
                {categories.map((cat) => (
                  <Button
                    key={cat.id}
                    type="button"
                    variant="ghost"
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap flex-shrink-0 transition-colors ${
                      selectedCategory === cat.id
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                    }`}
                  >
                    {cat.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Desktop sidebar */}
            <div className="hidden lg:block w-56 space-y-1 flex-shrink-0">
              <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                {ti.categories}
              </h3>
              {categories.map((cat) => (
                <Button
                  key={cat.id}
                  type="button"
                  variant="ghost"
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedCategory === cat.id
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted'
                  }`}
                >
                  <span className="capitalize">{cat.label}</span>
                  {cat.id !== 'all' && (
                    <span className="text-xs opacity-70">
                      {catalog.filter((d) => d.category.toLowerCase() === cat.id.toLowerCase()).length}
                    </span>
                  )}
                </Button>
              ))}
            </div>

            {/* Main content */}
            <div className="flex-1 space-y-4">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
                <Input
                  placeholder={ti.searchPlaceholder}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-9 md:h-10"
                />
              </div>

              {/* Loading */}
              {(isCatalogLoading || isConnectionsLoading) && (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}

              {/* Empty search */}
              {!isCatalogLoading && !isConnectionsLoading && filtered.length === 0 && (
                <div className="text-center py-12">
                  <Plug className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                  <p className="text-lg font-medium">{ti.noResults}</p>
                  <p className="text-sm text-muted-foreground mt-1">{ti.noResultsHint}</p>
                </div>
              )}

              {/* Grouped catalog */}
              {!isCatalogLoading &&
                !isConnectionsLoading &&
                Object.entries(grouped).map(([category, defs]) => (
                  <div key={category}>
                    {selectedCategory === 'all' && (
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3 capitalize">
                        {category}
                      </h2>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {defs.map((def) => {
                        const connection = connectionByType.get(def.type);
                        return (
                          <IntegrationCard
                            key={def.id}
                            def={def}
                            connection={connection}
                            onConnect={handleConnect}
                            onDisconnect={handleDisconnect}
                            onTest={handleTest}
                            isConnecting={
                              connectingProvider === def.type && connectMutation.isPending
                            }
                            isDisconnecting={
                              !!connection &&
                              disconnectTargetId === connection.id &&
                              disconnectMutation.isPending
                            }
                            isTesting={testingId === connection?.id && testMutation.isPending}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
