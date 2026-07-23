import { useState, useEffect } from 'react';
import {
  X,
  ChevronRight,
  ExternalLink,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Sparkles,
  FileText,
  Calendar,
  Megaphone,
  Package,
  Newspaper,
  Ticket
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';

function formatOutOfOfficeMessage(nextOpenTime?: string | null): string {
  if (!nextOpenTime) return "We're away right now";

  try {
    const nextDate = new Date(nextOpenTime);
    const now = new Date();
    const diffMs = nextDate.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 24) {
      const timeStr = nextDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return `We'll be back at ${timeStr}`;
    }

    const dayStr = nextDate.toLocaleDateString(undefined, { weekday: 'long' });
    const timeStr = nextDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `We'll be back ${dayStr} at ${timeStr}`;
  } catch {
    return "We're away right now";
  }
}

interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
}

function formatOfficeHoursSummary(officeHours?: Record<string, DayHours> | null): string | null {
  if (!officeHours) return null;

  const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
  const dayLabels: Record<string, string> = {
    monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
    friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
  };

  // Group consecutive days with the same schedule
  const openDays = dayOrder.filter(d => officeHours[d]?.isOpen);
  if (openDays.length === 0) return null;

  // Check if all open days share the same hours
  const firstDay = officeHours[openDays[0]];
  const allSameHours = openDays.every(d => {
    const day = officeHours[d];
    return day?.openTime === firstDay?.openTime && day?.closeTime === firstDay?.closeTime;
  });

  const formatTime = (time?: string) => {
    if (!time) return '';
    const [h, m] = time.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return m === 0 ? `${hour}${period}` : `${hour}:${m.toString().padStart(2, '0')}${period}`;
  };

  if (allSameHours && firstDay?.openTime && firstDay?.closeTime) {
    const timeRange = `${formatTime(firstDay.openTime)} - ${formatTime(firstDay.closeTime)}`;

    // Find consecutive runs
    const firstIdx = dayOrder.indexOf(openDays[0]);
    const lastIdx = dayOrder.indexOf(openDays[openDays.length - 1]);
    const isConsecutive = openDays.length === lastIdx - firstIdx + 1;

    if (isConsecutive && openDays.length > 1) {
      return `${dayLabels[openDays[0]]}-${dayLabels[openDays[openDays.length - 1]]}, ${timeRange}`;
    }

    return `${openDays.map(d => dayLabels[d]).join(', ')}, ${timeRange}`;
  }

  // Different hours per day — just show the days
  return `Open ${openDays.map(d => dayLabels[d]).join(', ')}`;
}

interface ZapietHomeViewProps {
  onClose: () => void;
  onBack?: () => void;
  onOpenChat?: () => void;
  onOpenMessages?: () => void;
  onOpenStatus?: () => void;
  onOpenFAQ?: () => void;
  onOpenChangelog?: () => void;
  onOpenNews?: () => void;
  onOpenFeedback?: () => void;
  onOpenAppointments?: () => void;
  onOpenAnnouncements?: () => void;
  onOpenEvents?: () => void;
  onOpenParcelTracking?: () => void;
  onOpenTickets?: () => void;
  enabledPages?: string[];
  companyLogoUrl?: string;
  companyName?: string;
  userName?: string;
  teamAvatars?: string[];
  statusPageUrl?: string;
  statusPageName?: string;
  isClosing?: boolean;
  shouldAnimate?: boolean;
  replyTimeText?: string;
  isWithinOfficeHours?: boolean;
  nextOpenTime?: string | null;
  officeHours?: Record<string, { isOpen: boolean; openTime?: string; closeTime?: string }> | null;
  officeHoursTimezone?: string | null;
}

export function ZapietHomeView({
  onClose,
  onOpenChat,
  onOpenMessages,
  onOpenStatus,
  onOpenFAQ,
  onOpenChangelog,
  onOpenNews,
  onOpenFeedback,
  onOpenAppointments,
  onOpenAnnouncements,
  onOpenEvents,
  onOpenParcelTracking,
  onOpenTickets,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking', 'tickets'],
  companyLogoUrl,
  companyName = 'Support',
  userName = '',
  teamAvatars = [],
  statusPageUrl,
  statusPageName = 'Status Page',
  isClosing = false,
  shouldAnimate = true,
  replyTimeText,
  isWithinOfficeHours,
  nextOpenTime,
  officeHours,
  officeHoursTimezone,
}: ZapietHomeViewProps) {
  const [activeTab] = useState('home');
  const [isEmbedded, setIsEmbedded] = useState(false);
  const isMobile = useMobileDetection();
  const viewport = useViewportHeight();

  useEffect(() => {
    try {
      setIsEmbedded(window.self !== window.top);
    } catch {
      setIsEmbedded(true);
    }
  }, []);

  const isEnabled = (pageId: string) => enabledPages.includes(pageId);

  // Determine if we should use full-screen mode
  // Full-screen when: embedded in iframe OR on mobile device
  const isFullScreen = isEmbedded || isMobile;

  // Container styles for embedded/mobile vs standalone desktop mode
  // In embedded mode, SDK container handles border and shadow
  const containerStyles: React.CSSProperties = isFullScreen
    ? {
        // Embedded mode (mobile or desktop): fill entire iframe
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
      }
    : {
        // Desktop standalone: floating widget with own border/shadow
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 16px 70px -12px rgba(0,0,0,0.35)',
        border: '1px solid rgba(0, 0, 0, 0.1)',
      };

  // Default team avatars if none provided
  const displayAvatars = teamAvatars.length > 0 ? teamAvatars : [
    'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=80&h=80&fit=crop&crop=face',
    'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=80&h=80&fit=crop&crop=face',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=80&h=80&fit=crop&crop=face',
  ];

  // Sample data for recent items
  const recentNews = [
    { id: '1', title: 'We Raised $50M in Series B Funding', description: 'We\'re thrilled to announce our Series B funding round led by top-tier investors.', imageUrl: 'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=400&h=200&fit=crop' },
    { id: '2', title: 'Introducing Our New Enterprise Plan', description: 'The Enterprise Plan includes advanced security features and dedicated support.', imageUrl: 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=400&h=200&fit=crop' },
    { id: '3', title: 'Recognized as Leader in G2 Grid Report', description: 'We\'re honored to be named a Leader in G2\'s Winter 2024 Grid Report.', imageUrl: 'https://images.unsplash.com/photo-1557804506-669a67965ba0?w=400&h=200&fit=crop' },
  ];

  const recentChangelog = [
    { id: '1', title: 'New Dashboard Analytics', version: 'v2.4.0' },
    { id: '2', title: 'Improved Search Performance', version: 'v2.3.5' },
  ];

  const recentHelp = [
    { id: '1', title: 'Getting Started', description: 'Everything you need to know', articleCount: 24 },
    { id: '2', title: 'Account & Billing', description: 'Manage your account settings', articleCount: 18 },
    { id: '3', title: 'Integrations', description: 'Connect with your favorite tools', articleCount: 12 },
    { id: '4', title: 'Troubleshooting', description: 'Solutions to common issues', articleCount: 15 },
  ];

  const upcomingEvents = [
    { id: '1', title: 'Customer Success Summit 2025', date: 'Mar 15-16' },
    { id: '2', title: 'Product Webinar: New Features', date: 'Dec 20' },
  ];

  const recentAnnouncements = [
    { id: '1', title: 'Holiday Support Hours', description: 'Updated support availability' },
    { id: '2', title: 'New Integration Available', description: 'Connect with Salesforce' },
  ];

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden",
        !isFullScreen && "fixed bottom-[90px] right-5 z-[999999]",
        shouldAnimate && !isFullScreen && (isClosing ? "widget-animation-closing" : "widget-animation")
      )}
      style={containerStyles}
    >
      {/* Fixed close button */}
      <button
        onClick={onClose}
        className="absolute top-4 z-10 w-8 h-8 flex items-center justify-center hover:bg-white/10 rounded-full transition-all duration-150"
        style={{ right: '11px' }}
        aria-label="Close"
      >
        <X size={18} strokeWidth={1.5} className="text-white/60" />
      </button>

      {/* Scrollable content area */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div
        className="flex-1 overflow-y-auto subtle-scrollbar"
        style={{
          ...subtleScrollbarStyles,
          borderTopLeftRadius: isMobile ? '0' : '16px',
          borderTopRightRadius: isMobile ? '0' : '16px',
        }}
      >
        {/* Dark header with logo, avatars, greeting - scrolls */}
        <div
          style={{
            background: '#1a1a1a',
            borderTopLeftRadius: isMobile ? '0' : '16px',
            borderTopRightRadius: isMobile ? '0' : '16px',
          }}
        >
          {/* Top bar with logo and avatars */}
          <div className="flex items-center justify-between px-5 pt-5">
            {/* Logo */}
            {companyLogoUrl ? (
              <img
                src={companyLogoUrl}
                alt="Logo"
                className="h-7 object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <div className="flex items-center">
                <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                  <path d="M8 8L16 24L24 8" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            )}

            {/* Team avatars */}
            <div className="flex items-center -space-x-2">
              {displayAvatars.slice(0, 3).map((avatar, index) => (
                <div
                  key={index}
                  className="w-8 h-8 rounded-full border-2 border-[#1a1a1a] overflow-hidden bg-gray-600"
                >
                  <img
                    src={avatar}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              ))}
            </div>

            {/* Spacer for close button */}
            <div className="w-8" />
          </div>

          {/* Greeting */}
          <div className="px-5 pt-10 pb-4">
            <h1
              className="text-white text-[28px] font-semibold leading-snug"
              style={{ fontFamily: 'var(--font-inter), -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', letterSpacing: '-0.02em' }}
            >
              {userName ? `Hi ${userName} 👋` : 'Hi there 👋'}
            </h1>
            <h2
              className="text-white text-[28px] font-semibold leading-snug"
              style={{ fontFamily: 'var(--font-inter), -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', letterSpacing: '-0.02em' }}
            >
              How can we help?
            </h2>
          </div>
        </div>

        {/* Smooth color transition area with button - scrolls */}
        <div
          className="relative"
          style={{
            background: 'linear-gradient(180deg, #1a1a1a 0%, #3a3a3a 25%, #6a6a6a 45%, #9a9a9a 60%, #c8c8c8 75%, #e8e8e8 88%, #fafafa 100%)',
            paddingTop: '8px',
            paddingBottom: '8px',
          }}
        >
          {/* Send us a message card */}
          <div className="px-4 relative z-10">
          {isEnabled('messages') && (
            <button
              onClick={onOpenChat}
              className="w-full flex items-center justify-between p-4 bg-white rounded-2xl border border-gray-200 hover:border-gray-300 transition-all duration-200 group"
            >
              <div className="text-left flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[15px] font-semibold text-gray-900">
                    Send us a message
                  </p>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: isWithinOfficeHours === false ? '#9CA3AF' : '#22C55E',
                    }}
                  />
                  <p className="text-[13px] text-gray-500">
                    {isWithinOfficeHours === false
                      ? formatOutOfOfficeMessage(nextOpenTime)
                      : (replyTimeText || 'We typically reply in a few hours')}
                  </p>
                </div>
                {officeHours && (() => {
                  const summary = formatOfficeHoursSummary(officeHours);
                  return summary ? (
                    <p className="text-[11px] text-gray-400 mt-0.5 ml-3.5">
                      {summary}
                    </p>
                  ) : null;
                })()}
              </div>
              <ChevronRight size={20} strokeWidth={2} className="text-gray-400 group-hover:text-gray-600 transition-colors flex-shrink-0" />
            </button>
          )}
          </div>
        </div>

        {/* Content area with light gray background - scrolls */}
        <div
          className="bg-[#fafafa] px-4"
          style={{
            paddingTop: '16px',
            paddingBottom: '16px',
          }}
        >
        {/* Your Requests Section */}
        {isEnabled('tickets') && (
          <div className="mb-4">
            <button
              onClick={onOpenTickets}
              className="w-full flex items-center justify-between p-4 bg-white rounded-xl border border-gray-200 hover:border-gray-300 transition-all duration-200 group"
            >
              <div className="flex items-center gap-3">
                <Ticket size={16} className="text-blue-500" />
                <div className="text-left">
                  <p className="text-[14px] font-medium text-gray-900">
                    Your Requests
                  </p>
                  <p className="text-[12px] text-gray-500 mt-0.5">
                    Track and submit support requests
                  </p>
                </div>
              </div>
              <ChevronRight size={18} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
            </button>
          </div>
        )}

        {/* Recent News Section */}
        {isEnabled('news') && (
          <div className="mb-4">
            <div className="mb-3">
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Recent News
              </h3>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {recentNews.map((item, index) => (
                <button
                  key={item.id}
                  onClick={onOpenNews}
                  className="w-full text-left hover:bg-gray-50 transition-all"
                  style={{
                    padding: '14px 16px',
                    borderBottom: index < recentNews.length - 1 ? '1px solid #F3F4F6' : 'none'
                  }}
                >
                  <div className="flex gap-4">
                    <div
                      className="rounded-lg bg-cover bg-center flex-shrink-0"
                      style={{ width: '75px', height: '75px', backgroundImage: `url(${item.imageUrl})` }}
                    />
                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                      <h3 style={{
                        fontSize: '14px',
                        fontWeight: 580,
                        color: '#111827',
                        marginBottom: '4px',
                        lineHeight: '1.3'
                      }}>
                        {item.title}
                      </h3>
                      <p style={{
                        fontSize: '13px',
                        color: '#6B7280',
                        lineHeight: '1.4',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden'
                      }}>
                        {item.description}
                      </p>
                    </div>
                    <ChevronRight size={18} className="text-gray-300 flex-shrink-0 self-center" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Recent Changelog Section */}
        {isEnabled('changelog') && (
          <div className="mb-4">
            <div className="mb-3">
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                What's New
              </h3>
            </div>
            <div className="bg-white rounded-xl border border-gray-200">
              {recentChangelog.map((item, index) => (
                <button
                  key={item.id}
                  onClick={onOpenChangelog}
                  className="w-full text-left hover:bg-gray-50 transition-all flex items-center justify-between"
                  style={{
                    padding: '12px 14px',
                    borderBottom: index < recentChangelog.length - 1 ? '1px solid #F3F4F6' : 'none'
                  }}
                >
                  <div className="flex items-center gap-3">
                    <Sparkles size={16} className="text-purple-500" />
                    <span style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>{item.title}</span>
                  </div>
                  <span style={{ fontSize: '12px', color: '#9CA3AF' }}>{item.version}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Help Articles Section */}
        {isEnabled('help') && (
          <div className="mb-0" style={{ marginTop: '24px' }}>
            <div className="mb-3">
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Help Articles
              </h3>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {recentHelp.map((item, index) => (
                <button
                  key={item.id}
                  onClick={onOpenFAQ}
                  className="w-full text-left hover:bg-gray-50 transition-all flex items-center justify-between"
                  style={{
                    padding: '12px 14px',
                    borderBottom: index < recentHelp.length - 1 ? '1px solid #F3F4F6' : 'none'
                  }}
                >
                  <div className="flex-1">
                    <p style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>{item.title}</p>
                    <p style={{ fontSize: '12px', color: '#9CA3AF' }}>{item.articleCount} articles</p>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Upcoming Events Section */}
        {isEnabled('events') && (
          <div className="mb-4">
            <div className="mb-3">
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Upcoming Events
              </h3>
            </div>
            <div className="bg-white rounded-xl border border-gray-200">
              {upcomingEvents.map((item, index) => (
                <button
                  key={item.id}
                  onClick={onOpenEvents}
                  className="w-full text-left hover:bg-gray-50 transition-all flex items-center justify-between"
                  style={{
                    padding: '12px 14px',
                    borderBottom: index < upcomingEvents.length - 1 ? '1px solid #F3F4F6' : 'none'
                  }}
                >
                  <div className="flex items-center gap-3">
                    <Calendar size={16} className="text-blue-500" />
                    <span style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>{item.title}</span>
                  </div>
                  <span style={{ fontSize: '12px', color: '#9CA3AF' }}>{item.date}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Announcements Section */}
        {isEnabled('announcements') && (
          <div className="mb-4">
            <div className="mb-3">
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Announcements
              </h3>
            </div>
            <div className="bg-white rounded-xl border border-gray-200">
              {recentAnnouncements.map((item, index) => (
                <button
                  key={item.id}
                  onClick={onOpenAnnouncements}
                  className="w-full text-left hover:bg-gray-50 transition-all flex items-center justify-between"
                  style={{
                    padding: '12px 14px',
                    borderBottom: index < recentAnnouncements.length - 1 ? '1px solid #F3F4F6' : 'none'
                  }}
                >
                  <div className="flex items-center gap-3">
                    <Megaphone size={16} className="text-orange-500" />
                    <div>
                      <p style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>{item.title}</p>
                      <p style={{ fontSize: '12px', color: '#9CA3AF' }}>{item.description}</p>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Status page link */}
        {isEnabled('status') && (
          <button
            onClick={statusPageUrl ? () => window.open(statusPageUrl, '_blank') : onOpenStatus}
            className="w-full flex items-center justify-between p-4 bg-white rounded-xl border border-gray-200 hover:border-gray-300 transition-all duration-200"
          >
            <div className="flex items-center gap-3">
              <Activity size={16} className="text-green-500" />
              <p className="text-[14px] font-medium text-gray-900">
                {companyName} {statusPageName}
              </p>
            </div>
            <ExternalLink size={16} strokeWidth={1.5} className="text-gray-400" />
          </button>
        )}
        </div>
      </div>

      {/* Bottom Navigation */}
      {enabledPages.length > 1 && (
        <div
          className="bg-white relative flex-shrink-0"
          style={{
            height: '60px',
            borderTop: '1px solid #E5E7EB',
            borderBottomLeftRadius: isMobile ? '0' : '16px',
            borderBottomRightRadius: isMobile ? '0' : '16px'
          }}
        >
          <div className="flex items-center h-full overflow-x-auto" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            <div className="flex items-center min-w-full px-2">
              {[
                { id: 'home', icon: Home, label: 'Home' },
                { id: 'messages', icon: MessageSquare, label: 'Chat', onClick: onOpenMessages },
                { id: 'help', icon: HelpCircle, label: 'Help', onClick: onOpenFAQ },
                { id: 'status', icon: Activity, label: 'Status', onClick: onOpenStatus },
                { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onOpenChangelog },
                { id: 'news', icon: Sparkles, label: 'News', onClick: onOpenNews },
                { id: 'feedback', icon: FileText, label: 'Feedback', onClick: onOpenFeedback },
                { id: 'appointments', icon: Calendar, label: 'Book', onClick: onOpenAppointments },
                { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onOpenAnnouncements },
                { id: 'events', icon: Calendar, label: 'Events', onClick: onOpenEvents },
                { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onOpenParcelTracking },
                { id: 'tickets', icon: Ticket, label: 'Requests', onClick: onOpenTickets }
              ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                <button
                  key={tab.id}
                  onClick={tab.onClick}
                  className="flex flex-col items-center justify-center px-3 py-2 transition-all group flex-1 min-w-[60px]"
                  aria-label={tab.label}
                >
                  <tab.icon
                    size={18}
                    className={cn(
                      "mb-1 transition-colors",
                      activeTab === tab.id ? "text-gray-900" : "text-gray-400"
                    )}
                    strokeWidth={activeTab === tab.id ? 2 : 1.5}
                  />
                  <span
                    className={cn(
                      "text-[10px] transition-colors",
                      activeTab === tab.id ? "text-gray-900 font-medium" : "text-gray-400"
                    )}
                  >
                    {tab.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
