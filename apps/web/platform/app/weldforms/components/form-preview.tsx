/**
 * The live preview: the real renderer in `preview` mode (nothing is stored),
 * at desktop or phone width, in either layout. Conversational previews start
 * at the selected block.
 */

import { useMemo } from 'react';
import { FormRenderer } from '@weldsuite/forms-renderer';
import '@weldsuite/forms-renderer/styles.css';
import type { FormDefinition, FormLayout, FormThemeTokens } from '@weldsuite/forms-engine';
import { cn } from '@/lib/utils';
import { getRendererLabels } from '../lib/renderer-labels';

export type PreviewDevice = 'desktop' | 'phone';

interface Props {
  definition: FormDefinition;
  theme?: FormThemeTokens;
  layout?: FormLayout;
  device?: PreviewDevice;
  /** Conversational layout: open at this block (a welcome screen or ending id opens at the start). */
  startAtBlockId?: string;
  /** Remount key; change it to restart the preview. */
  resetKey?: string;
  className?: string;
}

export function FormPreview({ definition, theme, layout, device = 'desktop', startAtBlockId, resetKey, className }: Readonly<Props>) {
  const labels = useMemo(() => getRendererLabels(definition.presentation.language), [definition.presentation.language]);
  const effectiveLayout = layout ?? definition.presentation.layout;
  const start = effectiveLayout === 'conversational' ? startAtBlockId : undefined;

  return (
    <div
      className={cn(
        'mx-auto h-full overflow-hidden border bg-background shadow-sm transition-[width] duration-200',
        device === 'phone' ? 'w-[375px] max-w-full rounded-[2rem] border-4' : 'w-full rounded-lg',
        className,
      )}
    >
      <FormRenderer
        key={`${resetKey ?? ''}:${effectiveLayout}:${start ?? ''}`}
        definition={definition}
        theme={theme}
        layout={effectiveLayout}
        labels={labels}
        mode="preview"
        embedded
        startAtBlockId={start}
        className="h-full"
      />
    </div>
  );
}
