/**
 * Choices Bubble Component
 * Renders a message with clickable option buttons for workflow interactive steps
 */

import { useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface ChoiceOption {
  id: string;
  label: string;
  value: string;
}

interface ChoicesBubbleProps {
  messageId: string;
  content: string;
  options: ChoiceOption[];
  selectedOptionId?: string;
  onSelect: (messageId: string, optionId: string, value: string) => void;
  isDisabled?: boolean;
}

export function ChoicesBubble({
  messageId,
  content,
  options,
  selectedOptionId,
  onSelect,
  isDisabled = false,
}: ChoicesBubbleProps) {
  const [selecting, setSelecting] = useState<string | null>(null);
  const hasResponded = !!selectedOptionId;

  const handleSelect = async (option: ChoiceOption) => {
    if (hasResponded || isDisabled || selecting) return;
    setSelecting(option.id);
    onSelect(messageId, option.id, option.value);
  };

  return (
    <div className="flex flex-col items-start gap-2 max-w-[85%]">
      {/* Prompt message */}
      <div
        className="px-4 py-3 rounded-2xl bg-[#F5F5F5] text-black"
        style={{
          borderBottomLeftRadius: '4px',
        }}
      >
        <p className="text-sm whitespace-pre-wrap leading-relaxed break-words">
          {content}
        </p>
      </div>

      {/* Option buttons */}
      <div className="flex flex-col gap-1.5 w-full">
        {options.map((option) => {
          const isSelected = selectedOptionId === option.id;
          const isCurrentlySelecting = selecting === option.id;

          return (
            <button
              key={option.id}
              onClick={() => handleSelect(option)}
              disabled={hasResponded || isDisabled || !!selecting}
              className={cn(
                'w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium transition-all border',
                isSelected
                  ? 'bg-black text-white border-black'
                  : hasResponded
                    ? 'bg-gray-50 text-gray-400 border-gray-200 cursor-default'
                    : 'bg-white text-black border-gray-200 hover:border-gray-400 hover:bg-gray-50 active:bg-gray-100',
                isCurrentlySelecting && 'opacity-70'
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span>{option.label}</span>
                {isSelected && <Check className="h-4 w-4 shrink-0" />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
