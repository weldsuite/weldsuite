
import { useState, useRef, useEffect, KeyboardEvent, DragEvent } from 'react';
import { useRouter, useSearchParams, Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import { toast } from 'sonner';
import { Upload, Loader2 } from 'lucide-react';
import { useCreateHelpArticle } from '@/hooks/queries/use-helpdesk-queries';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
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
  ChevronsUpDown,
  Check,
  FileText,
  Plus,
  ChevronLeft,
  Globe,
  Tag,
  FolderOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface CommandItem {
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

const categories = [
  { value: 'getting-started', label: 'Getting Started' },
  { value: 'account', label: 'Account & Billing' },
  { value: 'features', label: 'Features & Tools' },
  { value: 'troubleshooting', label: 'Troubleshooting' },
  { value: 'integrations', label: 'Integrations' },
  { value: 'api', label: 'API & Developers' },
];

export default function NewHelpArticlePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const st = useTranslations();
  const th = t.helpdesk.helpArticles;
  const initialCategory = searchParams.get('category') || '';

  const titleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [title, setTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [content, setContent] = useState('');
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
  const inlineImageInputRef = useRef<HTMLInputElement>(null);
  const [fontFamily, setFontFamily] = useState('Arial');
  const [isDragging, setIsDragging] = useState(false);
  const [fontSize, setFontSize] = useState('16');
  const [fontFamilyOpen, setFontFamilyOpen] = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const [showMetadata, setShowMetadata] = useState(true);
  const [selectedImage, setSelectedImage] = useState<HTMLImageElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeStartPos, setResizeStartPos] = useState({ x: 0, y: 0 });
  const [resizeStartSize, setResizeStartSize] = useState({ width: 0, height: 0 });
  const [resizeHandle, setResizeHandle] = useState<string>('');
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });

  const createHelpArticleMutation = useCreateHelpArticle();

  // Article metadata
  const [category, setCategory] = useState(initialCategory);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  const [excerpt, setExcerpt] = useState('');

  // Focus title on mount
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.focus();
    }
  }, []);

  // Initialize content on mount only - now starts empty with placeholder
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.innerHTML = '';
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

  // Handle click outside to deselect image
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectedImage && !isResizing) {
        const target = e.target as HTMLElement;
        // Check if click is on the image, resize handles, or toolbar buttons
        const isToolbarClick = target.closest('.border-b.bg-background.sticky');
        const isResizeWrapper = target.closest('.image-resize-wrapper');

        if (!isToolbarClick && !isResizeWrapper && target !== selectedImage) {
          setSelectedImage(null);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [selectedImage, isResizing]);

  // Handle image click within content editor
  useEffect(() => {
    const handleImageClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'IMG' && contentRef.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        const img = target as HTMLImageElement;
        setSelectedImage(img);
        setImageSize({ width: img.offsetWidth, height: img.offsetHeight });
      }
    };

    const contentEl = contentRef.current;
    if (contentEl) {
      contentEl.addEventListener('click', handleImageClick);
      return () => {
        contentEl.removeEventListener('click', handleImageClick);
      };
    }
  }, []);

  // Handle resize mouse move and mouse up
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !selectedImage) return;

      e.preventDefault();
      const deltaX = e.clientX - resizeStartPos.x;
      const deltaY = e.clientY - resizeStartPos.y;

      let newWidth = resizeStartSize.width;
      let newHeight = resizeStartSize.height;
      const aspectRatio = resizeStartSize.width / resizeStartSize.height;

      // Calculate new size based on which handle is being dragged
      if (resizeHandle.includes('e')) {
        newWidth = Math.max(50, resizeStartSize.width + deltaX);
      } else if (resizeHandle.includes('w')) {
        newWidth = Math.max(50, resizeStartSize.width - deltaX);
      }

      if (resizeHandle.includes('s')) {
        newHeight = Math.max(50, resizeStartSize.height + deltaY);
      } else if (resizeHandle.includes('n')) {
        newHeight = Math.max(50, resizeStartSize.height - deltaY);
      }

      // Maintain aspect ratio for corner handles
      if (resizeHandle.length === 2) {
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
          newHeight = newWidth / aspectRatio;
        } else {
          newWidth = newHeight * aspectRatio;
        }
      }

      // Constrain to content editor width
      const maxWidth = contentRef.current ? contentRef.current.offsetWidth : newWidth;
      newWidth = Math.min(newWidth, maxWidth);

      // Recalculate height if we had to constrain width (for corner handles)
      if (resizeHandle.length === 2 && newWidth === maxWidth) {
        newHeight = newWidth / aspectRatio;
      }

      selectedImage.style.width = `${newWidth}px`;
      selectedImage.style.height = `${newHeight}px`;
      selectedImage.style.maxHeight = 'none';

      // Update imageSize state to trigger re-render of handles
      setImageSize({ width: newWidth, height: newHeight });
    };

    const handleMouseUp = () => {
      if (isResizing) {
        document.body.classList.remove('resizing-image');
        setIsResizing(false);
        setResizeHandle('');
        if (contentRef.current) {
          setContent(contentRef.current.innerHTML);
        }
      }
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isResizing, selectedImage, resizeStartPos, resizeStartSize, resizeHandle]);

  const startResize = (e: React.MouseEvent, handle: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedImage) return;

    document.body.classList.add('resizing-image');
    setIsResizing(true);
    setResizeHandle(handle);
    setResizeStartPos({ x: e.clientX, y: e.clientY });
    setResizeStartSize({
      width: selectedImage.offsetWidth,
      height: selectedImage.offsetHeight,
    });
  };

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

    // Check font family and font size from selection
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      let element = range.startContainer as HTMLElement;

      // If text node, get parent element
      if (element.nodeType === Node.TEXT_NODE) {
        element = element.parentElement as HTMLElement;
      }

      if (element) {
        // Get computed styles
        const computedStyle = window.getComputedStyle(element);

        // Check font family
        const currentFontFamily = computedStyle.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
        const matchedFont = fontFamilies.find(f =>
          f.value.toLowerCase() === currentFontFamily.toLowerCase()
        );
        if (matchedFont) {
          setFontFamily(matchedFont.value);
        }

        // Check font size
        const currentFontSize = Math.round(parseFloat(computedStyle.fontSize));
        const matchedSize = fontSizes.find(s => parseInt(s.value) === currentFontSize);
        if (matchedSize) {
          setFontSize(matchedSize.value);
        } else {
          // Find closest size
          const closestSize = fontSizes.reduce((prev, curr) => {
            return Math.abs(parseInt(curr.value) - currentFontSize) < Math.abs(parseInt(prev.value) - currentFontSize)
              ? curr
              : prev;
          });
          setFontSize(closestSize.value);
        }
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
        alert(th.selectImageOnly);
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        alert(th.selectImageOnly5MB);
        return;
      }

      const imageUrl = URL.createObjectURL(file);
      setCoverImage(imageUrl);
    }
  };

  const handleAddCoverClick = () => {
    coverImageInputRef.current?.click();
  };

  const handleInlineImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach((file) => {
        insertImageFile(file);
      });
    }
    // Reset input so the same file can be selected again
    e.target.value = '';
  };

  const handleAddInlineImageClick = () => {
    inlineImageInputRef.current?.click();
  };

  const insertImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert(th.selectImageOnly);
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert(th.selectImageOnly10MB);
      return;
    }

    const imageUrl = URL.createObjectURL(file);
    insertImageAtCursor(imageUrl, file.name);
  };

  const insertImageAtCursor = (imageUrl: string, altText: string = 'Image') => {
    if (!contentRef.current) return;

    // Create image container
    const imageWrapper = document.createElement('div');
    imageWrapper.className = 'my-4 image-wrapper';
    imageWrapper.setAttribute('contenteditable', 'false');
    imageWrapper.setAttribute('data-image-wrapper', 'true');

    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = altText;
    img.className = 'max-w-full h-auto rounded-lg';
    img.style.maxHeight = '400px';
    img.style.objectFit = 'contain';

    imageWrapper.appendChild(img);

    // Create a paragraph after the image for continued typing
    const newParagraph = document.createElement('p');
    newParagraph.setAttribute('dir', 'ltr');
    newParagraph.innerHTML = '<br>';

    const selection = window.getSelection();
    let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    // Check if the range is within the content editor
    if (range && contentRef.current) {
      const isInEditor = contentRef.current.contains(range.commonAncestorContainer);
      if (!isInEditor) {
        range = null;
      }
    }

    if (range) {
      range.deleteContents();
      range.insertNode(newParagraph);
      range.insertNode(imageWrapper);

      // Move cursor to the new paragraph
      const newRange = document.createRange();
      newRange.setStart(newParagraph, 0);
      newRange.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(newRange);
    } else {
      // If no valid selection in editor, append to the end
      contentRef.current.appendChild(imageWrapper);
      contentRef.current.appendChild(newParagraph);

      // Move cursor to the new paragraph
      const selection = window.getSelection();
      if (selection) {
        const newRange = document.createRange();
        newRange.setStart(newParagraph, 0);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      }
    }

    setContent(contentRef.current.innerHTML);
    contentRef.current.focus();
  };

  // Drag and drop handlers
  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set isDragging to false if we're leaving the main container
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      // Focus the content editor first to ensure we have a valid insertion point
      if (contentRef.current) {
        contentRef.current.focus();

        // Place cursor at the end of the content if no selection exists
        const selection = window.getSelection();
        if (selection && contentRef.current) {
          const range = document.createRange();
          range.selectNodeContents(contentRef.current);
          range.collapse(false); // Collapse to end
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }

      Array.from(files).forEach((file) => {
        if (file.type.startsWith('image/')) {
          insertImageFile(file);
        }
      });
    }
  };

  // Handle paste for images
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          insertImageFile(file);
        }
        return;
      }
    }
  };

  const formatText = (command: string, value?: string) => {
    // If an image is selected and it's an alignment command, align the image instead
    if (selectedImage && (command === 'justifyLeft' || command === 'justifyCenter' || command === 'justifyRight' || command === 'justifyFull')) {
      alignSelectedImage(command);
      return;
    }

    document.execCommand(command, false, value);
    contentRef.current?.focus();
    checkActiveFormats();
  };

  const alignSelectedImage = (alignment: string) => {
    if (!selectedImage || !contentRef.current) return;

    // Find the image wrapper (parent div with data-image-wrapper or contenteditable="false")
    let wrapper = selectedImage.parentElement;

    // If the parent is not a wrapper, create one
    if (!wrapper || !wrapper.hasAttribute('data-image-wrapper')) {
      // Check if parent has contenteditable="false"
      if (wrapper && wrapper.getAttribute('contenteditable') === 'false') {
        wrapper.setAttribute('data-image-wrapper', 'true');
        wrapper.classList.add('image-wrapper');
      } else {
        // Create a wrapper for the image
        const newWrapper = document.createElement('div');
        newWrapper.className = 'my-4 image-wrapper';
        newWrapper.setAttribute('contenteditable', 'false');
        newWrapper.setAttribute('data-image-wrapper', 'true');
        selectedImage.parentNode?.insertBefore(newWrapper, selectedImage);
        newWrapper.appendChild(selectedImage);
        wrapper = newWrapper;
      }
    }

    if (!wrapper) return;

    // Reset any existing alignment styles on both wrapper and image
    wrapper.style.textAlign = '';
    wrapper.style.display = '';
    wrapper.style.justifyContent = '';
    wrapper.style.marginLeft = '';
    wrapper.style.marginRight = '';
    selectedImage.style.marginLeft = '';
    selectedImage.style.marginRight = '';
    selectedImage.style.display = '';

    switch (alignment) {
      case 'justifyLeft':
        wrapper.style.display = 'block';
        wrapper.style.textAlign = 'left';
        selectedImage.style.display = 'block';
        selectedImage.style.marginLeft = '0';
        selectedImage.style.marginRight = 'auto';
        break;
      case 'justifyCenter':
        wrapper.style.display = 'flex';
        wrapper.style.justifyContent = 'center';
        selectedImage.style.display = 'block';
        selectedImage.style.marginLeft = 'auto';
        selectedImage.style.marginRight = 'auto';
        break;
      case 'justifyRight':
        wrapper.style.display = 'flex';
        wrapper.style.justifyContent = 'flex-end';
        selectedImage.style.display = 'block';
        selectedImage.style.marginLeft = 'auto';
        selectedImage.style.marginRight = '0';
        break;
      case 'justifyFull':
        // For justify, make image full width
        wrapper.style.display = 'block';
        wrapper.style.textAlign = 'center';
        selectedImage.style.display = 'block';
        selectedImage.style.width = '100%';
        selectedImage.style.marginLeft = '0';
        selectedImage.style.marginRight = '0';
        setImageSize({ width: contentRef.current.offsetWidth, height: selectedImage.offsetHeight });
        break;
    }

    // Update content state
    setContent(contentRef.current.innerHTML);

    // Update the image size state to refresh the resize handles position after DOM update
    setTimeout(() => {
      if (selectedImage) {
        setImageSize({ width: selectedImage.offsetWidth, height: selectedImage.offsetHeight });
      }
    }, 10);
  };

  const changeFontFamily = (font: string) => {
    setFontFamily(font);
    document.execCommand('fontName', false, font);
    contentRef.current?.focus();
  };

  const changeFontSize = (size: string) => {
    setFontSize(size);
    document.execCommand('fontSize', false, '7');
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const span = document.createElement('span');
      span.style.fontSize = size + 'px';
      try {
        range.surroundContents(span);
      } catch {
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

    let parentNode: Node = range.commonAncestorContainer;
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

  const handleAddTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      setTags([...tags, tagInput.trim()]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
  };

  const handleTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error(th.titleRequired, {
        description: th.titleRequiredDesc,
      });
      return;
    }

    setIsSaving(true);
    createHelpArticleMutation.mutate(
      {
        title: title.trim(),
        content,
        excerpt: excerpt || undefined,
        category: category || undefined,
        tags: tags.length > 0 ? tags : undefined,
        status: 'draft',
        coverImage: coverImage || undefined,
      },
      {
        onSuccess: (result) => {
          if (result.success) {
            toast.success(th.draftSaved, {
              description: th.draftSavedDesc,
            });
            router.push('/welddesk/help');
          } else {
            toast.error(th.errorSavingDraft, {
              description: result.error || th.errorSavingDraft,
            });
          }
        },
        onError: () => {
          toast.error(th.errorSavingDraft);
        },
        onSettled: () => {
          setIsSaving(false);
        },
      }
    );
  };

  const handlePublish = async () => {
    if (!title.trim()) {
      toast.error(th.titleRequired, {
        description: th.titleRequiredDesc,
      });
      return;
    }

    setIsPublishing(true);
    createHelpArticleMutation.mutate(
      {
        title: title.trim(),
        content,
        excerpt: excerpt || undefined,
        category: category || undefined,
        tags: tags.length > 0 ? tags : undefined,
        status: 'published',
        coverImage: coverImage || undefined,
      },
      {
        onSuccess: (result) => {
          if (result.success) {
            toast.success(th.articlePublished, {
              description: th.articlePublishedDesc,
            });
            router.push('/welddesk/help');
          } else {
            toast.error(th.errorPublishing, {
              description: result.error || th.errorPublishing,
            });
          }
        },
        onError: () => {
          toast.error(th.errorPublishing);
        },
        onSettled: () => {
          setIsPublishing(false);
        },
      }
    );
  };

  const commands: CommandItem[] = [
    {
      id: 'text',
      label: th.cmdText,
      description: th.cmdTextDesc,
      icon: <Type className="h-4 w-4" />,
      action: () => insertBlock('p'),
    },
    {
      id: 'heading1',
      label: th.cmdHeading1,
      description: th.cmdHeading1Desc,
      icon: <Heading1 className="h-4 w-4" />,
      action: () => insertBlock('h1'),
    },
    {
      id: 'heading2',
      label: th.cmdHeading2,
      description: th.cmdHeading2Desc,
      icon: <Heading2 className="h-4 w-4" />,
      action: () => insertBlock('h2'),
    },
    {
      id: 'heading3',
      label: th.cmdHeading3,
      description: th.cmdHeading3Desc,
      icon: <Heading3 className="h-4 w-4" />,
      action: () => insertBlock('h3'),
    },
    {
      id: 'bulletlist',
      label: th.cmdBulletedList,
      description: th.cmdBulletedListDesc,
      icon: <List className="h-4 w-4" />,
      action: () => insertBlock('ul'),
    },
    {
      id: 'numberedlist',
      label: th.cmdNumberedList,
      description: th.cmdNumberedListDesc,
      icon: <ListOrdered className="h-4 w-4" />,
      action: () => insertBlock('ol'),
    },
    {
      id: 'quote',
      label: th.cmdQuote,
      description: th.cmdQuoteDesc,
      icon: <Quote className="h-4 w-4" />,
      action: () => insertBlock('blockquote'),
    },
    {
      id: 'code',
      label: th.cmdCode,
      description: th.cmdCodeDesc,
      icon: <Code className="h-4 w-4" />,
      action: () => insertBlock('pre'),
    },
    {
      id: 'divider',
      label: th.cmdDivider,
      description: th.cmdDividerDesc,
      icon: <Minus className="h-4 w-4" />,
      action: () => insertBlock('hr'),
    },
    {
      id: 'link',
      label: th.cmdLink,
      description: th.cmdLinkDesc,
      icon: <LinkIcon className="h-4 w-4" />,
      action: () => openLinkDialog(),
    },
    {
      id: 'image',
      label: th.cmdImage,
      description: th.cmdImageDesc,
      icon: <ImageIcon className="h-4 w-4" />,
      action: () => {
        setShowCommandMenu(false);
        setCommandFilter('');
        handleAddInlineImageClick();
      },
    },
  ];

  const filteredCommands = commands.filter(cmd =>
    cmd.label.toLowerCase().includes(commandFilter.toLowerCase()) ||
    cmd.description.toLowerCase().includes(commandFilter.toLowerCase())
  );

  return (
    <div
      className="min-h-[calc(100vh-120px)] bg-background relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Left Aligned Toolbar */}
      <div className="border-b bg-background sticky top-0 z-10" style={{ minHeight: '44px', padding: '6px 0 9px 24px' }}>
        <div className="flex items-center gap-1 flex-wrap">
          {/* Back Button */}
          <Link href="/welddesk/help">
            <Button variant="ghost" size="sm" className="h-8 mr-2 shadow-none">
              <ChevronLeft className="h-4 w-4 mr-1" />
              {th.back}
            </Button>
          </Link>

          <div className="w-px h-5 bg-border mx-1" />

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
                  : th.selectFont}
                <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-0">
              <Command>
                <CommandInput placeholder={th.searchFont} className="h-9" />
                <CommandList>
                  <CommandEmpty>{th.noFontFound}</CommandEmpty>
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
                  : th.size}
                <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-20 p-0">
              <Command>
                <CommandList className="scrollbar-thin scrollbar-thumb-transparent hover:scrollbar-thumb-gray-300">
                  <CommandEmpty>{th.noSizeFound}</CommandEmpty>
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
            className={cn("p-0", activeFormats.has('bold') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('bold')}
            title={st('sweep.welddesk.helpEditor.boldTooltip')}
          >
            <Bold className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('italic') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('italic')}
            title={st('sweep.welddesk.helpEditor.italicTooltip')}
          >
            <Italic className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('underline') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('underline')}
            title={st('sweep.welddesk.helpEditor.underlineTooltip')}
          >
            <Underline className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('strikethrough') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('strikeThrough')}
            title={st('sweep.welddesk.helpEditor.strikethroughTooltip')}
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
            title={st('sweep.welddesk.helpEditor.textColorTooltip')}
          >
            <Palette className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="p-0"
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => changeBackgroundColor('#ffff00')}
            title={st('sweep.welddesk.helpEditor.highlightColorTooltip')}
          >
            <Highlighter className="h-3.5 w-3.5" />
          </Button>

          <div className="w-px h-5 bg-border mx-1" />

          {/* Alignment */}
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('alignLeft') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('justifyLeft')}
            title={st('sweep.welddesk.helpEditor.alignLeftTooltip')}
          >
            <AlignLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('alignCenter') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('justifyCenter')}
            title={st('sweep.welddesk.helpEditor.alignCenterTooltip')}
          >
            <AlignCenter className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('alignRight') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('justifyRight')}
            title={st('sweep.welddesk.helpEditor.alignRightTooltip')}
          >
            <AlignRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('alignJustify') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('justifyFull')}
            title={st('sweep.welddesk.helpEditor.justifyTooltip')}
          >
            <AlignJustify className="h-3.5 w-3.5" />
          </Button>

          <div className="w-px h-5 bg-border mx-1" />

          {/* Lists */}
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('bulletList') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('insertUnorderedList')}
            title={st('sweep.welddesk.helpEditor.bulletListTooltip')}
          >
            <List className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0", activeFormats.has('numberedList') && "bg-primary/20 text-primary")}
            style={{ height: '28px', width: '28px', minHeight: '28px' }}
            onClick={() => formatText('insertOrderedList')}
            title={st('sweep.welddesk.helpEditor.numberedListTooltip')}
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
            title={th.insertLink}
          >
            <LinkIcon className="h-3.5 w-3.5 mr-1" />
            {th.link}
          </Button>

          <div className="w-px h-5 bg-border mx-1" />

          {/* Image */}
          <Button
            variant="ghost"
            size="sm"
            style={{ height: '28px', paddingLeft: '10px', paddingRight: '10px', minHeight: '28px' }}
            onClick={handleAddInlineImageClick}
            title={th.image}
          >
            <ImageIcon className="h-3.5 w-3.5 mr-1" />
            {th.image}
          </Button>

          {/* Right side actions */}
          <div className="flex items-center gap-2 ml-auto mr-6">
            <Button
              variant="outline"
              size="sm"
              className="h-8 shadow-none"
              onClick={handleSave}
              disabled={isSaving || isPublishing}
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {th.saveDraft}
            </Button>
            <Button
              size="sm"
              className="h-8 shadow-none"
              onClick={handlePublish}
              disabled={isSaving || isPublishing}
            >
              {isPublishing ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Globe className="h-4 w-4 mr-1.5" />
              )}
              {th.publish}
            </Button>
          </div>
        </div>
      </div>

      {/* Article Metadata Section */}
      <div className="absolute" style={{ top: '60px', left: '24px', zIndex: 5 }}>
        {!showMetadata ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-sm hover:bg-muted"
            title={st('sweep.welddesk.helpEditor.articleSettingsTooltip')}
            onClick={() => setShowMetadata(true)}
          >
            <FileText className="h-5 w-5" />
          </Button>
        ) : (
          <div className="w-64 bg-background border border-border rounded-lg shadow-sm p-4">
            <div className="flex items-center gap-2 mb-4">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowMetadata(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-medium">{th.articleSettings}</span>
            </div>

            <div className="space-y-4">
              {/* Status */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {th.status}
                </label>
                <Select value={status} onValueChange={(v: 'draft' | 'published') => setStatus(v)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">{th.draft}</SelectItem>
                    <SelectItem value="published">{th.published}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Category */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <FolderOpen className="h-3 w-3" />
                  {th.category}
                </label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder={th.selectCategory} />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Tags */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Tag className="h-3 w-3" />
                  {th.tags}
                </label>
                <div className="flex flex-wrap gap-1 mb-2">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                      <Button
                        variant="ghost"
                        onClick={() => handleRemoveTag(tag)}
                        className="ml-1 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-1">
                  <Input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    placeholder={th.addTag}
                    className="h-8 text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 shadow-none"
                    onClick={handleAddTag}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Excerpt */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {th.excerpt}
                </label>
                <textarea
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  placeholder={th.briefDescription}
                  className="w-full h-20 px-3 py-2 text-sm border border-border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* Cover Image */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {th.coverImage}
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-8 shadow-none"
                  onClick={handleAddCoverClick}
                >
                  <ImageIcon className="h-4 w-4 mr-1.5" />
                  {coverImage ? th.changeCover : th.addCover}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Editor Content */}
      <div className="mx-auto max-w-[900px] px-24 py-8">
        {/* Cover Image Section */}
        {coverImage && (
          <div className="relative mb-12 -mx-24 group">
            <img src={coverImage} alt={st('sweep.welddesk.helpEditor.coverImageAlt')} className="w-full h-[40vh] object-cover rounded-lg" />
            <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleAddCoverClick}
              >
                <ImageIcon className="h-4 w-4 mr-0.5" />
                {th.change}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCoverImage(undefined)}
              >
                <X className="h-4 w-4 mr-0.5" />
                {th.remove}
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

        {/* Hidden input for inline images */}
        <input
          ref={inlineImageInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleInlineImageUpload}
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
            "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40"
          )}
          data-placeholder={th.untitled}
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
            onPaste={handlePaste}
            dir="ltr"
            className={cn(
              "text-base outline-none min-h-[400px] leading-relaxed",
              "[&>p]:mb-2 [&>p]:min-h-[1.5em]",
              "[&_br]:block [&_br]:content-[''] [&_br]:my-0",
              "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40"
            )}
            data-placeholder={th.pressForCommands}
            style={{
              caretColor: 'currentColor',
              direction: 'ltr',
              unicodeBidi: 'normal',
              textAlign: 'left',
            }}
          />

          {/* Image Resize Handles */}
          {selectedImage && contentRef.current?.contains(selectedImage) && (() => {
            const imgWidth = imageSize.width || selectedImage.offsetWidth;
            const imgHeight = imageSize.height || selectedImage.offsetHeight;
            const editorWidth = contentRef.current?.offsetWidth || imgWidth;
            // Constrain the wrapper to not exceed the editor width
            const constrainedWidth = Math.min(imgWidth + 4, editorWidth);

            // Get the image's position relative to the content editor
            const imgRect = selectedImage.getBoundingClientRect();
            const editorRect = contentRef.current?.getBoundingClientRect();
            const relativeLeft = editorRect ? imgRect.left - editorRect.left : selectedImage.offsetLeft;
            const relativeTop = editorRect ? imgRect.top - editorRect.top : selectedImage.offsetTop;

            return (
            <div
              className="image-resize-wrapper"
              style={{
                position: 'absolute',
                top: relativeTop - 2,
                left: Math.max(0, relativeLeft - 2),
                width: constrainedWidth,
                height: imgHeight + 4,
                pointerEvents: 'none',
                zIndex: 40,
                overflow: 'visible',
              }}
            >
              {/* Selection border */}
              <div
                className="absolute inset-0 border-2 border-primary rounded-lg"
                style={{ pointerEvents: 'none' }}
              />

              {/* Corner handles */}
              <div
                className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-primary border-2 border-white rounded-sm cursor-nw-resize shadow-sm"
                style={{ pointerEvents: 'auto' }}
                onMouseDown={(e) => startResize(e, 'nw')}
              />
              <div
                className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-primary border-2 border-white rounded-sm cursor-ne-resize shadow-sm"
                style={{ pointerEvents: 'auto' }}
                onMouseDown={(e) => startResize(e, 'ne')}
              />
              <div
                className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-primary border-2 border-white rounded-sm cursor-sw-resize shadow-sm"
                style={{ pointerEvents: 'auto' }}
                onMouseDown={(e) => startResize(e, 'sw')}
              />
              <div
                className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-primary border-2 border-white rounded-sm cursor-se-resize shadow-sm"
                style={{ pointerEvents: 'auto' }}
                onMouseDown={(e) => startResize(e, 'se')}
              />

              {/* Edge handles */}
              <div
                className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-primary border-2 border-white rounded-sm cursor-n-resize shadow-sm"
                style={{ pointerEvents: 'auto' }}
                onMouseDown={(e) => startResize(e, 'n')}
              />
              <div
                className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-primary border-2 border-white rounded-sm cursor-s-resize shadow-sm"
                style={{ pointerEvents: 'auto' }}
                onMouseDown={(e) => startResize(e, 's')}
              />
              <div
                className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 bg-primary border-2 border-white rounded-sm cursor-w-resize shadow-sm"
                style={{ pointerEvents: 'auto' }}
                onMouseDown={(e) => startResize(e, 'w')}
              />
              <div
                className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 bg-primary border-2 border-white rounded-sm cursor-e-resize shadow-sm"
                style={{ pointerEvents: 'auto' }}
                onMouseDown={(e) => startResize(e, 'e')}
              />

              {/* Size indicator */}
              <div
                className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-black/75 text-white text-xs rounded whitespace-nowrap"
                style={{ pointerEvents: 'none' }}
              >
                {Math.round(imgWidth)} × {Math.round(imgHeight)}
              </div>
            </div>
            );
          })()}

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
                <h3 className="text-lg font-semibold">{th.insertLink}</h3>
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
                  <label className="text-sm font-medium">{th.linkText}</label>
                  <Input
                    value={linkText}
                    onChange={(e) => setLinkText(e.target.value)}
                    placeholder={th.enterLinkText}
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
                  <label className="text-sm font-medium">{th.url}</label>
                  <Input
                    ref={linkInputRef}
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder={st('sweep.welddesk.helpEditor.urlPlaceholder')}
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
                  {th.cancel}
                </Button>
                <Button onClick={insertLink} disabled={!linkUrl}>
                  {th.insertLink}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Drag Overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-primary rounded-lg bg-background">
            <Upload className="h-12 w-12 text-primary" />
            <div className="text-center">
              <p className="text-lg font-medium">{th.dropImagesHere}</p>
              <p className="text-sm text-muted-foreground">{th.releaseToUpload}</p>
            </div>
          </div>
        </div>
      )}

      {/* Custom Styles for contenteditable */}
      <style>{`
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
        [contenteditable] img {
          max-width: 100%;
          height: auto;
          border-radius: 0.5rem;
          margin: 1em 0;
        }
        [contenteditable] div[contenteditable="false"] {
          user-select: none;
        }
        /* Prevent text selection during image resize */
        body.resizing-image {
          user-select: none;
          cursor: inherit;
        }
        body.resizing-image * {
          user-select: none;
        }
      `}</style>
    </div>
  );
}
