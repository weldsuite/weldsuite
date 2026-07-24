
import { useState } from 'react';
import { getTranslations } from '@/lib/i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Separator } from '@weldsuite/ui/components/separator';
import { IntegrationDetailLayout } from '@/components/settings';
import {
  Server,
  Plus,
  MoreVertical,
  Trash2,
  RefreshCw,
  Zap,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Pencil,
  Globe,
  FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { integrationKeys } from '@/hooks/queries/use-integration-queries';

// ============================================================================
// Types
// ============================================================================

interface McpConnection {
  id: string;
  provider: string;
  name: string | null;
  status: string;
  settings: {
    transportType?: string;
    url?: string;
    authType?: string;
    headerName?: string;
    discoveredTools?: Array<{ name: string; description: string }>;
    lastDiscoveredAt?: string;
  } | null;
  lastError: string | null;
  connectedAt: string | null;
  createdAt: string;
}

interface McpFormData {
  name: string;
  url: string;
  authType: 'none' | 'bearer' | 'api_key' | 'header';
  headerName: string;
  accessToken: string;
}

const DEFAULT_FORM: McpFormData = {
  name: '',
  url: '',
  authType: 'none',
  headerName: '',
  accessToken: '',
};

const mcpIcon = (
  <img
    src="https://upload.wikimedia.org/wikipedia/commons/f/fe/Model_Context_Protocol_logo.svg"
    className="h-7 w-7"
    alt="MCP Servers"
  />
);

// ============================================================================
// Component
// ============================================================================

export default function McpServersPage() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const ts = getTranslations('settings');
  const tm = ts.mcpServers;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<McpFormData>(DEFAULT_FORM);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);

  // Fetch MCP connections
  const { data, isLoading } = useQuery({
    queryKey: ['mcp-connections'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: McpConnection[] }>('/integrations/connections');
      return (res.data || []).filter((c) => c.provider === 'mcp_server');
    },
  });

  // Create
  const createMutation = useMutation({
    mutationFn: async (formData: McpFormData) => {
      const client = await getClient();
      return client.post('/integrations/connections', {
        provider: 'mcp_server',
        name: formData.name,
        settings: {
          transportType: 'streamable-http',
          url: formData.url,
          authType: formData.authType,
          headerName: formData.authType === 'header' ? formData.headerName : undefined,
        },
        accessToken: formData.accessToken || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-connections'] });
      queryClient.invalidateQueries({ queryKey: integrationKeys.connections() });
      setDialogOpen(false);
      setForm(DEFAULT_FORM);
      toast.success(tm.messages.added);
    },
    onError: () => toast.error(tm.messages.addFailed),
  });

  // Update
  const updateMutation = useMutation({
    mutationFn: async ({ id, formData }: { id: string; formData: McpFormData }) => {
      const client = await getClient();
      return client.patch(`/integrations/connections/${id}`, {
        name: formData.name,
        settings: {
          transportType: 'streamable-http',
          url: formData.url,
          authType: formData.authType,
          headerName: formData.authType === 'header' ? formData.headerName : undefined,
        },
        accessToken: formData.accessToken || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-connections'] });
      queryClient.invalidateQueries({ queryKey: integrationKeys.connections() });
      setDialogOpen(false);
      setEditingId(null);
      setForm(DEFAULT_FORM);
      toast.success(tm.messages.updated);
    },
    onError: () => toast.error(tm.messages.updateFailed),
  });

  // Delete
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete(`/integrations/connections/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-connections'] });
      queryClient.invalidateQueries({ queryKey: integrationKeys.connections() });
      setDeleteConfirmId(null);
      toast.success(tm.messages.removed);
    },
    onError: () => toast.error(tm.messages.removeFailed),
  });

  // Test connectivity
  const testConnection = async (id: string) => {
    setTestingId(id);
    try {
      const client = await getClient();
      const res = await client.post<{ data: { connected: boolean; error?: string } }>(
        `/integrations/connections/${id}/test`,
        {},
      );
      if (res.data?.connected) {
        toast.success(tm.messages.connectionSuccess);
      } else {
        toast.error(res.data?.error || tm.messages.connectionFailed);
      }
      queryClient.invalidateQueries({ queryKey: ['mcp-connections'] });
    } catch {
      toast.error(tm.messages.connectionFailed);
    } finally {
      setTestingId(null);
    }
  };

  // Discover tools
  const discoverTools = async (id: string) => {
    setDiscoveringId(id);
    try {
      const client = await getClient();
      const res = await client.post<{ data: { tools: Array<{ name: string }>; lastDiscoveredAt: string } }>(
        `/integrations/connections/${id}/discover-tools`,
        {},
      );
      const count = res.data?.tools?.length || 0;
      toast.success(count !== 1 ? tm.messages.discoveredToolsPlural.replace('{count}', String(count)) : tm.messages.discoveredTools);
      queryClient.invalidateQueries({ queryKey: ['mcp-connections'] });
      queryClient.invalidateQueries({ queryKey: ['integration-connections-mcp'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Tool discovery failed');
    } finally {
      setDiscoveringId(null);
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setDialogOpen(true);
  };

  const openEdit = (conn: McpConnection) => {
    setEditingId(conn.id);
    setForm({
      name: conn.name || '',
      url: conn.settings?.url || '',
      authType: (conn.settings?.authType as McpFormData['authType']) || 'none',
      headerName: conn.settings?.headerName || '',
      accessToken: '', // Don't show existing token
    });
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) {
      toast.error(tm.messages.nameRequired);
      return;
    }
    if (!form.url.trim()) {
      toast.error(tm.messages.urlRequired);
      return;
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, formData: form });
    } else {
      createMutation.mutate(form);
    }
  };

  const connections = data ?? [];
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const connected = connections.length > 0;

  return (
    <>
      <IntegrationDetailLayout
        name={tm.name}
        description={tm.description}
        category="AI"
        icon={mcpIcon}
        connected={connected}
        isLoading={isLoading}
        isWorking={isSaving || deleteMutation.isPending}
        connectLabel={tm.addServer}
        disconnectLabel={tm.dialog.cancel}
        onConnect={openCreate}
        onDisconnect={undefined}
        canManage={!connected}
        provider="WeldSuite"
        resources={[
          { label: 'Website', href: 'https://modelcontextprotocol.io', icon: Globe },
          { label: 'Documentation', href: 'https://modelcontextprotocol.io/docs', icon: FileText },
        ]}
        overview={tm.description}
      >
        {/* Add Server button always visible in content area */}
        <div className="flex items-center justify-between mb-4">
          {connected && (
            <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider uppercase">
              {tm.connectedServers}
            </h2>
          )}
          <Button onClick={openCreate} size="sm" className={connected ? '' : 'ml-auto'}>
            <Plus className="h-4 w-4 mr-2" />
            {tm.addServer}
          </Button>
        </div>

        {connections.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <Server className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">{tm.noServers}</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              {tm.noServersDescription}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {connections.map((conn) => {
              const tools = conn.settings?.discoveredTools || [];
              const statusColor = conn.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' :
                conn.status === 'error' ? 'text-red-500' : 'text-muted-foreground';
              const StatusIcon = conn.status === 'active' ? CheckCircle2 :
                conn.status === 'error' ? XCircle : AlertCircle;

              return (
                <Card key={conn.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="rounded-lg bg-blue-100 dark:bg-blue-900/30 p-2 flex-shrink-0">
                          <Server className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-base">{conn.name || tm.unnamed}</CardTitle>
                            <StatusIcon className={`h-4 w-4 ${statusColor}`} />
                          </div>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {conn.settings?.url || tm.noUrl}
                          </p>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(conn)}>
                            <Pencil className="h-4 w-4 mr-2" /> {tm.menu.edit}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => testConnection(conn.id)}
                            disabled={testingId === conn.id}
                          >
                            {testingId === conn.id ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Zap className="h-4 w-4 mr-2" />
                            )}
                            {tm.menu.testConnection}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => discoverTools(conn.id)}
                            disabled={discoveringId === conn.id}
                          >
                            {discoveringId === conn.id ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4 mr-2" />
                            )}
                            {tm.menu.discoverTools}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteConfirmId(conn.id)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" /> {tm.menu.remove}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {conn.settings?.authType && conn.settings.authType !== 'none' && (
                        <Badge variant="outline" className="text-xs">
                          Auth: {conn.settings.authType}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-xs">
                        <Wrench className="h-3 w-3 mr-1" />
                        {tools.length !== 1 ? tm.toolsCountPlural.replace('{count}', String(tools.length)) : tm.toolsCount}
                      </Badge>
                      {conn.settings?.lastDiscoveredAt && (
                        <span className="text-xs text-muted-foreground">
                          {tm.lastDiscovered} {new Date(conn.settings.lastDiscoveredAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    {conn.lastError && (
                      <p className="text-xs text-red-500 mt-2 truncate">{conn.lastError}</p>
                    )}
                    {tools.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {tools.slice(0, 8).map((t) => (
                          <Badge key={t.name} variant="outline" className="text-xs font-mono font-normal">
                            {t.name}
                          </Badge>
                        ))}
                        {tools.length > 8 && (
                          <Badge variant="outline" className="text-xs font-normal">
                            +{tools.length - 8} more
                          </Badge>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </IntegrationDetailLayout>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? tm.dialog.editTitle : tm.dialog.addTitle}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium">{tm.dialog.nameLabel}</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={tm.dialog.namePlaceholder}
                className="mt-1.5"
              />
            </div>

            <div>
              <label className="text-sm font-medium">{tm.dialog.urlLabel}</label>
              <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
                {tm.dialog.urlDescription}
              </p>
              <Input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={tm.dialog.urlPlaceholder}
                type="url"
              />
            </div>

            <Separator />

            <div>
              <label className="text-sm font-medium">{tm.dialog.authLabel}</label>
              <Select
                value={form.authType}
                onValueChange={(v) => setForm({ ...form, authType: v as McpFormData['authType'] })}
              >
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{tm.dialog.authNone}</SelectItem>
                  <SelectItem value="bearer">{tm.dialog.authBearer}</SelectItem>
                  <SelectItem value="api_key">{tm.dialog.authApiKey}</SelectItem>
                  <SelectItem value="header">{tm.dialog.authHeader}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.authType === 'header' && (
              <div>
                <label className="text-sm font-medium">{tm.dialog.headerNameLabel}</label>
                <Input
                  value={form.headerName}
                  onChange={(e) => setForm({ ...form, headerName: e.target.value })}
                  placeholder={tm.dialog.headerNamePlaceholder}
                  className="mt-1.5"
                />
              </div>
            )}

            {form.authType !== 'none' && (
              <div>
                <label className="text-sm font-medium">
                  {form.authType === 'bearer' ? tm.dialog.tokenLabel : form.authType === 'api_key' ? tm.dialog.apiKeyLabel : tm.dialog.headerValueLabel}
                </label>
                <Input
                  value={form.accessToken}
                  onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
                  placeholder={editingId ? tm.dialog.tokenPlaceholderNew : tm.dialog.tokenPlaceholder}
                  type="password"
                  className="mt-1.5"
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{tm.dialog.cancel}</Button>
            <Button onClick={handleSubmit} disabled={isSaving}>
              {isSaving ? tm.dialog.saving : editingId ? tm.dialog.save : tm.dialog.add}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{tm.deleteDialog.title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {tm.deleteDialog.description}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>{tm.deleteDialog.cancel}</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirmId && deleteMutation.mutate(deleteConfirmId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? tm.deleteDialog.removing : tm.deleteDialog.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
