/**
 * What a bank line is connected to, from whichever backend answers.
 *
 * Where the edition offers `books-bank-links` (the Rust backend) one call
 * returns everything expanded (`GET /bank-transactions/:id/links`). On Global
 * that route does not exist: the line's own row is read instead and its ids
 * are resolved into what the panel shows, as far as the row allows.
 */

import { useMemo } from 'react';
import {
  useAccountingAccounts,
  useAccountingBill,
  useAccountingContactNames,
  useAccountingInvoice,
} from '@/hooks/queries/use-accounting-queries';
import { useBankLine, useBankLineLinks } from '@/hooks/queries/use-weldbooks-banking-queries';
import type { BankLine, BankLineLinks, BankLineProcessedAs } from '@/lib/api/domains/weldbooks-banking';
import { isFeatureAvailable } from '@/lib/edition';

/** How a line stands, from the ids on its row (the same rule the links route applies). */
export function processedAsOf(line: BankLine): BankLineProcessedAs {
  if (line.status === 'excluded') return 'excluded';
  if (line.status !== 'reconciled') return 'unprocessed';
  if (line.depositId) return 'deposit';
  if (line.reconciledPaymentId || line.reconciledInvoiceId || line.reconciledBillId) return 'payment';
  if (line.categoryAccountId) return 'category';
  return 'payment';
}

interface RowLookups {
  invoice?: { id: string; number: string | null; contactId: string | null; contactName: string | null; status: string | null; total: string | null };
  bill?: { id: string; number: string | null; contactId: string | null; contactName: string | null; status: string | null; total: string | null };
  account?: { id: string; code: string | null; name: string | null };
  contactName?: string;
}

/** The links of a line from its row alone (Global): what the row's ids and the lookups can say. */
export function linksFromLine(line: BankLine, lookups: RowLookups): BankLineLinks {
  const allocations: BankLineLinks['allocations'] = [];
  if (line.reconciledInvoiceId) {
    allocations.push({
      documentType: 'invoice',
      documentId: line.reconciledInvoiceId,
      number: lookups.invoice?.number ?? null,
      contactId: lookups.invoice?.contactId ?? line.contactId ?? null,
      contactName: lookups.invoice?.contactName ?? null,
      amount: String(Math.abs(Number(line.amount) || 0)),
      status: lookups.invoice?.status ?? null,
    });
  }
  if (line.reconciledBillId) {
    allocations.push({
      documentType: 'bill',
      documentId: line.reconciledBillId,
      number: lookups.bill?.number ?? null,
      contactId: lookups.bill?.contactId ?? line.contactId ?? null,
      contactName: lookups.bill?.contactName ?? null,
      amount: String(Math.abs(Number(line.amount) || 0)),
      status: lookups.bill?.status ?? null,
    });
  }
  return {
    transaction: line,
    processedAs: processedAsOf(line),
    payment: null,
    allocations,
    journalEntry: line.journalEntryId
      ? { id: line.journalEntryId, entryNumber: null, date: line.date, description: null, sourceType: null, sourceId: null }
      : null,
    deposit: line.depositId ? { id: line.depositId, date: line.date, amount: line.amount, reference: null } : null,
    category: line.categoryAccountId
      ? {
          accountId: line.categoryAccountId,
          accountCode: lookups.account?.code ?? null,
          accountName: lookups.account?.name ?? null,
          taxRateId: null,
          taxRateName: null,
        }
      : null,
    contact: line.contactId ? { id: line.contactId, name: lookups.contactName ?? null } : null,
    documents: [],
  };
}

export interface BankTransactionLinks {
  links: BankLineLinks | undefined;
  isLoading: boolean;
  isError: boolean;
  /** True where the edition has the links route; false when the panel works from the bare row. */
  expanded: boolean;
}

export function useBankTransactionLinks(id: string): BankTransactionLinks {
  const expanded = isFeatureAvailable('books-bank-links');
  const linksQuery = useBankLineLinks(id, { enabled: expanded });
  const lineQuery = useBankLine(id, { enabled: !expanded });
  const line = lineQuery.data;

  const invoice = useAccountingInvoice(!expanded && line?.reconciledInvoiceId ? line.reconciledInvoiceId : '').data?.data;
  const bill = useAccountingBill(!expanded && line?.reconciledBillId ? line.reconciledBillId : '').data?.data;
  const accountId = !expanded ? line?.categoryAccountId : null;
  const accounts = useAccountingAccounts({ includeInactive: true }, { enabled: !!accountId }).data?.data;
  const contactNames = useAccountingContactNames(!expanded && line?.contactId ? [line.contactId] : []);

  const fallback = useMemo(() => {
    if (!line) return undefined;
    const account = accountId ? accounts?.find((candidate) => candidate.id === accountId) : undefined;
    return linksFromLine(line, {
      invoice: invoice
        ? {
            id: invoice.id,
            number: invoice.invoiceNumber,
            contactId: invoice.contactId,
            contactName: invoice.contactName,
            status: invoice.status,
            total: invoice.total,
          }
        : undefined,
      bill: bill
        ? {
            id: bill.id,
            number: bill.billNumber,
            contactId: bill.contactId,
            contactName: bill.contactName,
            status: bill.status,
            total: bill.total,
          }
        : undefined,
      account: account ? { id: account.id, code: account.code, name: account.name } : undefined,
      contactName: line.contactId ? contactNames.get(line.contactId) : undefined,
    });
  }, [line, invoice, bill, accountId, accounts, contactNames]);

  if (expanded) {
    return { links: linksQuery.data, isLoading: linksQuery.isLoading, isError: linksQuery.isError, expanded };
  }
  return { links: fallback, isLoading: lineQuery.isLoading, isError: lineQuery.isError, expanded };
}
