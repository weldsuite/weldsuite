
import { useState, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ExactIntercomWidget } from '@/components/welddesk/chat-widget/exact-intercom-widget';
import { WidgetCustomizationPanel, WidgetThemeSettings } from '@/components/welddesk/chat-widget/widget-customization-panel';
import { WidgetInstallationPanel } from '@/components/welddesk/chat-widget/widget-installation-panel';
import { toast } from 'sonner';
import { useUpdateWidgetSettings, useUpdateWidgetById } from '@/hooks/queries/use-helpdesk-queries';
import { usePlanLimits } from '@/hooks/queries/use-billing-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useWidgetSettings } from '../contexts/widget-settings-context';
import { Button } from '@weldsuite/ui/components/button';
import { Settings, X, Crown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';

// All countries list (keeping for potential future use)
const ALL_COUNTRIES = [
  { id: 'af', name: 'Afghanistan', code: 'AF' },
  { id: 'al', name: 'Albania', code: 'AL' },
  { id: 'dz', name: 'Algeria', code: 'DZ' },
  { id: 'ad', name: 'Andorra', code: 'AD' },
  { id: 'ao', name: 'Angola', code: 'AO' },
  { id: 'ag', name: 'Antigua and Barbuda', code: 'AG' },
  { id: 'ar', name: 'Argentina', code: 'AR' },
  { id: 'am', name: 'Armenia', code: 'AM' },
  { id: 'au', name: 'Australia', code: 'AU' },
  { id: 'at', name: 'Austria', code: 'AT' },
  { id: 'az', name: 'Azerbaijan', code: 'AZ' },
  { id: 'bs', name: 'Bahamas', code: 'BS' },
  { id: 'bh', name: 'Bahrain', code: 'BH' },
  { id: 'bd', name: 'Bangladesh', code: 'BD' },
  { id: 'bb', name: 'Barbados', code: 'BB' },
  { id: 'by', name: 'Belarus', code: 'BY' },
  { id: 'be', name: 'Belgium', code: 'BE' },
  { id: 'bz', name: 'Belize', code: 'BZ' },
  { id: 'bj', name: 'Benin', code: 'BJ' },
  { id: 'bt', name: 'Bhutan', code: 'BT' },
  { id: 'bo', name: 'Bolivia', code: 'BO' },
  { id: 'ba', name: 'Bosnia and Herzegovina', code: 'BA' },
  { id: 'bw', name: 'Botswana', code: 'BW' },
  { id: 'br', name: 'Brazil', code: 'BR' },
  { id: 'bn', name: 'Brunei', code: 'BN' },
  { id: 'bg', name: 'Bulgaria', code: 'BG' },
  { id: 'bf', name: 'Burkina Faso', code: 'BF' },
  { id: 'bi', name: 'Burundi', code: 'BI' },
  { id: 'kh', name: 'Cambodia', code: 'KH' },
  { id: 'cm', name: 'Cameroon', code: 'CM' },
  { id: 'ca', name: 'Canada', code: 'CA' },
  { id: 'cv', name: 'Cape Verde', code: 'CV' },
  { id: 'cf', name: 'Central African Republic', code: 'CF' },
  { id: 'td', name: 'Chad', code: 'TD' },
  { id: 'cl', name: 'Chile', code: 'CL' },
  { id: 'cn', name: 'China', code: 'CN' },
  { id: 'co', name: 'Colombia', code: 'CO' },
  { id: 'km', name: 'Comoros', code: 'KM' },
  { id: 'cg', name: 'Congo', code: 'CG' },
  { id: 'cr', name: 'Costa Rica', code: 'CR' },
  { id: 'hr', name: 'Croatia', code: 'HR' },
  { id: 'cu', name: 'Cuba', code: 'CU' },
  { id: 'cy', name: 'Cyprus', code: 'CY' },
  { id: 'cz', name: 'Czech Republic', code: 'CZ' },
  { id: 'dk', name: 'Denmark', code: 'DK' },
  { id: 'dj', name: 'Djibouti', code: 'DJ' },
  { id: 'dm', name: 'Dominica', code: 'DM' },
  { id: 'do', name: 'Dominican Republic', code: 'DO' },
  { id: 'ec', name: 'Ecuador', code: 'EC' },
  { id: 'eg', name: 'Egypt', code: 'EG' },
  { id: 'sv', name: 'El Salvador', code: 'SV' },
  { id: 'gq', name: 'Equatorial Guinea', code: 'GQ' },
  { id: 'er', name: 'Eritrea', code: 'ER' },
  { id: 'ee', name: 'Estonia', code: 'EE' },
  { id: 'et', name: 'Ethiopia', code: 'ET' },
  { id: 'fj', name: 'Fiji', code: 'FJ' },
  { id: 'fi', name: 'Finland', code: 'FI' },
  { id: 'fr', name: 'France', code: 'FR' },
  { id: 'ga', name: 'Gabon', code: 'GA' },
  { id: 'gm', name: 'Gambia', code: 'GM' },
  { id: 'ge', name: 'Georgia', code: 'GE' },
  { id: 'de', name: 'Germany', code: 'DE' },
  { id: 'gh', name: 'Ghana', code: 'GH' },
  { id: 'gr', name: 'Greece', code: 'GR' },
  { id: 'gd', name: 'Grenada', code: 'GD' },
  { id: 'gt', name: 'Guatemala', code: 'GT' },
  { id: 'gn', name: 'Guinea', code: 'GN' },
  { id: 'gw', name: 'Guinea-Bissau', code: 'GW' },
  { id: 'gy', name: 'Guyana', code: 'GY' },
  { id: 'ht', name: 'Haiti', code: 'HT' },
  { id: 'hn', name: 'Honduras', code: 'HN' },
  { id: 'hu', name: 'Hungary', code: 'HU' },
  { id: 'is', name: 'Iceland', code: 'IS' },
  { id: 'in', name: 'India', code: 'IN' },
  { id: 'id', name: 'Indonesia', code: 'ID' },
  { id: 'ir', name: 'Iran', code: 'IR' },
  { id: 'iq', name: 'Iraq', code: 'IQ' },
  { id: 'ie', name: 'Ireland', code: 'IE' },
  { id: 'il', name: 'Israel', code: 'IL' },
  { id: 'it', name: 'Italy', code: 'IT' },
  { id: 'jm', name: 'Jamaica', code: 'JM' },
  { id: 'jp', name: 'Japan', code: 'JP' },
  { id: 'jo', name: 'Jordan', code: 'JO' },
  { id: 'kz', name: 'Kazakhstan', code: 'KZ' },
  { id: 'ke', name: 'Kenya', code: 'KE' },
  { id: 'ki', name: 'Kiribati', code: 'KI' },
  { id: 'kp', name: 'North Korea', code: 'KP' },
  { id: 'kr', name: 'South Korea', code: 'KR' },
  { id: 'kw', name: 'Kuwait', code: 'KW' },
  { id: 'kg', name: 'Kyrgyzstan', code: 'KG' },
  { id: 'la', name: 'Laos', code: 'LA' },
  { id: 'lv', name: 'Latvia', code: 'LV' },
  { id: 'lb', name: 'Lebanon', code: 'LB' },
  { id: 'ls', name: 'Lesotho', code: 'LS' },
  { id: 'lr', name: 'Liberia', code: 'LR' },
  { id: 'ly', name: 'Libya', code: 'LY' },
  { id: 'li', name: 'Liechtenstein', code: 'LI' },
  { id: 'lt', name: 'Lithuania', code: 'LT' },
  { id: 'lu', name: 'Luxembourg', code: 'LU' },
  { id: 'mk', name: 'North Macedonia', code: 'MK' },
  { id: 'mg', name: 'Madagascar', code: 'MG' },
  { id: 'mw', name: 'Malawi', code: 'MW' },
  { id: 'my', name: 'Malaysia', code: 'MY' },
  { id: 'mv', name: 'Maldives', code: 'MV' },
  { id: 'ml', name: 'Mali', code: 'ML' },
  { id: 'mt', name: 'Malta', code: 'MT' },
  { id: 'mh', name: 'Marshall Islands', code: 'MH' },
  { id: 'mr', name: 'Mauritania', code: 'MR' },
  { id: 'mu', name: 'Mauritius', code: 'MU' },
  { id: 'mx', name: 'Mexico', code: 'MX' },
  { id: 'fm', name: 'Micronesia', code: 'FM' },
  { id: 'md', name: 'Moldova', code: 'MD' },
  { id: 'mc', name: 'Monaco', code: 'MC' },
  { id: 'mn', name: 'Mongolia', code: 'MN' },
  { id: 'me', name: 'Montenegro', code: 'ME' },
  { id: 'ma', name: 'Morocco', code: 'MA' },
  { id: 'mz', name: 'Mozambique', code: 'MZ' },
  { id: 'mm', name: 'Myanmar', code: 'MM' },
  { id: 'na', name: 'Namibia', code: 'NA' },
  { id: 'nr', name: 'Nauru', code: 'NR' },
  { id: 'np', name: 'Nepal', code: 'NP' },
  { id: 'nl', name: 'Netherlands', code: 'NL' },
  { id: 'nz', name: 'New Zealand', code: 'NZ' },
  { id: 'ni', name: 'Nicaragua', code: 'NI' },
  { id: 'ne', name: 'Niger', code: 'NE' },
  { id: 'ng', name: 'Nigeria', code: 'NG' },
  { id: 'no', name: 'Norway', code: 'NO' },
  { id: 'om', name: 'Oman', code: 'OM' },
  { id: 'pk', name: 'Pakistan', code: 'PK' },
  { id: 'pw', name: 'Palau', code: 'PW' },
  { id: 'ps', name: 'Palestine', code: 'PS' },
  { id: 'pa', name: 'Panama', code: 'PA' },
  { id: 'pg', name: 'Papua New Guinea', code: 'PG' },
  { id: 'py', name: 'Paraguay', code: 'PY' },
  { id: 'pe', name: 'Peru', code: 'PE' },
  { id: 'ph', name: 'Philippines', code: 'PH' },
  { id: 'pl', name: 'Poland', code: 'PL' },
  { id: 'pt', name: 'Portugal', code: 'PT' },
  { id: 'qa', name: 'Qatar', code: 'QA' },
  { id: 'ro', name: 'Romania', code: 'RO' },
  { id: 'ru', name: 'Russia', code: 'RU' },
  { id: 'rw', name: 'Rwanda', code: 'RW' },
  { id: 'kn', name: 'Saint Kitts and Nevis', code: 'KN' },
  { id: 'lc', name: 'Saint Lucia', code: 'LC' },
  { id: 'vc', name: 'Saint Vincent and the Grenadines', code: 'VC' },
  { id: 'ws', name: 'Samoa', code: 'WS' },
  { id: 'sm', name: 'San Marino', code: 'SM' },
  { id: 'st', name: 'Sao Tome and Principe', code: 'ST' },
  { id: 'sa', name: 'Saudi Arabia', code: 'SA' },
  { id: 'sn', name: 'Senegal', code: 'SN' },
  { id: 'rs', name: 'Serbia', code: 'RS' },
  { id: 'sc', name: 'Seychelles', code: 'SC' },
  { id: 'sl', name: 'Sierra Leone', code: 'SL' },
  { id: 'sg', name: 'Singapore', code: 'SG' },
  { id: 'sk', name: 'Slovakia', code: 'SK' },
  { id: 'si', name: 'Slovenia', code: 'SI' },
  { id: 'sb', name: 'Solomon Islands', code: 'SB' },
  { id: 'so', name: 'Somalia', code: 'SO' },
  { id: 'za', name: 'South Africa', code: 'ZA' },
  { id: 'ss', name: 'South Sudan', code: 'SS' },
  { id: 'es', name: 'Spain', code: 'ES' },
  { id: 'lk', name: 'Sri Lanka', code: 'LK' },
  { id: 'sd', name: 'Sudan', code: 'SD' },
  { id: 'sr', name: 'Suriname', code: 'SR' },
  { id: 'se', name: 'Sweden', code: 'SE' },
  { id: 'ch', name: 'Switzerland', code: 'CH' },
  { id: 'sy', name: 'Syria', code: 'SY' },
  { id: 'tw', name: 'Taiwan', code: 'TW' },
  { id: 'tj', name: 'Tajikistan', code: 'TJ' },
  { id: 'tz', name: 'Tanzania', code: 'TZ' },
  { id: 'th', name: 'Thailand', code: 'TH' },
  { id: 'tl', name: 'Timor-Leste', code: 'TL' },
  { id: 'tg', name: 'Togo', code: 'TG' },
  { id: 'to', name: 'Tonga', code: 'TO' },
  { id: 'tt', name: 'Trinidad and Tobago', code: 'TT' },
  { id: 'tn', name: 'Tunisia', code: 'TN' },
  { id: 'tr', name: 'Turkey', code: 'TR' },
  { id: 'tm', name: 'Turkmenistan', code: 'TM' },
  { id: 'tv', name: 'Tuvalu', code: 'TV' },
  { id: 'ug', name: 'Uganda', code: 'UG' },
  { id: 'ua', name: 'Ukraine', code: 'UA' },
  { id: 'ae', name: 'United Arab Emirates', code: 'AE' },
  { id: 'gb', name: 'United Kingdom', code: 'GB' },
  { id: 'us', name: 'United States', code: 'US' },
  { id: 'uy', name: 'Uruguay', code: 'UY' },
  { id: 'uz', name: 'Uzbekistan', code: 'UZ' },
  { id: 'vu', name: 'Vanuatu', code: 'VU' },
  { id: 'va', name: 'Vatican City', code: 'VA' },
  { id: 've', name: 'Venezuela', code: 'VE' },
  { id: 'vn', name: 'Vietnam', code: 'VN' },
  { id: 'ye', name: 'Yemen', code: 'YE' },
  { id: 'zm', name: 'Zambia', code: 'ZM' },
  { id: 'zw', name: 'Zimbabwe', code: 'ZW' }
];

export interface ChatWidgetClientHandle {
  save: () => Promise<void>;
  isSaving: boolean;
}

interface ChatWidgetClientProps {
  initialSettings?: Helpdesk.Api.WidgetSettings;
  showCustomizationPanel?: boolean;
  widgetId?: string;
}

export const ChatWidgetClient = forwardRef<ChatWidgetClientHandle, ChatWidgetClientProps>(function ChatWidgetClient({ initialSettings, showCustomizationPanel = true, widgetId }, ref) {
  const { t } = useI18n();
  const { updateSettings: updateSidebarSettings } = useWidgetSettings();
  const updateWidgetSettingsMutation = useUpdateWidgetSettings();
  const updateWidgetByIdMutation = useUpdateWidgetById();
  const { data: planLimits } = usePlanLimits();
  const canRemoveBranding = planLimits?.data?.removeBranding ?? false;
  const [activeView, setActiveView] = useState('chat');
  const [isSaving, setIsSaving] = useState(false);
  const [showMobilePages, setShowMobilePages] = useState(false);
  const [showBranding, setShowBranding] = useState(true);

  const [themeSettings, setThemeSettings] = useState<WidgetThemeSettings>({
    primaryColor: '#3B82F6',
    backgroundColor: '#FFFFFF',
    textColor: '#111827',
    buttonColor: '#3B82F6',
    buttonTextColor: '#FFFFFF',
    borderRadius: '20px',
    fontSize: '14px',
    launcherColor: '#000000',
    headerColor: '#FFFFFF',
    accentColor: '#3B82F6',
    startingPage: 'messages', // Changed from 'home' since home is not yet implemented
    companyLogoUrl: '',
    // Chat interface colors
    chatBackgroundColor: '#FFFFFF',
    userBubbleColor: '#000000',
    userBubbleTextColor: '#FFFFFF',
    agentBubbleColor: '#F5F5F5',
    agentBubbleTextColor: '#000000',
  });

  const tw = t.helpdesk.chatWidget;
  const [widgetViews, setWidgetViews] = useState([
    // TODO: Implement these pages later
    // { id: 'home', title: 'Home', description: 'Main home view with quick actions', enabled: true },
    // { id: 'help', title: 'Help', description: 'FAQ and help documentation', enabled: true },
    // { id: 'news', title: 'News', description: 'Company news and blog posts', enabled: false },
    { id: 'chat', title: tw.chatViewTitle, description: tw.chatViewDesc, enabled: true, locked: true }, // Chat is always enabled
    // { id: 'parcel-tracking', title: 'Parcel Tracking', description: 'Track parcel deliveries and shipments', enabled: true },
    // { id: 'status', title: 'Status', description: 'System status and uptime information', enabled: true }, // Temporarily disabled - uncomment to re-enable
    // { id: 'changelog', title: 'Changelog', description: 'Product updates and version changes', enabled: false },
    // { id: 'announcements', title: 'Announcements', description: 'Important announcements and notices', enabled: false },
  ]);

  // Load initial settings from server
  useEffect(() => {
    if (initialSettings) {
      // Update theme settings
      setThemeSettings(prev => ({
        ...prev,
        primaryColor: initialSettings.colorPrimary || prev.primaryColor,
        buttonColor: initialSettings.colorButton || prev.buttonColor,
        buttonTextColor: initialSettings.colorButtonText || prev.buttonTextColor,
        launcherColor: initialSettings.colorLauncher || prev.launcherColor,
        headerColor: initialSettings.colorHeader || prev.headerColor,
        accentColor: initialSettings.colorAccent || prev.accentColor,
        borderRadius: initialSettings.borderRadius || prev.borderRadius,
        fontSize: initialSettings.fontSize || prev.fontSize,
        backgroundColor: initialSettings.typographyBackground || prev.backgroundColor,
        textColor: initialSettings.typographyText || prev.textColor,
        startingPage: initialSettings.startingPage || prev.startingPage,
        companyLogoUrl: initialSettings.companyLogoUrl || prev.companyLogoUrl,
        // Chat interface colors
        chatBackgroundColor: initialSettings.chatBackgroundColor || prev.chatBackgroundColor,
        userBubbleColor: initialSettings.userBubbleColor || prev.userBubbleColor,
        userBubbleTextColor: initialSettings.userBubbleTextColor || prev.userBubbleTextColor,
        agentBubbleColor: initialSettings.agentBubbleColor || prev.agentBubbleColor,
        agentBubbleTextColor: initialSettings.agentBubbleTextColor || prev.agentBubbleTextColor,
      }));

      // Branding
      setShowBranding(initialSettings.showBranding ?? true);

      // Update widget views enabled state
      setWidgetViews(prev => prev.map(view => {
        switch (view.id) {
          case 'home':
            return { ...view, enabled: initialSettings.pageHome ?? view.enabled };
          case 'chat':
            return { ...view, enabled: initialSettings.pageChat ?? view.enabled };
          case 'help':
            return { ...view, enabled: initialSettings.pageHelp ?? view.enabled };
          case 'parcel-tracking':
            return { ...view, enabled: initialSettings.pageParcelTracking ?? view.enabled };
          case 'changelog':
            return { ...view, enabled: initialSettings.pageChangelog ?? view.enabled };
          case 'news':
            return { ...view, enabled: initialSettings.pageNews ?? view.enabled };
          case 'announcements':
            return { ...view, enabled: initialSettings.pageAnnouncements ?? view.enabled };
          default:
            return view;
        }
      }));
    }
  }, [initialSettings]);

  // Save settings via server action
  const saveSettings = async () => {
    try {
      setIsSaving(true);

      const settingsData = {
        colorPrimary: themeSettings.primaryColor,
        colorButton: themeSettings.buttonColor,
        colorButtonText: themeSettings.buttonTextColor,
        colorLauncher: themeSettings.launcherColor,
        colorHeader: themeSettings.headerColor,
        colorAccent: themeSettings.accentColor,
        borderRadius: themeSettings.borderRadius,
        fontSize: themeSettings.fontSize,
        typographyBackground: themeSettings.backgroundColor,
        typographyText: themeSettings.textColor,
        startingPage: themeSettings.startingPage,
        companyLogoUrl: themeSettings.companyLogoUrl,
        // Chat interface colors
        chatBackgroundColor: themeSettings.chatBackgroundColor,
        userBubbleColor: themeSettings.userBubbleColor,
        userBubbleTextColor: themeSettings.userBubbleTextColor,
        agentBubbleColor: themeSettings.agentBubbleColor,
        agentBubbleTextColor: themeSettings.agentBubbleTextColor,
        showBranding,
        pageHome: widgetViews.find(v => v.id === 'home')?.enabled,
        pageChat: widgetViews.find(v => v.id === 'chat')?.enabled,
        pageHelp: widgetViews.find(v => v.id === 'help')?.enabled,
        pageParcelTracking: widgetViews.find(v => v.id === 'parcel-tracking')?.enabled,
        pageChangelog: widgetViews.find(v => v.id === 'changelog')?.enabled,
        pageNews: widgetViews.find(v => v.id === 'news')?.enabled,
        pageAnnouncements: widgetViews.find(v => v.id === 'announcements')?.enabled,
      };

      const result = widgetId
        ? await updateWidgetByIdMutation.mutateAsync({ widgetId, data: settingsData })
        : await updateWidgetSettingsMutation.mutateAsync(settingsData);

      if (result.success) {
        // Update sidebar to reflect new page visibility settings
        updateSidebarSettings({
          pageHelp: widgetViews.find(v => v.id === 'help')?.enabled ?? false,
          pageChangelog: widgetViews.find(v => v.id === 'changelog')?.enabled ?? false,
          pageNews: widgetViews.find(v => v.id === 'news')?.enabled ?? false,
          pageAnnouncements: widgetViews.find(v => v.id === 'announcements')?.enabled ?? false,
        });

        toast.success(t.helpdesk.chatWidget.settings, {
          description: tw.settingsSavedSuccess,
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Failed to save widget settings:', error);
      toast.error(t.helpdesk.chatWidget.settings, {
        description: tw.settingsSaveFailed,
      });
    } finally {
      setIsSaving(false);
    }
  };

  useImperativeHandle(ref, () => ({
    save: saveSettings,
    isSaving,
  }), [saveSettings, isSaving]);

  const handleToggleView = (id: string) => {
    const view = widgetViews.find(v => v.id === id);
    if (!view) return;

    // Don't allow toggling locked views
    if (view.locked) return;

    // Count currently enabled views
    const enabledCount = widgetViews.filter(v => v.enabled).length;

    // If trying to enable and already at max (5), don't allow
    if (!view.enabled && enabledCount >= 5) {
      return;
    }

    setWidgetViews(prev =>
      prev.map(v =>
        v.id === id ? { ...v, enabled: !v.enabled } : v
      )
    );
  };

  return (
    <div className="flex h-full overflow-hidden bg-gray-50 dark:bg-background">
      {/* Mobile Header */}
      {showCustomizationPanel && (
        <div className="md:hidden fixed top-[56px] left-0 right-0 z-[40] flex items-center px-3 py-2 bg-white dark:bg-black border-b border-gray-100 dark:border-border">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setShowMobilePages(true)}
          >
            <Settings className="h-4 w-4" />
            {tw.settingsLabel}
          </Button>
        </div>
      )}

      {/* Mobile Pages Sidebar Overlay */}
      {showMobilePages && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setShowMobilePages(false)}
        />
      )}


      {/* Left Sidebar - Widget Views (only on Chat Widget page) */}
      {showCustomizationPanel && (
        <div className={cn(
          "w-96 bg-white dark:bg-black border-r border-gray-200 dark:border-border pl-3.5 pr-3.5 py-4 overflow-y-auto flex-shrink-0",
          "fixed md:static top-[56px] md:top-0 left-0 h-[calc(100%-56px)] md:h-auto z-50 md:z-auto",
          "transition-transform duration-200 ease-in-out",
          showMobilePages ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )} style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(156, 163, 175, 0.3) transparent' }}>
          <div className="mb-4 md:hidden">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setShowMobilePages(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-2">
            {widgetViews.map((view) => (
              <div
                key={view.id}
                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                  activeView === view.id
                    ? 'bg-blue-50 dark:bg-background/30 border-blue-200 dark:border-border'
                    : 'bg-white dark:bg-background border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-background/30'
                }`}
                onClick={() => setActiveView(view.id)}
              >
                <div className="flex items-start justify-between relative">
                  <div className="flex-1 pr-12">
                    <h3 className="font-medium text-sm mb-1 text-gray-900 dark:text-foreground">{view.title}</h3>
                    <p className="text-xs text-gray-500 dark:text-muted-foreground leading-relaxed">
                      {view.description}
                    </p>
                  </div>
                  <label className={`absolute top-0 right-0 inline-flex items-center ${view.locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={view.enabled}
                      onChange={() => handleToggleView(view.id)}
                      disabled={view.locked}
                      className="sr-only peer"
                    />
                    <div className="w-7 h-4 bg-gray-300 dark:bg-accent peer-checked:bg-blue-500 dark:peer-checked:bg-border rounded-full transition-colors"></div>
                    <div className="absolute left-[2px] top-[2px] bg-white dark:bg-gray-200 w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                  </label>
                </div>
              </div>
            ))}
          </div>

          {/* Info about max pages - only show when at max */}
          {widgetViews.filter(v => v.enabled).length >= 5 && (
            <div className="mt-4 p-3 bg-blue-50 dark:bg-background/20 rounded-lg border border-transparent dark:border-border">
              <p className="text-xs text-blue-600 dark:text-muted-foreground">
                <strong>{widgetViews.filter(v => v.enabled).length}/5</strong> {tw.pagesActiveText}
              </p>
            </div>
          )}

          {/* Branding */}
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-900 dark:text-foreground mb-2">{tw.brandingLabel}</h3>
            <div className={cn(
              "p-3 rounded-lg border border-gray-200 dark:border-border",
              !canRemoveBranding && "opacity-60"
            )}>
              <div className="flex items-start justify-between relative">
                <div className="flex-1 pr-12">
                  <h3 className="font-medium text-sm mb-1 text-gray-900 dark:text-foreground">{tw.showWeldDeskBranding}</h3>
                  <p className="text-xs text-gray-500 dark:text-muted-foreground leading-relaxed">
                    {canRemoveBranding
                      ? tw.brandingFooterDesc
                      : tw.upgradePlanBranding}
                  </p>
                  {!canRemoveBranding && (
                    <Link
                      href="/settings/billing"
                      className="inline-flex items-center gap-1 mt-1.5 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 font-medium"
                    >
                      <Crown className="h-3 w-3" />
                      {tw.upgradePlan}
                    </Link>
                  )}
                </div>
                <label className={cn(
                  "absolute top-0 right-0 inline-flex items-center",
                  canRemoveBranding ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                )}>
                  <input
                    type="checkbox"
                    checked={showBranding}
                    onChange={() => canRemoveBranding && setShowBranding(prev => !prev)}
                    disabled={!canRemoveBranding}
                    className="sr-only peer"
                  />
                  <div className="w-7 h-4 bg-gray-300 dark:bg-accent peer-checked:bg-blue-500 dark:peer-checked:bg-border rounded-full transition-colors"></div>
                  <div className="absolute left-[2px] top-[2px] bg-white dark:bg-gray-200 w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>
            </div>
          </div>

          {/* Installation Instructions */}
          <WidgetInstallationPanel widgetId={initialSettings?.widgetId || 'loading...'} />
        </div>
      )}

      {/* Center - Chat Widget Preview */}
      <div className={cn(
        "flex-1 flex flex-col relative bg-gray-50 dark:bg-background",
        showCustomizationPanel && "pt-12 md:pt-0" // Add top padding on mobile for the mobile header
      )}>
        <Tabs defaultValue="preview" className="w-full h-full flex flex-col">
            <div className="absolute top-[22px] right-6 z-10 hidden md:block">
              <TabsList className="bg-transparent border-0 ring-0 p-0">
                <TabsTrigger value="preview" className="!text-gray-700 dark:!text-muted-foreground !border-0 !shadow-none px-4 rounded-md font-semibold cursor-default pointer-events-none" style={{ backgroundColor: '#f0f0f0' }}>{tw.previewLabel}</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="preview" className="flex-1 flex items-center justify-center p-0 md:p-8 bg-gray-50 dark:bg-background">
              {/* Chat Widget Preview Canvas - Simulated Viewport */}
              <div className="relative w-full h-full max-w-full md:max-w-[1400px] max-h-full md:max-h-[900px] overflow-hidden">
                {/* Widget Container - positioned relatively to act as viewport */}
                <div className="relative w-full h-full chat-widget-preview chat-widget-preview-mobile">
                  <ExactIntercomWidget
                    defaultOpen={true}
                    enabledPages={widgetViews.filter(v => v.enabled).map(v => v.id === 'chat' ? 'messages' : v.id)}
                    themeSettings={themeSettings}
                    hideCloseButton={true}
                    disableLauncherButton={true}
                    showBranding={showBranding}
                  />
                </div>
              </div>

              {/* CSS to make fixed elements work within preview */}
              <style jsx global>{`
                /* Convert fixed to absolute and reset z-index */
                .chat-widget-preview *[class*="fixed"] {
                  position: absolute !important;
                  z-index: 1 !important;
                }

                /* Softer shadow on widget in preview */
                .chat-widget-preview > div[class*="fixed"] {
                  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08) !important;
                }

                /* Center the chat popup widget - Desktop */
                @media (min-width: 768px) {
                  .chat-widget-preview > div[class*="fixed"] {
                    left: 50% !important;
                    top: 50% !important;
                    bottom: auto !important;
                    right: auto !important;
                    transform: translate(-50%, -50%) !important;
                    max-height: calc(100% - 20px) !important;
                  }

                  /* Position launcher button at bottom-right of popup - Desktop */
                  .chat-widget-preview > button[class*="fixed"] {
                    left: 50% !important;
                    top: 50% !important;
                    bottom: auto !important;
                    right: auto !important;
                    /* Offset to bottom-right: popup is 400px wide, button is 60px, so offset by (200px - 27px) to right */
                    /* Offset to bottom: popup is ~680px tall, so offset by ~340px + 40px down */
                    transform: translate(calc(-50% + 200px - 27px), calc(-50% + 340px + 40px)) !important;
                  }
                }

                /* Full screen widget on mobile */
                @media (max-width: 767px) {
                  .chat-widget-preview > div[class*="fixed"] {
                    left: 0 !important;
                    top: 1px !important;
                    right: 0 !important;
                    bottom: auto !important;
                    width: 100% !important;
                    height: calc(100% - 49px) !important;
                    max-height: calc(100% - 49px) !important;
                    max-width: 100% !important;
                    border-radius: 0 !important;
                    transform: none !important;
                  }

                  /* Hide launcher button on mobile */
                  .chat-widget-preview > button[class*="fixed"] {
                    display: none !important;
                  }
                }
              `}</style>
          </TabsContent>
        </Tabs>
      </div>

      {/* Right Sidebar - Customization Panel (hidden on mobile) */}
      {showCustomizationPanel && (
        <div className="hidden md:block h-full">
          <WidgetCustomizationPanel
            settings={themeSettings}
            onSettingsChange={setThemeSettings}
          />
        </div>
      )}
    </div>
  );
});
