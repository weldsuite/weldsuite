
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
  Package,
  ChevronRight
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { subtleScrollbarStyles, subtleScrollbarCSS } from './scrollbar-styles';

interface ChangelogViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateNews?: () => void;
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
  tags: { label: string; color: 'gray' | 'blue' | 'green' | 'purple' }[];
}

export function ChangelogView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateStatus,
  onNavigateFAQ,
  onNavigateNews,
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateEvents,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'appointments', 'announcements', 'events', 'news', 'parcel-tracking']
}: ChangelogViewProps) {
  const [activeTab] = useState('changelog');

  const changelogItems: ChangelogItem[] = [
    {
      id: '1',
      title: 'Train Fin to detect key attributes in every conversation',
      description: 'Fin can now automatically detect the attributes you define—like issue type,...',
      imageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&h=400&fit=crop&q=90&sharp=20',
      date: 'December 13, 2024',
      tags: [{ label: 'Fin', color: 'gray' }, { label: 'New feature', color: 'blue' }]
    },
    {
      id: '2',
      title: 'Introducing Smart Automation workflows',
      description: 'Set up complex multi-step automations with our visual builder and AI-suggested optimizations.',
      imageUrl: 'https://images.unsplash.com/photo-1535378620166-273708d44e4c?w=800&h=400&fit=crop&q=90&sharp=20',
      date: 'December 5, 2024',
      tags: [{ label: 'Automation', color: 'purple' }, { label: 'New feature', color: 'blue' }]
    },
    {
      id: '3',
      title: 'Enhanced Security & Compliance features',
      description: 'Enterprise-grade security with SOC 2 Type II compliance and advanced encryption.',
      imageUrl: 'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&h=400&fit=crop&q=90&sharp=20',
      date: 'November 28, 2024',
      tags: [{ label: 'Security', color: 'green' }, { label: 'Update', color: 'gray' }]
    }
  ];

  const tagColors = {
    gray: 'bg-gray-100 text-gray-700',
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    purple: 'bg-purple-100 text-purple-700'
  };

  return (
    <div
      className="fixed bottom-[90px] right-5 flex flex-col bg-white dark:bg-background z-[999999] overflow-hidden"
      style={{
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)'
      }}
    >
      {/* Header Bar */}
      <div
        className="flex items-center justify-between bg-white dark:bg-background relative border-b border-gray-200 dark:border-border"
        style={{
          height: '52px',
          padding: '0 16px',
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px'
        }}
      >
        {/* Left spacer for balance */}
        <div className="w-8"></div>

        {/* Centered Title */}
        <h2
          className="text-gray-900 dark:text-foreground absolute left-1/2 transform -translate-x-1/2"
          style={{
            fontSize: '15px',
            fontWeight: 500,
            letterSpacing: '-0.01em'
          }}
        >
          Changelog
        </h2>

        {/* Close button */}
        <Button
          variant="ghost"
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-150"
          aria-label="Close"
        >
          <X
            size={18}
            strokeWidth={2}
            className="text-gray-500 dark:text-muted-foreground"
          />
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
          {changelogItems.map((item, index) => (
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

      {/* Bottom Tab Bar with scrollable navigation - Only show if more than 1 page is enabled */}
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
                { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: () => {} },
                { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
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
