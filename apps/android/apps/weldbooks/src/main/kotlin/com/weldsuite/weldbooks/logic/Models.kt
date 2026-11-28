package com.weldsuite.weldbooks.logic

import java.math.BigDecimal

/** The app's own models. [com.weldsuite.weldbooks.BooksRepository] maps the generated API types to these, and nothing else does. */

data class Address(
    val line1: String? = null,
    val line2: String? = null,
    val city: String? = null,
    val state: String? = null,
    val postalCode: String? = null,
    val country: String? = null,
    val county: String? = null,
) {
    val isEmpty: Boolean get() = listOf(line1, line2, city, state, postalCode, country, county).all { it.isNullOrBlank() }
}

/** A company (legal entity) with WeldBooks on. */
data class Entity(
    val id: String,
    val name: String,
    val legalName: String? = null,
    val jurisdictionCode: String,
    val baseCurrency: String,
    val locale: String? = null,
    val address: Address? = null,
    val entityType: String? = null,
    val taxClassification: String? = null,
    val dba: String? = null,
    /** US: the EIN, when what is stored looks like one (a masked SSN never does). */
    val ein: String? = null,
    val vatNumber: String? = null,
    val registrationNumber: String? = null,
    val iban: String? = null,
    val bic: String? = null,
    val fiscalYearStart: Int? = null,
    val isDefault: Boolean = false,
    val isActive: Boolean = true,
)

/** One row of a document's tax: per rate (VAT, GST), per component and treatment (BR), or per jurisdiction and line (US). */
data class TaxRow(
    val name: String? = null,
    val rate: BigDecimal = BigDecimal.ZERO,
    val taxableAmount: BigDecimal = BigDecimal.ZERO,
    val taxAmount: BigDecimal = BigDecimal.ZERO,
    val jurisdictionCode: String? = null,
    val jurisdictionName: String? = null,
    val level: String? = null,
    val stateCode: String? = null,
    val exemptAmount: BigDecimal = BigDecimal.ZERO,
    val nonTaxableAmount: BigDecimal = BigDecimal.ZERO,
    val exemptReason: String? = null,
    val kind: String? = null,
    val component: String? = null,
    val treatment: String? = null,
)

data class DocumentLine(
    val id: String,
    val description: String,
    val quantity: BigDecimal,
    val unitPrice: BigDecimal,
    val taxRate: BigDecimal,
    val lineTotal: BigDecimal,
    val taxCode: String? = null,
    val accrueUseTax: Boolean = false,
)

/** An invoice or a credit note. */
data class Invoice(
    val id: String,
    val number: String?,
    val type: String,
    val status: String,
    val contactId: String,
    val contactName: String?,
    val contactEmail: String? = null,
    val issueDate: String,
    val dueDate: String,
    val currency: String?,
    val subtotal: BigDecimal = BigDecimal.ZERO,
    val taxTotal: BigDecimal = BigDecimal.ZERO,
    val total: BigDecimal = BigDecimal.ZERO,
    val amountPaid: BigDecimal = BigDecimal.ZERO,
    val balanceDue: BigDecimal = BigDecimal.ZERO,
    val notes: String? = null,
    val reference: String? = null,
    val billingAddress: Address? = null,
    val shippingAddress: Address? = null,
    val taxBreakdown: List<TaxRow> = emptyList(),
    val taxWarnings: List<String> = emptyList(),
    val lines: List<DocumentLine> = emptyList(),
) {
    val isCreditNote: Boolean get() = type == "credit_note"

    /** The status as the app shows it: `partial` reads as partly paid, and an open invoice past its due date as overdue. */
    fun displayStatus(today: java.time.LocalDate = Days.today()): String = Statuses.invoice(status, dueDate, balanceDue, today)
}

data class Bill(
    val id: String,
    val number: String?,
    val status: String,
    val approvalStatus: String?,
    val contactId: String,
    val contactName: String?,
    val issueDate: String,
    val dueDate: String,
    val currency: String?,
    val subtotal: BigDecimal = BigDecimal.ZERO,
    val taxTotal: BigDecimal = BigDecimal.ZERO,
    val total: BigDecimal = BigDecimal.ZERO,
    val amountPaid: BigDecimal = BigDecimal.ZERO,
    val balanceDue: BigDecimal = BigDecimal.ZERO,
    val notes: String? = null,
    val reference: String? = null,
    val sourceDocumentId: String? = null,
    val deliveryAddress: Address? = null,
    val taxBreakdown: List<TaxRow> = emptyList(),
    val lines: List<DocumentLine> = emptyList(),
) {
    fun displayStatus(today: java.time.LocalDate = Days.today()): String =
        Statuses.bill(status, approvalStatus, dueDate, balanceDue, today)
}

/** What OCR read from a receipt, as a bill form prefill. */
data class BillPrefill(
    val contactName: String?,
    val externalReference: String?,
    val issueDate: String?,
    val dueDate: String?,
    val currency: String?,
    val items: List<PrefillLine>,
    val subtotal: BigDecimal?,
    val taxTotal: BigDecimal?,
    val total: BigDecimal?,
    val sourceDocumentId: String,
    val matchedContactId: String?,
)

data class PrefillLine(
    val description: String,
    val quantity: String,
    val unitPrice: String,
    val taxRate: String?,
    val sortOrder: Int,
)

data class GlAccount(val id: String, val code: String, val name: String, val type: String, val isActive: Boolean)

data class BankAccount(
    val id: String,
    val name: String,
    val iban: String?,
    val bankName: String?,
    val accountType: String?,
    val routingNumber: String?,
    val accountNumberLast4: String?,
    val currency: String?,
    val balance: BigDecimal,
    val lastImportDate: String?,
)

data class BankTransaction(
    val id: String,
    val bankAccountId: String,
    val date: String,
    val description: String?,
    val amount: BigDecimal,
    val status: String,
    val counterpartyName: String?,
    /** The bank's reference (payment reference, end-to-end id), as the platform's Reference column. */
    val reference: String? = null,
)

data class MatchSuggestion(
    val id: String,
    val type: String,
    val number: String?,
    val contactName: String?,
    val amount: BigDecimal,
    val confidence: Double,
)

data class UnmatchedTransaction(val transaction: BankTransaction, val suggestions: List<MatchSuggestion>)

data class ReconciliationStats(val unmatched: Int, val matched: Int, val pendingAmount: BigDecimal)

data class ContactPerson(val name: String, val email: String?, val phone: String?)

data class Contact(
    val id: String,
    val name: String,
    /** `company`, `person`, or null for an older contact. */
    val kind: String?,
    /** `customer`, `supplier`, `both` or `none`. */
    val role: String,
    val email: String?,
    val phone: String?,
    val vatNumber: String?,
    val contactPerson: ContactPerson?,
    val billingAddress: Address?,
    val shippingAddress: Address?,
    val is1099Vendor: Boolean,
    val tinType: String?,
    val tinLast4: String?,
) {
    val city: String? get() = billingAddress?.city
}

data class ContactBalance(val receivable: BigDecimal, val payable: BigDecimal)

/** An invoice to be paid or a bill to pay, on the dashboard's "Due this week". */
data class DueItem(
    val kind: String,
    val id: String,
    val number: String?,
    val contactName: String?,
    val dueDate: String,
    val amount: BigDecimal,
    val currency: String?,
)

/** A payment on the dashboard: `received` on an invoice, `sent` on a bill. */
data class RecentPayment(
    val id: String,
    val type: String?,
    val date: String,
    val amount: BigDecimal,
    val currency: String?,
    val method: String?,
    val reference: String?,
    val invoiceId: String?,
    val billId: String?,
)

/** One month of the ledger: revenue, expenses and net profit; null when nothing is known. */
data class TrendMonth(val month: String, val revenue: BigDecimal?, val expenses: BigDecimal?, val profit: BigDecimal?)

data class Dashboard(
    val currency: String,
    val outstanding: BigDecimal,
    val outstandingCount: Int,
    val overdue: BigDecimal,
    val overdueCount: Int,
    val payables: BigDecimal,
    val payablesCount: Int,
    val profitMonth: BigDecimal,
    /** The ledger balance of the money accounts, or the bank accounts' sum on an older server. */
    val cashBalance: BigDecimal = BigDecimal.ZERO,
    val bankAccountCount: Int = 0,
    val pendingDocuments: Int = 0,
    /** Invoices and bills due within the week, soonest first. */
    val dueThisWeek: List<DueItem> = emptyList(),
    val recentPayments: List<RecentPayment> = emptyList(),
    /** The last 24 months, oldest first. */
    val trend: List<TrendMonth> = emptyList(),
)

/** This year's running total of a metric against last year's, month by month (the platform's `yearToDateSeries`). */
data class YearToDate(
    val year: Int,
    /** `YYYY-MM` of the last month with figures; null without a trend. */
    val throughMonth: String?,
    /** Twelve points, January to December: this year's running total (null after this month) and last year's. */
    val points: List<Pair<BigDecimal?, BigDecimal?>>,
    val total: BigDecimal,
    val lastYearTotal: BigDecimal,
)

object DashboardSeries {
    /** Revenue, expenses or net profit of a month. */
    fun value(month: TrendMonth, metric: String): BigDecimal? = when (metric) {
        "expenses" -> month.expenses
        "profit" -> month.profit
        else -> month.revenue
    }

    /** An older server returns only revenue: expenses and profit are then unknown. */
    fun hasTrend(months: List<TrendMonth>): Boolean = months.isNotEmpty() && months.all { it.expenses != null }

    fun yearToDate(months: List<TrendMonth>, metric: String, today: java.time.LocalDate = Days.today()): YearToDate {
        val current = months.lastOrNull()?.month
        val year = current?.take(4)?.toIntOrNull() ?: today.year
        val byMonth = months.associate { it.month to value(it, metric) }
        fun key(y: Int, m: Int) = "%04d-%02d".format(y, m)
        var running: BigDecimal? = BigDecimal.ZERO
        var lastYearRunning: BigDecimal? = BigDecimal.ZERO
        var total = BigDecimal.ZERO
        var lastYearTotal = BigDecimal.ZERO
        val points = (1..12).map { m ->
            val month = key(year, m)
            val inRange = current != null && month <= current
            val value = byMonth[month]
            val lastYearValue = byMonth[key(year - 1, m)]
            running = if (inRange && running != null && value != null) running!! + value else null
            lastYearRunning = if (lastYearRunning != null && lastYearValue != null) lastYearRunning!! + lastYearValue else null
            if (month == current) {
                total = running ?: BigDecimal.ZERO
                lastYearTotal = lastYearRunning ?: BigDecimal.ZERO
            }
            (if (inRange) running else null) to lastYearRunning
        }
        return YearToDate(year, current, points, total, lastYearTotal)
    }

    /** Invoices and bills due by the end of the week (overdue ones too), soonest first, at most [limit]. */
    fun dueThisWeek(items: List<DueItem>, today: java.time.LocalDate = Days.today(), limit: Int = 10): List<DueItem> {
        val end = today.plusDays(7).toString()
        return items.filter { it.dueDate.take(10).isNotEmpty() && it.dueDate.take(10) <= end }
            .sortedBy { it.dueDate.take(10) }
            .take(limit)
    }
}

data class ProfitLoss(val revenue: BigDecimal, val expenses: BigDecimal, val netProfit: BigDecimal) {
    /** Percent of revenue, 0 without revenue. */
    val margin: BigDecimal
        get() = if (revenue.signum() > 0) {
            netProfit.multiply(BigDecimal(100)).divide(revenue, 1, java.math.RoundingMode.HALF_UP)
        } else {
            BigDecimal.ZERO
        }
}

data class BalanceRow(val code: String, val name: String, val balance: BigDecimal)

data class BalanceSheet(
    val assets: List<BalanceRow>,
    val liabilities: List<BalanceRow>,
    val equity: List<BalanceRow>,
    val totalAssets: BigDecimal,
    val totalLiabilities: BigDecimal,
    val totalEquity: BigDecimal,
    val totalLiabilitiesAndEquity: BigDecimal,
) {
    /** Sub-cent differences are rounding; anything more is a books problem worth showing. */
    val isBalanced: Boolean get() = totalAssets.subtract(totalLiabilitiesAndEquity).abs() < BigDecimal("0.01")
}

data class VatReturn(
    val id: String,
    val period: String,
    val year: Int,
    val status: String,
    val salesTax: BigDecimal,
    val purchaseTax: BigDecimal,
    val netAmount: BigDecimal,
    val periodStart: String?,
    val periodEnd: String?,
    val filedAt: String?,
    /** Boxes worth showing on a phone, by key (`r1a`), as numbers. */
    val boxes: Map<String, BigDecimal>,
) {
    /** Calculated or reviewed, not sent yet: it can be filed. */
    val isFileable: Boolean get() = status in setOf("draft", "calculated", "reviewed")

    val isFiled: Boolean get() = status in setOf("filed", "submitted", "accepted")
}

/** A page of a list, as the list screens keep it. */
data class Page<T>(val items: List<T>, val totalCount: Int, val hasMore: Boolean)
