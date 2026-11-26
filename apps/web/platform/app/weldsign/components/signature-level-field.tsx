/**
 * The signature type of one signer or signing role: Simple, Advanced or
 * Qualified, each with its price in credits, and a line on what the signer
 * will have to do. Renders nothing where the install offers only simple
 * signatures (Global, or an install without a trust service provider).
 */

import { useId } from 'react';
import type { SignCapabilities, SignSignatureLevel } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { levelPrice, offersTrustLevels, pickableLevels } from '../lib/signature-levels';
import { ChoiceField } from './choice-field';

interface SignatureLevelFieldProps {
  value: SignSignatureLevel;
  capabilities: SignCapabilities | null;
  disabled?: boolean;
  onChange: (level: SignSignatureLevel) => void;
}

export function SignatureLevelField({ value, capabilities, disabled = false, onChange }: Readonly<SignatureLevelFieldProps>) {
  const { t, format } = useI18n();
  const te = t.weldsign.eidas;
  const hintId = useId();
  if (!offersTrustLevels(capabilities)) return null;

  const priceText = (level: SignSignatureLevel) => {
    const price = levelPrice(capabilities, level);
    if (price === null) return null;
    return format(price === 1 ? te.creditOne : te.creditMany, { count: price });
  };
  const options = pickableLevels(capabilities, value).map((level) => {
    const price = priceText(level);
    return { value: level, label: price ? format(te.levelOption, { level: te.levels[level], price }) : te.levels[level] };
  });
  const hint = format(te.hints[value], { provider: capabilities.provider ?? te.hints.noProvider });

  return (
    <div className="col-span-full flex flex-col gap-1.5">
      <ChoiceField label={te.level} value={value} options={options} disabled={disabled} describedBy={hintId} onChange={onChange} />
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
