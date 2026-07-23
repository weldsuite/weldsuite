
import { useEffect, useState, useCallback, useRef } from 'react';
import { useMobileNav } from '@/contexts/mobile-nav-context';
import { Button } from '@weldsuite/ui/components/button';

export function TextSelectionTooltip() {
  const { setShowWeldAgent, setWeldAgentPrefill } = useMobileNav();
  const [selectedText, setSelectedText] = useState('');
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 });
  const [showPopup, setShowPopup] = useState(false);
  const probeRef = useRef<HTMLDivElement>(null);

  const handleAskAgent = useCallback(() => {
    if (!selectedText) return;
    setWeldAgentPrefill(selectedText);
    setShowWeldAgent(true);
    setShowPopup(false);
    setSelectedText('');
    // Clear the browser selection
    window.getSelection()?.removeAllRanges();
  }, [selectedText, setShowWeldAgent, setWeldAgentPrefill]);

  useEffect(() => {
    let selectionTimeout: NodeJS.Timeout | null = null;
    let popupVisible = false;

    const clearSelection = () => {
      if (selectionTimeout) {
        clearTimeout(selectionTimeout);
        selectionTimeout = null;
      }
      if (popupVisible) {
        setShowPopup(false);
        setSelectedText('');
        popupVisible = false;
      }
    };

    const checkSelection = () => {
      const selection = window.getSelection();

      if (!selection || selection.rangeCount === 0) {
        clearSelection();
        return;
      }

      const text = selection.toString().trim();

      if (!text || text.length < 2) {
        clearSelection();
        return;
      }

      // Don't show tooltip for selections inside input/textarea/contenteditable elements
      const anchorNode = selection.anchorNode;
      const parentElement = anchorNode?.parentElement;
      if (parentElement) {
        const closest = parentElement.closest('input, textarea, .weldagent-panel');
        if (closest) {
          clearSelection();
          return;
        }
      }

      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          clearSelection();
          return;
        }

        // Measure containing block offset (non-zero if a parent has transform/filter)
        const probe = probeRef.current;
        const offsetX = probe ? probe.getBoundingClientRect().left : 0;
        const offsetY = probe ? probe.getBoundingClientRect().top : 0;

        // Position above the selection, centered, corrected for containing block
        const x = rect.left + rect.width / 2 - offsetX;
        const y = rect.top - 10 - offsetY;

        setSelectedText(text);
        setPopupPosition({ x, y });
        setShowPopup(true);
        popupVisible = true;
      } catch {
        clearSelection();
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.text-selection-tooltip')) return;

      if (selectionTimeout) clearTimeout(selectionTimeout);
      selectionTimeout = setTimeout(() => checkSelection(), 300);
    };

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.text-selection-tooltip')) {
        e.preventDefault();
        return;
      }
      clearSelection();
    };

    const handleSelectionChange = () => {
      if (selectionTimeout) clearTimeout(selectionTimeout);
      selectionTimeout = setTimeout(() => checkSelection(), 300);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };

    document.addEventListener('mouseup', handleMouseUp, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      if (selectionTimeout) clearTimeout(selectionTimeout);
      document.removeEventListener('mouseup', handleMouseUp, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  if (!showPopup || !selectedText) return (
    <div ref={probeRef} className="fixed left-0 top-0 w-0 h-0 pointer-events-none" />
  );

  return (
    <>
    <div ref={probeRef} className="fixed left-0 top-0 w-0 h-0 pointer-events-none" />
    <div
      className="text-selection-tooltip fixed z-[9999]"
      style={{
        left: `${popupPosition.x}px`,
        top: `${popupPosition.y}px`,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <Button
        type="button"
        variant="ghost"
        className="flex items-center gap-2 rounded-xl bg-white px-3.5 py-2 text-sm font-medium text-gray-900 shadow-lg border border-gray-200 transition-colors hover:bg-gray-50"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleAskAgent();
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <img src="/assets/images/weldagent/logo-light.png" alt="" className="h-4 w-4" />
        <span>Ask Agent</span>
      </Button>
    </div>
    </>
  );
}
