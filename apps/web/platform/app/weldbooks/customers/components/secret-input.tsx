import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@weldsuite/ui/components/input';

interface SecretInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  inputMode?: 'numeric' | 'text';
  showLabel: string;
  hideLabel: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/**
 * A text input that hides what is typed (a TIN, an account number) until the
 * eye is pressed. Browsers and password managers are told to leave it alone.
 */
export function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  inputMode = 'numeric',
  showLabel,
  hideLabel,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: Readonly<SecretInputProps>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        aria-describedby={describedBy}
        aria-invalid={invalid}
        className="pr-10 font-mono"
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:text-foreground"
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
}
