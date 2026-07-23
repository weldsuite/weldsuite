
import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { useRouter } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { format } from 'date-fns';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Calendar as CalendarComponent } from '@weldsuite/ui/components/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  ArrowLeft,
  EllipsisVertical,
  Eye,
  Trash2,
  Copy,
  Calendar as CalendarIcon,
  User,
  Tag as TagIcon,
  Image as ImageIcon,
  Star,
  StarOff,
  X,
  Plus,
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Minus,
  Link as LinkIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface Command {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  action: () => void;
}

interface AnnouncementEditorClientProps {
  announcementId: string;
}

export function AnnouncementEditorClient({ announcementId }: AnnouncementEditorClientProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const ta = t.helpdesk.announcements;
  const router = useRouter();
  const titleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: t.helpdesk.announcements.title, href: '/welddesk/announcements' },
    { label: t.helpdesk.announcements.editAnnouncement },
  ]);

  // Mock data - in real app, fetch from API based on announcementId
  const [title, setTitle] = useState('System Maintenance Scheduled for Next Week');
  const [excerpt, setExcerpt] = useState('We will be performing scheduled system maintenance next week to improve performance and add new features.');
  const [content, setContent] = useState('<p dir="ltr">Full announcement content here...</p><p dir="ltr"><br></p><p dir="ltr">This is where you can write your announcement content. The editor provides a clean, distraction-free writing experience similar to Notion.</p><p dir="ltr"><br></p><p dir="ltr">You can write multiple paragraphs, and the content will automatically expand as you type.</p>');
  const [author, setAuthor] = useState('Sarah Williams');
  const [category, setCategory] = useState<string>('company');
  const [status, setStatus] = useState<string>('published');
  const [publishDate, setPublishDate] = useState(new Date('2024-01-20'));
  const [featured, setFeatured] = useState(true);
  const [tags, setTags] = useState(['milestone', 'growth', 'users']);
  const [newTag, setNewTag] = useState('');
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [coverImage, setCoverImage] = useState<string | undefined>(undefined);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandMenuPosition, setCommandMenuPosition] = useState({ top: 0, left: 0 });
  const [commandFilter, setCommandFilter] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const linkInputRef = useRef<HTMLInputElement>(null);
  const coverImageInputRef = useRef<HTMLInputElement>(null);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<Date | undefined>(publishDate);
  const [dateInputValue, setDateInputValue] = useState(format(publishDate, 'MMMM d, yyyy'));

  // Focus title on mount
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.focus();
      // Set initial title content
      if (title && titleRef.current.textContent !== title) {
        titleRef.current.textContent = title;
      }
    }
  }, []);

  // Initialize content on mount only
  useEffect(() => {
    if (contentRef.current && !contentRef.current.innerHTML) {
      contentRef.current.innerHTML = content;
      const paragraphs = contentRef.current.querySelectorAll('p');
      paragraphs.forEach((p) => {
        p.setAttribute('dir', 'ltr');
      });
    }
  }, []);

  const handleTitleInput = (e: React.FormEvent<HTMLDivElement>) => {
    const text = e.currentTarget.textContent || '';
    setTitle(text);
  };

  const handleTitleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (contentRef.current) {
        contentRef.current.focus();
      }
    }
  };

  const handleContentInput = (e: React.FormEvent<HTMLDivElement>) => {
    const element = e.currentTarget;

    // Ensure all paragraphs have dir="ltr"
    const paragraphs = element.querySelectorAll('p');
    paragraphs.forEach((p) => {
      if (!p.hasAttribute('dir')) {
        p.setAttribute('dir', 'ltr');
      }
    });

    // Update content state
    setContent(element.innerHTML);

    // Track command filter when menu is open
    if (showCommandMenu) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const textNode = range.startContainer;

        if (textNode.nodeType === Node.TEXT_NODE && textNode.textContent) {
          const text = textNode.textContent;
          const cursorPos = range.startOffset;
          const slashIndex = text.lastIndexOf('/', cursorPos);

          if (slashIndex >= 0) {
            const filter = text.substring(slashIndex + 1, cursorPos);
            setCommandFilter(filter);
            setSelectedCommandIndex(0);
          } else {
            setShowCommandMenu(false);
            setCommandFilter('');
          }
        }
      }
    }
  };

  const handleContentKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Ensure the current element has proper direction
    const selection = window.getSelection();
    if (selection && selection.anchorNode) {
      let element = selection.anchorNode as HTMLElement;
      if (element.nodeType === Node.TEXT_NODE) {
        element = element.parentElement as HTMLElement;
      }
      if (element && element.tagName === 'P') {
        element.setAttribute('dir', 'ltr');
        element.style.direction = 'ltr';
      }

      // Handle backspace in list items
      if (e.key === 'Backspace' && element.tagName === 'LI') {
        const range = selection.getRangeAt(0);
        const listItem = element;

        // Check if cursor is at the very start of the list item
        if (range.collapsed && range.startOffset === 0) {
          // Check if we're at the start of the first text node or the list item itself
          const isAtStart = range.startContainer === listItem ||
                           (range.startContainer === listItem.firstChild &&
                            range.startContainer.nodeType === Node.TEXT_NODE);

          if (isAtStart) {
            const list = listItem.parentElement;

            if (list && (list.tagName === 'UL' || list.tagName === 'OL')) {
              e.preventDefault();

              // Get the HTML content of the list item
              const content = listItem.innerHTML.replace(/^\u200B/, '').trim() || '';

              // Create a paragraph with the list item content
              const paragraph = document.createElement('p');
              paragraph.setAttribute('dir', 'ltr');

              if (content) {
                paragraph.innerHTML = content;
              } else {
                paragraph.appendChild(document.createTextNode('\u200B'));
              }

              // Get the position where we need to insert
              const nextSibling = list.nextSibling;
              const parentNode = list.parentNode;

              // Remove the list item first
              listItem.remove();

              // Check if list still has items
              if (list.children.length === 0) {
                // List is empty, replace it with the paragraph
                parentNode?.replaceChild(paragraph, list);
              } else {
                // List still has items, insert paragraph after it
                if (nextSibling) {
                  parentNode?.insertBefore(paragraph, nextSibling);
                } else {
                  parentNode?.appendChild(paragraph);
                }
              }

              // Set cursor at the start of the new paragraph
              setTimeout(() => {
                const newRange = document.createRange();
                const firstNode = paragraph.childNodes[0];

                if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
                  newRange.setStart(firstNode, 0);
                } else if (firstNode) {
                  newRange.setStart(firstNode, 0);
                } else {
                  newRange.setStart(paragraph, 0);
                }

                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                // Update content
                if (contentRef.current) {
                  setContent(contentRef.current.innerHTML);
                }
              }, 0);
            }
          }
        }
      }
    }

    // Handle command menu navigation
    if (showCommandMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCommandIndex((prev) =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCommandIndex((prev) =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredCommands[selectedCommandIndex]) {
          filteredCommands[selectedCommandIndex].action();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowCommandMenu(false);
        setCommandFilter('');
      }
    } else if (e.key === '/') {
      // Show command menu when / is typed
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          const editorRect = contentRef.current?.getBoundingClientRect();

          if (editorRect) {
            setCommandMenuPosition({
              top: rect.bottom - editorRect.top + 5,
              left: rect.left - editorRect.left,
            });
          }
          setShowCommandMenu(true);
          setCommandFilter('');
          setSelectedCommandIndex(0);
        }
      }, 0);
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
  };

  const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && newTag.trim()) {
      e.preventDefault();
      const tagValue = newTag.trim().toLowerCase();
      if (!tags.includes(tagValue)) {
        setTags([...tags, tagValue]);
      }
      setNewTag('');
      setIsAddingTag(false);
    } else if (e.key === 'Escape') {
      setNewTag('');
      setIsAddingTag(false);
    }
  };

  const handleCoverImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Check if file is an image
      if (!file.type.startsWith('image/')) {
        alert(ta.selectImageOnly);
        return;
      }

      // Check file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        alert(ta.imageSizeLimit);
        return;
      }

      // Create a local URL for the image
      const imageUrl = URL.createObjectURL(file);
      setCoverImage(imageUrl);
    }
  };

  const handleAddCoverClick = () => {
    coverImageInputRef.current?.click();
  };

  const insertBlock = (tagName: string, attributes: Record<string, string> = {}) => {
    const selection = window.getSelection();
    if (!selection || !contentRef.current) return;

    const range = selection.getRangeAt(0);

    // Get the parent element where we'll insert
    let parentElement = range.commonAncestorContainer;
    if (parentElement.nodeType === Node.TEXT_NODE) {
      parentElement = parentElement.parentElement!;
    }

    // Delete the slash command text
    const textNode = range.startContainer;
    if (textNode.nodeType === Node.TEXT_NODE && textNode.textContent) {
      const text = textNode.textContent;
      const slashIndex = text.lastIndexOf('/', range.startOffset);
      if (slashIndex >= 0) {
        const newRange = document.createRange();
        newRange.setStart(textNode, slashIndex);
        newRange.setEnd(textNode, range.startOffset);
        newRange.deleteContents();
      }
    }

    // For lists, we need special handling
    if (tagName === 'ul' || tagName === 'ol') {
      // Create the list
      const list = document.createElement(tagName);
      list.setAttribute('dir', 'ltr');

      // Create first list item
      const listItem = document.createElement('li');
      listItem.setAttribute('dir', 'ltr');
      listItem.textContent = '\u200B'; // Zero-width space to make it editable
      list.appendChild(listItem);

      // Insert after the current paragraph
      if (parentElement.tagName === 'P' || parentElement.tagName === 'DIV') {
        parentElement.parentNode?.insertBefore(list, parentElement.nextSibling);
        // Remove the paragraph if it's empty
        if (!parentElement.textContent?.trim()) {
          parentElement.remove();
        }
      } else {
        parentElement.appendChild(list);
      }

      // Set cursor inside the list item
      const newRange = document.createRange();
      newRange.setStart(listItem, 0);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    } else {
      // Create new element for non-list blocks
      const newElement = document.createElement(tagName);
      Object.entries(attributes).forEach(([key, value]) => {
        newElement.setAttribute(key, value);
      });
      newElement.setAttribute('dir', 'ltr');
      newElement.innerHTML = '<br>';

      // Insert the new element
      range.insertNode(newElement);

      // Move cursor into the new element
      const newRange = document.createRange();
      newRange.setStart(newElement, 0);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

    // Update content
    setContent(contentRef.current.innerHTML);
    setShowCommandMenu(false);
    setCommandFilter('');
  };

  const openLinkDialog = () => {
    const selection = window.getSelection();
    if (selection && selection.toString()) {
      setLinkText(selection.toString());
    }
    setShowCommandMenu(false);
    setCommandFilter('');
    setShowLinkDialog(true);
  };

  const insertLink = () => {
    if (!linkUrl || !contentRef.current) return;

    const selection = window.getSelection();
    if (!selection) return;

    const range = selection.getRangeAt(0);

    // Delete the slash command text if present
    const textNode = range.startContainer;
    if (textNode.nodeType === Node.TEXT_NODE && textNode.textContent) {
      const text = textNode.textContent;
      const slashIndex = text.lastIndexOf('/', range.startOffset);
      if (slashIndex >= 0) {
        const newRange = document.createRange();
        newRange.setStart(textNode, slashIndex);
        newRange.setEnd(textNode, range.startOffset);
        newRange.deleteContents();
      }
    }

    // Create link element
    const link = document.createElement('a');
    link.href = linkUrl;
    link.textContent = linkText || linkUrl;
    link.setAttribute('dir', 'ltr');
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.className = 'text-primary underline hover:text-primary/80';

    // Insert link
    range.deleteContents();
    range.insertNode(link);

    // Move cursor after the link
    const newRange = document.createRange();
    newRange.setStartAfter(link);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);

    // Update content
    setContent(contentRef.current.innerHTML);
    setShowLinkDialog(false);
    setLinkUrl('');
    setLinkText('');
  };

  const commands: Command[] = [
    {
      id: 'text',
      label: ta.cmdText,
      description: ta.cmdTextDesc,
      icon: <Type className="h-4 w-4" />,
      action: () => insertBlock('p'),
    },
    {
      id: 'heading1',
      label: ta.cmdHeading1,
      description: ta.cmdHeading1Desc,
      icon: <Heading1 className="h-4 w-4" />,
      action: () => insertBlock('h1'),
    },
    {
      id: 'heading2',
      label: ta.cmdHeading2,
      description: ta.cmdHeading2Desc,
      icon: <Heading2 className="h-4 w-4" />,
      action: () => insertBlock('h2'),
    },
    {
      id: 'heading3',
      label: ta.cmdHeading3,
      description: ta.cmdHeading3Desc,
      icon: <Heading3 className="h-4 w-4" />,
      action: () => insertBlock('h3'),
    },
    {
      id: 'bulletlist',
      label: ta.cmdBulletedList,
      description: ta.cmdBulletedListDesc,
      icon: <List className="h-4 w-4" />,
      action: () => insertBlock('ul'),
    },
    {
      id: 'numberedlist',
      label: ta.cmdNumberedList,
      description: ta.cmdNumberedListDesc,
      icon: <ListOrdered className="h-4 w-4" />,
      action: () => insertBlock('ol'),
    },
    {
      id: 'quote',
      label: ta.cmdQuote,
      description: ta.cmdQuoteDesc,
      icon: <Quote className="h-4 w-4" />,
      action: () => insertBlock('blockquote'),
    },
    {
      id: 'code',
      label: ta.cmdCode,
      description: ta.cmdCodeDesc,
      icon: <Code className="h-4 w-4" />,
      action: () => insertBlock('pre'),
    },
    {
      id: 'divider',
      label: ta.cmdDivider,
      description: ta.cmdDividerDesc,
      icon: <Minus className="h-4 w-4" />,
      action: () => insertBlock('hr'),
    },
    {
      id: 'link',
      label: ta.cmdLink,
      description: ta.cmdLinkDesc,
      icon: <LinkIcon className="h-4 w-4" />,
      action: () => openLinkDialog(),
    },
  ];

  const filteredCommands = commands.filter(cmd =>
    cmd.label.toLowerCase().includes(commandFilter.toLowerCase()) ||
    cmd.description.toLowerCase().includes(commandFilter.toLowerCase())
  );

  const getCategoryColor = (cat: string) => {
    switch (cat) {
      case 'company': return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-900';
      case 'product': return 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-900';
      case 'industry': return 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-400 dark:border-purple-900';
      case 'announcement': return 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-400 dark:border-yellow-900';
      default: return 'bg-gray-50 text-gray-700 border-gray-200 dark:bg-background dark:text-muted-foreground dark:border-background';
    }
  };

  const getStatusColor = (stat: string) => {
    switch (stat) {
      case 'published': return 'default';
      case 'draft': return 'secondary';
      case 'scheduled': return 'outline';
      default: return 'secondary';
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            {/* Empty space for alignment */}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm">
              <Eye className="h-4 w-4 mr-0.5" />
              {ta.preview}
            </Button>
            <Button size="sm">
              {ta.publish}
            </Button>
          </div>
        </div>
      </div>

      {/* Main Layout with Sidebar */}
      <div className="flex">
        {/* Editor Content */}
        <div className="flex-1 mx-auto max-w-[900px] px-24 py-16">
        {/* Cover Image Section */}
        {coverImage ? (
          <div className="relative mb-12 -mx-24 group">
            <img src={coverImage} alt={st('sweep.welddesk.announcementEditor.coverImageAlt')} className="w-full h-[40vh] object-cover rounded-lg" />
            <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleAddCoverClick}
              >
                <ImageIcon className="h-4 w-4 mr-0.5" />
                {ta.change}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCoverImage(undefined)}
              >
                <X className="h-4 w-4 mr-0.5" />
                {ta.remove}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <input
              ref={coverImageInputRef}
              type="file"
              accept="image/*"
              onChange={handleCoverImageUpload}
              className="hidden"
            />
            <Button
              variant="ghost"
              onClick={handleAddCoverClick}
              className="w-full mb-12 py-12 bg-muted/30 hover:bg-muted/60 transition-colors flex items-center justify-center gap-2 text-muted-foreground hover:text-foreground text-sm border border-dashed border-muted-foreground/20 hover:border-muted-foreground/40 rounded-lg"
            >
              <ImageIcon className="h-5 w-5" />
              <span>{ta.addCover}</span>
            </Button>
          </>
        )}

        {/* Title */}
        <div
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleTitleInput}
          onKeyDown={handleTitleKeyDown}
          dir="ltr"
          className={cn(
            "text-4xl font-bold outline-none mb-2 leading-[1.2]",
            !title && "text-muted-foreground/40"
          )}
          data-placeholder={ta.untitled}
          style={{
            caretColor: 'currentColor',
            direction: 'ltr',
            unicodeBidi: 'normal',
            textAlign: 'left',
          }}
        />


        {/* Content Editor */}
        <div className="relative">
          <div
            ref={contentRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleContentInput}
            onKeyDown={handleContentKeyDown}
            dir="ltr"
            className={cn(
              "text-base outline-none min-h-[400px] leading-relaxed",
              "[&>p]:mb-2 [&>p]:min-h-[1.5em]",
              "[&_br]:block [&_br]:content-[''] [&_br]:my-0",
              "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40"
            )}
            data-placeholder={ta.pressForCommands}
            style={{
              caretColor: 'currentColor',
              direction: 'ltr',
              unicodeBidi: 'normal',
              textAlign: 'left',
            }}
          />

          {/* Command Menu */}
          {showCommandMenu && filteredCommands.length > 0 && (
            <div
              ref={commandMenuRef}
              className="absolute z-50 w-72 bg-popover text-popover-foreground border border-border rounded-md shadow-md overflow-hidden animate-in fade-in-0 zoom-in-95"
              style={{
                top: `${commandMenuPosition.top}px`,
                left: `${commandMenuPosition.left}px`,
              }}
            >
              <div className="overflow-hidden p-1">
                <div className="overflow-y-auto max-h-[300px] overflow-x-hidden">
                  {filteredCommands.map((command, index) => (
                    <div
                      key={command.id}
                      onClick={() => command.action()}
                      className={cn(
                        "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors",
                        index === selectedCommandIndex
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent hover:text-accent-foreground"
                      )}
                      role="option"
                      aria-selected={index === selectedCommandIndex}
                    >
                      <div className="mr-0.5 h-4 w-4 shrink-0 opacity-70">
                        {command.icon}
                      </div>
                      <span className="flex-1 truncate">{command.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        </div>

        {/* Right Sidebar */}
        <div className="w-80 border-l border-gray-200 bg-white text-gray-900 flex flex-col">
          {/* Header */}
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">{ta.announcementSettings}</h3>
            </div>
          </div>

          {/* Content */}
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              {/* Author */}
              <div className="space-y-2">
                <Label className="text-xs">{ta.author}</Label>
                <Input
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder={ta.enterAuthorName}
                  className="text-sm"
                />
              </div>

              {/* Date */}
              <div className="flex items-center justify-between gap-4">
                <Label className="text-xs">{ta.date}</Label>
                <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
                  <PopoverTrigger asChild>
                    <div className="relative w-[180px]">
                      <Input
                        value={dateInputValue}
                        placeholder={ta.datePlaceholder}
                        className="text-sm pr-10 cursor-pointer"
                        readOnly
                        onClick={() => setIsCalendarOpen(true)}
                      />
                      <Button
                        variant="ghost"
                        className="absolute top-1/2 right-2 size-6 -translate-y-1/2 p-0 pointer-events-none"
                      >
                        <CalendarIcon className="h-3.5 w-3.5" />
                        <span className="sr-only">{ta.selectDate}</span>
                      </Button>
                    </div>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-auto overflow-hidden p-0"
                    align="end"
                    alignOffset={-8}
                    sideOffset={10}
                  >
                    <CalendarComponent
                      mode="single"
                      selected={publishDate}
                      captionLayout="dropdown"
                      month={calendarMonth}
                      onMonthChange={setCalendarMonth}
                      onSelect={(date) => {
                        if (date) {
                          setPublishDate(date);
                          setDateInputValue(format(date, 'MMMM d, yyyy'));
                          setIsCalendarOpen(false);
                        }
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Category */}
              <div className="flex items-center justify-between gap-4">
                <Label className="text-xs">{ta.category}</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="text-sm w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="company">🏢 {ta.company}</SelectItem>
                    <SelectItem value="product">📦 {ta.product}</SelectItem>
                    <SelectItem value="industry">📊 {ta.industry}</SelectItem>
                    <SelectItem value="announcement">📢 {ta.categoryAnnouncement}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Status */}
              <div className="flex items-center justify-between gap-4">
                <Label className="text-xs">{ta.status}</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="text-sm w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">{ta.draft}</SelectItem>
                    <SelectItem value="published">{ta.published}</SelectItem>
                    <SelectItem value="scheduled">{ta.scheduled}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Link Dialog */}
      {showLinkDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in-0">
          <div className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 animate-in zoom-in-95">
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">{ta.insertLink}</h3>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    setShowLinkDialog(false);
                    setLinkUrl('');
                    setLinkText('');
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">{ta.linkText}</label>
                  <Input
                    value={linkText}
                    onChange={(e) => setLinkText(e.target.value)}
                    placeholder={ta.enterLinkText}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        insertLink();
                      } else if (e.key === 'Escape') {
                        setShowLinkDialog(false);
                        setLinkUrl('');
                        setLinkText('');
                      }
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">{ta.url}</label>
                  <Input
                    ref={linkInputRef}
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder={st('sweep.welddesk.announcementEditor.urlPlaceholder')}
                    type="url"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        insertLink();
                      } else if (e.key === 'Escape') {
                        setShowLinkDialog(false);
                        setLinkUrl('');
                        setLinkText('');
                      }
                    }}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowLinkDialog(false);
                    setLinkUrl('');
                    setLinkText('');
                  }}
                >
                  {ta.cancel}
                </Button>
                <Button onClick={insertLink} disabled={!linkUrl}>
                  {ta.insertLinkButton}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Custom Styles for contenteditable */}
      <style jsx global>{`
        /* Subtle scrollbar styles */
        * {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 0, 0, 0.1) transparent;
        }

        *::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }

        *::-webkit-scrollbar-track {
          background: transparent;
        }

        *::-webkit-scrollbar-thumb {
          background-color: rgba(0, 0, 0, 0.1);
          border-radius: 4px;
          border: 2px solid transparent;
        }

        *::-webkit-scrollbar-thumb:hover {
          background-color: rgba(0, 0, 0, 0.2);
        }

        /* Dark mode scrollbar */
        .dark *::-webkit-scrollbar-thumb {
          background-color: rgba(255, 255, 255, 0.1);
        }

        .dark *::-webkit-scrollbar-thumb:hover {
          background-color: rgba(255, 255, 255, 0.2);
        }

        .dark * {
          scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
        }

        [contenteditable]:focus {
          outline: none;
        }
        [contenteditable] p {
          margin: 0;
          padding: 3px 0;
          min-height: 1.5em;
          direction: ltr;
          unicode-bidi: normal;
          text-align: left;
        }
        [contenteditable] p:empty:before {
          content: '\\200B';
        }
        [contenteditable] h1 {
          font-size: 2em;
          font-weight: bold;
          margin: 0.67em 0;
          direction: ltr;
        }
        [contenteditable] h2 {
          font-size: 1.5em;
          font-weight: bold;
          margin: 0.75em 0;
          direction: ltr;
        }
        [contenteditable] h3 {
          font-size: 1.25em;
          font-weight: bold;
          margin: 0.83em 0;
          direction: ltr;
        }
        [contenteditable] blockquote {
          border-left: 3px solid currentColor;
          padding-left: 1em;
          margin: 1em 0;
          opacity: 0.8;
          direction: ltr;
        }
        [contenteditable] pre {
          background: rgba(0, 0, 0, 0.05);
          border-radius: 0.375rem;
          padding: 1em;
          margin: 1em 0;
          overflow-x: auto;
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 0.875em;
          direction: ltr;
        }
        [contenteditable] ul,
        [contenteditable] ol {
          margin: 0.5em 0;
          padding-left: 2em;
          direction: ltr;
          list-style-position: outside;
        }
        [contenteditable] ul {
          list-style-type: disc;
        }
        [contenteditable] ol {
          list-style-type: decimal;
        }
        [contenteditable] li {
          margin: 0.25em 0;
          direction: ltr;
          display: list-item;
        }
        [contenteditable] hr {
          border: none;
          border-top: 1px solid currentColor;
          opacity: 0.2;
          margin: 2em 0;
        }
        [contenteditable] a {
          color: hsl(var(--primary));
          text-decoration: underline;
          cursor: pointer;
          direction: ltr;
        }
        [contenteditable] a:hover {
          opacity: 0.8;
        }
      `}</style>
    </div>
  );
}
