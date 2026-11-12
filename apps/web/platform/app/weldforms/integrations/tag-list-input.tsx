import { useEffect, useState } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';

/** Splits comma-separated text into trimmed, unique, non-empty tags. */
export function parseTags(text: string, max = 20): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of text.split(',')) {
    const tag = part.trim().slice(0, 100);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === max) break;
  }
  return tags;
}

/** Tags typed as comma-separated text; the list is committed as you type. */
export function TagListInput({
  id,
  label,
  value,
  onChange,
  placeholder,
}: Readonly<{ id: string; label: string; value: string[]; onChange: (tags: string[]) => void; placeholder?: string }>) {
  const [text, setText] = useState(value.join(', '));
  // Follow the saved value when it changes from outside (a reset after saving).
  useEffect(() => {
    setText((current) => (parseTags(current).join('\u0000') === value.join('\u0000') ? current : value.join(', ')));
  }, [value]);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseTags(e.target.value));
        }}
      />
    </div>
  );
}
