
import React, { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
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
  TrendingUp,
  Award,
  Users,
  Package,
  ChevronRight
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { subtleScrollbarStyles, subtleScrollbarCSS } from './scrollbar-styles';

interface NewsViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
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
  date: string;
  category: 'company' | 'product' | 'community' | 'achievement';
  readTime?: string;
}

export function NewsView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateStatus,
  onNavigateFAQ,
  onNavigateChangelog,
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateEvents,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'appointments', 'announcements', 'events', 'news', 'parcel-tracking']
}: NewsViewProps) {
  const [activeTab] = useState('news');

  const newsItems: NewsItem[] = [
    {
      id: '1',
      title: 'We Raised $50M in Series B Funding',
      description: 'We\'re thrilled to announce our Series B funding round led by top-tier investors.',
      imageUrl: 'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=800&h=400&fit=crop&q=90&sharp=20',
      date: 'December 18, 2024',
      category: 'company',
      readTime: '3 min read'
    },
    {
      id: '2',
      title: 'Introducing Our New Enterprise Plan',
      description: 'The Enterprise Plan includes advanced security features, dedicated support, and custom integrations.',
      imageUrl: 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=800&h=400&fit=crop&q=90&sharp=20',
      date: 'December 14, 2024',
      category: 'product',
      readTime: '4 min read'
    },
    {
      id: '3',
      title: 'Recognized as Leader in G2 Grid Report',
      description: 'We\'re honored to be named a Leader in G2\'s Winter 2024 Grid Report for Customer Service Software.',
      imageUrl: 'https://images.unsplash.com/photo-1557804506-669a67965ba0?w=800&h=400&fit=crop&q=90&sharp=20',
      date: 'December 10, 2024',
      category: 'achievement',
      readTime: '2 min read'
    }
  ];

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'company':
        return <TrendingUp size={16} className="text-blue-600" />;
      case 'product':
        return <Sparkles size={16} className="text-purple-600" />;
      case 'community':
        return <Users size={16} className="text-green-600" />;
      case 'achievement':
        return <Award size={16} className="text-orange-600" />;
      default:
        return <Sparkles size={16} className="text-gray-600" />;
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'company':
        return 'bg-blue-100 text-blue-700';
      case 'product':
        return 'bg-purple-100 text-purple-700';
      case 'community':
        return 'bg-green-100 text-green-700';
      case 'achievement':
        return 'bg-orange-100 text-orange-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div
      className="fixed bottom-[90px] right-5 flex flex-col bg-white z-[999999] overflow-hidden"
      style={{
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)'
      }}
    >
      {/* Header Bar */}
      <div
        className="flex items-center justify-between bg-white relative"
        style={{
          height: '52px',
          padding: '0 16px',
          borderBottom: '1px solid #E5E7EB',
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px'
        }}
      >
        {/* Left spacer for balance */}
        <div className="w-8"></div>

        {/* Centered Title */}
        <h2
          className="text-gray-900 absolute left-1/2 transform -translate-x-1/2"
          style={{
            fontSize: '15px',
            fontWeight: 500,
            letterSpacing: '-0.01em'
          }}
        >
          News
        </h2>

        {/* Close button */}
        <Button
          variant="ghost"
          onClick={onClose}
          className="hover:bg-gray-100 transition-colors rounded-sm flex items-center justify-center"
          style={{
            width: '28px',
            height: '28px'
          }}
        >
          <X size={18} strokeWidth={2} className="text-gray-600" />
        </Button>
      </div>

      {/* Content Area */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div
        className="flex-1 overflow-y-auto bg-white dark:bg-background subtle-scrollbar"
        style={{
          padding: '0',
          ...subtleScrollbarStyles
        }}
      >
        <div style={{ margin: '0' }}>
          {newsItems.map((item, index) => (
            <div key={item.id}>
              {index > 0 && (
                <div className="border-t border-gray-100 dark:border-border mx-4" />
              )}
              <Button
                variant="ghost"
                className="w-full text-left hover:bg-gray-50 dark:hover:bg-secondary/50 transition-all duration-150"
                style={{ padding: '16px' }}
              >
                {/* Image */}
                <div className="relative h-36 bg-gray-100 dark:bg-accent rounded-lg overflow-hidden mb-3">
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

                {/* Title and Description with Chevron */}
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0 pr-3">
                    <h3 className="font-semibold text-gray-900 dark:text-foreground mb-1" style={{ fontSize: '14px', lineHeight: '1.4' }}>
                      {item.title}
                    </h3>
                    <p className="text-gray-500 dark:text-muted-foreground" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                      {item.description}
                    </p>
                  </div>
                  <ChevronRight
                    size={18}
                    className="text-gray-400 dark:text-muted-foreground flex-shrink-0 mt-1"
                  />
                </div>
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Tab Bar with all navigation - Only show if more than 1 page is enabled */}
      {enabledPages.length > 1 && (
        <div
          className="bg-white dark:bg-background relative border-t border-gray-200 dark:border-border"
          style={{
            height: '60px',
            borderBottomLeftRadius: '16px',
            borderBottomRightRadius: '16px'
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
                { id: 'news', icon: Sparkles, label: 'News', onClick: () => {} },
                { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
                { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
                { id: 'events', icon: Calendar, label: 'Events', onClick: onNavigateEvents },
                { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
              ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                <Button
                  key={tab.id}
                  variant="ghost"
                  onClick={tab.onClick}
                  className="flex flex-col items-center justify-center px-3 py-2 transition-all group flex-1 min-w-[60px]"
                  aria-label={tab.label}
                >
                  <tab.icon
                    size={18}
                    className={cn(
                      "mb-1 transition-colors",
                      activeTab === tab.id ? "text-gray-900 dark:text-foreground" : "text-gray-400 dark:text-muted-foreground"
                    )}
                    strokeWidth={activeTab === tab.id ? 2 : 1.5}
                  />
                  <span
                    className={cn(
                      "text-[10px] transition-colors",
                      activeTab === tab.id ? "text-gray-900 dark:text-foreground font-medium" : "text-gray-400 dark:text-muted-foreground"
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
