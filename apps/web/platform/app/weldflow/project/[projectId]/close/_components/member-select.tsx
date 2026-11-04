import type { ComponentProps } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { PickerMember } from '../_lib/members';

/** Radix selects cannot hold an empty string, so "no one" is this value. */
export const NO_ONE = '__none__';

interface MemberSelectProps extends Omit<ComponentProps<typeof SelectTrigger>, 'value' | 'onChange' | 'children'> {
  members: readonly PickerMember[];
  value: string | null;
  onChange: (userId: string | null) => void;
  /** Offers a first choice that stores null. */
  noneLabel?: string;
  placeholder?: string;
  /** Marks a member in the list, for example "(sponsor)". */
  suffixOf?: (member: PickerMember) => string | null;
}

/** A select over the workspace's people. Pass `aria-label` or an `id` with a label. */
export function MemberSelect({ members, value, onChange, noneLabel, placeholder, suffixOf, ...triggerProps }: Readonly<MemberSelectProps>) {
  return (
    <Select value={value ?? (noneLabel ? NO_ONE : '')} onValueChange={(next) => onChange(next === NO_ONE ? null : next)}>
      <SelectTrigger {...triggerProps}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel ? <SelectItem value={NO_ONE}>{noneLabel}</SelectItem> : null}
        {members.map((member) => {
          const suffix = suffixOf?.(member);
          return (
            <SelectItem key={member.userId} value={member.userId}>
              {suffix ?? member.name}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
