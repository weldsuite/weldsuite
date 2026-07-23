import React from 'react';

export interface AccordionItem {
  title: string;
  content: string;
}

export interface AccordionBlockProps {
  items?: AccordionItem[];
  allowMultiple?: boolean;
  defaultOpen?: number[];
  mode?: 'live' | 'preview';
}

export function AccordionBlock({
  items = [],
  allowMultiple = false,
  defaultOpen = [0],
  mode = 'live'
}: AccordionBlockProps) {
  const [openItems, setOpenItems] = React.useState<number[]>(defaultOpen);

  if (items.length === 0) {
    items = [
      { title: 'Question 1', content: 'Answer to question 1' },
      { title: 'Question 2', content: 'Answer to question 2' },
      { title: 'Question 3', content: 'Answer to question 3' },
    ];
  }

  const toggleItem = (index: number) => {
    if (allowMultiple) {
      setOpenItems(prev =>
        prev.includes(index)
          ? prev.filter(i => i !== index)
          : [...prev, index]
      );
    } else {
      setOpenItems(prev =>
        prev.includes(index) ? [] : [index]
      );
    }
  };

  return (
    <div className="space-y-2">
      {items.map((item, index) => {
        const isOpen = openItems.includes(index);

        return (
          <div key={index} className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              onClick={() => toggleItem(index)}
              className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
            >
              <span className="font-medium text-gray-900">{item.title}</span>
              <svg
                className={`w-5 h-5 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {isOpen && (
              <div className="px-6 py-4 border-t border-gray-200 bg-gray-50">
                <p className="text-gray-700">{item.content}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
