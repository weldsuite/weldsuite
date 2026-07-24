
import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Link2,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  MoreVertical,
  Loader2,
  ExternalLink,
  Unplug,
  Settings,
} from 'lucide-react';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { HELPDESK_PROVIDERS, type HelpdeskProviderId } from '@/lib/integrations/helpdesk-providers';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useI18n } from '@/lib/i18n/provider';
import {
  useConnectChannelOAuth,
  useDisconnectChannel,
  useSaveTokenIntegration,
  useTestChannelConnection,
  useRefreshChannelToken,
} from '@/hooks/queries/use-helpdesk-integration-queries';

interface ChannelConnectButtonProps {
  provider: HelpdeskProviderId;
  integration?: Helpdesk.Api.ChannelIntegration | null;
  onConnectionChange?: () => void;
  variant?: 'default' | 'compact';
  className?: string;
  hideIcon?: boolean;
  buttonColor?: string;
}

export function ChannelConnectButton({
  provider,
  integration,
  onConnectionChange,
  className,
  hideIcon,
  buttonColor,
}: ChannelConnectButtonProps) {
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const connectOAuthMutation = useConnectChannelOAuth();
  const disconnectChannelMutation = useDisconnectChannel();
  const saveTokenMutation = useSaveTokenIntegration();
  const testConnectionMutation = useTestChannelConnection();
  const refreshTokenMutation = useRefreshChannelToken();

  const [isConnecting, setIsConnecting] = useState(false);
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [tokenValue, setTokenValue] = useState('');

  const providerConfig = HELPDESK_PROVIDERS[provider];

  if (!providerConfig) {
    return null;
  }

  const isConnected = integration?.status === 'connected';
  const isExpired = integration?.status === 'expired';
  const hasError = integration?.status === 'error';

  const handleConnect = async () => {
    if (providerConfig.type === 'oauth2') {
      // POST-first pattern: app-api mints the OAuth state nonce against the
      // caller's Clerk JWT and returns the provider authorize URL.
      setIsConnecting(true);
      try {
        const { authUrl } = await connectOAuthMutation.mutateAsync(provider);
        if (authUrl) {
          window.location.href = authUrl;
        } else {
          setIsConnecting(false);
          toast.error(ti.failedToStartOAuth);
        }
      } catch {
        setIsConnecting(false);
        toast.error(ti.failedToStartOAuth);
      }
    } else if (providerConfig.type === 'token') {
      // Show token input dialog
      setShowTokenDialog(true);
    } else {
      // Wizard type - could open a wizard dialog
      toast.info(ti.setupWizardComingSoon);
    }
  };

  const handleSaveToken = async () => {
    if (!tokenValue.trim()) {
      toast.error(ti.pleaseEnterToken);
      return;
    }

    try {
      await saveTokenMutation.mutateAsync({ provider, token: tokenValue.trim() });
      toast.success(ti.connectedSuccessfully.replace('{name}', providerConfig.name));
      setShowTokenDialog(false);
      setTokenValue('');
      onConnectionChange?.();
    } catch {
      toast.error(ti.failedToConnect);
    }
  };

  const handleDisconnect = async () => {
    if (!integration?.id) return;

    try {
      await disconnectChannelMutation.mutateAsync(integration.id);
      toast.success(ti.disconnectedProvider.replace('{name}', providerConfig.name));
      setShowDisconnectDialog(false);
      onConnectionChange?.();
    } catch {
      toast.error(ti.failedToDisconnect);
    }
  };

  const handleTestConnection = async () => {
    try {
      const result = await testConnectionMutation.mutateAsync(provider);
      if (result.success) {
        toast.success(result.message || ti.connectionWorking);
      } else {
        toast.error(ti.connectionTestFailed);
      }
    } catch {
      toast.error(ti.connectionTestFailed);
    }
  };

  const handleRefreshToken = async () => {
    if (!integration?.id) return;

    try {
      await refreshTokenMutation.mutateAsync(integration.id);
      toast.success(ti.tokenRefreshed);
      onConnectionChange?.();
    } catch {
      toast.error(ti.failedToRefreshToken);
    }
  };

  const isTesting = testConnectionMutation.isPending;
  const isDisconnecting = disconnectChannelMutation.isPending;

  // Connected state
  if (isConnected) {
    return (
      <>
        <div className={cn('flex items-center gap-2', className)}>
          <Badge variant="secondary" className="flex items-center gap-1.5 py-1 px-2">
            <CheckCircle className="h-3 w-3 text-green-500" />
            <span className="text-xs">{ti.connectedStatus}</span>
            {integration?.accountInfo?.name && (
              <span className="text-xs text-muted-foreground">
                ({integration.accountInfo.name})
              </span>
            )}
          </Badge>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Settings link for providers with settings pages */}
              {provider === 'discord' && (
                <DropdownMenuItem asChild>
                  <Link href={`/welddesk/settings/integrations/${provider}`}>
                    <Settings className="h-4 w-4 mr-0.5" />
                    {ti.configureChannels}
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleTestConnection} disabled={isTesting}>
                {isTesting ? (
                  <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-0.5" />
                )}
                {ti.testConnection}
              </DropdownMenuItem>
              {providerConfig.docsUrl && (
                <DropdownMenuItem onClick={() => window.open(providerConfig.docsUrl, '_blank')}>
                  <ExternalLink className="h-4 w-4 mr-0.5" />
                  {ti.viewDocumentation}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600"
                onClick={() => setShowDisconnectDialog(true)}
              >
                <Unplug className="h-4 w-4 mr-0.5" />
                {ti.disconnect}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Disconnect confirmation dialog */}
        <Dialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{ti.disconnectProvider.replace('{name}', providerConfig.name)}</DialogTitle>
              <DialogDescription>
                {ti.disconnectProviderDescription.replace('{name}', providerConfig.name)}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDisconnectDialog(false)}>
                {ti.cancel}
              </Button>
              <Button
                variant="destructive"
                onClick={handleDisconnect}
                disabled={isDisconnecting}
              >
                {isDisconnecting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                    {ti.disconnecting}
                  </>
                ) : (
                  ti.disconnect
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // Expired token state
  if (isExpired) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <Badge variant="outline" className="flex items-center gap-1.5 py-1 px-2 border-yellow-500">
          <AlertCircle className="h-3 w-3 text-yellow-500" />
          <span className="text-xs">{ti.expired}</span>
        </Badge>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRefreshToken}
          disabled={isConnecting}
        >
          {isConnecting ? (
            <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-0.5" />
          )}
          {ti.reconnect}
        </Button>
      </div>
    );
  }

  // Error state
  if (hasError) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="flex items-center gap-1.5 py-1 px-2 border-red-500">
            <AlertCircle className="h-3 w-3 text-red-500" />
            <span className="text-xs">{ti.error}</span>
          </Badge>
          <Button size="sm" variant="outline" onClick={handleConnect} disabled={isConnecting}>
            {isConnecting ? (
              <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-0.5" />
            )}
            {ti.reconnect}
          </Button>
        </div>
        {integration?.errorMessage && (
          <p className="text-xs text-red-500">{integration.errorMessage}</p>
        )}
      </div>
    );
  }

  // Disconnected / not connected state
  return (
    <>
      <Button
        onClick={handleConnect}
        disabled={isConnecting}
        className={cn(className)}
        style={{ backgroundColor: buttonColor || providerConfig.color }}
      >
        {isConnecting ? (
          <>
            <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
            {ti.connecting}
          </>
        ) : (
          <>
            {!hideIcon && <Link2 className="h-4 w-4 mr-0.5" />}
            {ti.connectProvider.replace('{name}', providerConfig.name)}
          </>
        )}
      </Button>

      {/* Token input dialog for token-based providers */}
      <Dialog open={showTokenDialog} onOpenChange={setShowTokenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ti.connectProvider.replace('{name}', providerConfig.name)}</DialogTitle>
            <DialogDescription>
              {providerConfig.description}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Setup steps */}
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-sm font-medium mb-2">{ti.setupSteps}</p>
              <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                {providerConfig.setupSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>

            {/* Token input */}
            <div className="space-y-2">
              <Label htmlFor="token">{ti.botToken}</Label>
              <Input
                id="token"
                type="password"
                placeholder={ti.enterBotToken}
                value={tokenValue}
                onChange={(e) => setTokenValue(e.target.value)}
              />
            </div>

            {/* Docs link */}
            {providerConfig.docsUrl && (
              <Button
                variant="link"
                size="sm"
                className="p-0 h-auto"
                onClick={() => window.open(providerConfig.docsUrl, '_blank')}
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                {ti.viewProviderDocumentation.replace('{name}', providerConfig.name)}
              </Button>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTokenDialog(false)}>
              {ti.cancel}
            </Button>
            <Button
              onClick={handleSaveToken}
              disabled={!tokenValue.trim() || isConnecting}
              style={{ backgroundColor: providerConfig.color }}
            >
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                  {ti.connecting}
                </>
              ) : (
                ti.connect
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
