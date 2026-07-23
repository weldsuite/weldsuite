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
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface ChangelogViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateNews?: () => void;
  onNavigateFeedback?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

interface ChangelogItem {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  date: string;
}

export function ChangelogView({ onClose, onNavigateHome, onNavigateMessages, onNavigateStatus, onNavigateFAQ, onNavigateNews, onNavigateFeedback, onNavigateAppointments, onNavigateAnnouncements, onNavigateEvents, onNavigateParcelTracking, enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking'] }: ChangelogViewProps) {
  const [activeTab] = useState('changelog');

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

  const changelogItems: ChangelogItem[] = [
    {
      id: '1',
      title: 'A new era of Insights has arrived',
      description: 'We announced Fin Insights, a groundbreaking, AI-powered product that gives you complete visibility into every customer conversation, with AI-powered tools and suggestions that help you monitor, analyze, and instantly optimize your customer service quality. Watch the event on-demand.',
      imageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&h=400&fit=crop',
      date: 'December 13, 2024'
    },
    {
      id: '2',
      title: 'Introducing Smart Automation',
      description: 'Our latest update brings intelligent workflow automation that learns from your team\'s patterns. Set up complex multi-step automations with our visual builder, integrate with your favorite tools, and watch your productivity soar with AI-suggested optimizations.',
      imageUrl: 'https://images.unsplash.com/photo-1535378620166-273708d44e4c?w=800&h=400&fit=crop',
      date: 'December 5, 2024'
    },
    {
      id: '3',
      title: 'Enhanced Security & Compliance',
      description: 'We\'ve rolled out enterprise-grade security features including SOC 2 Type II compliance, advanced encryption, and granular access controls. Your data is now more secure than ever with our new privacy-first architecture and GDPR-compliant data handling.',
      imageUrl: 'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&h=400&fit=crop',
      date: 'November 28, 2024'
    }
  ];

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
          Changelog
        </h2>

        {/* Close button */}
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
          style={{ marginRight: '-5px' }}
          aria-label="Close"
        >
          <X
            size={18}
            strokeWidth={2}
            className="text-gray-500"
          />
        </button>
      </div>

      {/* Content Area */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div
        className="flex-1 overflow-y-auto bg-white subtle-scrollbar"
        style={{
          padding: '16px',
          ...subtleScrollbarStyles
        }}
      >
        <div className="space-y-4">
          {changelogItems.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-lg overflow-hidden"
              style={{
                border: '1px solid #E5E7EB'
              }}
            >
              {/* Image */}
              <div className="relative h-48 bg-gray-100">
                <img
                  src={item.imageUrl}
                  alt={item.title}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.style.display = 'none';
                    if (target.parentElement) {
                      target.parentElement.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                    }
                  }}
                />
              </div>

              {/* Content */}
              <div className="p-4">
                <h3 className="font-semibold text-gray-900 mb-2" style={{ fontSize: '15px', lineHeight: '1.4' }}>
                  {item.title}
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">
                  {item.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Tab Bar with scrollable navigation - only show if more than 1 page enabled */}
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
              { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: () => {} },
              { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
              { id: 'feedback', icon: FileText, label: 'Feedback', onClick: onNavigateFeedback },
              { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
              { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
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
