import { useState } from 'react';
import { defaultProps } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { getBlockEditorStrings } from '../strings';

export const CALLOUT_ICONS = ['💡', 'ℹ️', '✅', '⚠️', '❗', '❓', '📌', '🔥', '⭐', '📝', '🚀', '🎯'] as const;

/**
 * Notion-style callout: an emoji and a tinted box around a line of text.
 * The tint comes from the block's `backgroundColor` (the slash menu's
 * background-color commands change it); `default` renders the neutral grey
 * set in globals.css.
 */
export const CalloutBlock = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: {
      textAlignment: defaultProps.textAlignment,
      textColor: defaultProps.textColor,
      backgroundColor: defaultProps.backgroundColor,
      icon: { default: '💡' },
    },
    content: 'inline',
  },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="bn-callout">
        <CalloutIcon
          icon={block.props.icon}
          editable={editor.isEditable}
          onChange={(icon) => editor.updateBlock(block, { props: { icon } })}
        />
        <div className="bn-callout-content" ref={contentRef} />
      </div>
    ),
  },
);

function CalloutIcon({
  icon,
  editable,
  onChange,
}: Readonly<{ icon: string; editable: boolean; onChange: (icon: string) => void }>) {
  const t = getBlockEditorStrings();
  const [open, setOpen] = useState(false);

  if (!editable) {
    return (
      <span contentEditable={false} className="bn-callout-icon">
        {icon}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          contentEditable={false}
          aria-label={t.callout.changeIcon}
          title={t.callout.changeIcon}
          className="bn-callout-icon cursor-pointer rounded hover:bg-foreground/10"
        >
          {icon}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-auto grid-cols-6 gap-1 p-2">
        {CALLOUT_ICONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              onChange(option);
              setOpen(false);
            }}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-lg hover:bg-accent"
          >
            {option}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
