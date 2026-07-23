interface TagLabelProps {
  tag: string;
  className?: string;
}

const tagColors = [
  { light: 'bg-blue-100 text-blue-700', dark: 'dark:bg-blue-900 dark:text-blue-300' },
  { light: 'bg-orange-100 text-orange-700', dark: 'dark:bg-orange-900 dark:text-orange-300' },
  { light: 'bg-green-100 text-green-700', dark: 'dark:bg-green-900 dark:text-green-300' },
  { light: 'bg-purple-100 text-purple-700', dark: 'dark:bg-purple-900 dark:text-purple-300' },
  { light: 'bg-pink-100 text-pink-700', dark: 'dark:bg-pink-900 dark:text-pink-300' },
  { light: 'bg-amber-100 text-amber-700', dark: 'dark:bg-amber-900 dark:text-amber-300' },
  { light: 'bg-cyan-100 text-cyan-700', dark: 'dark:bg-cyan-900 dark:text-cyan-300' },
  { light: 'bg-red-100 text-red-700', dark: 'dark:bg-red-900 dark:text-red-300' },
];

// Generate consistent color based on tag name
const getTagColor = (tagName: string) => {
  let hash = 0;
  for (let i = 0; i < tagName.length; i++) {
    hash = tagName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return tagColors[Math.abs(hash) % tagColors.length];
};

export function TagLabel({ tag, className = '' }: TagLabelProps) {
  const color = getTagColor(tag);

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-xs ${color.light} ${color.dark} ${className}`}
      style={{ borderRadius: '5px' }}
    >
      {tag}
    </span>
  );
}
