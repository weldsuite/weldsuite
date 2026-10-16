
import { useState } from 'react';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  ChevronRight,
  Sparkles,
  Megaphone,
  Calendar,
  Package,
  Search
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { subtleScrollbarStyles, subtleScrollbarCSS } from './scrollbar-styles';

interface ZapietHomeViewProps {
  onClose: () => void;
  onOpenChat?: () => void;
  onOpenMessages?: () => void;
  onOpenStatus?: () => void;
  onOpenFAQ?: () => void;
  onOpenChangelog?: () => void;
  onOpenNews?: () => void;
  onOpenAppointments?: () => void;
  onOpenAnnouncements?: () => void;
  onOpenEvents?: () => void;
  onOpenParcelTracking?: () => void;
  enabledPages?: string[];
  companyLogoUrl?: string;
}

export function ZapietHomeView({
  onClose,
  onOpenChat,
  onOpenMessages,
  onOpenStatus,
  onOpenFAQ,
  onOpenChangelog,
  onOpenNews,
  onOpenAppointments,
  onOpenAnnouncements,
  onOpenEvents,
  onOpenParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'appointments', 'announcements', 'events', 'parcel-tracking'],
  companyLogoUrl
}: Readonly<ZapietHomeViewProps>) {
  const { t } = useI18n();
  const [activeTab] = useState('home');

  return (
    <div
      className="fixed bottom-[90px] right-5 flex flex-col bg-white dark:bg-[#0a0a0a] z-[999999] overflow-hidden border border-gray-200 dark:border-border"
      style={{
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 16px 70px -12px rgba(0,0,0,0.35)'
      }}
    >
      {/* Header */}
      <div className="relative px-5 pt-5 pb-4 border-b border-gray-100 dark:border-border/50">
        {/* Close button */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-150"
          aria-label={t.helpdeskWidget.common.close}
        >
          <X size={16} strokeWidth={2} className="text-gray-400 dark:text-muted-foreground" />
        </Button>

        {/* Logo */}
        {companyLogoUrl ? (
          <img
            src={companyLogoUrl}
            alt={t.helpdeskWidget.home.logoAlt}
            className="h-7 object-contain mb-5"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center mb-5">
            <MessageSquare size={16} className="text-primary-foreground" />
          </div>
        )}

        {/* Welcome text */}
        <h1 className="text-gray-900 dark:text-white text-[17px] font-semibold tracking-[-0.01em]">
          {t.helpdeskWidget.home.heading}
        </h1>
      </div>

      {/* Content */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div
        className="flex-1 overflow-y-auto subtle-scrollbar"
        style={{ ...subtleScrollbarStyles }}
      >
        {/* Search */}
        {enabledPages.includes('help') && (
          <div className="px-5 pt-4">
            <Button
              variant="ghost"
              onClick={onOpenFAQ}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 bg-gray-50 dark:bg-background hover:bg-gray-100 dark:hover:bg-secondary border border-gray-200 dark:border-border rounded-lg transition-all duration-150"
            >
              <Search size={15} className="text-gray-400 dark:text-muted-foreground" />
              <span className="text-[13px] text-gray-400 dark:text-muted-foreground">{t.helpdeskWidget.home.searchPlaceholder}</span>
            </Button>
          </div>
        )}

        {/* Actions */}
        <div className="px-5 py-4">
          <div className="space-y-px rounded-lg border border-gray-200 dark:border-border overflow-hidden">
            {/* Send message */}
            <Button
              variant="ghost"
              onClick={onOpenChat}
              className="w-full flex items-center gap-3.5 px-4 py-3.5 bg-white dark:bg-[#0a0a0a] hover:bg-gray-50 dark:hover:bg-background transition-all duration-150"
            >
              <div className="w-8 h-8 rounded-lg bg-blue-500 flex items-center justify-center flex-shrink-0">
                <MessageSquare size={15} className="text-white" />
              </div>
              <div className="flex-1 text-left">
                <p className="text-[13px] font-medium text-gray-900 dark:text-white">
                  {t.helpdeskWidget.home.sendMessageTitle}
                </p>
                <p className="text-[12px] text-gray-500 dark:text-muted-foreground mt-0.5">
                  {t.helpdeskWidget.home.sendMessageDescription}
                </p>
              </div>
              <ChevronRight size={16} className="text-gray-300 dark:text-gray-600" />
            </Button>

            {/* Help center */}
            {enabledPages.includes('help') && (
              <>
                <div className="h-px bg-gray-100 dark:bg-secondary" />
                <Button
                  variant="ghost"
                  onClick={onOpenFAQ}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 bg-white dark:bg-[#0a0a0a] hover:bg-gray-50 dark:hover:bg-background transition-all duration-150"
                >
                  <div className="w-8 h-8 rounded-lg bg-purple-500 flex items-center justify-center flex-shrink-0">
                    <HelpCircle size={15} className="text-white" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-[13px] font-medium text-gray-900 dark:text-white">
                      {t.helpdeskWidget.home.helpCenterTitle}
                    </p>
                    <p className="text-[12px] text-gray-500 dark:text-muted-foreground mt-0.5">
                      {t.helpdeskWidget.home.helpCenterDescription}
                    </p>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 dark:text-gray-600" />
                </Button>
              </>
            )}

            {/* Track order */}
            {enabledPages.includes('parcel-tracking') && (
              <>
                <div className="h-px bg-gray-100 dark:bg-secondary" />
                <Button
                  variant="ghost"
                  onClick={onOpenParcelTracking}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 bg-white dark:bg-[#0a0a0a] hover:bg-gray-50 dark:hover:bg-background transition-all duration-150"
                >
                  <div className="w-8 h-8 rounded-lg bg-teal-500 flex items-center justify-center flex-shrink-0">
                    <Package size={15} className="text-white" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-[13px] font-medium text-gray-900 dark:text-white">
                      {t.helpdeskWidget.home.trackOrderTitle}
                    </p>
                    <p className="text-[12px] text-gray-500 dark:text-muted-foreground mt-0.5">
                      {t.helpdeskWidget.home.trackOrderDescription}
                    </p>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 dark:text-gray-600" />
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Updates */}
        {(enabledPages.includes('news') || enabledPages.includes('changelog')) && (
          <div className="px-5 pb-4">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[11px] font-medium text-gray-400 dark:text-muted-foreground uppercase tracking-wider">
                {t.helpdeskWidget.home.updates}
              </span>
            </div>
            <div className="space-y-2">
              {[
                {
                  title: t.helpdeskWidget.home.updateItems.aiFeatures,
                  date: t.helpdeskWidget.home.updateItems.aiFeaturesDate,
                },
                {
                  title: t.helpdeskWidget.home.updateItems.performance,
                  date: t.helpdeskWidget.home.updateItems.performanceDate,
                }
              ].map((item) => (
                <Button
                  variant="ghost"
                  key={item.title}
                  onClick={enabledPages.includes('changelog') ? onOpenChangelog : onOpenNews}
                  className="w-full flex items-center justify-between px-3.5 py-3 bg-gray-50 dark:bg-background hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-all duration-150 group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                    <span className="text-[13px] text-gray-700 dark:text-muted-foreground group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
                      {item.title}
                    </span>
                  </div>
                  <span className="text-[11px] text-gray-400 dark:text-gray-600">
                    {item.date}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Quick links */}
        {enabledPages.includes('help') && (
          <div className="px-5 pb-4">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[11px] font-medium text-gray-400 dark:text-muted-foreground uppercase tracking-wider">
                {t.helpdeskWidget.home.quickLinks}
              </span>
            </div>
            <div className="space-y-px rounded-lg border border-gray-200 dark:border-border overflow-hidden bg-white dark:bg-[#0a0a0a]">
              {[
                t.helpdeskWidget.home.quickLinkItems.gettingStarted,
                t.helpdeskWidget.home.quickLinkItems.accountSettings,
                t.helpdeskWidget.home.quickLinkItems.billing,
              ].map((item, index) => (
                <Button
                  variant="ghost"
                  key={item}
                  onClick={onOpenFAQ}
                  className={cn(
                    "w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-gray-50 dark:hover:bg-background transition-all duration-150",
                    index < 2 && "border-b border-gray-100 dark:border-border"
                  )}
                >
                  <span className="text-[13px] text-gray-600 dark:text-muted-foreground">
                    {item}
                  </span>
                  <ChevronRight size={14} className="text-gray-300 dark:text-gray-700" />
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="h-2" />
      </div>

      {/* Bottom Navigation */}
      {enabledPages.length > 1 && (
        <div
          className="bg-white dark:bg-[#0a0a0a] border-t border-gray-100 dark:border-border/50"
          style={{
            height: '56px',
            borderBottomLeftRadius: '16px',
            borderBottomRightRadius: '16px'
          }}
        >
          <div className="flex items-center h-full overflow-x-auto" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            <div className="flex items-center min-w-full px-2">
              {[
                { id: 'home', icon: Home, label: t.helpdeskWidget.nav.home },
                { id: 'messages', icon: MessageSquare, label: t.helpdeskWidget.nav.chat, onClick: onOpenMessages },
                { id: 'help', icon: HelpCircle, label: t.helpdeskWidget.nav.help, onClick: onOpenFAQ },
                { id: 'status', icon: Activity, label: t.helpdeskWidget.nav.status, onClick: onOpenStatus },
                { id: 'changelog', icon: Sparkles, label: t.helpdeskWidget.home.updatesTab, onClick: onOpenChangelog },
                { id: 'news', icon: Sparkles, label: t.helpdeskWidget.nav.news, onClick: onOpenNews },
                { id: 'appointments', icon: Calendar, label: t.helpdeskWidget.nav.book, onClick: onOpenAppointments },
                { id: 'announcements', icon: Megaphone, label: t.helpdeskWidget.nav.announce, onClick: onOpenAnnouncements },
                { id: 'events', icon: Calendar, label: t.helpdeskWidget.nav.events, onClick: onOpenEvents },
                { id: 'parcel-tracking', icon: Package, label: t.helpdeskWidget.nav.track, onClick: onOpenParcelTracking }
              ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                <Button
                  variant="ghost"
                  key={tab.id}
                  onClick={tab.onClick}
                  className="flex flex-col items-center justify-center px-3 py-1.5 transition-all flex-1 min-w-[56px]"
                  aria-label={tab.label}
                >
                  <tab.icon
                    size={18}
                    className={cn(
                      "mb-1 transition-colors duration-150",
                      activeTab === tab.id ? "text-gray-900 dark:text-white" : "text-gray-400 dark:text-gray-600"
                    )}
                    strokeWidth={activeTab === tab.id ? 2 : 1.5}
                  />
                  <span
                    className={cn(
                      "text-[10px] transition-colors duration-150",
                      activeTab === tab.id ? "text-gray-900 dark:text-white font-medium" : "text-gray-400 dark:text-gray-600"
                    )}
                  >
                    {tab.label}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
