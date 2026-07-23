
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WysiwygEditor, DefaultToolbar } from '@/components/wysiwyg-editor/wysiwyg-editor';
import type { ToolbarProps } from '@/components/wysiwyg-editor/wysiwyg-editor';

// ============================================================================
// Shared document editor page layout
// Extracted from weldflow/project/documents — used by weldflow documents,
// welddesk knowledge articles, and any other rich-text editing page.
// ============================================================================

interface DocumentEditorPageProps {
  /** Initial HTML content for the editor */
  initialContent?: string;
  /** Initial title */
  initialTitle?: string;
  /** Cover image URL */
  coverImage?: string;
  /** Whether the editor is editable */
  editable?: boolean;
  /** Placeholder text for content area */
  contentPlaceholder?: string;
  /** Show the title field */
  showTitle?: boolean;
  /** Show cover image support */
  showCoverImage?: boolean;

  // ── Callbacks ──────────────────────────────────────────────────────────
  /** Called when content changes (HTML string) */
  onContentChange?: (html: string) => void;
  /** Called when title changes */
  onTitleChange?: (title: string) => void;
  /** Called when cover image changes */
  onCoverImageChange?: (url: string | undefined) => void;
  /** Called to upload a cover image, returns the URL */
  onCoverImageUpload?: (file: File) => Promise<string | undefined>;
  /** Whether a cover image is currently uploading */
  isUploadingCover?: boolean;

  // ── Toolbar customization ─────────────────────────────────────────────
  /** Content rendered to the left of the formatting toolbar (e.g. back button) */
  toolbarLeft?: React.ReactNode;
  /** Content rendered to the right of the formatting toolbar (e.g. save button, presence) */
  toolbarRight?: React.ReactNode;
  /** Completely override the toolbar rendering */
  renderToolbar?: (toolbarProps: ToolbarProps) => React.ReactNode;

  // ── Side panel ────────────────────────────────────────────────────────
  /** Optional side panel (e.g. article settings) */
  sidePanel?: React.ReactNode;

  // ── Refs ───────────────────────────────────────────────────────────────
  /** Ref to the content editable div */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  /** Ref to the title editable div */
  titleRef?: React.RefObject<HTMLDivElement | null>;

  /** Additional class name for the root element */
  className?: string;
}

export function DocumentEditorPage({
  initialContent = '',
  initialTitle = '',
  coverImage,
  editable = true,
  contentPlaceholder = "Press / for commands or start typing...",
  showTitle = true,
  showCoverImage = true,
  onContentChange,
  onTitleChange,
  onCoverImageChange,
  onCoverImageUpload,
  isUploadingCover,
  toolbarLeft,
  toolbarRight,
  renderToolbar,
  sidePanel,
  contentRef,
  titleRef,
  className,
}: DocumentEditorPageProps) {
  const defaultToolbarRenderer = useCallback((toolbarProps: ToolbarProps) => (
    <div className="bg-background sticky top-0 z-10 w-full border-b">
      <div className="flex items-center gap-2 px-3 py-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <div className="flex items-center gap-2 flex-shrink-0">
          {toolbarLeft}
          {toolbarLeft && <div className="w-px h-5 bg-border mx-1" />}
          <DefaultToolbar {...toolbarProps} />
        </div>
        {toolbarRight && (
          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            {toolbarRight}
          </div>
        )}
      </div>
    </div>
  ), [toolbarLeft, toolbarRight]);

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      <div className="flex-1 overflow-hidden flex">
        {/* Main editor area */}
        <div className="flex-1 flex flex-col min-w-0">
          <WysiwygEditor
            initialContent={initialContent}
            initialTitle={initialTitle}
            showTitle={showTitle}
            showCoverImage={showCoverImage}
            coverImage={coverImage}
            editable={editable}
            contentPlaceholder={contentPlaceholder}
            onContentChange={onContentChange}
            onTitleChange={onTitleChange}
            onCoverImageChange={onCoverImageChange}
            onCoverImageUpload={onCoverImageUpload}
            isUploadingCover={isUploadingCover}
            contentRef={contentRef}
            titleRef={titleRef}
            renderToolbar={renderToolbar || defaultToolbarRenderer}
          />
        </div>

        {/* Optional side panel */}
        {sidePanel && (
          <div className="w-80 border-l bg-muted/30 overflow-y-auto flex-shrink-0">
            {sidePanel}
          </div>
        )}
      </div>
    </div>
  );
}

export type { DocumentEditorPageProps, ToolbarProps };
