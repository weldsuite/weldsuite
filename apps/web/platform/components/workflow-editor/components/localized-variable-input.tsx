import type { ComponentProps } from 'react';
import { VariableInput as BaseVariableInput } from '@weldsuite/ui/components/workflow-canvas/parts/variable-input';
import { useI18n } from '@/lib/i18n/provider';

type BaseVariableInputProps = ComponentProps<typeof BaseVariableInput>;

export function VariableInput(props: BaseVariableInputProps) {
  const { t } = useI18n();
  const { labels: labelsProp, ...rest } = props;
  return (
    <BaseVariableInput
      {...rest}
      labels={{ ...t.weldconnect.variablePicker, ...labelsProp }}
    />
  );
}
