export interface Invoice {
  id: string;
  invoiceNumber: string;
  contactId?: string;
  contactName: string;
  contactEmail?: string;
  issueDate: string;
  dueDate: string;
  status: 'draft' | 'sent' | 'viewed' | 'paid' | 'overdue' | 'cancelled' | 'refunded';
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  balanceDue: string;
  notes?: string;
  reference?: string;
  items?: InvoiceItem[];
  payments?: Payment[];
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  amount: string;
  taxAmount: string;
  accountId?: string;
  sortOrder: number;
}

export interface Bill {
  id: string;
  billNumber: string;
  contactId?: string;
  contactName: string;
  issueDate: string;
  dueDate: string;
  status: 'pending' | 'approved' | 'paid' | 'overdue' | 'rejected';
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  balanceDue: string;
  notes?: string;
  documentId?: string;
  items?: BillItem[];
  createdAt: string;
}

export interface BillItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  amount: string;
  taxAmount: string;
  accountId?: string;
  sortOrder: number;
}

export interface BankAccount {
  id: string;
  name: string;
  iban?: string;
  bankName?: string;
  accountType: string;
  currency: string;
  currentBalance: string;
  isActive: boolean;
  lastSyncAt?: string;
}

export interface BankTransaction {
  id: string;
  bankAccountId: string;
  date: string;
  description: string;
  amount: string;
  type: 'credit' | 'debit';
  status: 'pending' | 'unmatched' | 'matched' | 'reconciled' | 'excluded';
  counterpartyName?: string;
  reference?: string;
}

export interface Payment {
  id: string;
  invoiceId?: string;
  billId?: string;
  amount: string;
  date: string;
  method?: string;
}

export interface VatReturn {
  id: string;
  period: string;
  year: number;
  status: 'draft' | 'submitted' | 'accepted' | 'rejected';
  totalSalesTax: string;
  totalPurchaseTax: string;
  netAmount: string;
  filedAt?: string;
  createdAt: string;
}

export interface TaxRate {
  id: string;
  name: string;
  rate: string;
  isActive: boolean;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  balance: string;
  isActive: boolean;
}

export interface DashboardData {
  invoices: {
    total: number;
    draft: number;
    sent: number;
    paid: number;
    overdue: number;
    totalOutstanding: string;
    revenueMonth: string;
  };
  bills: {
    total: number;
    totalOutstanding: string;
  };
  bankAccounts: BankAccount[];
  recentInvoices: Invoice[];
  pendingDocuments: number;
}

export interface QuickExpense {
  amount: number;
  category: string;
  description?: string;
  vendorName?: string;
  date?: string;
  documentId?: string;
  accountId?: string;
  taxRate?: number;
}

export type ExpenseCategory = 'food' | 'transport' | 'office' | 'travel' | 'supplies' | 'utilities' | 'insurance' | 'other';
