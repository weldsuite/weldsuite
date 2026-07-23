
import * as React from 'react';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import {
  Video,
  MessageCircle,
  Activity,
  DollarSign,
  Loader2,
  Printer,
  Package,
  ShoppingCart,
  Globe,
  FileText,
  Mail,
  Calendar,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { useIntegrations, usePrintNodeSettings, useUpdatePrintNodeSettings } from '@/hooks/queries/use-settings-queries';

interface Integration {
  id: string;
  name: string;
  description: string;
  category: 'Communication' | 'Shipping' | 'Accounting' | 'E-Commerce' | 'Printing';
  icon: React.ReactNode;
  connected: boolean;
  configurable: boolean;
}

// Integration definitions with content
const INTEGRATION_DATA: Record<string, {
  name: string;
  description: string;
  category: 'Communication' | 'Shipping' | 'Accounting' | 'E-Commerce' | 'Printing';
  icon: React.ReactNode;
  configurable: boolean;
  overview: string;
  features: string[];
  howItWorks: string[];
}> = {
  'google-meet': {
    name: 'Google Meet',
    description: 'Schedule and join video meetings from your workspace.',
    category: 'Communication',
    icon: <Video className="h-5 w-5" />,
    configurable: false,
    overview: 'Google Meet integration brings seamless video conferencing directly into your WeldSuite workspace. Schedule meetings, join calls, and collaborate with your team without switching between applications. Share your screen, present documents, and hold productive meetings all from within your familiar workspace environment.',
    features: [
      'One-click meeting creation from any workspace context',
      'Calendar integration for scheduled meetings',
      'Screen sharing and presentation mode',
      'Real-time collaboration during calls',
      'Meeting recordings and transcripts',
      'Automatic meeting notes and action items',
    ],
    howItWorks: [
      'Connect your Google account to enable the integration',
      'Access Google Meet from the communication menu in your workspace',
      'Create instant meetings or schedule them for later',
      'Invite team members and external participants directly',
      'Meeting summaries are automatically saved to your workspace',
    ],
  },
  'microsoft-teams': {
    name: 'Microsoft Teams',
    description: 'Collaborate through chat, video calls, and meetings.',
    category: 'Communication',
    icon: <MessageCircle className="h-5 w-5" />,
    configurable: false,
    overview: 'Microsoft Teams integration connects your WeldSuite workspace with the full power of Teams collaboration. Chat with colleagues, join video meetings, and access Microsoft 365 documents seamlessly. Keep your team aligned with integrated communication tools.',
    features: [
      'Direct messaging and group chats',
      'Video and audio conferencing',
      'Integration with Microsoft 365 apps',
      'File sharing and co-authoring',
      'Presence status synchronization',
      'Meeting scheduling with Outlook calendar',
    ],
    howItWorks: [
      'Sign in with your Microsoft account',
      'Grant permissions for Teams access',
      'Access Teams features from the sidebar',
      'Start or join meetings directly from workspace',
      'Chat messages sync automatically',
    ],
  },
  'slack': {
    name: 'Slack',
    description: 'Get real-time notifications in your Slack channels.',
    category: 'Communication',
    icon: <MessageCircle className="h-5 w-5" />,
    configurable: false,
    overview: 'Slack integration keeps your team informed with real-time notifications and updates. Receive alerts about important events, share updates to channels, and keep your workflow connected. Customize which notifications go where to reduce noise and increase productivity.',
    features: [
      'Real-time notifications for workspace events',
      'Customizable notification rules per channel',
      'Direct message notifications',
      'Slash commands for quick actions',
      'Rich message formatting with attachments',
      'Thread support for organized discussions',
    ],
    howItWorks: [
      'Install the WeldSuite app in your Slack workspace',
      'Configure which channels receive notifications',
      'Set up notification rules based on event types',
      'Use slash commands to interact with WeldSuite',
      'Click notifications to jump directly to relevant items',
    ],
  },
  'dhl': {
    name: 'DHL',
    description: 'Manage shipments and track packages worldwide.',
    category: 'Shipping',
    icon: <Activity className="h-5 w-5" />,
    configurable: true,
    overview: 'DHL integration streamlines your international shipping operations. Generate labels, track packages in real-time, and manage deliveries across the globe. Access competitive rates and reliable delivery services directly from your workspace.',
    features: [
      'Automated shipping label generation',
      'Real-time package tracking',
      'Rate comparison and optimization',
      'Customs documentation for international shipments',
      'Pickup scheduling',
      'Delivery notifications and updates',
    ],
    howItWorks: [
      'Enter your DHL account credentials',
      'Configure default shipping preferences',
      'Generate labels directly from orders',
      'Track shipments from the shipping dashboard',
      'Receive automatic status updates',
    ],
  },
  'ups': {
    name: 'UPS',
    description: 'Ship and track deliveries with competitive rates.',
    category: 'Shipping',
    icon: <Activity className="h-5 w-5" />,
    configurable: true,
    overview: 'UPS integration provides access to one of the world\'s largest delivery networks. Ship packages domestically and internationally with confidence. Get real-time tracking, competitive rates, and reliable delivery estimates.',
    features: [
      'Domestic and international shipping',
      'Real-time tracking and notifications',
      'Rate shopping across service levels',
      'Address validation',
      'Return label generation',
      'Pickup scheduling and management',
    ],
    howItWorks: [
      'Connect your UPS account',
      'Set up shipping preferences and defaults',
      'Create shipments from your orders',
      'Print labels and schedule pickups',
      'Track all shipments in one dashboard',
    ],
  },
  'postnl': {
    name: 'PostNL',
    description: 'Ship within Netherlands and internationally.',
    category: 'Shipping',
    icon: <Package className="h-5 w-5" />,
    configurable: true,
    overview: 'PostNL integration is perfect for businesses shipping within the Netherlands and across Europe. Access the extensive PostNL network with pickup points, track & trace, and reliable delivery services.',
    features: [
      'Dutch and European shipping services',
      'Extensive pickup point network',
      'Track & trace integration',
      'Same-day delivery options',
      'Letterbox packages support',
      'Return management',
    ],
    howItWorks: [
      'Enter your PostNL API credentials',
      'Configure shipping products and services',
      'Generate labels for your orders',
      'Track shipments through the dashboard',
      'Manage returns efficiently',
    ],
  },
  'exact-online': {
    name: 'Exact Online',
    description: 'Sync invoices and automate your bookkeeping.',
    category: 'Accounting',
    icon: <DollarSign className="h-5 w-5" />,
    configurable: true,
    overview: 'Exact Online integration synchronizes your financial data automatically. Invoices, expenses, and payments flow seamlessly between systems, reducing manual data entry and ensuring your books are always up to date.',
    features: [
      'Automatic invoice synchronization',
      'Expense tracking and categorization',
      'Bank transaction matching',
      'Financial reporting',
      'Multi-company support',
      'VAT calculation and reporting',
    ],
    howItWorks: [
      'Authorize the connection to Exact Online',
      'Map your accounts and categories',
      'Configure sync settings and frequency',
      'Transactions sync automatically',
      'Review and reconcile in either system',
    ],
  },
  'quickbooks': {
    name: 'QuickBooks',
    description: 'Seamless accounting with transactions and reports.',
    category: 'Accounting',
    icon: <DollarSign className="h-5 w-5" />,
    configurable: true,
    overview: 'QuickBooks integration brings powerful accounting capabilities to your workspace. Sync invoices, track expenses, and generate financial reports. Keep your accounting data consistent across systems without manual entry.',
    features: [
      'Two-way invoice synchronization',
      'Expense and receipt tracking',
      'Customer and vendor sync',
      'Financial report generation',
      'Bank feed integration',
      'Multi-currency support',
    ],
    howItWorks: [
      'Connect your QuickBooks account via OAuth',
      'Configure account mappings',
      'Set up automatic sync rules',
      'Review synced transactions',
      'Generate reports from either platform',
    ],
  },
  'printnode': {
    name: 'PrintNode',
    description: 'Automated cloud printing for labels and documents.',
    category: 'Printing',
    icon: <Printer className="h-5 w-5" />,
    configurable: true,
    overview: 'PrintNode integration enables automated cloud printing for your business. Print shipping labels, packing slips, invoices, and custom documents to any connected printer. Set up print rules to automate your workflow.',
    features: [
      'Cloud printing to any connected printer',
      'Automatic label printing on order creation',
      'Multiple printer support',
      'Print queue management',
      'Custom print templates',
      'Print history and logging',
    ],
    howItWorks: [
      'Create a PrintNode account and get your API key',
      'Install the PrintNode client on your computers',
      'Enter your API key in the integration settings',
      'Configure default printers for different document types',
      'Documents will print automatically based on your rules',
    ],
  },
};

// Related integrations by category
function getRelatedIntegrations(currentId: string, category: string): string[] {
  return Object.keys(INTEGRATION_DATA)
    .filter(id => INTEGRATION_DATA[id].category === category && id !== currentId)
    .slice(0, 3);
}

interface IntegrationDetailClientProps {
  integrationId: string;
}

export function IntegrationDetailClient({ integrationId }: IntegrationDetailClientProps) {
  const router = useRouter();
  const { t } = useI18n();
  const ti = t.settings.integrations;
  const [isConnected, setIsConnected] = React.useState(false);
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = React.useState(false);
  const [showConfigDialog, setShowConfigDialog] = React.useState(false);
  const [printNodeApiKey, setPrintNodeApiKey] = React.useState('');
  const [selectedImage, setSelectedImage] = React.useState(0);
  const thumbnailsRef = React.useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = React.useState(false);
  const [canScrollDown, setCanScrollDown] = React.useState(true);

  const integration = INTEGRATION_DATA[integrationId];

  // React Query hooks
  const { data: printNodeData, isLoading: printNodeLoading } = usePrintNodeSettings();
  const { data: integrationsData, isLoading: integrationsLoading } = useIntegrations();
  const updatePrintNodeMutation = useUpdatePrintNodeSettings();
  const isSaving = updatePrintNodeMutation.isPending;

  const isLoading = integrationId === 'printnode' ? printNodeLoading : integrationsLoading;

  // Sync connection status from query data
  React.useEffect(() => {
    if (integrationId === 'printnode' && printNodeData) {
      const data = printNodeData as any;
      setIsConnected(!!data?.data?.apiKey);
      if (data?.data?.apiKey) {
        setPrintNodeApiKey(data.data.apiKey);
      }
    } else if (integrationsData) {
      const data = integrationsData as any;
      if (data?.data?.[integrationId]) {
        setIsConnected(data.data[integrationId].connected || false);
      }
    }
  }, [integrationId, printNodeData, integrationsData]);

  const handleScroll = () => {
    if (thumbnailsRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = thumbnailsRef.current;
      setCanScrollUp(scrollTop > 0);
      setCanScrollDown(scrollTop + clientHeight < scrollHeight - 10);
    }
  };

  // Placeholder screenshots
  const screenshots = [
    { id: 1, placeholder: true },
    { id: 2, placeholder: true },
    { id: 3, placeholder: true },
    { id: 4, placeholder: true },
    { id: 5, placeholder: true },
    { id: 6, placeholder: true },
  ];

  if (!integration) {
    router.push('/settings/integrations');
    return null;
  }

  const relatedIds = getRelatedIntegrations(integrationId, integration.category);

  const handleConnect = async () => {
    if (integrationId === 'printnode') {
      setShowConfigDialog(true);
      return;
    }

    // For other integrations, show coming soon
    toast.info(ti.comingSoon.replace('{integration}', integration.name));
  };

  const handleDisconnect = async () => {
    setIsConnecting(true);
    setShowDisconnectDialog(false);
    try {
      if (integrationId === 'printnode') {
        await updatePrintNodeMutation.mutateAsync({ apiKey: '' });
        setPrintNodeApiKey('');
      }
      setIsConnected(false);
      toast.success(ti.messages.disconnected.replace('{integration}', integration.name));
    } catch (error) {
      toast.error(ti.messages.disconnectFailed.replace('{integration}', integration.name));
    } finally {
      setIsConnecting(false);
    }
  };

  /**
   * Test the PrintNode connection.
   *
   * TODO(printnode-test): NOT IMPLEMENTED — this reports failure unconditionally.
   * It needs `POST /api/integrations/printnode/test` on app-api, which would call
   * PrintNode's `/whoami` with the stored key and report the result. Saving the
   * key (handleSavePrintNode below) works and is unaffected.
   *
   * It has never worked: this posted to `/settings/integrations/printnode/test`,
   * which exists on NO worker (api-worker exposes only GET/PUT
   * /settings/printnode), so it 404'd and hit the failure toast every time. The
   * user-visible outcome is therefore unchanged — only the doomed round-trip to
   * the retiring api-worker is gone.
   *
   * This cannot be done client-side: the API key is a secret and PrintNode's API
   * is not CORS-accessible from the browser, so the check has to be server-side.
   */
  const handleTestPrintNode = async () => {
    if (!printNodeApiKey) {
      toast.error(ti.messages.enterApiKey);
      return;
    }

    toast.error(ti.messages.testFailed);
  };

  const handleSavePrintNode = async () => {
    if (!printNodeApiKey) {
      toast.error(ti.messages.enterApiKey);
      return;
    }

    try {
      await updatePrintNodeMutation.mutateAsync({ apiKey: printNodeApiKey });
      setIsConnected(true);
      setShowConfigDialog(false);
      toast.success(ti.messages.printNodeSaved);
    } catch (error) {
      toast.error(ti.messages.printNodeSaveFailed);
    }
  };

  return (
    <>
      <div className="flex flex-col">
        {/* Hero Section */}
        <div className="bg-background">
          <div className="max-w-[1200px] mx-auto px-8 py-8 border-x border-border border-b">
            {/* Back Button */}
            <div className="mb-6">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 -ml-3"
                onClick={() => router.push('/settings/integrations')}
              >
                <ChevronLeft className="h-4 w-4 mr-0.5" />
                {ti.backToIntegrations}
              </Button>
            </div>

            <div className="flex items-start gap-6">
              {/* Integration Icon */}
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center shrink-0">
                <div className="scale-150">{integration.icon}</div>
              </div>

              <div>
                {/* Integration Name */}
                <h1 className="text-3xl font-semibold text-foreground mb-2">{integration.name}</h1>

                {/* Description */}
                <p className="text-base text-muted-foreground mb-4 max-w-2xl">
                  {integration.description}
                </p>

                {/* Connect Button */}
                <Button
                  variant={isConnected ? 'outline' : 'default'}
                  disabled={isConnecting || isLoading}
                  className={isConnected ? 'hover:text-destructive' : ''}
                  onClick={() => {
                    if (isConnected) {
                      setShowDisconnectDialog(true);
                    } else {
                      handleConnect();
                    }
                  }}
                >
                  {isConnecting || isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isConnected ? (
                    t.settings.actions.disconnect
                  ) : (
                    t.settings.actions.connect
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content - 3 Column Layout */}
        <div className="flex-1">
          <div className="max-w-[1200px] mx-auto flex border-x border-border">
            {/* Left Sidebar */}
            <div className="hidden md:block w-[300px] shrink-0 bg-muted/40 border-r border-border p-8">

              {/* Category */}
              <div className="mb-6">
                <h3 className="text-sm font-medium text-foreground mb-2">{ti.category}</h3>
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded bg-muted flex items-center justify-center">
                    <svg className="w-3 h-3 text-muted-foreground" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="1" y="1" width="6" height="6" rx="1" />
                      <rect x="9" y="1" width="6" height="6" rx="1" />
                      <rect x="1" y="9" width="6" height="6" rx="1" />
                      <rect x="9" y="9" width="6" height="6" rx="1" />
                    </svg>
                  </div>
                  <span className="text-sm text-muted-foreground">{integration.category}</span>
                </div>
              </div>

              {/* Version */}
              <div className="mb-6">
                <h3 className="text-sm font-medium text-foreground mb-2">{ti.version}</h3>
                <span className="text-sm text-muted-foreground">1.0.0</span>
              </div>

              {/* Last updated */}
              <div className="mb-6">
                <h3 className="text-sm font-medium text-foreground mb-2">{ti.lastUpdated}</h3>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">December 2024</span>
                </div>
              </div>

              {/* Resources */}
              <div className="mb-6">
                <h3 className="text-sm font-medium text-foreground mb-2">{ti.resources}</h3>
                <div className="space-y-2">
                  <a href="#" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                    <Globe className="h-4 w-4" />
                    {ti.website}
                  </a>
                  <a href="#" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                    <FileText className="h-4 w-4" />
                    {ti.documentation}
                  </a>
                  <a href="#" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                    <Mail className="h-4 w-4" />
                    {ti.support}
                  </a>
                </div>
              </div>

              {/* Connect Button */}
              <Button
                variant={isConnected ? 'outline' : 'default'}
                disabled={isConnecting || isLoading}
                className={`w-full ${isConnected ? 'hover:text-destructive' : ''}`}
                onClick={() => {
                  if (isConnected) {
                    setShowDisconnectDialog(true);
                  } else {
                    handleConnect();
                  }
                }}
              >
                {isConnecting || isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isConnected ? (
                  t.settings.actions.disconnect
                ) : (
                  t.settings.actions.connect
                )}
              </Button>

            </div>

            {/* Center Content */}
            <div className="flex-1 p-8">
              {/* Image Gallery */}
              <div className="flex gap-4 mb-10">
                {/* Main Image */}
                <div className="flex-1 aspect-video bg-card border border-border rounded-xl overflow-hidden flex items-center justify-center">
                  <div className="text-muted-foreground text-sm">
                    <div className="w-full h-full bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center min-h-[300px]">
                      <div className="scale-[3]">{integration.icon}</div>
                    </div>
                  </div>
                </div>

                {/* Thumbnail Strip */}
                <div className="w-32 relative h-[360px]">
                  {/* Fade overlay at top with arrow */}
                  {screenshots.length > 5 && canScrollUp && (
                    <>
                      <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-background to-transparent pointer-events-none z-10" />
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (thumbnailsRef.current) {
                            thumbnailsRef.current.scrollBy({ top: -150, behavior: 'smooth' });
                          }
                        }}
                        className="absolute -top-6 left-1/2 -translate-x-1/2 text-muted-foreground hover:text-foreground transition-colors z-20 p-0 h-auto w-auto"
                      >
                        <ChevronUp className="h-5 w-5" />
                      </Button>
                    </>
                  )}
                  <div
                    ref={thumbnailsRef}
                    onScroll={handleScroll}
                    className="flex flex-col gap-2 h-full overflow-y-auto scrollbar-hide"
                    style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                  >
                    {screenshots.map((screenshot, index) => (
                      <Button
                        key={screenshot.id}
                        variant="ghost"
                        onClick={() => setSelectedImage(index)}
                        className={`aspect-video bg-card border-[1.5px] rounded-lg overflow-hidden transition-all shrink-0 h-auto p-0 ${
                          selectedImage === index
                            ? 'border-primary'
                            : 'border-border hover:border-muted-foreground/50'
                        }`}
                      >
                        <div className="w-full h-full bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center">
                          <div className="scale-75">{integration.icon}</div>
                        </div>
                      </Button>
                    ))}
                  </div>
                  {/* Fade overlay at bottom with arrow */}
                  {screenshots.length > 5 && canScrollDown && (
                    <>
                      <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-background to-transparent pointer-events-none" />
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (thumbnailsRef.current) {
                            thumbnailsRef.current.scrollBy({ top: 150, behavior: 'smooth' });
                          }
                        }}
                        className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-muted-foreground hover:text-foreground transition-colors p-0 h-auto w-auto"
                      >
                        <ChevronDown className="h-5 w-5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Overview Section */}
              <div className="mb-10">
                <h2 className="text-xl font-semibold text-foreground mb-4">{ti.overview}</h2>
                <p className="text-muted-foreground leading-relaxed">
                  {integration.overview}
                </p>
              </div>

              {/* Features Section */}
              <div className="mb-10">
                <h2 className="text-xl font-semibold text-foreground mb-4">{ti.features}</h2>
                <ul className="space-y-2">
                  {integration.features.map((feature, index) => (
                    <li key={index} className="flex items-start gap-3">
                      <svg className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <p className="text-muted-foreground">{feature}</p>
                    </li>
                  ))}
                </ul>
              </div>

              {/* How it works Section */}
              <div className="mb-10">
                <h2 className="text-xl font-semibold text-foreground mb-4">{ti.howItWorks}</h2>
                <ul className="space-y-3">
                  {integration.howItWorks.map((step, index) => (
                    <li key={index} className="flex items-start gap-3">
                      <span className="text-primary text-sm font-mono tabular-nums shrink-0 mt-0.5">
                        {index + 1}.
                      </span>
                      <p className="text-muted-foreground">{step}</p>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Related Integrations Section */}
              {relatedIds.length > 0 && (
                <div className="pt-8 border-t border-border">
                  <h2 className="text-[0.8rem] font-medium text-muted-foreground uppercase tracking-wider mb-4">
                    {ti.otherInCategory.replace('{category}', integration.category)}
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {relatedIds.map((relatedId) => {
                      const related = INTEGRATION_DATA[relatedId];
                      return (
                        <Button
                          key={relatedId}
                          variant="ghost"
                          onClick={() => router.push(`/settings/integrations/${relatedId}`)}
                          className="bg-card border border-border rounded-xl p-3 hover:bg-accent/50 hover:border-border/80 transition-all text-left h-auto justify-start"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                              {related.icon}
                            </div>
                            <div className="min-w-0">
                              <h3 className="text-sm font-medium text-foreground truncate">
                                {related.name}
                              </h3>
                              <p className="text-xs text-muted-foreground truncate">
                                {related.category}
                              </p>
                            </div>
                          </div>
                        </Button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Disconnect Confirmation Dialog */}
      <ConfirmDialog
        open={showDisconnectDialog}
        onOpenChange={setShowDisconnectDialog}
        title={ti.disconnectConfirmTitle.replace('{integration}', integration.name)}
        description={ti.disconnectConfirmDescription}
        confirmLabel={t.settings.actions.disconnect}
        onConfirm={handleDisconnect}
      />

      {/* PrintNode Configuration Dialog */}
      <Dialog open={showConfigDialog && integrationId === 'printnode'} onOpenChange={setShowConfigDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ti.configurePrintNode}</DialogTitle>
            <DialogDescription>
              {ti.printNodeDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="printnode-api-key">{ti.apiKey}</Label>
              <Input
                id="printnode-api-key"
                type="password"
                placeholder={ti.apiKeyPlaceholder}
                value={printNodeApiKey}
                onChange={(e) => setPrintNodeApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {ti.apiKeyHelp}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfigDialog(false)}>
              {t.common.actions.cancel}
            </Button>
            <Button variant="outline" onClick={handleTestPrintNode} disabled={!printNodeApiKey}>
              {t.settings.actions.testConnection}
            </Button>
            <Button onClick={handleSavePrintNode} disabled={isSaving || !printNodeApiKey}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                  {t.settings.actions.saving}
                </>
              ) : (
                t.common.actions.save
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
