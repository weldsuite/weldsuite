import { useSearchParams } from 'react-router-dom';
import { useState, useEffect, lazy, Suspense } from 'react';
import type { WidgetSettings, PageConfig, OpenWelcomeWorkflow, OpenTeam, OpenContact, OpenConversation } from '@/lib/api/types';
import { platformApi } from '@/lib/api/client';
import { getOrCreateVisitorId } from '@/lib/utils/customer-storage';

// Lazy load the main widget component
const HelpdeskWidget = lazy(() =>
  import('@/components/widget/helpdesk-widget').then(mod => ({ default: mod.HelpdeskWidget }))
);

const CUSTOMER_FIELD_DEFS: Record<string, { label: string; type: string; placeholder: string }> = {
  name: { label: 'Name', type: 'text', placeholder: 'John Doe' },
  email: { label: 'Email', type: 'email', placeholder: 'your@email.com' },
  phone: { label: 'Phone', type: 'phone', placeholder: '+1 555 123 4567' },
  company: { label: 'Company', type: 'text', placeholder: 'Acme Inc.' },
};

function resolveCollectFields(
  stepType: string,
  rawFields: unknown,
): Array<{ id: string; label: string; type: string; required: boolean; placeholder?: string }> {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return stepType === 'collect_customer_info'
      ? [{ id: 'email', label: 'Email', type: 'email', required: true, placeholder: 'your@email.com' }]
      : [];
  }
  if (stepType === 'collect_customer_info') {
    // New format: { id, required }[]
    if (typeof rawFields[0] === 'object' && !('label' in (rawFields[0] as any))) {
      return (rawFields as Array<{ id: string; required: boolean }>)
        .filter((f) => CUSTOMER_FIELD_DEFS[f.id])
        .map((f) => ({ id: f.id, ...CUSTOMER_FIELD_DEFS[f.id], required: f.required }));
    }
    // Legacy string[] format
    if (typeof rawFields[0] === 'string') {
      return (rawFields as string[])
        .filter((id) => CUSTOMER_FIELD_DEFS[id])
        .map((id) => ({ id, ...CUSTOMER_FIELD_DEFS[id], required: id === 'email' }));
    }
  }
  // collect_input or legacy full objects
  return rawFields as Array<{ id: string; label: string; type: string; required: boolean; placeholder?: string }>;
}

interface WidgetConfig {
  widgetId: string;
  workspaceId?: string;
  parentOrigin?: string;
  defaultOpen?: boolean;
  enabledPages?: string[];
  pageConfigs?: PageConfig[];
  themeSettings?: {
    primaryColor?: string;
    backgroundColor?: string;
    textColor?: string;
    buttonColor?: string;
    buttonTextColor?: string;
    borderRadius?: string;
    fontSize?: string;
    launcherColor?: string;
    headerColor?: string;
    accentColor?: string;
    startingPage?: string;
    chatBackgroundColor?: string;
    userBubbleColor?: string;
    userBubbleTextColor?: string;
    agentBubbleColor?: string;
    agentBubbleTextColor?: string;
  };
  disableBackNavigation?: boolean;
  customerEmail?: string;
  customerName?: string;
  mode?: 'launcher' | 'widget';
  testMode?: boolean;
  showBranding?: boolean;
  replyTimeText?: string;
  isWithinOfficeHours?: boolean;
  nextOpenTime?: string | null;
  officeHoursTimezone?: string | null;
  officeHours?: Record<string, { isOpen: boolean; openTime?: string; closeTime?: string }> | null;
  // Workflow-driven welcome from /api/open
  welcomeWorkflow?: OpenWelcomeWorkflow | null;
  team?: OpenTeam;
  contact?: OpenContact | null;
  conversations?: OpenConversation[];
  initialUnreadCount?: number;
  // Bot agent info from WeldAgent settings
  botAgent?: { name: string; avatarUrl: string | null } | null;
}

// Helper function to convert boolean page flags to PageConfig array
function convertPageFlagsToConfigs(settings: WidgetSettings): PageConfig[] {
  const pageMapping: PageConfig[] = [
    { id: 'home', name: 'Home', icon: 'home', label: 'Home', enabled: settings.pageHome, order: 1 },
    { id: 'messages', name: 'Messages', icon: 'message-circle', label: 'Chat', enabled: settings.pageChat, order: 2 },
    { id: 'help', name: 'Help', icon: 'help-circle', label: 'Help', enabled: settings.pageHelp, order: 3 },
    { id: 'status', name: 'Status', icon: 'activity', label: 'Status', enabled: false, order: 4 },
    { id: 'parcel-tracking', name: 'Parcel Tracking', icon: 'package', label: 'Track Parcel', enabled: settings.pageParcelTracking, order: 5 },
    { id: 'changelog', name: 'Changelog', icon: 'sparkles', label: 'Changelog', enabled: settings.pageChangelog, order: 6 },
    { id: 'news', name: 'News', icon: 'newspaper', label: 'News', enabled: settings.pageNews, order: 7 },
    { id: 'feedback', name: 'Feedback', icon: 'file-text', label: 'Feedback', enabled: settings.pageFeedback, order: 8 },
    { id: 'appointments', name: 'Appointments', icon: 'calendar', label: 'Book', enabled: false, order: 9 },
    { id: 'announcements', name: 'Announcements', icon: 'megaphone', label: 'Announce', enabled: settings.pageAnnouncements, order: 10 },
    { id: 'events', name: 'Events', icon: 'calendar', label: 'Events', enabled: settings.pageEventSignUp, order: 11 },
  ];

  return pageMapping;
}

/**
 * Build WidgetSettings from the /api/open config payload.
 * This mirrors the transformation in getWidgetSettings() but works with the raw config object.
 */
function buildSettingsFromOpenConfig(config: Record<string, unknown>, widgetId: string): WidgetSettings {
  const colors = config?.colors as Record<string, string> | undefined;
  const styling = config?.styling as Record<string, string> | undefined;
  const pages = config?.pages as Record<string, boolean> | undefined;
  const behavior = config?.behavior as Record<string, unknown> | undefined;
  const branding = config?.branding as Record<string, unknown> | undefined;
  const chat = config?.chat as Record<string, string> | undefined;
  const availability = config?.availability as Record<string, unknown> | undefined;

  return {
    id: (config?.widgetId as string) || widgetId,
    name: (config?.widgetName as string) || 'Widget',
    themeSettings: {
      colorPrimary: colors?.primary || '#4169E1',
      colorButton: colors?.button || '#4169E1',
      colorButtonText: colors?.buttonText || '#FFFFFF',
      colorLauncher: colors?.launcher || '#000000',
      colorHeader: colors?.header || '#FFFFFF',
      colorAccent: colors?.accent || '#4169E1',
      borderRadius: parseInt(styling?.borderRadius || '20') || 20,
      fontSize: parseInt(styling?.fontSize || '14') || 14,
      typographyText: styling?.typographyText || '#000000',
      typographyBackground: styling?.typographyBackground || '#FFFFFF',
    },
    pageHome: pages?.home ?? true,
    pageChat: pages?.chat ?? true,
    pageHelp: pages?.help ?? true,
    pageParcelTracking: pages?.parcelTracking ?? false,
    pageChangelog: pages?.changelog ?? false,
    pageNews: pages?.news ?? false,
    pageFeedback: pages?.feedback ?? false,
    pageAnnouncements: pages?.announcements ?? false,
    pageEventSignUp: pages?.eventSignUp ?? false,
    typographyText: styling?.typographyText || '#000000',
    typographyBackground: styling?.typographyBackground || '#FFFFFF',
    startingPage: (behavior?.startingPage as string) || 'Home',
    position: (behavior?.position as string) || 'bottom-right',
    autoOpen: (behavior?.autoOpen as boolean) ?? false,
    companyLogoUrl: branding?.companyLogoUrl as string | undefined,
    showBranding: (branding?.showBranding as boolean) ?? true,
    chatBackgroundColor: chat?.backgroundColor,
    userBubbleColor: chat?.userBubbleColor,
    userBubbleTextColor: chat?.userBubbleTextColor,
    agentBubbleColor: chat?.agentBubbleColor,
    agentBubbleTextColor: chat?.agentBubbleTextColor,
    replyTimeText: (availability?.replyTimeText as string) || undefined,
    isWithinOfficeHours: (availability?.isWithinOfficeHours as boolean) ?? undefined,
    nextOpenTime: (availability?.nextOpenTime as string) || null,
    officeHoursTimezone: (availability?.officeHoursTimezone as string) || null,
    officeHours: (availability?.officeHours as Record<string, { isOpen: boolean; openTime?: string; closeTime?: string }>) || null,
  };
}

function buildWidgetConfig(
  widgetId: string,
  apiSettings: WidgetSettings,
  searchParams: URLSearchParams,
  mode: 'launcher' | 'widget',
  testMode: boolean,
  parentOrigin: string | undefined,
  openData?: { welcomeWorkflow: OpenWelcomeWorkflow | null; team: OpenTeam; contact: OpenContact | null; conversations: OpenConversation[]; unreadCount: number }
): WidgetConfig {
  const urlEnabledPages = searchParams.get('enabledPages')?.split(',');
  const pageConfigs = convertPageFlagsToConfigs(apiSettings);
  const workspaceId = apiSettings.workspaceId || apiSettings.organizationId;

  return {
    widgetId,
    workspaceId,
    mode,
    testMode,
    parentOrigin,
    defaultOpen: searchParams.get('defaultOpen') === 'true' || apiSettings.autoOpen,
    enabledPages: urlEnabledPages || pageConfigs.filter(p => p.enabled).map(p => p.id),
    pageConfigs,
    themeSettings: {
      primaryColor: searchParams.get('primaryColor') || apiSettings.themeSettings.colorPrimary,
      backgroundColor: apiSettings.themeSettings.typographyBackground,
      textColor: apiSettings.themeSettings.typographyText,
      buttonColor: searchParams.get('buttonColor') || apiSettings.themeSettings.colorButton,
      buttonTextColor: searchParams.get('buttonTextColor') || apiSettings.themeSettings.colorButtonText,
      borderRadius: searchParams.get('borderRadius') || apiSettings.themeSettings.borderRadius.toString(),
      fontSize: searchParams.get('fontSize') || apiSettings.themeSettings.fontSize.toString(),
      launcherColor: searchParams.get('launcherColor') || apiSettings.themeSettings.colorLauncher,
      headerColor: searchParams.get('headerColor') || apiSettings.themeSettings.colorHeader,
      accentColor: searchParams.get('accentColor') || apiSettings.themeSettings.colorAccent,
      startingPage: searchParams.get('startingPage') || apiSettings.startingPage,
      chatBackgroundColor: apiSettings.chatBackgroundColor,
      userBubbleColor: apiSettings.userBubbleColor,
      userBubbleTextColor: apiSettings.userBubbleTextColor,
      agentBubbleColor: apiSettings.agentBubbleColor,
      agentBubbleTextColor: apiSettings.agentBubbleTextColor,
    },
    disableBackNavigation: searchParams.get('disableBackNavigation') === 'true' || apiSettings.disableBackNavigation,
    customerEmail: searchParams.get('customerEmail') || undefined,
    customerName: searchParams.get('customerName') || undefined,
    showBranding: apiSettings.showBranding ?? true,
    replyTimeText: apiSettings.replyTimeText,
    isWithinOfficeHours: apiSettings.isWithinOfficeHours,
    nextOpenTime: apiSettings.nextOpenTime,
    officeHoursTimezone: apiSettings.officeHoursTimezone,
    officeHours: apiSettings.officeHours,
    // Open data
    welcomeWorkflow: openData?.welcomeWorkflow ?? undefined,
    team: openData?.team ?? undefined,
    contact: openData?.contact ?? undefined,
    conversations: openData?.conversations ?? undefined,
    initialUnreadCount: openData?.unreadCount ?? undefined,
    // Bot agent from WeldAgent settings
    botAgent: apiSettings.botAgent ?? undefined,
  };
}

function WidgetSkeleton() {
  return <div className="w-full h-full" />;
}

function WidgetError({ error }: { error: Error }) {
  return (
    <div className="flex items-center justify-center w-full h-full bg-white p-4">
      <div className="text-center text-red-500">
        <p className="text-lg font-medium">Failed to load widget</p>
        <p className="text-sm mt-2">{error.message}</p>
      </div>
    </div>
  );
}

export function WidgetPage() {
  const [searchParams] = useSearchParams();
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [realtimeUrl, setRealtimeUrl] = useState<string>('');

  useEffect(() => {
    async function loadConfig() {
      try {
        // Get URL parameters
        const widgetId = searchParams.get('widgetId') || searchParams.get('id') || import.meta.env.VITE_DEFAULT_WIDGET_ID || 'widget_mksrg143u6xd24j2';
        const mode = (searchParams.get('mode') as 'launcher' | 'widget') || 'widget';
        const parentOrigin = searchParams.get('parentOrigin') || undefined;
        const testMode = searchParams.get('testMode') === 'true';

        if (!widgetId) {
          throw new Error('Missing widgetId');
        }

        // Configure the API client
        platformApi.setWidgetId(widgetId);
        if (testMode) {
          platformApi.setTestMode(true);
        }

        // Try the new /api/open endpoint first (single request)
        const visitorId = getOrCreateVisitorId();
        const customerEmail = searchParams.get('customerEmail') || undefined;
        const customerName = searchParams.get('customerName') || undefined;

        // Set up RoomClient realtime URL and token provider
        const rtUrl = import.meta.env.VITE_WIDGET_REALTIME_URL || '';
        setRealtimeUrl(rtUrl);

        // Load widget config
        let apiSettings: WidgetSettings;
        const response = await platformApi.getWidgetSettings(widgetId);

        if (response.success && response.data) {
          apiSettings = response.data;
        } else {
          console.warn('Failed to load widget settings from API:', response.error);
          apiSettings = platformApi.getDefaultSettings();
        }

        // Transform welcomeFlow from config API into OpenWelcomeWorkflow shape
        let welcomeWorkflow: OpenWelcomeWorkflow | null = null;
        if (apiSettings.welcomeFlow && apiSettings.welcomeFlow.length > 0) {
          welcomeWorkflow = {
            workflowId: 'config',
            parts: apiSettings.welcomeFlow
              .filter((s) => s.type === 'send_message' || s.type === 'send_choices' || s.type === 'delay' || s.type === 'collect_input' || s.type === 'collect_customer_info')
              .map((step) => ({
                stepId: step.id,
                type: step.type as 'send_message' | 'send_choices' | 'delay' | 'collect_input' | 'collect_customer_info',
                message: (step.config.message as string) || '',
                options: step.type === 'send_choices'
                  ? (step.config.options as Array<{ id: string; label: string; value: string }>) || []
                  : undefined,
                fields: (step.type === 'collect_input' || step.type === 'collect_customer_info')
                  ? resolveCollectFields(step.type, step.config.fields)
                  : undefined,
                delaySeconds: step.type === 'delay'
                  ? (Number(step.config.days || 0) * 86400
                    + Number(step.config.hours || 0) * 3600
                    + Number(step.config.minutes || 0) * 60
                    + Number(step.config.seconds || 0)
                    + Number(step.config.duration || 0) / 1000) || 1
                  : undefined,
              })),
            bot: { name: apiSettings.name || 'Assistant', avatarUrl: apiSettings.companyLogoUrl || null, isBot: true },
          };
          // Need at least one visible part (not just delays)
          if (!welcomeWorkflow.parts.some((p) => p.type !== 'delay')) welcomeWorkflow = null;
        }

        const openData = welcomeWorkflow ? {
          welcomeWorkflow,
          team: { agents: [], onlineCount: 0 },
          contact: null,
          conversations: [],
          unreadCount: 0,
        } : undefined;

        setConfig(buildWidgetConfig(widgetId, apiSettings, searchParams, mode, testMode, parentOrigin, openData));
      } catch (err) {
        console.error('Error loading widget config:', err);
        setError(err instanceof Error ? err : new Error('Unknown error'));
      } finally {
        setLoading(false);
      }
    }

    loadConfig();
  }, [searchParams]);

  if (loading) return <WidgetSkeleton />;
  if (error) return <WidgetError error={error} />;
  if (!config) return null;

  return (
    <Suspense fallback={<WidgetSkeleton />}>
      <HelpdeskWidget
        {...config}
        realtimeUrl={realtimeUrl}
      />
    </Suspense>
  );
}
