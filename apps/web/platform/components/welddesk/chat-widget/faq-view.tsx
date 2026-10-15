
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
  Calendar,
  Sparkles,
  Megaphone,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
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
}: Readonly<FAQViewProps>) {
  const { t, format } = useI18n();
  const activeTab = 'help';
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedArticle, setSelectedArticle] = useState<FAQItem | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<HelpCollection | null>(null);
  const [selectedHelpArticle, setSelectedHelpArticle] = useState<HelpArticle | null>(null);

  const helpCollections: HelpCollection[] = [
    {
      id: '1',
      title: t.helpdeskWidget.faq.collections.gettingStarted.title,
      description: t.helpdeskWidget.faq.collections.gettingStarted.description,
      articleCount: 24,
      articles: [
        { id: '1-1', title: t.helpdeskWidget.faq.collections.gettingStarted.articles.article1.title, description: t.helpdeskWidget.faq.collections.gettingStarted.articles.article1.description },
        { id: '1-2', title: t.helpdeskWidget.faq.collections.gettingStarted.articles.article2.title, description: t.helpdeskWidget.faq.collections.gettingStarted.articles.article2.description },
        { id: '1-3', title: t.helpdeskWidget.faq.collections.gettingStarted.articles.article3.title, description: t.helpdeskWidget.faq.collections.gettingStarted.articles.article3.description },
        { id: '1-4', title: t.helpdeskWidget.faq.collections.gettingStarted.articles.article4.title, description: t.helpdeskWidget.faq.collections.gettingStarted.articles.article4.description }
      ]
    },
    {
      id: '2',
      title: t.helpdeskWidget.faq.collections.accountBilling.title,
      description: t.helpdeskWidget.faq.collections.accountBilling.description,
      articleCount: 18,
      articles: [
        { id: '2-1', title: t.helpdeskWidget.faq.collections.accountBilling.articles.article1.title, description: t.helpdeskWidget.faq.collections.accountBilling.articles.article1.description },
        { id: '2-2', title: t.helpdeskWidget.faq.collections.accountBilling.articles.article2.title, description: t.helpdeskWidget.faq.collections.accountBilling.articles.article2.description },
        { id: '2-3', title: t.helpdeskWidget.faq.collections.accountBilling.articles.article3.title, description: t.helpdeskWidget.faq.collections.accountBilling.articles.article3.description },
        { id: '2-4', title: t.helpdeskWidget.faq.collections.accountBilling.articles.article4.title, description: t.helpdeskWidget.faq.collections.accountBilling.articles.article4.description }
      ]
    },
    {
      id: '3',
      title: t.helpdeskWidget.faq.collections.featuresTools.title,
      description: t.helpdeskWidget.faq.collections.featuresTools.description,
      articleCount: 32,
      articles: [
        { id: '3-1', title: t.helpdeskWidget.faq.collections.featuresTools.articles.article1.title, description: t.helpdeskWidget.faq.collections.featuresTools.articles.article1.description },
        { id: '3-2', title: t.helpdeskWidget.faq.collections.featuresTools.articles.article2.title, description: t.helpdeskWidget.faq.collections.featuresTools.articles.article2.description },
        { id: '3-3', title: t.helpdeskWidget.faq.collections.featuresTools.articles.article3.title, description: t.helpdeskWidget.faq.collections.featuresTools.articles.article3.description },
        { id: '3-4', title: t.helpdeskWidget.faq.collections.featuresTools.articles.article4.title, description: t.helpdeskWidget.faq.collections.featuresTools.articles.article4.description }
      ]
    },
    {
      id: '4',
      title: t.helpdeskWidget.faq.collections.integrations.title,
      description: t.helpdeskWidget.faq.collections.integrations.description,
      articleCount: 15,
      articles: [
        { id: '4-1', title: t.helpdeskWidget.faq.collections.integrations.articles.article1.title, description: t.helpdeskWidget.faq.collections.integrations.articles.article1.description },
        { id: '4-2', title: t.helpdeskWidget.faq.collections.integrations.articles.article2.title, description: t.helpdeskWidget.faq.collections.integrations.articles.article2.description },
        { id: '4-3', title: t.helpdeskWidget.faq.collections.integrations.articles.article3.title, description: t.helpdeskWidget.faq.collections.integrations.articles.article3.description },
        { id: '4-4', title: t.helpdeskWidget.faq.collections.integrations.articles.article4.title, description: t.helpdeskWidget.faq.collections.integrations.articles.article4.description }
      ]
    },
    {
      id: '5',
      title: t.helpdeskWidget.faq.collections.troubleshooting.title,
      description: t.helpdeskWidget.faq.collections.troubleshooting.description,
      articleCount: 28,
      articles: [
        { id: '5-1', title: t.helpdeskWidget.faq.collections.troubleshooting.articles.article1.title, description: t.helpdeskWidget.faq.collections.troubleshooting.articles.article1.description },
        { id: '5-2', title: t.helpdeskWidget.faq.collections.troubleshooting.articles.article2.title, description: t.helpdeskWidget.faq.collections.troubleshooting.articles.article2.description },
        { id: '5-3', title: t.helpdeskWidget.faq.collections.troubleshooting.articles.article3.title, description: t.helpdeskWidget.faq.collections.troubleshooting.articles.article3.description },
        { id: '5-4', title: t.helpdeskWidget.faq.collections.troubleshooting.articles.article4.title, description: t.helpdeskWidget.faq.collections.troubleshooting.articles.article4.description }
      ]
    }
  ];

  const filteredCollections = helpCollections.filter(collection =>
    collection.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    collection.description.toLowerCase().includes(searchQuery.toLowerCase())
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
            aria-label={t.helpdeskWidget.common.back}
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
            aria-label={t.helpdeskWidget.common.close}
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
              {format(t.helpdeskWidget.faq.articlePlaceholder.intro, { title: selectedHelpArticle.title.toLowerCase() })}
            </p>
            <p className="mb-4">
              {t.helpdeskWidget.faq.articlePlaceholder.details}
            </p>
            <p>
              {t.helpdeskWidget.faq.articlePlaceholder.help}
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
                  { id: 'home', icon: Home, label: t.helpdeskWidget.nav.home, onClick: onNavigateHome },
                  { id: 'messages', icon: MessageSquare, label: t.helpdeskWidget.nav.chat, onClick: onNavigateMessages },
                  { id: 'help', icon: HelpCircle, label: t.helpdeskWidget.nav.help, onClick: () => { setSelectedHelpArticle(null); setSelectedCollection(null); } },
                  { id: 'status', icon: Activity, label: t.helpdeskWidget.nav.status, onClick: onNavigateStatus },
                  { id: 'changelog', icon: Sparkles, label: t.helpdeskWidget.nav.changelog, onClick: onNavigateChangelog },
                  { id: 'news', icon: Sparkles, label: t.helpdeskWidget.nav.news, onClick: onNavigateNews },
                  { id: 'appointments', icon: Calendar, label: t.helpdeskWidget.nav.book, onClick: onNavigateAppointments },
                  { id: 'announcements', icon: Megaphone, label: t.helpdeskWidget.nav.announce, onClick: onNavigateAnnouncements },
                  { id: 'events', icon: Calendar, label: t.helpdeskWidget.nav.events, onClick: onNavigateEvents },
                  { id: 'parcel-tracking', icon: Package, label: t.helpdeskWidget.nav.track, onClick: onNavigateParcelTracking }
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
            aria-label={t.helpdeskWidget.common.back}
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
            aria-label={t.helpdeskWidget.common.close}
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
                  { id: 'home', icon: Home, label: t.helpdeskWidget.nav.home, onClick: onNavigateHome },
                  { id: 'messages', icon: MessageSquare, label: t.helpdeskWidget.nav.chat, onClick: onNavigateMessages },
                  { id: 'help', icon: HelpCircle, label: t.helpdeskWidget.nav.help, onClick: () => setSelectedCollection(null) },
                  { id: 'status', icon: Activity, label: t.helpdeskWidget.nav.status, onClick: onNavigateStatus },
                  { id: 'changelog', icon: Sparkles, label: t.helpdeskWidget.nav.changelog, onClick: onNavigateChangelog },
                  { id: 'news', icon: Sparkles, label: t.helpdeskWidget.nav.news, onClick: onNavigateNews },
                  { id: 'appointments', icon: Calendar, label: t.helpdeskWidget.nav.book, onClick: onNavigateAppointments },
                  { id: 'announcements', icon: Megaphone, label: t.helpdeskWidget.nav.announce, onClick: onNavigateAnnouncements },
                  { id: 'events', icon: Calendar, label: t.helpdeskWidget.nav.events, onClick: onNavigateEvents },
                  { id: 'parcel-tracking', icon: Package, label: t.helpdeskWidget.nav.track, onClick: onNavigateParcelTracking }
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
          {t.helpdeskWidget.faq.title}
        </h2>
        <Button
          variant="ghost"
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-150"
          aria-label={t.helpdeskWidget.common.close}
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
            placeholder={t.helpdeskWidget.faq.searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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
                      {format(t.helpdeskWidget.faq.articleCount, { count: collection.articleCount })}
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
            {t.helpdeskWidget.faq.noResults}
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
                { id: 'home', icon: Home, label: t.helpdeskWidget.nav.home, onClick: onNavigateHome },
                { id: 'messages', icon: MessageSquare, label: t.helpdeskWidget.nav.chat, onClick: onNavigateMessages },
                { id: 'help', icon: HelpCircle, label: t.helpdeskWidget.nav.help, onClick: () => {} },
                { id: 'status', icon: Activity, label: t.helpdeskWidget.nav.status, onClick: onNavigateStatus },
                { id: 'changelog', icon: Sparkles, label: t.helpdeskWidget.nav.changelog, onClick: onNavigateChangelog },
                { id: 'news', icon: Sparkles, label: t.helpdeskWidget.nav.news, onClick: onNavigateNews },
                { id: 'appointments', icon: Calendar, label: t.helpdeskWidget.nav.book, onClick: onNavigateAppointments },
                { id: 'announcements', icon: Megaphone, label: t.helpdeskWidget.nav.announce, onClick: onNavigateAnnouncements },
                { id: 'events', icon: Calendar, label: t.helpdeskWidget.nav.events, onClick: onNavigateEvents },
                { id: 'parcel-tracking', icon: Package, label: t.helpdeskWidget.nav.track, onClick: onNavigateParcelTracking }
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