import type { ComponentProps } from 'react';
import { Globe2, ShieldCheck } from 'lucide-react';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { cn } from '@weldsuite/ui/lib/utils';

export type AiProviderRegion = 'eu' | 'outside-eu';

export type AiProviderBadgeProps = {
  /** Provider name as people know it ("Claude", "Mistral"). */
  provider: string;
  /** Where the provider processes the data. */
  region: AiProviderRegion;
  /** Text for the region, already translated ("outside the EU", "processed in the EU"). */
  regionLabel: string;
  /** Hide the icon (for dense lists). */
  hideIcon?: boolean;
} & Omit<ComponentProps<typeof SoftBadge>, 'tone' | 'children'>;

/**
 * Says which AI provider handled something and whether the data stayed in the
 * EU: "Claude · outside the EU" in amber, "Mistral · processed in the EU" in
 * green. The library holds no translations, so the region text is a prop.
 */
export function AiProviderBadge({
  provider,
  region,
  regionLabel,
  hideIcon,
  className,
  ...props
}: Readonly<AiProviderBadgeProps>) {
  const Icon = region === 'eu' ? ShieldCheck : Globe2;
  return (
    <SoftBadge
      tone={region === 'eu' ? 'success' : 'warning'}
      className={cn('gap-1 whitespace-nowrap font-normal', className)}
      data-region={region}
      {...props}
    >
      {!hideIcon && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="font-medium">{provider}</span>
      <span aria-hidden>·</span>
      <span>{regionLabel}</span>
    </SoftBadge>
  );
}
