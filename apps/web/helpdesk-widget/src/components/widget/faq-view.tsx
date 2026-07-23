import React, { useState, useEffect } from 'react';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Search,
  ChevronRight,
  Calendar,
  FileText,
  Sparkles,
  Megaphone,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ArticleView } from './article-view';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface FAQViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateFeedback?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

interface HelpCategory {
  id: string;
  title: string;
  description: string;
  articleCount: number;
  articles: { id: string; question: string; description: string; answer: string }[];
}

export function FAQView({ onClose, onNavigateHome, onNavigateMessages, onNavigateStatus, onNavigateChangelog, onNavigateNews, onNavigateFeedback, onNavigateAppointments, onNavigateAnnouncements, onNavigateEvents, onNavigateParcelTracking, enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking'] }: FAQViewProps) {
  const [activeTab] = useState('help');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<HelpCategory | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<{ id: string; question: string; answer: string } | null>(null);

  // Detect if we're embedded in an iframe (SDK mode)
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

  // Determine if we should use full-screen mode
  const isFullScreen = isEmbedded || isMobile;

  const helpCategories: HelpCategory[] = [
    {
      id: '1',
      title: 'Getting Started',
      description: 'Everything you need to know to get started with our platform.',
      articleCount: 24,
      articles: [
        { id: '1-1', question: 'Creating your first project', description: 'Learn how to set up and configure your first project.', answer: 'Creating an account is simple. Click on the Sign Up button and follow the registration process. You\'ll need to provide your email address and create a password.' },
        { id: '1-2', question: 'Inviting team members', description: 'Add collaborators to your workspace.', answer: 'After registration, complete your profile by adding your name, company information, and preferences. This helps us personalize your experience.' },
        { id: '1-3', question: 'Understanding the dashboard', description: 'Navigate and customize your main dashboard.', answer: 'The dashboard provides an overview of your key metrics and activities. Customize widgets to show the information most relevant to you.' },
        { id: '1-4', question: 'Setting up notifications', description: 'Configure alerts and notification preferences.', answer: 'Navigate to Settings > Notifications to customize how and when you receive alerts about activity in your workspace.' },
      ]
    },
    {
      id: '2',
      title: 'Account & Billing',
      description: 'Manage your account settings, subscriptions, and payment methods.',
      articleCount: 18,
      articles: [
        { id: '2-1', question: 'How to update payment method', description: 'Change or add new payment options.', answer: 'Go to Settings > Billing > Payment Methods. You can add, remove, or update your credit cards and other payment options.' },
        { id: '2-2', question: 'Understanding your invoice', description: 'Review charges and download invoices.', answer: 'Invoices are generated monthly and include a breakdown of all charges. You can download PDF invoices from the Billing section.' },
      ]
    },
    {
      id: '3',
      title: 'Features & Tools',
      description: 'Learn how to use all the features and tools available to you.',
      articleCount: 32,
      articles: [
        { id: '3-1', question: 'Using the dashboard', description: 'Overview of dashboard features and widgets.', answer: 'The dashboard provides an overview of your key metrics and activities. Customize widgets to show the information most relevant to you.' },
        { id: '3-2', question: 'Setting up automations', description: 'Create workflows and automated tasks.', answer: 'Navigate to Automation > Rules to create workflows that trigger based on specific conditions. Save time by automating repetitive tasks.' },
      ]
    },
    {
      id: '4',
      title: 'Integrations',
      description: 'Connect with third-party tools and services.',
      articleCount: 15,
      articles: [
        { id: '4-1', question: 'Connecting to Slack', description: 'Set up Slack notifications and commands.', answer: 'Go to Integrations > Slack and click Connect. Authorize the connection and select which channels to receive notifications.' },
        { id: '4-2', question: 'Zapier integration', description: 'Automate workflows with Zapier.', answer: 'Use Zapier to connect with hundreds of other apps. Set up triggers and actions to automate your workflow across platforms.' },
      ]
    },
    {
      id: '5',
      title: 'Troubleshooting',
      description: 'Find solutions to common issues and problems.',
      articleCount: 28,
      articles: [
        { id: '5-1', question: 'Login issues', description: 'Resolve account access problems.', answer: 'If you\'re having trouble logging in, try resetting your password. Make sure you\'re using the correct email address associated with your account.' },
        { id: '5-2', question: 'Slow performance', description: 'Improve app speed and responsiveness.', answer: 'Clear your browser cache and cookies. Try using a different browser or disabling extensions that might interfere with the application.' },
      ]
    }
  ];

  // Filter categories based on search
  const filteredCategories = searchQuery
    ? helpCategories.filter(cat =>
        cat.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        cat.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        cat.articles.some(a => a.question.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : helpCategories;

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

  // If an article is selected, show the article view
  if (selectedArticle) {
    return (
      <ArticleView
        article={{
          id: selectedArticle.id,
          title: selectedArticle.question,
          content: selectedArticle.answer
        }}
        onBack={() => setSelectedArticle(null)}
        onClose={onClose}
      />
    );
  }

  // If a category is selected, show articles in that category
  if (selectedCategory) {
    return (
      <div
        className={cn(
          'flex flex-col bg-white overflow-hidden',
          !isFullScreen && 'fixed bottom-[90px] right-5 z-[999999]'
        )}
        style={containerStyles}
      >
        {/* Header */}
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
            onClick={() => setSelectedCategory(null)}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
          >
            <ChevronRight size={18} className="text-gray-500 rotate-180" />
          </button>
          <h2
            className="text-center flex-1"
            style={{ fontSize: '16px', fontWeight: 560, color: '#111827', letterSpacing: '-0.01em' }}
          >
            {selectedCategory.title}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
            style={{ marginRight: '-5px' }}
          >
            <X size={18} strokeWidth={2} className="text-gray-500" />
          </button>
        </div>

        {/* Articles list */}
        <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
        <div className="flex-1 overflow-y-auto bg-white subtle-scrollbar" style={subtleScrollbarStyles}>
          {selectedCategory.articles.map((article, index) => (
            <div key={article.id}>
              <button
                onClick={() => setSelectedArticle(article)}
                className="w-full text-left hover:bg-gray-50 transition-all flex items-center justify-between"
                style={{
                  padding: '14px 16px',
                }}
              >
                <div className="flex-1 pr-4">
                  <h3 style={{ fontSize: '14.5px', fontWeight: 595, color: '#111827', marginBottom: '2px' }}>
                    {article.question}
                  </h3>
                  <p style={{ fontSize: '13px', color: '#6B7280', lineHeight: '1.4' }}>
                    {article.description}
                  </p>
                </div>
                <ChevronRight size={18} className="text-gray-300 flex-shrink-0" />
              </button>
              {index < selectedCategory.articles.length - 1 && (
                <div style={{ padding: '0 16px' }}>
                  <div style={{ borderBottom: '1px solid #F3F4F6' }} />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Bottom Navigation - only show if more than 1 page enabled */}
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
          <div className="flex items-center h-full overflow-x-auto" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            <div className="flex items-center min-w-full px-2">
              {[
                { id: 'home', icon: Home, label: 'Home', onClick: onNavigateHome },
                { id: 'messages', icon: MessageSquare, label: 'Chat', onClick: onNavigateMessages },
                { id: 'help', icon: HelpCircle, label: 'Help', onClick: () => setSelectedCategory(null) },
                { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
                { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
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
        className="flex items-center justify-between bg-white"
        style={{
          height: '52px',
          padding: '0 16px',
          borderBottom: '1px solid #E5E7EB',
          borderTopLeftRadius: isMobile ? '0' : '16px',
          borderTopRightRadius: isMobile ? '0' : '16px'
        }}
      >
        <div className="w-8"></div>
        <h2
          className="text-center flex-1"
          style={{
            fontSize: '16px',
            fontWeight: 560,
            color: '#111827',
            letterSpacing: '-0.01em'
          }}
        >
          Help
        </h2>
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

      {/* Search Bar */}
      <div className="bg-white flex-shrink-0" style={{ padding: '16px 16px 4px 16px' }}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search help docs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={cn(
              "w-full pl-9 pr-3 py-2 bg-gray-100 rounded-lg text-sm",
              "placeholder:text-gray-400 transition-all duration-200",
              "focus:outline-none focus:ring-1 focus:ring-gray-300"
            )}
          />
        </div>
      </div>

      {/* Categories List */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div className="flex-1 overflow-y-auto bg-white subtle-scrollbar" style={subtleScrollbarStyles}>
        {filteredCategories.map((category, index) => (
          <div key={category.id}>
            <button
              onClick={() => setSelectedCategory(category)}
              className="w-full text-left hover:bg-gray-50 transition-all flex items-center justify-between"
              style={{
                padding: '14px 16px',
              }}
            >
              <div className="flex-1 pr-4">
                <h3 style={{ fontSize: '14.5px', fontWeight: 595, color: '#111827', marginBottom: '2px' }}>
                  {category.title}
                </h3>
                <p style={{ fontSize: '13px', color: '#6B7280', lineHeight: '1.4', marginBottom: '2px' }}>
                  {category.description}
                </p>
                <span style={{ fontSize: '12px', color: '#9CA3AF' }}>
                  {category.articleCount} articles
                </span>
              </div>
              <ChevronRight size={18} className="text-gray-300 flex-shrink-0" />
            </button>
            {index < filteredCategories.length - 1 && (
              <div style={{ padding: '0 16px' }}>
                <div style={{ borderBottom: '1px solid #F3F4F6' }} />
              </div>
            )}
          </div>
        ))}

        {filteredCategories.length === 0 && (
          <div className="text-center" style={{ padding: '40px 20px', color: '#6B7280', fontSize: '14px' }}>
            No help topics found matching your search
          </div>
        )}
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
              { id: 'help', icon: HelpCircle, label: 'Help', onClick: () => {} },
              { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
              { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
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
