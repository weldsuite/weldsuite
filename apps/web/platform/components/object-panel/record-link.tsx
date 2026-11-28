/**
 * A link to another record that never leaves the page: the record opens as a
 * stacked object panel on top of the one that is showing. The chip's `href` is
 * the same stack as a URL, so Cmd/Ctrl-click and middle-click open it in a
 * new tab (on a page that syncs `?stack=`, see `useObjectPanelUrlSync`).
 */

import { useCallback } from 'react';
import {
  ArrowLeftRight,
  Banknote,
  BookText,
  Building2,
  FileText,
  Hash,
  Package,
  Percent,
  PiggyBank,
  Receipt,
  ScrollText,
  ShoppingCart,
  User,
  Wallet,
} from 'lucide-react';
import { RecordChip, type RecordChipProps } from '@weldsuite/ui/components/record-chip';
import { useObjectPanel } from '@/components/object-panel';
import { withQuery } from '@/lib/with-query';
import { serializeStack } from './stack-url';
import type { ObjectType } from './types';

/** The icon of each record type the WeldBooks screens link to. */
const RECORD_ICONS: Record<string, RecordChipProps['icon']> = {
  invoice: FileText,
  quote: ScrollText,
  bill: Receipt,
  weldbooks_contact: User,
  journal_entry: BookText,
  ledger_account: Hash,
  bank_transaction: ArrowLeftRight,
  bank_account: Building2,
  deposit: PiggyBank,
  fixed_asset: Package,
  payroll_run: Wallet,
  vat_return: Percent,
  order: ShoppingCart,
  payment: Banknote,
};

export interface RecordTarget {
  type: ObjectType;
  id: string;
}

export interface RecordLinkTarget {
  /** The stack as an address, for a new tab. */
  href: string;
  /** Stacks the record's panel on top of the current one. */
  onOpen: () => void;
}

/** `(type, id)` to the two things a `RecordChip` needs. */
export function useRecordLink(): (target: RecordTarget) => RecordLinkTarget {
  // The stack changes whenever a panel opens or closes, which re-renders the chips and refreshes their href.
  const { stack, open } = useObjectPanel();

  return useCallback(
    ({ type, id }: RecordTarget) => {
      const next = [...stack, { type, id, mode: 'panel' as const, depth: stack.length }];
      // The address bar, not the router's internal path: it carries the workspace prefix.
      const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
      params.set('stack', serializeStack(next));
      const path = typeof window === 'undefined' ? '' : window.location.pathname;
      return {
        href: withQuery(path, params.toString()),
        onOpen: () => open({ type, id, stack: true }),
      };
    },
    [stack, open],
  );
}

export type RecordLinkProps = RecordTarget &
  Omit<RecordChipProps, 'href' | 'onOpen' | 'icon'> & {
    /** Defaults to the type's icon; `null` shows none. */
    icon?: RecordChipProps['icon'] | null;
  };

/** A `RecordChip` that stacks the record's panel. */
export function RecordLink({ type, id, icon, ...chip }: Readonly<RecordLinkProps>) {
  const link = useRecordLink();
  const { href, onOpen } = link({ type, id });
  return <RecordChip {...chip} icon={icon === null ? undefined : (icon ?? RECORD_ICONS[type])} href={href} onOpen={onOpen} />;
}
