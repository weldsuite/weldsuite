# Banking Transaction Import Guide

This document explains how to import bank transactions into WeldSuite using CSV files.

## Supported Formats

The import feature supports standard CSV files with the following formats:

### 1. Standard CSV Format (Recommended)

This is the most flexible format that works with most banking exports:

```csv
Date,Description,Amount,Type,Category,Reference,Notes
2024-01-15,Office Supplies Purchase,-50.00,DEBIT,Office Supplies,TXN001,Monthly supplies
2024-01-16,Client Payment,1000.00,CREDIT,Income,INV-2024-001,Payment for services
2024-01-17,Bank Transfer,500.00,TRANSFER,Internal,TRANS-001,Transfer to savings
```

**Required Columns:**
- **Date**: Transaction date (supports multiple formats)
- **Description**: Transaction description/memo
- **Amount**: Transaction amount (positive for credits, negative for debits)

**Optional Columns:**
- **Type**: CREDIT, DEBIT, or TRANSFER (auto-detected if not provided)
- **Category**: Transaction category
- **Reference**: Reference or transaction ID
- **Notes**: Additional notes or memo

### 2. Bank Statement CSV

Most banks export transactions in a similar format:

```csv
Transaction Date,Description,Debit,Credit,Balance
01/15/2024,Office Supplies,50.00,,9950.00
01/16/2024,Client Payment,,1000.00,10950.00
```

### 3. QuickBooks CSV

Compatible with QuickBooks export format:

```csv
Date,Num,Description,Memo,Account,Split,Debit,Credit
01/15/2024,TXN001,Office Supplies,Monthly supplies,Checking,Office Expense,50.00,
01/16/2024,INV001,Client Payment,Payment received,Checking,Income,,1000.00
```

## Supported Date Formats

The import parser automatically detects and handles multiple date formats:

- **YYYY-MM-DD** (ISO): `2024-01-15`
- **MM/DD/YYYY** (US): `01/15/2024`
- **DD/MM/YYYY** (European): `15/01/2024`
- **DD-MM-YYYY**: `15-01-2024`

## How to Import

### Step 1: Prepare Your CSV File

1. Export transactions from your bank or accounting software
2. Ensure the CSV contains at minimum: Date, Description, and Amount columns
3. Verify date formatting is consistent
4. Check that amounts are numeric (can include currency symbols like $ which will be stripped)

### Step 2: Upload via WeldSuite

1. Navigate to **Accounting > Banking**
2. Click the **Import** button in the top right
3. Select your CSV file format from the dropdown
4. (Optional) Select a specific bank account
5. Choose your CSV file
6. Click **Import Transactions**

### Step 3: Review Results

After import, you'll see:
- Number of transactions successfully imported
- Number of transactions skipped (duplicates)
- Any errors encountered during import

## Import Rules

### Duplicate Detection
- Transactions with identical dates, amounts, and descriptions are automatically detected
- Duplicates are skipped to prevent double-entry
- The skipped count is shown in the import results

### Transaction Type Detection
If the Type column is not provided:
- Positive amounts → CREDIT (deposits, income)
- Negative amounts → DEBIT (withdrawals, expenses)

### Amount Parsing
- Currency symbols ($, €, £, etc.) are automatically stripped
- Commas in numbers (1,000.00) are handled correctly
- Negative signs indicate debits/withdrawals

## Example Templates

### Template 1: Simple Format
```csv
Date,Description,Amount
2024-01-15,Salary Deposit,3000.00
2024-01-16,Rent Payment,-1200.00
2024-01-17,Utilities,-150.00
```

### Template 2: Detailed Format
```csv
Date,Description,Amount,Type,Category,Reference,Notes
2024-01-15,Salary Deposit,3000.00,CREDIT,Income,SAL-JAN-2024,Monthly salary
2024-01-16,Rent Payment,-1200.00,DEBIT,Rent,RENT-JAN,January rent
2024-01-17,Electric Bill,-75.00,DEBIT,Utilities,UTIL-001,Electric company
2024-01-17,Water Bill,-75.00,DEBIT,Utilities,UTIL-002,Water company
```

### Template 3: Bank Export Format
```csv
Date,Payee,Memo,Amount,Category
01/15/2024,ABC Corp,Invoice #123,1500.00,Revenue
01/16/2024,Office Depot,Supplies,-89.99,Office Expense
01/17/2024,AT&T,Phone bill,-125.00,Utilities
```

## Download Template

Click the **Template** button in the import dialog to download a pre-formatted CSV template with example transactions.

## Troubleshooting

### Common Issues

**Issue: "Invalid date format"**
- Solution: Ensure dates are in one of the supported formats
- Check for typos or mixed date formats in the same file

**Issue: "Invalid amount"**
- Solution: Verify amounts are numeric
- Remove any text or special characters (except . for decimals and - for negatives)

**Issue: "No valid transactions found"**
- Solution: Check that your CSV has the required columns (Date, Description, Amount)
- Verify column headers match expected names

**Issue: "Import failed"**
- Solution: Check file size (should be under 5MB)
- Ensure file is valid CSV format
- Try with a smaller batch of transactions first

### Best Practices

1. **Test with a small file first**: Import 5-10 transactions to verify formatting
2. **Clean your data**: Remove empty rows and ensure consistent formatting
3. **Backup before large imports**: Always keep a copy of your original CSV
4. **Review imported transactions**: Check the Banking page after import to verify accuracy
5. **Use categories**: Including category information helps with reporting

## API Integration

For developers, the import function is available as a server action:

```typescript
import { importTransactionsCSV } from '@/app/accounting/banking/actions';

const formData = new FormData();
formData.append('file', csvFile);
formData.append('accountId', 'optional-account-id');
formData.append('format', 'standard-csv');

const result = await importTransactionsCSV(formData);
```

## Limits

- Maximum file size: 5 MB
- Maximum transactions per import: 1,000
- Supported file types: CSV only (.csv)

## Need Help?

If you encounter issues with importing:
1. Download and review the template file
2. Compare your CSV structure to the examples above
3. Try importing a single transaction first to isolate formatting issues
4. Contact support with your CSV file (remove sensitive data first)
