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
  ChevronRight,
  Package,
  ArrowLeft,
  Minimize2,
  Maximize2
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface NewsViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateFeedback?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

interface NewsItem {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  content: string;
}

// News Article Detail View Component
function NewsArticleView({
  article,
  onBack,
  onClose
}: {
  article: NewsItem;
  onBack: () => void;
  onClose: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isMobile = useMobileDetection();
  const viewport = useViewportHeight();

  // Auto-expand after component mounts for smooth animation (only on desktop)
  useEffect(() => {
    if (isMobile) return;
    const timer = setTimeout(() => {
      setIsExpanded(true);
    }, 50);
    return () => clearTimeout(timer);
  }, [isMobile]);

  // Mobile: full-screen, Desktop: expandable
  const containerStyles: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        top: viewport.offsetTop || 0,
        left: 0,
        right: 0,
        width: '100vw',
        height: viewport.height || '100vh',
        borderRadius: '0',
        boxShadow: 'none',
        zIndex: 999999,
      }
    : {
        position: 'fixed',
        width: isExpanded ? '900px' : '400px',
        height: isExpanded ? 'calc(100vh - 120px)' : 'min(680px, 88vh)',
        bottom: '90px',
        right: '20px',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        transformOrigin: 'bottom right',
        zIndex: 999999,
      };

  return (
    <div
      className="flex flex-col bg-white overflow-hidden"
      style={containerStyles}
    >
      {/* Header Bar */}
      <div
        className="flex items-center justify-between bg-white"
        style={{
          height: '52px',
          padding: '0 16px',
          borderBottom: '1px solid #E5E7EB',
          borderTopLeftRadius: isMobile ? '0' : '16px',
          borderTopRightRadius: isMobile ? '0' : '16px'
        }}
      >
        <button
          onClick={() => {
            setIsExpanded(false);
            setTimeout(onBack, 300);
          }}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
        >
          <ArrowLeft size={18} className="text-gray-500" />
        </button>

        <h2
          className="text-center flex-1"
          style={{ fontSize: '16px', fontWeight: 560, color: '#111827', letterSpacing: '-0.01em' }}
        >
          News
        </h2>

        <div className="flex items-center gap-1">
          {/* Hide expand/minimize button on mobile (always full-screen) */}
          {!isMobile && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
              title={isExpanded ? "Minimize" : "Expand"}
            >
              {isExpanded ? (
                <Minimize2 size={18} className="text-gray-500" />
              ) : (
                <Maximize2 size={18} className="text-gray-500" />
              )}
            </button>
          )}

          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
            style={{ marginRight: '-5px' }}
          >
            <X size={18} strokeWidth={2} className="text-gray-500" />
          </button>
        </div>
      </div>

      {/* Article Content */}
      <div className="flex-1 overflow-y-auto bg-white">
        {/* Article Image */}
        <div
          className="w-full bg-cover bg-center"
          style={{
            backgroundImage: `url(${article.imageUrl})`,
            height: '200px',
          }}
        />

        {/* Article Body */}
        <div style={{ padding: '24px 20px' }}>
          <h1 style={{
            fontSize: '24px',
            fontWeight: 600,
            color: '#111827',
            lineHeight: '1.3',
            marginBottom: '16px'
          }}>
            {article.title}
          </h1>

          <div style={{
            fontSize: '15px',
            color: '#374151',
            lineHeight: '1.7',
            whiteSpace: 'pre-wrap'
          }}>
            {article.content}
          </div>
        </div>
      </div>
    </div>
  );
}

export function NewsView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateStatus,
  onNavigateFAQ,
  onNavigateChangelog,
  onNavigateFeedback,
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateEvents,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'feedback', 'appointments', 'announcements', 'events', 'news', 'parcel-tracking']
}: NewsViewProps) {
  const [activeTab] = useState('news');
  const [selectedArticle, setSelectedArticle] = useState<NewsItem | null>(null);

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

  const newsItems: NewsItem[] = [
    {
      id: '1',
      title: 'We Raised $50M in Series B Funding',
      description: 'We\'re thrilled to announce our Series B funding round led by top-tier investors. This investment will help us accelerate product development, expand our team, and better serve our growing customer base worldwide.',
      imageUrl: 'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=800&h=400&fit=crop',
      content: 'We\'re thrilled to announce our Series B funding round led by top-tier investors. This investment will help us accelerate product development, expand our team, and better serve our growing customer base worldwide.\n\nThe funding round was led by prominent venture capital firms who share our vision for transforming customer service through AI and automation. With this investment, we plan to:\n\n• Expand our AI capabilities and research team\n• Scale our infrastructure to support enterprise customers\n• Enter new international markets\n• Enhance our product with new features and integrations\n\nWe\'re grateful to our customers, partners, and team members who have helped us reach this milestone.',
    },
    {
      id: '2',
      title: 'Introducing Our New Enterprise Plan',
      description: 'The Enterprise Plan includes advanced security features, dedicated support, and custom integrations. Perfect for large organizations looking to scale their customer service operations with confidence.',
      imageUrl: 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=800&h=400&fit=crop',
      content: 'Today we\'re launching our most comprehensive plan yet. The Enterprise Plan includes advanced security features, dedicated support, custom integrations, and unlimited team members. Perfect for large organizations scaling their operations.\n\nKey features of the Enterprise Plan:\n\n• Advanced security with SSO, SAML, and audit logs\n• Dedicated customer success manager\n• Custom API integrations and webhooks\n• Priority support with 1-hour response time\n• Unlimited team members and workspaces\n• Custom training and onboarding\n\nContact our sales team to learn more about how the Enterprise Plan can help your organization.',
    },
    {
      id: '3',
      title: 'Recognized as Leader in G2 Grid Report',
      description: 'We\'re honored to be named a Leader in G2\'s Winter 2024 Grid Report for Customer Service Software. This recognition is a testament to our team\'s dedication and our customers\' trust.',
      imageUrl: 'https://images.unsplash.com/photo-1557804506-669a67965ba0?w=800&h=400&fit=crop',
      content: 'We\'re honored to be named a Leader in G2\'s Winter 2024 Grid Report for Customer Service Software. This recognition is a testament to our team\'s dedication and our customers\' trust in our platform.\n\nG2 Grid Reports are based on real user reviews and market presence, making this recognition especially meaningful. Our customers highlighted:\n\n• Ease of use and quick implementation\n• Powerful AI capabilities\n• Excellent customer support\n• Continuous product improvements\n\nThank you to all our customers who took the time to share their experiences. Your feedback drives us to keep improving.',
    },
    {
      id: '4',
      title: 'Join Us at Customer Success Summit 2025',
      description: 'Connect with fellow users, attend workshops, and hear from industry leaders at our first annual summit. Early bird tickets are now available for this exciting two-day event.',
      imageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&h=400&fit=crop',
      content: 'We\'re excited to announce our first annual Customer Success Summit in San Francisco. Connect with fellow users, attend workshops, and hear from industry leaders. Early bird tickets are now available!\n\nEvent highlights:\n\n• Keynote presentations from industry experts\n• Hands-on workshops and training sessions\n• Networking opportunities with peers\n• Product roadmap preview and Q&A\n• Customer success stories and best practices\n\nDates: March 15-16, 2025\nLocation: San Francisco, CA\n\nRegister now to secure your early bird discount!',
    },
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

  // If an article is selected, show the expanded article view
  if (selectedArticle) {
    return (
      <NewsArticleView
        article={selectedArticle}
        onBack={() => setSelectedArticle(null)}
        onClose={onClose}
      />
    );
  }

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
          News
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
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div className="flex-1 overflow-y-auto bg-white subtle-scrollbar" style={subtleScrollbarStyles}>
        <div>
          {newsItems.map((item, index) => (
            <div key={item.id}>
              <button
                onClick={() => setSelectedArticle(item)}
                className="w-full text-left hover:bg-gray-50 transition-all overflow-hidden group"
                style={{ padding: '14px 16px' }}
              >
                {/* Compact horizontal layout */}
                <div className="flex gap-4">
                  {/* Thumbnail */}
                  <div
                    className="rounded-lg bg-cover bg-center flex-shrink-0"
                    style={{ width: '75px', height: '75px', backgroundImage: `url(${item.imageUrl})` }}
                  />

                  {/* Content */}
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

                  {/* Arrow */}
                  <ChevronRight
                    size={18}
                    className="text-gray-300 group-hover:text-gray-400 flex-shrink-0 self-center transition-colors"
                  />
                </div>
              </button>
              {index < newsItems.length - 1 && (
                <div style={{ padding: '0 16px' }}>
                  <div style={{ borderBottom: '1px solid #F3F4F6' }} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Navigation - only show if more than 1 page enabled */}
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
              { id: 'home', icon: Home, label: 'Home', onClick: onNavigateHome },
              { id: 'messages', icon: MessageSquare, label: 'Chat', onClick: onNavigateMessages },
              { id: 'help', icon: HelpCircle, label: 'Help', onClick: onNavigateFAQ },
              { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
              { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
              { id: 'news', icon: Sparkles, label: 'News', onClick: () => {} },
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
                  className={cn("mb-1 transition-colors", activeTab === tab.id ? "text-gray-900" : "text-gray-400")}
                  strokeWidth={activeTab === tab.id ? 2 : 1.5}
                />
                <span className={cn("text-[10px] transition-colors", activeTab === tab.id ? "text-gray-900 font-medium" : "text-gray-400")}>
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
