
import { useState } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import {
  Search,
  Filter,
  Calendar,
  User,
  Tag,
  Paperclip,
  Star,
  ChevronDown,
  X,
  Mail,
  AlertCircle
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Calendar as CalendarComponent } from '@weldsuite/ui/components/calendar';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';

interface Email {
  id: string;
  from: string;
  subject: string;
  preview: string;
  date: Date;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  labels: string[];
}

interface SearchClientProps {
  initialEmails: Email[];
}

export function SearchClient({ initialEmails }: SearchClientProps) {
  const { t, plural } = useI18n();

  // Set breadcrumbs for Search
  useBreadcrumbs([
    { label: t.mail.inboxPage.mailBreadcrumb, href: '/weldmail' },
    { label: t.mail.search.title }
  ]);

  const [searchQuery, setSearchQuery] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dateRange, setDateRange] = useState<{ from?: Date; to?: Date }>({});
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [hasAttachment, setHasAttachment] = useState(false);
  const [isStarred, setIsStarred] = useState(false);
  const [isUnread, setIsUnread] = useState(false);
  const [sender, setSender] = useState('');
  const [searchResults, setSearchResults] = useState(initialEmails);

  const labels = ['Work', 'Personal', 'Finance', 'Travel', 'Shopping', 'Important'];

  const handleSearch = () => {
    // Filter sample emails based on search criteria
    const results = initialEmails.filter(email => {
      const matchesQuery = !searchQuery ||
        email.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
        email.from.toLowerCase().includes(searchQuery.toLowerCase()) ||
        email.preview.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesSender = !sender ||
        email.from.toLowerCase().includes(sender.toLowerCase());

      const matchesLabels = selectedLabels.length === 0 ||
        selectedLabels.some(label => email.labels.includes(label));

      const matchesAttachment = !hasAttachment || email.hasAttachments;
      const matchesStarred = !isStarred || email.isStarred;
      const matchesUnread = !isUnread || !email.isRead;

      return matchesQuery && matchesSender && matchesLabels &&
             matchesAttachment && matchesStarred && matchesUnread;
    });

    setSearchResults(results);
  };

  const toggleLabel = (label: string) => {
    setSelectedLabels(prev =>
      prev.includes(label)
        ? prev.filter(l => l !== label)
        : [...prev, label]
    );
  };

  const clearFilters = () => {
    setSearchQuery('');
    setDateRange({});
    setSelectedLabels([]);
    setHasAttachment(false);
    setIsStarred(false);
    setIsUnread(false);
    setSender('');
    setSearchResults(initialEmails);
    setShowAdvanced(false);
  };

  const formatEmailDate = (date: Date) => {
    return format(new Date(date), 'MMM d, yyyy');
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Search Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-4">{t.mail.search.searchHeader}</h1>

        {/* Main Search Bar */}
        <div className="flex gap-2 mb-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t.mail.search.searchAllMail}
              className="pl-9 pr-10"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2"
              >
                <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
              </Button>
            )}
          </div>
          <Button onClick={handleSearch}>
            <Search className="h-4 w-4 mr-0.5" />
            {t.mail.search.title}
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <Filter className="h-4 w-4 mr-0.5" />
            {t.mail.search.advanced}
            <ChevronDown className={cn(
              "h-4 w-4 ml-2 transition-transform",
              showAdvanced && "rotate-180"
            )} />
          </Button>
        </div>

        {/* Advanced Filters */}
        {showAdvanced && (
          <Card className="mb-4">
            <CardContent className="pt-6 space-y-4">
              {/* Sender Filter */}
              <div>
                <Label className="text-sm mb-2">{t.mail.search.from}</Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t.mail.search.senderEmailOrName}
                    className="pl-9"
                    value={sender}
                    onChange={(e) => setSender(e.target.value)}
                  />
                </div>
              </div>

              {/* Date Range */}
              <div>
                <Label className="text-sm mb-2">{t.mail.search.dateRange}</Label>
                <div className="flex gap-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="flex-1 justify-start">
                        <Calendar className="h-4 w-4 mr-0.5" />
                        {dateRange.from ? format(dateRange.from, 'PP') : t.mail.search.fromDate}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarComponent
                        mode="single"
                        selected={dateRange.from}
                        onSelect={(date) => setDateRange(prev => ({ ...prev, from: date }))}
                      />
                    </PopoverContent>
                  </Popover>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="flex-1 justify-start">
                        <Calendar className="h-4 w-4 mr-0.5" />
                        {dateRange.to ? format(dateRange.to, 'PP') : t.mail.search.toDate}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarComponent
                        mode="single"
                        selected={dateRange.to}
                        onSelect={(date) => setDateRange(prev => ({ ...prev, to: date }))}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {/* Labels */}
              <div>
                <Label className="text-sm mb-2">{t.mail.search.labels}</Label>
                <div className="flex flex-wrap gap-2">
                  {labels.map(label => (
                    <Badge
                      key={label}
                      variant={selectedLabels.includes(label) ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => toggleLabel(label)}
                    >
                      <Tag className="h-3 w-3 mr-1" />
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Quick Filters */}
              <div>
                <Label className="text-sm mb-2">{t.mail.search.quickFilters}</Label>
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="attachment"
                      checked={hasAttachment}
                      onCheckedChange={(checked) => setHasAttachment(!!checked)}
                    />
                    <label
                      htmlFor="attachment"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      <Paperclip className="h-4 w-4 inline mr-2" />
                      {t.mail.search.hasAttachments}
                    </label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="starred"
                      checked={isStarred}
                      onCheckedChange={(checked) => setIsStarred(!!checked)}
                    />
                    <label
                      htmlFor="starred"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      <Star className="h-4 w-4 inline mr-2" />
                      {t.mail.search.starred}
                    </label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="unread"
                      checked={isUnread}
                      onCheckedChange={(checked) => setIsUnread(!!checked)}
                    />
                    <label
                      htmlFor="unread"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      <Mail className="h-4 w-4 inline mr-2" />
                      {t.mail.search.unread}
                    </label>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={clearFilters}>
                  {t.mail.search.clearFilters}
                </Button>
                <Button onClick={handleSearch}>
                  {t.mail.search.applyFilters}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Active Filters Display */}
        {(selectedLabels.length > 0 || hasAttachment || isStarred || isUnread || sender || dateRange.from || dateRange.to) && (
          <div className="flex flex-wrap gap-2 mb-4">
            {sender && (
              <Badge variant="secondary">
                {t.mail.search.fromBadge.replace('{value}', sender)}
                <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => setSender('')} />
              </Badge>
            )}
            {dateRange.from && (
              <Badge variant="secondary">
                {t.mail.search.fromBadge.replace('{value}', format(dateRange.from, 'PP'))}
                <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => setDateRange(prev => ({ ...prev, from: undefined }))} />
              </Badge>
            )}
            {dateRange.to && (
              <Badge variant="secondary">
                {t.mail.search.toBadge.replace('{value}', format(dateRange.to, 'PP'))}
                <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => setDateRange(prev => ({ ...prev, to: undefined }))} />
              </Badge>
            )}
            {selectedLabels.map(label => (
              <Badge key={label} variant="secondary">
                {label}
                <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => toggleLabel(label)} />
              </Badge>
            ))}
            {hasAttachment && (
              <Badge variant="secondary">
                {t.mail.search.hasAttachments}
                <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => setHasAttachment(false)} />
              </Badge>
            )}
            {isStarred && (
              <Badge variant="secondary">
                {t.mail.search.starred}
                <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => setIsStarred(false)} />
              </Badge>
            )}
            {isUnread && (
              <Badge variant="secondary">
                {t.mail.search.unread}
                <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => setIsUnread(false)} />
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Search Results */}
      <div>
        <div className="text-sm text-muted-foreground mb-4">
          {plural(searchResults.length, t.common.plurals.searchResults)}
        </div>

        {searchResults.length === 0 ? (
          <Card className="p-12">
            <div className="flex flex-col items-center justify-center text-muted-foreground">
              <AlertCircle className="h-12 w-12 mb-4" />
              <p className="text-lg font-medium">{t.mail.search.noResults}</p>
              <p className="text-sm mt-2">{t.mail.search.tryAdjusting}</p>
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {searchResults.map((email) => (
              <Card key={email.id} className="hover:bg-accent transition-colors cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback>{email.from[0]?.toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between mb-1">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-sm",
                              !email.isRead && "font-semibold"
                            )}>
                              {email.from}
                            </span>
                            {email.isStarred && (
                              <Star className="h-3 w-3 fill-yellow-400 text-yellow-400 dark:fill-yellow-300 dark:text-yellow-300" />
                            )}
                            {email.hasAttachments && (
                              <Paperclip className="h-3 w-3 text-muted-foreground" />
                            )}
                          </div>
                          <div className={cn(
                            "text-sm",
                            !email.isRead && "font-semibold"
                          )}>
                            {email.subject}
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatEmailDate(email.date)}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {email.preview}
                      </p>
                      {email.labels.length > 0 && (
                        <div className="flex gap-1 mt-2">
                          {email.labels.map((label) => (
                            <Badge key={label} variant="outline" className="text-xs">
                              {label}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
