import React from 'react';

export interface TabItem {
  title: string;
  content: string;
}

export interface TabsBlockProps {
  items?: TabItem[];
  defaultTab?: number;
  variant?: 'underline' | 'pills' | 'boxed';
  mode?: 'live' | 'preview';
}

export function TabsBlock({
  items = [],
  defaultTab = 0,
  variant = 'underline',
  mode = 'live'
}: TabsBlockProps) {
  const [activeTab, setActiveTab] = React.useState(defaultTab);

  if (items.length === 0) {
    items = [
      { title: 'Tab 1', content: 'Content for tab 1' },
      { title: 'Tab 2', content: 'Content for tab 2' },
      { title: 'Tab 3', content: 'Content for tab 3' },
    ];
  }

  const getTabClasses = (isActive: boolean) => {
    const baseClasses = 'px-4 py-2 font-medium transition-colors cursor-pointer';

    switch (variant) {
      case 'underline':
        return `${baseClasses} border-b-2 ${
          isActive
            ? 'border-gray-900 text-gray-900'
            : 'border-transparent text-gray-500 hover:text-gray-700'
        }`;
      case 'pills':
        return `${baseClasses} rounded-full ${
          isActive
            ? 'bg-gray-900 text-white'
            : 'text-gray-700 hover:bg-gray-100'
        }`;
      case 'boxed':
        return `${baseClasses} border ${
          isActive
            ? 'border-gray-900 bg-gray-900 text-white'
            : 'border-gray-200 text-gray-700 hover:border-gray-300'
        }`;
      default:
        return baseClasses;
    }
  };

  const containerClasses = {
    underline: 'flex gap-6 border-b border-gray-200',
    pills: 'flex gap-2',
    boxed: 'flex gap-0',
  }[variant];

  return (
    <div className="w-full">
      {/* Tab Headers */}
      <div className={containerClasses}>
        {items.map((item, index) => (
          <button
            key={index}
            onClick={() => setActiveTab(index)}
            className={getTabClasses(activeTab === index)}
          >
            {item.title}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="mt-6 p-6 border border-gray-200 rounded-lg bg-white">
        <p className="text-gray-700">{items[activeTab]?.content}</p>
      </div>
    </div>
  );
}
