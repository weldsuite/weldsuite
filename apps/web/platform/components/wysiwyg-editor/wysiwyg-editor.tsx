
import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
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
  ImageIcon,
  X,
  Loader2,
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
  ChevronsUpDown,
  Check,
  Undo2,
  Redo2,
  RemoveFormatting,
  Indent,
  Outdent,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface SlashCommand {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  action: () => void;
}

const fontFamilies = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Lato', label: 'Lato' },
  { value: 'Montserrat', label: 'Montserrat' },
  { value: 'Poppins', label: 'Poppins' },
  { value: 'Playfair Display', label: 'Playfair Display' },
  { value: 'Merriweather', label: 'Merriweather' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'Nunito', label: 'Nunito' },
];

const GOOGLE_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Open+Sans:wght@300;400;600;700&family=Lato:wght@300;400;700&family=Montserrat:wght@300;400;500;600;700&family=Poppins:wght@300;400;500;600;700&family=Playfair+Display:wght@400;500;600;700&family=Merriweather:wght@300;400;700&family=Source+Code+Pro:wght@300;400;500;700&family=Nunito:wght@300;400;600;700&display=swap';

const fontSizes = [
  { value: '12', label: '12' },
  { value: '14', label: '14' },
  { value: '16', label: '16' },
  { value: '18', label: '18' },
  { value: '20', label: '20' },
  { value: '24', label: '24' },
  { value: '28', label: '28' },
  { value: '32', label: '32' },
];

const textColors = [
  { value: '#000000', labelKey: 'sweep.shared.color.black' },
  { value: '#434343', labelKey: 'sweep.shared.color.darkGray' },
  { value: '#666666', labelKey: 'sweep.shared.color.gray' },
  { value: '#999999', labelKey: 'sweep.shared.color.lightGray' },
  { value: '#E03131', labelKey: 'sweep.shared.color.red' },
  { value: '#E8590C', labelKey: 'sweep.shared.color.orange' },
  { value: '#F08C00', labelKey: 'sweep.shared.color.amber' },
  { value: '#2F9E44', labelKey: 'sweep.shared.color.green' },
  { value: '#1971C2', labelKey: 'sweep.shared.color.blue' },
  { value: '#7048E8', labelKey: 'sweep.shared.color.purple' },
];

const highlightColors = [
  { value: '#FFFF00', labelKey: 'sweep.shared.color.yellow' },
  { value: '#FFC9C9', labelKey: 'sweep.shared.color.lightRed' },
  { value: '#FFD8A8', labelKey: 'sweep.shared.color.lightOrange' },
  { value: '#B2F2BB', labelKey: 'sweep.shared.color.lightGreen' },
  { value: '#A5D8FF', labelKey: 'sweep.shared.color.lightBlue' },
  { value: '#D0BFFF', labelKey: 'sweep.shared.color.lightPurple' },
  { value: '#FCC2D7', labelKey: 'sweep.shared.color.pink' },
  { value: '#99E9F2', labelKey: 'sweep.shared.color.cyan' },
  { value: '#FFFFFF', labelKey: 'sweep.shared.color.whiteRemove' },
];

export interface ToolbarProps {
  fontFamily: string;
  fontSize: string;
  fontFamilyOpen: boolean;
  fontSizeOpen: boolean;
  textColorOpen: boolean;
  highlightColorOpen: boolean;
  activeFormats: Set<string>;
  setFontFamilyOpen: (open: boolean) => void;
  setFontSizeOpen: (open: boolean) => void;
  setTextColorOpen: (open: boolean) => void;
  setHighlightColorOpen: (open: boolean) => void;
  saveSelection: () => void;
  changeFontFamily: (font: string) => void;
  changeFontSize: (size: string) => void;
  changeTextColor: (color: string) => void;
  changeBackgroundColor: (color: string) => void;
  formatText: (command: string, value?: string) => void;
  clearFormatting: () => void;
  openLinkDialog: () => void;
}

export interface WysiwygEditorProps {
  initialContent?: string;
  initialTitle?: string;
  showTitle?: boolean;
  showCoverImage?: boolean;
  coverImage?: string;
  titlePlaceholder?: string;
  contentPlaceholder?: string;
  editable?: boolean;
  onContentChange?: (html: string) => void;
  onTitleChange?: (title: string) => void;
  onCoverImageChange?: (url: string | undefined) => void;
  onCoverImageUpload?: (file: File) => Promise<string | undefined>;
  isUploadingCover?: boolean;
  contentRef?: React.RefObject<HTMLDivElement | null>;
  titleRef?: React.RefObject<HTMLDivElement | null>;
  renderToolbar?: (toolbarProps: ToolbarProps) => React.ReactNode;
  className?: string;
}

export function WysiwygEditor({
  initialContent = '',
  initialTitle = '',
  showTitle = true,
  showCoverImage = true,
  coverImage: externalCoverImage,
  titlePlaceholder,
  contentPlaceholder,
  editable = true,
  onContentChange,
  onTitleChange,
  onCoverImageChange,
  onCoverImageUpload,
  isUploadingCover = false,
  contentRef: externalContentRef,
  titleRef: externalTitleRef,
  renderToolbar,
  className,
}: WysiwygEditorProps) {
  const t = useTranslations();
  const resolvedTitlePlaceholder = titlePlaceholder ?? t('sweep.shared.untitled');
  const resolvedContentPlaceholder = contentPlaceholder ?? t('sweep.shared.pressSlashForCommands');
  const internalTitleRef = useRef<HTMLDivElement>(null);
  const internalContentRef = useRef<HTMLDivElement>(null);
  const titleRef = externalTitleRef || internalTitleRef;
  const contentRef = externalContentRef || internalContentRef;

  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [coverImage, setCoverImage] = useState<string | undefined>(externalCoverImage);
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
  const [fontFamily, setFontFamily] = useState('Inter');
  const [fontSize, setFontSize] = useState('16');
  const [fontFamilyOpen, setFontFamilyOpen] = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [textColorOpen, setTextColorOpen] = useState(false);
  const [highlightColorOpen, setHighlightColorOpen] = useState(false);
  const savedSelectionRef = useRef<Range | null>(null);
  const explicitFontRef = useRef<string | null>(null);
  const explicitFontSizeRef = useRef<string | null>(null);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const [showTitlePlaceholder, setShowTitlePlaceholder] = useState(!initialTitle);
  const [showContentPlaceholder, setShowContentPlaceholder] = useState(!initialContent);

  // Sync cover image from parent
  useEffect(() => {
    setCoverImage(externalCoverImage);
  }, [externalCoverImage]);

  // Save the editor selection before a toolbar popover steals focus
  const saveSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (contentRef.current?.contains(range.commonAncestorContainer)) {
        savedSelectionRef.current = range.cloneRange();
      }
    }
  }, [contentRef]);

  // Restore the saved selection back into the editor
  const restoreSelection = useCallback(() => {
    const range = savedSelectionRef.current;
    if (range && contentRef.current) {
      contentRef.current.focus();
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }, [contentRef]);

  // Load Google Fonts
  useEffect(() => {
    const id = 'wysiwyg-editor-google-fonts';
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = GOOGLE_FONTS_URL;
      document.head.appendChild(link);
    }
  }, []);

  // Focus title on mount
  useEffect(() => {
    if (titleRef.current && showTitle) {
      if (initialTitle) {
        titleRef.current.textContent = initialTitle;
      }
      titleRef.current.focus();
    }
  }, []);

  // Initialize content on mount only
  useEffect(() => {
    if (contentRef.current) {
      if (initialContent) {
        contentRef.current.innerHTML = initialContent;
        const allElements = contentRef.current.querySelectorAll('*');
        allElements.forEach((el) => {
          el.setAttribute('dir', 'ltr');
        });
      }
      contentRef.current.setAttribute('dir', 'ltr');
    }

    // MutationObserver to ensure all new elements have LTR direction
    if (contentRef.current) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as HTMLElement;
              el.setAttribute('dir', 'ltr');
            }
          });
        });
      });

      observer.observe(contentRef.current, {
        childList: true,
        subtree: true,
      });

      return () => observer.disconnect();
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

    // Detect font family and size at cursor position to sync toolbar
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && contentRef.current?.contains(selection.anchorNode)) {
      let node: Node | null = selection.anchorNode;
      if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
      let detectedFont = false;
      let detectedSize = false;
      while (node && node !== contentRef.current) {
        const el = node as HTMLElement;
        if (!detectedFont && el.style?.fontFamily) {
          const ff = el.style.fontFamily.split(',')[0].trim().replace(/['"]/g, '');
          if (fontFamilies.some(f => f.value === ff)) {
            setFontFamily(ff);
            detectedFont = true;
            if (explicitFontRef.current && ff !== explicitFontRef.current) {
              explicitFontRef.current = null;
            }
          }
        }
        if (!detectedSize && el.style?.fontSize) {
          const fs = parseInt(el.style.fontSize);
          if (fs && fontSizes.some(s => s.value === String(fs))) {
            setFontSize(String(fs));
            detectedSize = true;
            if (explicitFontSizeRef.current && String(fs) !== explicitFontSizeRef.current) {
              explicitFontSizeRef.current = null;
            }
          }
        }
        if (detectedFont && detectedSize) break;
        node = node.parentNode;
      }
    }

    setActiveFormats(formats);
  };

  const handleTitleInput = (e: React.FormEvent<HTMLDivElement>) => {
    const text = e.currentTarget.textContent || '';
    setTitle(text);
    setShowTitlePlaceholder(!text);
    onTitleChange?.(text);
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

    const paragraphs = element.querySelectorAll('p');
    paragraphs.forEach((p) => {
      if (!p.hasAttribute('dir')) {
        p.setAttribute('dir', 'ltr');
      }
    });

    const divs = element.querySelectorAll('div');
    divs.forEach((div) => {
      if (!div.hasAttribute('dir')) {
        div.setAttribute('dir', 'ltr');
      }
    });

    const htmlContent = element.innerHTML;
    const textContent = element.textContent || '';
    const hasContent = textContent.trim().length > 0;
    setShowContentPlaceholder(!hasContent);

    setContent(htmlContent);
    checkActiveFormats();
    onContentChange?.(htmlContent);

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
    // Enforce explicitly selected font/size when typing in a differently-styled context
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (explicitFontRef.current || explicitFontSizeRef.current)
    ) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.getRangeAt(0).collapsed) {
        let node: Node | null = sel.anchorNode;
        if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
        let cursorFont = '';
        let cursorSize = '';
        let walk: Node | null = node;
        while (walk && walk !== contentRef.current) {
          const el = walk as HTMLElement;
          if (!cursorFont && el.style?.fontFamily) {
            cursorFont = el.style.fontFamily.split(',')[0].trim().replace(/['"]/g, '');
          }
          if (!cursorSize && el.style?.fontSize) {
            cursorSize = parseInt(el.style.fontSize).toString();
          }
          if (cursorFont && cursorSize) break;
          walk = walk.parentNode;
        }

        const needsFont = explicitFontRef.current && cursorFont !== explicitFontRef.current;
        const needsSize = explicitFontSizeRef.current && cursorSize !== explicitFontSizeRef.current;

        if (needsFont || needsSize) {
          const range = sel.getRangeAt(0);
          const span = document.createElement('span');
          if (explicitFontRef.current) {
            span.style.fontFamily = `'${explicitFontRef.current}', sans-serif`;
          }
          if (explicitFontSizeRef.current) {
            span.style.fontSize = explicitFontSizeRef.current + 'px';
          }
          span.appendChild(document.createTextNode('\u200B'));
          range.insertNode(span);
          const newRange = document.createRange();
          newRange.setStart(span.firstChild!, 1);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
      }
    }

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

  const handleCoverImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      return;
    }

    if (onCoverImageUpload) {
      const url = await onCoverImageUpload(file);
      if (url) {
        setCoverImage(url);
        onCoverImageChange?.(url);
      }
    } else {
      // Fallback: use object URL
      const imageUrl = URL.createObjectURL(file);
      setCoverImage(imageUrl);
      onCoverImageChange?.(imageUrl);
    }
  };

  const handleAddCoverClick = () => {
    coverImageInputRef.current?.click();
  };

  const handleRemoveCover = () => {
    setCoverImage(undefined);
    onCoverImageChange?.(undefined);
  };

  const formatText = useCallback((command: string, value?: string) => {
    const isListCommand = command === 'insertUnorderedList' || command === 'insertOrderedList';

    let currentAlign = '';
    if (isListCommand) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        let node: Node | null = selection.anchorNode;
        if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
        while (node && node !== contentRef.current) {
          const el = node as HTMLElement;
          if (el.style?.textAlign) {
            currentAlign = el.style.textAlign;
            break;
          }
          node = node.parentNode;
        }
      }
    }

    document.execCommand(command, false, value);

    if (isListCommand && currentAlign && currentAlign !== 'left') {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        let node: Node | null = selection.anchorNode;
        if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
        while (node && node !== contentRef.current) {
          const el = node as HTMLElement;
          const tag = el.tagName;
          if (tag === 'UL' || tag === 'OL') {
            el.style.textAlign = currentAlign;
            el.style.listStylePosition = 'inside';
            el.querySelectorAll('li').forEach((li) => {
              li.style.textAlign = currentAlign;
            });
            break;
          }
          if (tag === 'LI') {
            el.style.textAlign = currentAlign;
            const parentList = el.parentElement;
            if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
              parentList.style.textAlign = currentAlign;
              parentList.style.listStylePosition = 'inside';
            }
          }
          node = node.parentNode;
        }
      }
    }

    const isAlignCommand = command.startsWith('justify');
    if (isAlignCommand) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        let node: Node | null = selection.anchorNode;
        if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
        while (node && node !== contentRef.current) {
          const el = node as HTMLElement;
          if (el.tagName === 'UL' || el.tagName === 'OL') {
            const isNonLeft = command !== 'justifyLeft';
            el.style.listStylePosition = isNonLeft ? 'inside' : 'outside';
            break;
          }
          node = node.parentNode;
        }
      }
    }

    contentRef.current?.focus();
    checkActiveFormats();
  }, [contentRef]);

  const changeFontFamily = useCallback((font: string) => {
    setFontFamily(font);
    explicitFontRef.current = font;
    restoreSelection();
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (range.collapsed) {
        const span = document.createElement('span');
        span.style.fontFamily = `'${font}', sans-serif`;
        span.appendChild(document.createTextNode('\u200B'));
        range.insertNode(span);
        const newRange = document.createRange();
        newRange.setStart(span.firstChild!, 1);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      } else {
        document.execCommand('fontName', false, font);
        if (contentRef.current) {
          const fontElements = contentRef.current.querySelectorAll(`font[face="${font}"]`);
          fontElements.forEach((fontEl) => {
            const span = document.createElement('span');
            span.style.fontFamily = `'${font}', sans-serif`;
            span.innerHTML = fontEl.innerHTML;
            fontEl.parentNode?.replaceChild(span, fontEl);
          });
        }
      }
    }
    contentRef.current?.focus();
  }, [contentRef, restoreSelection]);

  const changeFontSize = useCallback((size: string) => {
    setFontSize(size);
    explicitFontSizeRef.current = size;
    restoreSelection();
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (range.collapsed) {
        const span = document.createElement('span');
        span.style.fontSize = size + 'px';
        span.appendChild(document.createTextNode('\u200B'));
        range.insertNode(span);
        const newRange = document.createRange();
        newRange.setStart(span.firstChild!, 1);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      } else {
        document.execCommand('fontSize', false, '7');
        if (contentRef.current) {
          const fontElements = contentRef.current.querySelectorAll('font[size="7"]');
          fontElements.forEach((fontEl) => {
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';
            span.innerHTML = fontEl.innerHTML;
            fontEl.parentNode?.replaceChild(span, fontEl);
          });
        }
      }
    }
    contentRef.current?.focus();
  }, [contentRef, restoreSelection]);

  const changeTextColor = useCallback((color: string) => {
    restoreSelection();
    document.execCommand('foreColor', false, color);
    contentRef.current?.focus();
  }, [contentRef, restoreSelection]);

  const changeBackgroundColor = useCallback((color: string) => {
    restoreSelection();
    document.execCommand('hiliteColor', false, color);
    contentRef.current?.focus();
  }, [contentRef, restoreSelection]);

  const clearFormatting = useCallback(() => {
    document.execCommand('removeFormat', false);
    document.execCommand('unlink', false);
    contentRef.current?.focus();
    checkActiveFormats();
  }, [contentRef]);

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

    const htmlContent = contentRef.current.innerHTML;
    setContent(htmlContent);
    onContentChange?.(htmlContent);
    setShowCommandMenu(false);
    setCommandFilter('');
  };

  const openLinkDialog = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString()) {
      setLinkText(selection.toString());
    }
    setShowCommandMenu(false);
    setCommandFilter('');
    setShowLinkDialog(true);
  }, []);

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

    const htmlContent = contentRef.current.innerHTML;
    setContent(htmlContent);
    onContentChange?.(htmlContent);
    setShowLinkDialog(false);
    setLinkUrl('');
    setLinkText('');
  };

  const commands: SlashCommand[] = [
    {
      id: 'text',
      label: t('sweep.shared.slashCommand.text.label'),
      description: t('sweep.shared.slashCommand.text.description'),
      icon: <Type className="h-4 w-4" />,
      action: () => insertBlock('p'),
    },
    {
      id: 'heading1',
      label: t('sweep.shared.slashCommand.heading1.label'),
      description: t('sweep.shared.slashCommand.heading1.description'),
      icon: <Heading1 className="h-4 w-4" />,
      action: () => insertBlock('h1'),
    },
    {
      id: 'heading2',
      label: t('sweep.shared.slashCommand.heading2.label'),
      description: t('sweep.shared.slashCommand.heading2.description'),
      icon: <Heading2 className="h-4 w-4" />,
      action: () => insertBlock('h2'),
    },
    {
      id: 'heading3',
      label: t('sweep.shared.slashCommand.heading3.label'),
      description: t('sweep.shared.slashCommand.heading3.description'),
      icon: <Heading3 className="h-4 w-4" />,
      action: () => insertBlock('h3'),
    },
    {
      id: 'bulletlist',
      label: t('sweep.shared.slashCommand.bulletList.label'),
      description: t('sweep.shared.slashCommand.bulletList.description'),
      icon: <List className="h-4 w-4" />,
      action: () => insertBlock('ul'),
    },
    {
      id: 'numberedlist',
      label: t('sweep.shared.slashCommand.numberedList.label'),
      description: t('sweep.shared.slashCommand.numberedList.description'),
      icon: <ListOrdered className="h-4 w-4" />,
      action: () => insertBlock('ol'),
    },
    {
      id: 'quote',
      label: t('sweep.shared.slashCommand.quote.label'),
      description: t('sweep.shared.slashCommand.quote.description'),
      icon: <Quote className="h-4 w-4" />,
      action: () => insertBlock('blockquote'),
    },
    {
      id: 'code',
      label: t('sweep.shared.slashCommand.code.label'),
      description: t('sweep.shared.slashCommand.code.description'),
      icon: <Code className="h-4 w-4" />,
      action: () => insertBlock('pre'),
    },
    {
      id: 'divider',
      label: t('sweep.shared.slashCommand.divider.label'),
      description: t('sweep.shared.slashCommand.divider.description'),
      icon: <Minus className="h-4 w-4" />,
      action: () => insertBlock('hr'),
    },
    {
      id: 'link',
      label: t('sweep.shared.slashCommand.link.label'),
      description: t('sweep.shared.slashCommand.link.description'),
      icon: <LinkIcon className="h-4 w-4" />,
      action: () => openLinkDialog(),
    },
  ];

  const filteredCommands = commands.filter(cmd =>
    cmd.label.toLowerCase().includes(commandFilter.toLowerCase()) ||
    cmd.description.toLowerCase().includes(commandFilter.toLowerCase())
  );

  const toolbarProps: ToolbarProps = {
    fontFamily,
    fontSize,
    fontFamilyOpen,
    fontSizeOpen,
    textColorOpen,
    highlightColorOpen,
    activeFormats,
    setFontFamilyOpen,
    setFontSizeOpen,
    setTextColorOpen,
    setHighlightColorOpen,
    saveSelection,
    changeFontFamily,
    changeFontSize,
    changeTextColor,
    changeBackgroundColor,
    formatText,
    clearFormatting,
    openLinkDialog,
  };

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      {/* Default Toolbar (if no custom renderer) */}
      {!renderToolbar && (
        <div className="border-b bg-background sticky top-0 z-10" style={{ minHeight: '44px', padding: '6px 12px 9px 12px' }}>
          <DefaultToolbar {...toolbarProps} />
        </div>
      )}

      {/* Custom Toolbar */}
      {renderToolbar && renderToolbar(toolbarProps)}

      {/* Editor Content */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[900px] px-4 md:px-24 py-8 md:py-16">
          {/* Cover Image Section */}
          {showCoverImage && coverImage && (
            <div className="relative mb-8 md:mb-12 -mx-4 md:-mx-24 group">
              <img src={coverImage} alt={t('sweep.shared.cover')} className="w-full h-[30vh] md:h-[40vh] object-cover md:rounded-lg" />
              {editable && (
                <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleAddCoverClick}
                    disabled={isUploadingCover}
                  >
                    {isUploadingCover ? (
                      <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                    ) : (
                      <ImageIcon className="h-4 w-4 mr-0.5" />
                    )}
                    {isUploadingCover ? t('sweep.shared.uploadingEllipsis') : t('sweep.shared.change')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleRemoveCover}
                    disabled={isUploadingCover}
                  >
                    <X className="h-4 w-4 mr-0.5" />
                    {t('sweep.shared.remove')}
                  </Button>
                </div>
              )}
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
          {showTitle && (
            <div className="relative mb-4">
              {showTitlePlaceholder && (
                <div
                  className="absolute top-0 left-0 text-2xl md:text-4xl font-bold text-muted-foreground/40 pointer-events-none leading-[1.2]"
                  aria-hidden="true"
                >
                  {resolvedTitlePlaceholder}
                </div>
              )}
              <div
                ref={titleRef as React.RefObject<HTMLDivElement>}
                contentEditable={editable}
                suppressContentEditableWarning
                onInput={handleTitleInput}
                onKeyDown={handleTitleKeyDown}
                dir="ltr"
                className="text-2xl md:text-4xl font-bold outline-none leading-[1.2] relative min-h-[1.2em]"
                style={{
                  caretColor: 'currentColor',
                  direction: 'ltr',
                  unicodeBidi: 'normal',
                  textAlign: 'left',
                }}
              />
            </div>
          )}

          {/* Content Editor */}
          <div className="relative">
            {showContentPlaceholder && editable && (
              <div
                className="absolute top-0 left-0 text-base text-muted-foreground/40 pointer-events-none leading-relaxed"
                aria-hidden="true"
              >
                {resolvedContentPlaceholder}
              </div>
            )}
            <div
              ref={contentRef as React.RefObject<HTMLDivElement>}
              contentEditable={editable}
              suppressContentEditableWarning
              onInput={handleContentInput}
              onKeyDown={handleContentKeyDown}
              dir="ltr"
              className={cn(
                "text-base outline-none min-h-[400px] leading-relaxed w-full relative",
                "[&>p]:mb-2 [&>p]:min-h-[1.5em]",
                "[&_br]:block [&_br]:content-[''] [&_br]:my-0"
              )}
              style={{
                caretColor: 'currentColor',
                direction: 'ltr',
                unicodeBidi: 'normal',
                width: '100%',
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
                  <div className="overflow-y-auto max-h-[300px] overflow-x-hidden [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 hover:[&::-webkit-scrollbar-thumb]:bg-border/70 [&::-webkit-scrollbar-track]:bg-transparent">
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
                        <div className="mr-2 h-4 w-4 shrink-0 opacity-70">
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
                  <h3 className="text-lg font-semibold">{t('sweep.shared.insertLink')}</h3>
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
                    <label className="text-sm font-medium">{t('sweep.shared.linkText')}</label>
                    <Input
                      value={linkText}
                      onChange={(e) => setLinkText(e.target.value)}
                      placeholder={t('sweep.shared.enterLinkTextPlaceholder')}
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
                    <label className="text-sm font-medium">{t('sweep.shared.url')}</label>
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
                    {t('sweep.shared.cancel')}
                  </Button>
                  <Button onClick={insertLink} disabled={!linkUrl}>
                    {t('sweep.shared.insertLink')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Custom Styles for contenteditable */}
        <style>{`
          [contenteditable] {
            direction: ltr;
          }
          [contenteditable]:focus {
            outline: none;
          }
          [contenteditable]:empty:before {
            display: block;
          }
          [contenteditable] p {
            margin: 0;
            padding: 3px 0;
            min-height: 1.5em;
            direction: ltr !important;
            unicode-bidi: normal !important;
            width: 100%;
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
    </div>
  );
}

export function DefaultToolbar({
  fontFamily,
  fontSize,
  fontFamilyOpen,
  fontSizeOpen,
  textColorOpen,
  highlightColorOpen,
  activeFormats,
  setFontFamilyOpen,
  setFontSizeOpen,
  setTextColorOpen,
  setHighlightColorOpen,
  saveSelection,
  changeFontFamily,
  changeFontSize,
  changeTextColor,
  changeBackgroundColor,
  formatText,
  clearFormatting,
  openLinkDialog,
}: ToolbarProps) {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* Font Family */}
      <Popover open={fontFamilyOpen} onOpenChange={(open) => { if (open) saveSelection(); setFontFamilyOpen(open); }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={fontFamilyOpen}
            className="hidden md:flex h-8 w-44 justify-between text-xs shadow-none"
            style={{ fontFamily: `'${fontFamily}', sans-serif` }}
          >
            <span className="truncate">
              {fontFamily
                ? fontFamilies.find((font) => font.value === fontFamily)?.label
                : t('sweep.shared.selectFontEllipsis')}
            </span>
            <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-0">
          <Command>
            <CommandInput placeholder={t('sweep.shared.searchFontPlaceholder')} className="h-9" />
            <CommandList>
              <CommandEmpty>{t('sweep.shared.noFontFound')}</CommandEmpty>
              <CommandGroup>
                {fontFamilies.map((font) => (
                  <CommandItem
                    key={font.value}
                    value={font.value}
                    onSelect={(currentValue) => {
                      changeFontFamily(currentValue === fontFamily ? "" : currentValue);
                      setFontFamilyOpen(false);
                    }}
                    style={{ fontFamily: `'${font.value}', sans-serif` }}
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
      <Popover open={fontSizeOpen} onOpenChange={(open) => { if (open) saveSelection(); setFontSizeOpen(open); }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={fontSizeOpen}
            className="hidden md:flex h-8 w-20 justify-between text-xs shadow-none"
          >
            {fontSize
              ? fontSizes.find((size) => size.value === fontSize)?.label
              : t('sweep.shared.size')}
            <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-20 p-0">
          <Command>
            <CommandList className="scrollbar-thin scrollbar-thumb-transparent hover:scrollbar-thumb-gray-300">
              <CommandEmpty>{t('sweep.shared.noSizeFound')}</CommandEmpty>
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

      <div className="hidden md:block w-px h-5 bg-border mx-1" />

      {/* Text Formatting */}
      <Button
        variant="ghost"
        size="sm"
        className={cn("p-0", activeFormats.has('bold') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('bold')}
        title={t('sweep.shared.boldShortcut')}
      >
        <Bold className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("p-0", activeFormats.has('italic') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('italic')}
        title={t('sweep.shared.italicShortcut')}
      >
        <Italic className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("p-0", activeFormats.has('underline') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('underline')}
        title={t('sweep.shared.underlineShortcut')}
      >
        <Underline className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("p-0", activeFormats.has('strikethrough') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('strikeThrough')}
        title={t('sweep.shared.strikethrough')}
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </Button>

      <div className="hidden md:block w-px h-5 bg-border mx-1" />

      {/* Text Color */}
      <Popover open={textColorOpen} onOpenChange={(open) => { if (open) saveSelection(); setTextColorOpen(open); }}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="hidden md:flex p-0"
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            title={t('sweep.shared.textColor')}
          >
            <Palette className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="start">
          <div className="grid grid-cols-5 gap-1">
            {textColors.map((color) => (
              <Button
                key={color.value}
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded border border-border hover:scale-110 transition-transform"
                style={{ backgroundColor: color.value }}
                title={t(color.labelKey)}
                onClick={() => {
                  changeTextColor(color.value);
                  setTextColorOpen(false);
                }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Popover open={highlightColorOpen} onOpenChange={(open) => { if (open) saveSelection(); setHighlightColorOpen(open); }}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="hidden md:flex p-0"
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            title={t('sweep.shared.highlightColor')}
          >
            <Highlighter className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="start">
          <div className="grid grid-cols-5 gap-1">
            {highlightColors.map((color) => (
              <Button
                key={color.value}
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded border border-border hover:scale-110 transition-transform"
                style={{ backgroundColor: color.value }}
                title={t(color.labelKey)}
                onClick={() => {
                  changeBackgroundColor(color.value);
                  setHighlightColorOpen(false);
                }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <div className="hidden md:block w-px h-5 bg-border mx-1" />

      {/* Alignment */}
      <Button
        variant="ghost"
        size="sm"
        className={cn("hidden md:flex p-0", activeFormats.has('alignLeft') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('justifyLeft')}
        title={t('sweep.shared.alignLeft')}
      >
        <AlignLeft className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("hidden md:flex p-0", activeFormats.has('alignCenter') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('justifyCenter')}
        title={t('sweep.shared.alignCenter')}
      >
        <AlignCenter className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("hidden md:flex p-0", activeFormats.has('alignRight') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('justifyRight')}
        title={t('sweep.shared.alignRight')}
      >
        <AlignRight className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("hidden md:flex p-0", activeFormats.has('alignJustify') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('justifyFull')}
        title={t('sweep.shared.justify')}
      >
        <AlignJustify className="h-3.5 w-3.5" />
      </Button>

      <div className="hidden md:block w-px h-5 bg-border mx-1" />

      {/* Lists */}
      <Button
        variant="ghost"
        size="sm"
        className={cn("p-0", activeFormats.has('bulletList') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('insertUnorderedList')}
        title={t('sweep.shared.bulletList')}
      >
        <List className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("p-0", activeFormats.has('numberedList') && "bg-muted")}
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('insertOrderedList')}
        title={t('sweep.shared.numberedList')}
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </Button>

      <div className="hidden md:block w-px h-5 bg-border mx-1" />

      {/* Link */}
      <Button
        variant="ghost"
        size="sm"
        className="p-0"
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => openLinkDialog()}
        title={t('sweep.shared.insertLink')}
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </Button>

      <div className="hidden md:block w-px h-5 bg-border mx-1" />

      {/* Indent / Outdent */}
      <Button
        variant="ghost"
        size="sm"
        className="hidden md:flex p-0"
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('outdent')}
        title={t('sweep.shared.decreaseIndent')}
      >
        <Outdent className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="hidden md:flex p-0"
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => formatText('indent')}
        title={t('sweep.shared.increaseIndent')}
      >
        <Indent className="h-3.5 w-3.5" />
      </Button>

      <div className="hidden md:block w-px h-5 bg-border mx-1" />

      {/* Clear Formatting */}
      <Button
        variant="ghost"
        size="sm"
        className="hidden md:flex p-0"
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={clearFormatting}
        title={t('sweep.shared.clearFormatting')}
      >
        <RemoveFormatting className="h-3.5 w-3.5" />
      </Button>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Undo / Redo */}
      <Button
        variant="ghost"
        size="sm"
        className="p-0"
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => document.execCommand('undo')}
        title={t('sweep.shared.undoShortcut')}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="p-0"
        style={{ height: '28px', width: '28px', minHeight: '28px' }}
        onClick={() => document.execCommand('redo')}
        title={t('sweep.shared.redoShortcut')}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
