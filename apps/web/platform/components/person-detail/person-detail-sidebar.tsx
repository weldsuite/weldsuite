
import { ReactNode, useState, useRef, useEffect } from 'react';
import { Check, Circle, X } from 'lucide-react';
import { Input } from '@weldsuite/ui/components/input';
import { useTranslations } from '@weldsuite/i18n/client';

export interface SidebarField {
  icon?: ReactNode;
  label: string;
  value?: string | ReactNode;
  /** Field key for identifying when saving */
  key?: string;
  /** If true, shows as editable with "Add" link */
  editable?: boolean;
  /** Custom click handler for editable fields */
  onEdit?: () => void;
  /** Callback when value is saved */
  onSave?: (value: string) => void;
}

interface SidebarSection {
  title?: string;
  fields: SidebarField[];
}

export interface PersonDetailSidebarProps {
  sections: SidebarSection[];
  className?: string;
  /** Global save handler - receives field key and new value */
  onFieldSave?: (fieldKey: string, value: string) => void;
}

function EditableField({
  field,
  onSave
}: {
  field: SidebarField;
  onSave?: (fieldKey: string, value: string) => void;
}) {
  const t = useTranslations();
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Get display value directly from props
  const displayValue = typeof field.value === 'string' ? field.value : '';

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEditing = () => {
    setInputValue(displayValue);
    setIsEditing(true);
  };

  const handleSave = () => {
    const trimmedValue = inputValue.trim();
    if (trimmedValue) {
      if (field.onSave) {
        field.onSave(trimmedValue);
      } else if (onSave && field.key) {
        onSave(field.key, trimmedValue);
      }
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  const handleClick = () => {
    if (field.onEdit) {
      field.onEdit();
    } else {
      handleStartEditing();
    }
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-3 w-full">
        {field.icon ? (
          field.icon
        ) : (
          <Circle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-sm text-muted-foreground flex-shrink-0">{field.label}</span>
        <div className="flex items-center gap-1 ml-auto">
          <Input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSave}
            className="h-6 text-sm px-2 py-0 w-[180px] border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-muted/50"
            placeholder={t('sweep.weldcrm.personDetailSidebar.addField', { field: field.label.toLowerCase() })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {field.icon ? (
        field.icon
      ) : field.editable ? (
        <Circle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      ) : field.value ? (
        <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
      ) : (
        <Circle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      )}
      <span className="text-sm text-muted-foreground">{field.label}</span>
      {field.editable && !displayValue ? (
        <span
          className="text-sm text-primary ml-auto cursor-pointer hover:underline"
          onClick={handleClick}
        >
          {t('sweep.weldcrm.personDetailSidebar.add')}
        </span>
      ) : field.editable && displayValue ? (
        <span
          className="text-sm text-foreground ml-auto truncate max-w-[180px] cursor-pointer hover:text-primary"
          onClick={handleClick}
          title={t('sweep.weldcrm.personDetailSidebar.clickToEdit')}
        >
          {displayValue}
        </span>
      ) : (
        <span className="text-sm text-foreground ml-auto truncate max-w-[180px]">
          {displayValue || '-'}
        </span>
      )}
    </div>
  );
}

export function PersonDetailSidebar({ sections, className, onFieldSave }: PersonDetailSidebarProps) {
  return (
    <div className={`w-full md:w-80 flex-shrink-0 md:pr-8 pb-6 md:pb-0 border-b md:border-b-0 md:border-r border-border/40 ${className || ''}`}>
      {sections.map((section, sectionIndex) => (
        <div
          key={sectionIndex}
          className={`${sectionIndex < sections.length - 1 ? 'pb-5 border-b border-border/50' : 'py-5'} ${sectionIndex > 0 ? 'py-5' : ''} space-y-3`}
        >
          {section.title && (
            <p className="text-sm font-medium text-foreground mb-3">{section.title}</p>
          )}
          {section.fields.map((field, fieldIndex) => (
            <EditableField
              key={fieldIndex}
              field={field}
              onSave={onFieldSave}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
