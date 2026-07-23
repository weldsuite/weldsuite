import React, { useState, useEffect } from 'react';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Sparkles,
  Calendar,
  FileText,
  Megaphone,
  AlertCircle,
  Info,
  CheckCircle,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface AnnouncementsViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateFeedback?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

interface AnnouncementItem {
  id: string;
  title: string;
  description: string;
  type: 'info' | 'warning' | 'success' | 'announcement';
  date: string;
  priority: 'high' | 'medium' | 'low';
}

export function AnnouncementsView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateStatus,
  onNavigateFAQ,
  onNavigateChangelog,
  onNavigateNews,
  onNavigateFeedback,
  onNavigateAppointments,
  onNavigateEvents,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking']
}: AnnouncementsViewProps) {
  const [activeTab] = useState('announcements');

  // Detect if we're embedded in an iframe (SDK mode)
  const [isEmbedded, setIsEmbedded] = useState(false);
  const isMobile = useMobileDetection();
  const viewport = useViewportHeight();

  useEffect(() => {
    try {
      setIsEmbedded(window.self !== window.top);
    } catch {
      // Cross-origin iframe - we're definitely embedded
      setIsEmbedded(true);
    }
  }, []);

  // Determine if we should use full-screen mode
  const isFullScreen = isEmbedded || isMobile;

  const announcements: AnnouncementItem[] = [
    {
      id: '1',
      title: 'Scheduled Maintenance',
      description: 'Our platform will undergo scheduled maintenance on December 20th from 2:00 AM to 4:00 AM UTC. During this time, some services may be temporarily unavailable.',
      type: 'warning',
      date: 'December 15, 2024',
      priority: 'high'
    },
    {
      id: '2',
      title: 'New Feature Launch: Advanced Analytics',
      description: 'We\'re excited to announce the launch of our Advanced Analytics dashboard. Get deeper insights into your data with customizable reports and real-time metrics.',
      type: 'announcement',
      date: 'December 12, 2024',
      priority: 'medium'
    },
    {
      id: '3',
      title: 'Security Update Completed',
      description: 'We\'ve successfully completed our latest security update. All systems are now running with enhanced encryption and improved authentication protocols.',
      type: 'success',
      date: 'December 8, 2024',
      priority: 'medium'
    },
    {
      id: '4',
      title: 'Holiday Support Hours',
      description: 'Please note that our support team will be operating on reduced hours from December 24th to January 2nd. We\'ll return to normal hours on January 3rd.',
      type: 'info',
      date: 'December 5, 2024',
      priority: 'low'
    }
  ];

  const getAnnouncementIcon = (type: string) => {
    switch (type) {
      case 'warning':
        return <AlertCircle className="text-orange-500" size={20} />;
      case 'success':
        return <CheckCircle className="text-green-500" size={20} />;
      case 'info':
        return <Info className="text-blue-500" size={20} />;
      default:
        return <Megaphone className="text-purple-500" size={20} />;
    }
  };

  const getAnnouncementBorderColor = (type: string) => {
    switch (type) {
      case 'warning':
        return 'border-l-orange-500';
      case 'success':
        return 'border-l-green-500';
      case 'info':
        return 'border-l-blue-500';
      default:
        return 'border-l-purple-500';
    }
  };

  // Container styles for embedded vs standalone mode
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
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
        border: '1px solid rgba(0, 0, 0, 0.1)',
      };

  return (
    <div
      className={cn(
        'flex flex-col bg-white overflow-hidden',
        !isFullScreen && 'fixed bottom-[90px] right-5 z-[999999]'
      )}
      style={containerStyles}
    >
      {/* Header Bar */}
      <div
        className="flex items-center justify-between bg-white relative"
        style={{
          height: '52px',
          padding: '0 16px',
          borderBottom: '1px solid #E5E7EB',
          borderTopLeftRadius: isMobile ? '0' : '16px',
          borderTopRightRadius: isMobile ? '0' : '16px'
        }}
      >
        {/* Left spacer for balance */}
        <div className="w-8"></div>

        {/* Centered Title */}
        <h2
          className="text-gray-900 absolute left-1/2 transform -translate-x-1/2"
          style={{
            fontSize: '16px',
            fontWeight: 560,
            letterSpacing: '-0.01em'
          }}
        >
          Announcements
        </h2>

        {/* Close button */}
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
          style={{ marginRight: '-5px' }}
        >
          <X size={18} strokeWidth={2} className="text-gray-500" />
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto" style={subtleScrollbarStyles}>
        <style>{subtleScrollbarCSS}</style>

        <div className="p-4 space-y-3">
          {announcements.map((announcement) => (
            <div
              key={announcement.id}
              className={cn(
                "bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow border-l-4",
                getAnnouncementBorderColor(announcement.type)
              )}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  {getAnnouncementIcon(announcement.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="font-semibold text-gray-900 text-sm">
                      {announcement.title}
                    </h3>
                    {announcement.priority === 'high' && (
                      <span className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded-full whitespace-nowrap">
                        High Priority
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 mb-2 leading-relaxed">
                    {announcement.description}
                  </p>
                  <p className="text-xs text-gray-400">
                    {announcement.date}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Tab Bar with all navigation - only show if more than 1 page enabled */}
      {enabledPages.length > 1 && (
      <div
        className="bg-white relative"
        style={{
          height: '60px',
          borderTop: '1px solid #E5E7EB',
          borderBottomLeftRadius: isMobile ? '0' : '16px',
          borderBottomRightRadius: isMobile ? '0' : '16px'
        }}
      >
        <div className="flex items-center h-full overflow-x-auto scrollbar-hide" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          <div className="flex items-center min-w-full px-2">
            {[
              { id: 'home', icon: Home, label: 'Home', onClick: onNavigateHome },
              { id: 'messages', icon: MessageSquare, label: 'Chat', onClick: onNavigateMessages },
              { id: 'help', icon: HelpCircle, label: 'Help', onClick: onNavigateFAQ },
              { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
              { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
              { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
              { id: 'feedback', icon: FileText, label: 'Feedback', onClick: onNavigateFeedback },
              { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
              { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: () => {} },
              { id: 'events', icon: Calendar, label: 'Events', onClick: onNavigateEvents },
              { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
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
