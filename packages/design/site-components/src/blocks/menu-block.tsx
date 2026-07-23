import React from 'react';

export interface MenuItem {
  label: string;
  url: string;
  children?: MenuItem[];
}

export interface MenuBlockProps {
  items?: MenuItem[];
  orientation?: 'horizontal' | 'vertical';
  alignment?: 'left' | 'center' | 'right';
  mode?: 'live' | 'preview';
}

export function MenuBlock({
  items = [],
  orientation = 'horizontal',
  alignment = 'left',
  mode = 'live'
}: MenuBlockProps) {
  const [openDropdown, setOpenDropdown] = React.useState<number | null>(null);

  const alignmentClass = {
    left: 'justify-start',
    center: 'justify-center',
    right: 'justify-end',
  }[alignment];

  const orientationClass = orientation === 'horizontal'
    ? `flex ${alignmentClass} gap-6`
    : 'flex flex-col gap-2';

  if (items.length === 0) {
    items = [
      { label: 'Home', url: '/' },
      { label: 'Shop', url: '/shop' },
      { label: 'About', url: '/about' },
      { label: 'Contact', url: '/contact' },
    ];
  }

  return (
    <nav className={orientationClass}>
      {items.map((item, index) => (
        <div key={index} className="relative group">
          <a
            href={mode === 'live' ? item.url : '#'}
            className="text-gray-700 hover:text-gray-900 font-medium transition-colors py-2 inline-block"
            onMouseEnter={() => item.children && setOpenDropdown(index)}
            onMouseLeave={() => setOpenDropdown(null)}
          >
            {item.label}
          </a>

          {item.children && item.children.length > 0 && (
            <div
              className={`absolute left-0 top-full mt-1 bg-white shadow-lg rounded-lg py-2 min-w-[200px] z-50 ${
                openDropdown === index ? 'block' : 'hidden'
              }`}
              onMouseEnter={() => setOpenDropdown(index)}
              onMouseLeave={() => setOpenDropdown(null)}
            >
              {item.children.map((child, childIndex) => (
                <a
                  key={childIndex}
                  href={mode === 'live' ? child.url : '#'}
                  className="block px-4 py-2 text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition-colors"
                >
                  {child.label}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
