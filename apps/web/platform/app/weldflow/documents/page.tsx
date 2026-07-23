
import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Eye,
  ImageIcon,
  X,
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
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Palette,
  Highlighter,
  ChevronDown,
  ChevronsUpDown,
  Check,
  FileText,
  Plus,
  MoreVertical,
  ChevronLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Command {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  action: () => void;
}

const fontFamilies = [
  { value: 'Arial', label: 'Arial' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Comic Sans MS', label: 'Comic Sans MS' },
  { value: 'Impact', label: 'Impact' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS' },
];

const fontSizes = [
  { value: '10', label: '10' },
  { value: '12', label: '12' },
  { value: '14', label: '14' },
  { value: '16', label: '16' },
  { value: '18', label: '18' },
  { value: '20', label: '20' },
  { value: '24', label: '24' },
  { value: '28', label: '28' },
  { value: '32', label: '32' },
  { value: '36', label: '36' },
];

export default function DocumentsPage() {
  const { t } = useI18n();
  const titleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [title, setTitle] = useState('Untitled');
  const [content, setContent] = useState('<p dir="ltr">Start writing...</p>');
  const [coverImage, setCoverImage] = useState<string | undefined>(undefined);
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
  const [fontFamily, setFontFamily] = useState('Arial');
  const [fontSize, setFontSize] = useState('16');
  const [fontFamilyOpen, setFontFamilyOpen] = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const [showTabs, setShowTabs] = useState(false);

  const [tabs, setTabs] = useState([
    { id: 1, name: t.projects.documentEditor.tabDefault.replace('{n}', '1'), active: false },
    { id: 2, name: t.projects.documentEditor.tabDefault.replace('{n}', '2'), active: true },
    { id: 3, name: t.projects.documentEditor.tabDefault.replace('{n}', '3'), active: false },
  ]);

  const handleTabClick = (tabId: number) => {
    setTabs(tabs.map(tab => ({
      ...tab,
      active: tab.id === tabId
    })));
  };

  const handleAddTab = () => {
    const newTabId = tabs.length + 1;
    setTabs([...tabs, {
      id: newTabId,
      name: t.projects.documentEditor.tabDefault.replace('{n}', String(newTabId)),
      active: false
    }]);
  };

  // Focus title on mount
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.focus();
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

  // Check active formats on selection change
  useEffect(() => {
    const handleSelectionChange = () => {
      checkActiveFormats();
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
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

  const checkActiveFormats = () => {
    const formats = new Set<string>();

    if (document.queryCommandState('bold')) formats.add('bold');
    if (document.queryCommandState('italic')) formats.add('italic');
    if (document.queryCommandState('underline')) formats.add('underline');
    if (document.queryCommandState('strikeThrough')) formats.add('strikethrough');
    if (document.queryCommandState('insertUnorderedList')) formats.add('bulletList');
    if (document.queryCommandState('insertOrderedList')) formats.add('numberedList');
    if (document.queryCommandState('justifyLeft')) formats.add('alignLeft');
    if (document.queryCommandState('justifyCenter')) formats.add('alignCenter');
    if (document.queryCommandState('justifyRight')) formats.add('alignRight');
    if (document.queryCommandState('justifyFull')) formats.add('alignJustify');

    setActiveFormats(formats);
  };

  const handleContentInput = (e: React.FormEvent<HTMLDivElement>) => {
    const element = e.currentTarget;

    const paragraphs = element.querySelectorAll('p');
    paragraphs.forEach((p) => {
      if (!p.hasAttribute('dir')) {
        p.setAttribute('dir', 'ltr');
      }
    });

    setContent(element.innerHTML);
    checkActiveFormats();

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

  const handleContentPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // Let the browser handle non-text payloads (e.g. pasted images) natively.
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;

    e.preventDefault();

    // Insert as plain text at the caret rather than letting the browser drop in
    // its rich clipboard HTML (nested <div>/<span> from other apps). That nested
    // markup left the DOM caret detached from the visible cursor, so pressing
    // Enter afterwards split the *previous* paragraph instead of starting a new
    // one. insertText keeps the editor's flat <p> model intact and leaves the
    // caret at the end of the pasted text.
    document.execCommand('insertText', false, text);
  };

  const handleContentKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
    }

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

  const handleCoverImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        alert(t.projects.documentEditor.imageTypeError);
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        alert(t.projects.documentEditor.imageSizeError);
        return;
      }

      const imageUrl = URL.createObjectURL(file);
      setCoverImage(imageUrl);
    }
  };

  const handleAddCoverClick = () => {
    coverImageInputRef.current?.click();
  };

  const formatText = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    contentRef.current?.focus();
    checkActiveFormats();
  };

  const changeFontFamily = (font: string) => {
    setFontFamily(font);
    document.execCommand('fontName', false, font);
    contentRef.current?.focus();
  };

  const changeFontSize = (size: string) => {
    setFontSize(size);
    document.execCommand('fontSize', false, '7');
    // Wrap the selection in a span with custom font size
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const span = document.createElement('span');
      span.style.fontSize = size + 'px';
      try {
        range.surroundContents(span);
      } catch (e) {
        // If surroundContents fails, just apply the command
      }
    }
    contentRef.current?.focus();
  };

  const changeTextColor = (color: string) => {
    document.execCommand('foreColor', false, color);
    contentRef.current?.focus();
  };

  const changeBackgroundColor = (color: string) => {
    document.execCommand('hiliteColor', false, color);
    contentRef.current?.focus();
  };

  const insertBlock = (tagName: string, attributes: Record<string, string> = {}) => {
    const selection = window.getSelection();
    if (!selection || !contentRef.current) return;

    const range = selection.getRangeAt(0);

    let parentNode = range.commonAncestorContainer;
    if (parentNode.nodeType === Node.TEXT_NODE) {
      parentNode = parentNode.parentElement!;
    }
    const parentElement = parentNode as Element;

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

    if (tagName === 'ul' || tagName === 'ol') {
      const list = document.createElement(tagName);
      list.setAttribute('dir', 'ltr');

      const listItem = document.createElement('li');
      listItem.setAttribute('dir', 'ltr');
      listItem.textContent = '\u200B';
      list.appendChild(listItem);

      if (parentElement.tagName === 'P' || parentElement.tagName === 'DIV') {
        parentElement.parentNode?.insertBefore(list, parentElement.nextSibling);
        if (!parentElement.textContent?.trim()) {
          parentElement.remove();
        }
      } else {
        parentElement.appendChild(list);
      }

      const newRange = document.createRange();
      newRange.setStart(listItem, 0);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    } else {
      const newElement = document.createElement(tagName);
      Object.entries(attributes).forEach(([key, value]) => {
        newElement.setAttribute(key, value);
      });
      newElement.setAttribute('dir', 'ltr');
      newElement.innerHTML = '<br>';

      range.insertNode(newElement);

      const newRange = document.createRange();
      newRange.setStart(newElement, 0);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

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

    const link = document.createElement('a');
    link.href = linkUrl;
    link.textContent = linkText || linkUrl;
    link.setAttribute('dir', 'ltr');
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.className = 'text-primary underline hover:text-primary/80';

    range.deleteContents();
    range.insertNode(link);

    const newRange = document.createRange();
    newRange.setStartAfter(link);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);

    setContent(contentRef.current.innerHTML);
    setShowLinkDialog(false);
    setLinkUrl('');
    setLinkText('');
  };

  const commands: Command[] = [
    {
      id: 'text',
      label: t.projects.documentEditor.commands.text,
      description: t.projects.documentEditor.commands.textDesc,
      icon: <Type className="h-4 w-4" />,
      action: () => insertBlock('p'),
    },
    {
      id: 'heading1',
      label: t.projects.documentEditor.commands.heading1,
      description: t.projects.documentEditor.commands.heading1Desc,
      icon: <Heading1 className="h-4 w-4" />,
      action: () => insertBlock('h1'),
    },
    {
      id: 'heading2',
      label: t.projects.documentEditor.commands.heading2,
      description: t.projects.documentEditor.commands.heading2Desc,
      icon: <Heading2 className="h-4 w-4" />,
      action: () => insertBlock('h2'),
    },
    {
      id: 'heading3',
      label: t.projects.documentEditor.commands.heading3,
      description: t.projects.documentEditor.commands.heading3Desc,
      icon: <Heading3 className="h-4 w-4" />,
      action: () => insertBlock('h3'),
    },
    {
      id: 'bulletlist',
      label: t.projects.documentEditor.commands.bulletedList,
      description: t.projects.documentEditor.commands.bulletedListDesc,
      icon: <List className="h-4 w-4" />,
      action: () => insertBlock('ul'),
    },
    {
      id: 'numberedlist',
      label: t.projects.documentEditor.commands.numberedList,
      description: t.projects.documentEditor.commands.numberedListDesc,
      icon: <ListOrdered className="h-4 w-4" />,
      action: () => insertBlock('ol'),
    },
    {
      id: 'quote',
      label: t.projects.documentEditor.commands.quote,
      description: t.projects.documentEditor.commands.quoteDesc,
      icon: <Quote className="h-4 w-4" />,
      action: () => insertBlock('blockquote'),
    },
    {
      id: 'code',
      label: t.projects.documentEditor.commands.code,
      description: t.projects.documentEditor.commands.codeDesc,
      icon: <Code className="h-4 w-4" />,
      action: () => insertBlock('pre'),
    },
    {
      id: 'divider',
      label: t.projects.documentEditor.commands.divider,
      description: t.projects.documentEditor.commands.dividerDesc,
      icon: <Minus className="h-4 w-4" />,
      action: () => insertBlock('hr'),
    },
    {
      id: 'link',
      label: t.projects.documentEditor.commands.link,
      description: t.projects.documentEditor.commands.linkDesc,
      icon: <LinkIcon className="h-4 w-4" />,
      action: () => openLinkDialog(),
    },
  ];

  const filteredCommands = commands.filter(cmd =>
    cmd.label.toLowerCase().includes(commandFilter.toLowerCase()) ||
    cmd.description.toLowerCase().includes(commandFilter.toLowerCase())
  );

  return (
    <div className="-m-6 min-h-screen bg-background relative" style={{ borderLeft: '1px solid hsl(var(--border))' }}>
      {/* Left Aligned Toolbar */}
      <div className="border-b bg-background mt-1" style={{ minHeight: '44px', padding: '6px 0 9px 24px' }}>
          <div className="flex items-center gap-1 flex-wrap">
            {/* Font Family */}
            <Popover open={fontFamilyOpen} onOpenChange={setFontFamilyOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={fontFamilyOpen}
                  className="h-8 w-40 justify-between text-xs shadow-none"
                >
                  {fontFamily
                    ? fontFamilies.find((font) => font.value === fontFamily)?.label
                    : t.projects.documentEditor.selectFont}
                  <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-40 p-0">
                <Command>
                  <CommandInput placeholder={t.projects.documentEditor.searchFont} className="h-9" />
                  <CommandList>
                    <CommandEmpty>{t.projects.documentEditor.noFontFound}</CommandEmpty>
                    <CommandGroup>
                      {fontFamilies.map((font) => (
                        <CommandItem
                          key={font.value}
                          value={font.value}
                          onSelect={(currentValue) => {
                            changeFontFamily(currentValue === fontFamily ? "" : currentValue);
                            setFontFamilyOpen(false);
                          }}
                        >
                          {font.label}
                          <Check
                            className={cn(
                              "ml-auto h-4 w-4",
                              fontFamily === font.value ? "opacity-100" : "opacity-0"
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {/* Font Size */}
            <Popover open={fontSizeOpen} onOpenChange={setFontSizeOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={fontSizeOpen}
                  className="h-8 w-20 justify-between text-xs shadow-none"
                >
                  {fontSize
                    ? fontSizes.find((size) => size.value === fontSize)?.label
                    : t.projects.documentEditor.size}
                  <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-20 p-0">
                <Command>
                  <CommandList className="scrollbar-thin scrollbar-thumb-transparent hover:scrollbar-thumb-gray-300">
                    <CommandEmpty>{t.projects.documentEditor.noSizeFound}</CommandEmpty>
                    <CommandGroup>
                      {fontSizes.map((size) => (
                        <CommandItem
                          key={size.value}
                          value={size.value}
                          onSelect={(currentValue) => {
                            changeFontSize(currentValue === fontSize ? "" : currentValue);
                            setFontSizeOpen(false);
                          }}
                        >
                          {size.label}
                          <Check
                            className={cn(
                              "ml-auto h-4 w-4",
                              fontSize === size.value ? "opacity-100" : "opacity-0"
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Text Formatting */}
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('bold') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('bold')}
              title="Bold (Ctrl+B)"
            >
              <Bold className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('italic') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('italic')}
              title="Italic (Ctrl+I)"
            >
              <Italic className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('underline') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('underline')}
              title="Underline (Ctrl+U)"
            >
              <Underline className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('strikethrough') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('strikeThrough')}
              title="Strikethrough"
            >
              <Strikethrough className="h-3.5 w-3.5" />
            </Button>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Text Color */}
            <Button
              variant="ghost"
              size="sm"
              className="p-0"
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => changeTextColor('#000000')}
              title="Text Color"
            >
              <Palette className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="p-0"
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => changeBackgroundColor('#ffff00')}
              title="Highlight Color"
            >
              <Highlighter className="h-3.5 w-3.5" />
            </Button>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Alignment */}
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('alignLeft') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('justifyLeft')}
              title="Align Left"
            >
              <AlignLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('alignCenter') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('justifyCenter')}
              title="Align Center"
            >
              <AlignCenter className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('alignRight') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('justifyRight')}
              title="Align Right"
            >
              <AlignRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('alignJustify') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('justifyFull')}
              title="Justify"
            >
              <AlignJustify className="h-3.5 w-3.5" />
            </Button>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Lists */}
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('bulletList') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('insertUnorderedList')}
              title="Bullet List"
            >
              <List className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("p-0", activeFormats.has('numberedList') && "bg-muted")}
              style={{ height: '28px', width: '28px', minHeight: '28px' }}
              onClick={() => formatText('insertOrderedList')}
              title="Numbered List"
            >
              <ListOrdered className="h-3.5 w-3.5" />
            </Button>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Link */}
            <Button
              variant="ghost"
              size="sm"
              style={{ height: '28px', paddingLeft: '10px', paddingRight: '10px', minHeight: '28px' }}
              onClick={() => openLinkDialog()}
              title={t.projects.documentEditor.insertLink}
            >
              <LinkIcon className="h-3.5 w-3.5 mr-1" />
              {t.projects.documentEditor.link}
            </Button>
          </div>
        </div>

      {/* Document Tabs Section */}
      <div className="absolute" style={{ top: '70px', left: '24px', zIndex: 5 }}>
        {!showTabs ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-sm hover:bg-muted"
            title={t.projects.documentEditor.documentTabs}
            onClick={() => setShowTabs(true)}
          >
            <FileText className="h-5 w-5" />
          </Button>
        ) : (
          <div className="w-48">
            <div className="flex items-center gap-2 mb-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowTabs(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-medium">{t.projects.documentEditor.documentTabs}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 ml-auto"
                title={t.projects.documentEditor.addNewTab}
                onClick={handleAddTab}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-1">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm",
                    tab.active ? "bg-blue-50 hover:bg-blue-100" : "hover:bg-muted"
                  )}
                  onClick={() => handleTabClick(tab.id)}
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="flex-1 truncate">{tab.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Editor Content */}
      <div className="mx-auto max-w-[900px] px-24 py-16">
        {/* Cover Image Section */}
        {coverImage && (
          <div className="relative mb-12 -mx-24 group">
            <img src={coverImage} alt="Cover" className="w-full h-[40vh] object-cover rounded-lg" />
            <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleAddCoverClick}
              >
                <ImageIcon className="h-4 w-4 mr-0.5" />
                {t.projects.documentEditor.changeCover}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCoverImage(undefined)}
              >
                <X className="h-4 w-4 mr-0.5" />
                {t.projects.documentEditor.removeCover}
              </Button>
            </div>
          </div>
        )}

        <input
          ref={coverImageInputRef}
          type="file"
          accept="image/*"
          onChange={handleCoverImageUpload}
          className="hidden"
        />

        {/* Title */}
        <div
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleTitleInput}
          onKeyDown={handleTitleKeyDown}
          dir="ltr"
          className={cn(
            "text-4xl font-bold outline-none mb-4 leading-[1.2]",
            !title && "text-muted-foreground/40"
          )}
          data-placeholder={t.projects.documentEditor.titlePlaceholder}
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
            onPaste={handleContentPaste}
            dir="ltr"
            className={cn(
              "text-base outline-none min-h-[400px] leading-relaxed",
              "[&>p]:mb-2 [&>p]:min-h-[1.5em]",
              "[&_br]:block [&_br]:content-[''] [&_br]:my-0",
              "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40"
            )}
            data-placeholder={t.projects.documentEditor.contentPlaceholder}
            style={{
              caretColor: 'currentColor',
              direction: 'ltr',
              unicodeBidi: 'normal',
              textAlign: 'left',
              // Break long unbroken words/URLs so they wrap inside the page
              // instead of overflowing past the right edge and getting clipped.
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
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

      {/* Link Dialog */}
      {showLinkDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in-0">
          <div className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 animate-in zoom-in-95">
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">{t.projects.documentEditor.insertLink}</h3>
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
                  <label className="text-sm font-medium">{t.projects.documentEditor.linkText}</label>
                  <Input
                    value={linkText}
                    onChange={(e) => setLinkText(e.target.value)}
                    placeholder={t.projects.documentEditor.linkTextPlaceholder}
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
                  <label className="text-sm font-medium">{t.projects.documentEditor.urlLabel}</label>
                  <Input
                    ref={linkInputRef}
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder="https://example.com"
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
                  {t.projects.documentEditor.cancel}
                </Button>
                <Button onClick={insertLink} disabled={!linkUrl}>
                  {t.projects.documentEditor.insertLinkAction}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Custom Styles for contenteditable */}
      <style jsx global>{`
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
