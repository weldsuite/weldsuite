
import React, { useState } from 'react';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Search,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Calendar,
  FileText,
  Sparkles,
  Megaphone,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { ArticleView } from './article-view';
import { subtleScrollbarStyles, subtleScrollbarCSS } from './scrollbar-styles';

interface FAQViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

interface FAQItem {
  id: string;
  question: string;
  answer: string;
}

interface HelpArticle {
  id: string;
  title: string;
  description: string;
}

interface HelpCollection {
  id: string;
  title: string;
  description: string;
  articleCount: number;
  articles: HelpArticle[];
}

export function FAQView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateStatus,
  onNavigateChangelog,
  onNavigateNews,
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateEvents,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'appointments', 'announcements', 'events', 'news', 'parcel-tracking']
}: FAQViewProps) {
  const [activeTab] = useState('help');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedArticle, setSelectedArticle] = useState<FAQItem | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<HelpCollection | null>(null);
  const [selectedHelpArticle, setSelectedHelpArticle] = useState<HelpArticle | null>(null);

  const helpCollections: HelpCollection[] = [
    {
      id: '1',
      title: 'Getting Started',
      description: 'Everything you need to know to get started with our platform.',
      articleCount: 24,
      articles: [
        { id: '1-1', title: 'Creating your first project', description: 'Learn how to set up and configure your first project.' },
        { id: '1-2', title: 'Inviting team members', description: 'Add collaborators to your workspace.' },
        { id: '1-3', title: 'Understanding the dashboard', description: 'Navigate and customize your main dashboard.' },
        { id: '1-4', title: 'Setting up notifications', description: 'Configure alerts and notification preferences.' }
      ]
    },
    {
      id: '2',
      title: 'Account & Billing',
      description: 'Manage your account settings, subscriptions, and payment methods.',
      articleCount: 18,
      articles: [
        { id: '2-1', title: 'Updating your profile', description: 'Change your name, email, and profile picture.' },
        { id: '2-2', title: 'Managing subscriptions', description: 'Upgrade, downgrade, or cancel your plan.' },
        { id: '2-3', title: 'Payment methods', description: 'Add or update your payment information.' },
        { id: '2-4', title: 'Viewing invoices', description: 'Access and download your billing history.' }
      ]
    },
    {
      id: '3',
      title: 'Features & Tools',
      description: 'Learn how to use all the features and tools available to you.',
      articleCount: 32,
      articles: [
        { id: '3-1', title: 'Using the chat widget', description: 'Configure and customize your chat widget.' },
        { id: '3-2', title: 'Setting up automations', description: 'Create automated workflows and responses.' },
        { id: '3-3', title: 'Analytics and reporting', description: 'Track performance and generate reports.' },
        { id: '3-4', title: 'Knowledge base setup', description: 'Create and organize help articles.' }
      ]
    },
    {
      id: '4',
      title: 'Integrations',
      description: 'Connect with third-party tools and services.',
      articleCount: 15,
      articles: [
        { id: '4-1', title: 'Slack integration', description: 'Connect your workspace to Slack.' },
        { id: '4-2', title: 'Zapier workflows', description: 'Automate tasks with Zapier.' },
        { id: '4-3', title: 'CRM connections', description: 'Sync with Salesforce, HubSpot, and more.' },
        { id: '4-4', title: 'API documentation', description: 'Build custom integrations with our API.' }
      ]
    },
    {
      id: '5',
      title: 'Troubleshooting',
      description: 'Find solutions to common issues and problems.',
      articleCount: 28,
      articles: [
        { id: '5-1', title: 'Connection issues', description: 'Resolve connectivity and sync problems.' },
        { id: '5-2', title: 'Login problems', description: 'Fix authentication and access issues.' },
        { id: '5-3', title: 'Performance optimization', description: 'Speed up your workspace.' },
        { id: '5-4', title: 'Error messages explained', description: 'Understand and resolve common errors.' }
      ]
    }
  ];

  const faqItems: FAQItem[] = [
    {
      id: '1',
      question: 'Connect your email support channel',
      answer: 'To connect your email support channel, go to Settings > Email Integration and follow the setup wizard. You\'ll need to provide your email server details and authentication credentials.'
    },
    {
      id: '2',
      question: 'How to set up automated responses',
      answer: 'Navigate to Automation > Auto-responses and create rules based on keywords, time of day, or customer segments. You can customize messages and set conditions for when they should trigger.'
    },
    {
      id: '3',
      question: 'Managing team permissions and roles',
      answer: 'Access Teams > Permissions to assign roles to team members. You can control access to specific features, data, and customer interactions based on each team member\'s responsibilities.'
    },
    {
      id: '4',
      question: 'Integrating with third-party tools',
      answer: 'Visit Integrations > Browse Apps to connect with popular tools like Slack, Salesforce, and Zapier. Each integration has a setup guide and configuration options.'
    },
    {
      id: '5',
      question: 'Understanding your analytics dashboard',
      answer: 'The Analytics section provides insights into response times, customer satisfaction, and team performance. You can customize reports and export data for further analysis.'
    },
    {
      id: '6',
      question: 'Setting up chatbot workflows',
      answer: 'Go to WeldAgent > Workflows to create conversation flows. Use the visual builder to design paths based on customer responses and integrate with your knowledge base.'
    },
    {
      id: '7',
      question: 'Customizing your chat widget appearance',
      answer: 'In Chat Widget > Appearance, you can modify colors, positioning, welcome messages, and branding to match your website\'s design and tone.'
    },
    {
      id: '8',
      question: 'Managing customer data and privacy',
      answer: 'Review Settings > Privacy & Data to configure data retention policies, GDPR compliance settings, and customer data export options. Ensure your practices align with local regulations.'
    }
  ];

  const filteredCollections = helpCollections.filter(collection =>
    collection.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    collection.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredFAQs = faqItems.filter(item =>
    item.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.answer.toLowerCase().includes(searchQuery.toLowerCase())
  );

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

  // If a help article is selected, show expanded article view
  if (selectedHelpArticle && selectedCollection) {
    return (
      <div
        className="fixed bottom-[90px] right-5 flex flex-col bg-white dark:bg-background z-[999999] overflow-hidden transition-all duration-300"
        style={{
          width: '700px',
          height: '1200px',
          borderRadius: '16px',
          boxShadow: '0 16px 40px rgba(0,0,0,0.35)'
        }}
      >
        {/* Header Bar with Back Button */}
        <div
          className="flex items-center justify-between bg-white dark:bg-background border-b border-gray-200 dark:border-border"
          style={{
            height: '52px',
            padding: '0 16px',
            borderTopLeftRadius: '16px',
            borderTopRightRadius: '16px'
          }}
        >
          <Button
            variant="ghost"
            onClick={() => setSelectedHelpArticle(null)}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-150"
            aria-label="Back"
          >
            <ChevronLeft
              size={18}
              strokeWidth={2}
              className="text-gray-500 dark:text-muted-foreground"
            />
          </Button>
          <h2
            className="text-center flex-1 text-gray-900 dark:text-foreground"
            style={{
              fontSize: '16px',
              fontWeight: 500
            }}
          >
            {selectedHelpArticle.title}
          </h2>
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
        <div className="flex-1 overflow-y-auto bg-white dark:bg-background subtle-scrollbar" style={{ padding: '24px', ...subtleScrollbarStyles }}>
          <p className="text-gray-600 dark:text-muted-foreground" style={{ fontSize: '15px', lineHeight: '1.7' }}>
            {selectedHelpArticle.description}
          </p>
          <div className="mt-6 text-gray-500 dark:text-muted-foreground" style={{ fontSize: '14px', lineHeight: '1.7' }}>
            <p className="mb-4">
              This is where the full article content would appear. The article provides detailed information about {selectedHelpArticle.title.toLowerCase()}.
            </p>
            <p className="mb-4">
              You can include step-by-step instructions, screenshots, videos, and other helpful resources to guide users through the process.
            </p>
            <p>
              If you need additional help, feel free to start a conversation with our support team.
            </p>
          </div>
        </div>

        {/* Bottom Tab Bar */}
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
                  { id: 'help', icon: HelpCircle, label: 'Help', onClick: () => { setSelectedHelpArticle(null); setSelectedCollection(null); } },
                  { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
                  { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
                  { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
                  { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
                  { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
                  { id: 'events', icon: Calendar, label: 'Events', onClick: onNavigateEvents },
                  { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
                ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                  <Button
                    variant="ghost"
                    key={tab.id}
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

  // If a collection is selected, show the sub-collection view
  if (selectedCollection) {
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
        {/* Header Bar with Back Button */}
        <div
          className="flex items-center justify-between bg-white dark:bg-background border-b border-gray-200 dark:border-border"
          style={{
            height: '52px',
            padding: '0 16px',
            borderTopLeftRadius: '16px',
            borderTopRightRadius: '16px'
          }}
        >
          <Button
            variant="ghost"
            onClick={() => setSelectedCollection(null)}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-150"
            aria-label="Back"
          >
            <ChevronLeft
              size={18}
              strokeWidth={2}
              className="text-gray-500 dark:text-muted-foreground"
            />
          </Button>
          <h2
            className="text-center flex-1 text-gray-900 dark:text-foreground"
            style={{
              fontSize: '16px',
              fontWeight: 500
            }}
          >
            {selectedCollection.title}
          </h2>
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
        <div className="flex-1 overflow-y-auto bg-white dark:bg-background subtle-scrollbar" style={{ padding: '0 16px', ...subtleScrollbarStyles }}>
          {/* Articles List */}
          <div style={{ margin: '0 -16px' }}>
            {selectedCollection.articles.map((article, index) => (
              <div key={article.id}>
                {index > 0 && (
                  <div className="border-t border-gray-100 dark:border-border mx-4" />
                )}
                <Button
                  variant="ghost"
                  onClick={() => setSelectedHelpArticle(article)}
                  className="w-full text-left hover:bg-gray-50 dark:hover:bg-secondary/50 transition-all duration-150 flex items-center justify-between group"
                  style={{
                    padding: '14px 16px'
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-900 dark:text-foreground font-medium"
                      style={{
                        fontSize: '14px',
                        lineHeight: '1.5'
                      }}>
                      {article.title}
                    </p>
                    <p className="text-gray-500 dark:text-muted-foreground mt-0.5"
                      style={{
                        fontSize: '13px',
                        lineHeight: '1.4'
                      }}>
                      {article.description}
                    </p>
                  </div>
                  <ChevronRight
                    size={18}
                    className="text-gray-400 dark:text-muted-foreground flex-shrink-0 ml-3"
                  />
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
                  { id: 'help', icon: HelpCircle, label: 'Help', onClick: () => setSelectedCollection(null) },
                  { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
                  { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
                  { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
                  { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
                  { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
                  { id: 'events', icon: Calendar, label: 'Events', onClick: onNavigateEvents },
                  { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
                ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                  <Button
                    variant="ghost"
                    key={tab.id}
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
        className="flex items-center justify-between bg-white dark:bg-background border-b border-gray-200 dark:border-border"
        style={{
          height: '52px',
          padding: '0 16px',
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px'
        }}
      >
        <div className="w-8"></div>
        <h2
          className="text-center flex-1 text-gray-900 dark:text-foreground"
          style={{
            fontSize: '16px',
            fontWeight: 500
          }}
        >
          Help
        </h2>
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

      {/* Search Bar - Fixed above scrollable area */}
      <div className="bg-white dark:bg-background" style={{ padding: '16px 16px 4px 16px' }}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-muted-foreground" />
          <input
            type="text"
            placeholder="Search for help..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className={cn(
              "w-full pl-9 pr-3 py-2 bg-gray-100 dark:bg-secondary rounded-md text-sm text-gray-900 dark:text-foreground",
              "placeholder:text-gray-400 dark:placeholder:text-gray-500 transition-all duration-200",
              "focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600"
            )}
          />
        </div>
      </div>

      {/* Content Area */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div className="flex-1 overflow-y-auto bg-white dark:bg-background subtle-scrollbar" style={{ padding: '0 16px', ...subtleScrollbarStyles }}>
        {/* Help Collections */}
        {filteredCollections.length > 0 && (
          <div style={{ margin: '0 -16px' }}>
            {filteredCollections.map((collection, index) => (
              <div key={collection.id}>
                {index > 0 && (
                  <div className="border-t border-gray-100 dark:border-border mx-4" />
                )}
                <Button
                  variant="ghost"
                  onClick={() => setSelectedCollection(collection)}
                  className="w-full text-left hover:bg-gray-50 dark:hover:bg-secondary/50 transition-all duration-150 flex items-center justify-between group"
                  style={{
                    padding: '14px 16px'
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-900 dark:text-foreground font-medium"
                      style={{
                        fontSize: '14px',
                        lineHeight: '1.5'
                      }}>
                      {collection.title}
                    </p>
                    <p className="text-gray-500 dark:text-muted-foreground mt-0.5"
                      style={{
                        fontSize: '13px',
                        lineHeight: '1.4'
                      }}>
                      {collection.description}
                    </p>
                    <span className="text-gray-400 dark:text-muted-foreground mt-1 inline-block"
                      style={{
                        fontSize: '12px'
                      }}>
                      {collection.articleCount} articles
                    </span>
                  </div>
                  <ChevronRight
                    size={18}
                    className="text-gray-400 dark:text-muted-foreground flex-shrink-0 ml-3"
                  />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* No results message */}
        {filteredCollections.length === 0 && (
          <div className="text-center py-10 text-gray-600 dark:text-muted-foreground text-sm">
            No collections found matching your search
          </div>
        )}
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
                { id: 'help', icon: HelpCircle, label: 'Help', onClick: () => {} },
                { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
                { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
                { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
                { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
                { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
                { id: 'events', icon: Calendar, label: 'Events', onClick: onNavigateEvents },
                { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
              ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                <Button
                  variant="ghost"
                  key={tab.id}
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