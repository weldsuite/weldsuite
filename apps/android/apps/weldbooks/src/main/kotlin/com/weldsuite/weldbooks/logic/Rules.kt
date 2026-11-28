package com.weldsuite.weldbooks.logic

import java.math.BigDecimal
import java.time.LocalDate

/** The statuses as the app shows them. */
object Statuses {
    /**
     * An invoice's status: `partial` reads as partly paid, and a booked invoice
     * with an open balance past its due date as overdue (the server derives
     * overdue, it rarely stores it).
     */
    fun invoice(status: String, dueDate: String?, balanceDue: BigDecimal, today: LocalDate = Days.today()): String {
        val base = if (status == "partial") "partially_paid" else status
        val open = base in setOf("finalized", "sent", "viewed", "partially_paid")
        return if (open && Days.isOverdue(dueDate, balanceDue, today)) "overdue" else base
    }

    /** A bill's: a rejected one is cancelled on the server, a partly paid one `partial`. */
    fun bill(status: String, approvalStatus: String?, dueDate: String?, balanceDue: BigDecimal, today: LocalDate = Days.today()): String {
        val base = when {
            approvalStatus == "rejected" || (status == "cancelled" && approvalStatus != "approved") -> "rejected"
            status == "partial" -> "partially_paid"
            else -> status
        }
        val open = base == "approved" || base == "partially_paid"
        return if (open && Days.isOverdue(dueDate, balanceDue, today)) "overdue" else base
    }

    /** A VAT return's: the server calls a filed return `filed`; the app calls it submitted. */
    fun vatReturn(status: String): String = if (status == "filed") "submitted" else status

    /**
     * The platform's chip tone of a status (`STATUS_TONES` in
     * `weldbooks-row-cells.tsx`): `green`, `blue`, `amber`, `red` or `gray`.
     */
    fun tone(status: String): String = when (status) {
        "paid", "posted", "reconciled", "matched", "filed", "accepted" -> "green"
        "approved", "sent", "viewed", "finalized", "open", "submitted", "processing" -> "blue"
        "partial", "partially_paid", "pending", "review", "needs_review", "due" -> "amber"
        "overdue", "failed", "rejected", "error" -> "red"
        else -> "gray"
    }

    fun billAwaitsApproval(bill: Bill): Boolean =
        (bill.status == "draft" || bill.status == "pending") && bill.approvalStatus != "rejected"

    fun billIsPayable(bill: Bill): Boolean =
        bill.balanceDue.signum() > 0 && bill.status in setOf("approved", "partial", "partially_paid", "overdue")

    fun invoiceIsSettled(status: String): Boolean = status in setOf("paid", "cancelled", "uncollectible")
}

/** How a line is taxed: a VAT/GST rate, a US product tax code (the server works out the tax), or US vendor tax paid as cost. */
enum class TaxMode { RATE, CODE, COST;

    companion object {
        fun of(isUs: Boolean, isInvoice: Boolean): TaxMode = when {
            !isUs -> RATE
            isInvoice -> CODE
            else -> COST
        }
    }
}

/** A line of the invoice and bill forms, as typed. */
data class LineDraft(
    val key: String,
    val description: String = "",
    val quantity: String = "1",
    val unitPrice: String = "",
    val taxRate: String = "0",
    val taxCode: String = UsRules.DEFAULT_TAX_CODE,
    val accrueUseTax: Boolean = false,
)

/** A line as the API takes it: every number a decimal string. */
data class LineInputValues(
    val description: String,
    val quantity: String,
    val unitPrice: String,
    val taxRate: String?,
    val taxCode: String?,
    val accrueUseTax: Boolean,
    val accountId: String? = null,
    val sortOrder: Int,
)

data class Totals(val subtotal: BigDecimal, val taxTotal: BigDecimal, val total: BigDecimal)

object LineItems {
    private var counter = 0

    fun empty(taxRate: String): LineDraft {
        counter += 1
        return LineDraft(key = "li_${System.nanoTime()}_$counter", taxRate = taxRate)
    }

    fun lineTotal(line: LineDraft, decimalPoint: Boolean = false): BigDecimal =
        Amounts.parse(line.quantity.ifBlank { "0" }, decimalPoint).multiply(Amounts.parse(line.unitPrice.ifBlank { "0" }, decimalPoint))

    /** In [TaxMode.CODE] the server calculates the tax, so it is 0 here. */
    fun totals(lines: List<LineDraft>, mode: TaxMode, decimalPoint: Boolean = false): Totals {
        var subtotal = BigDecimal.ZERO
        var tax = BigDecimal.ZERO
        for (line in lines) {
            val total = lineTotal(line, decimalPoint)
            subtotal += total
            if (mode != TaxMode.CODE) {
                tax += total.multiply(Amounts.parse(line.taxRate.ifBlank { "0" }, decimalPoint)).divide(BigDecimal(100))
            }
        }
        return Totals(subtotal, tax, subtotal + tax)
    }

    /** Lines with a description and a price above zero. */
    fun valid(lines: List<LineDraft>, decimalPoint: Boolean = false): List<LineDraft> =
        lines.filter { it.description.isNotBlank() && Amounts.parse(it.unitPrice.ifBlank { "0" }, decimalPoint).signum() > 0 }

    fun inputs(lines: List<LineDraft>, mode: TaxMode, decimalPoint: Boolean = false): List<LineInputValues> =
        valid(lines, decimalPoint).mapIndexed { index, line ->
            val base = LineInputValues(
                description = line.description.trim(),
                quantity = Amounts.plain(Amounts.parse(line.quantity.ifBlank { "1" }, decimalPoint)),
                unitPrice = Amounts.plain(Amounts.parse(line.unitPrice, decimalPoint)),
                taxRate = null,
                taxCode = null,
                accrueUseTax = false,
                sortOrder = index,
            )
            when (mode) {
                TaxMode.RATE -> base.copy(taxRate = Amounts.plain(Amounts.parse(line.taxRate.ifBlank { "0" }, decimalPoint)))
                TaxMode.CODE -> base.copy(taxCode = line.taxCode.ifBlank { UsRules.DEFAULT_TAX_CODE })
                TaxMode.COST -> base.copy(
                    taxRate = Amounts.plain(Amounts.parse(line.taxRate.ifBlank { "0" }, decimalPoint)),
                    accrueUseTax = line.accrueUseTax,
                    taxCode = if (line.accrueUseTax) line.taxCode.ifBlank { UsRules.DEFAULT_TAX_CODE } else null,
                )
            }
        }

    /** Lines from a read receipt; one empty line when it had none. */
    fun fromPrefill(prefill: BillPrefill, defaultTaxRate: String): List<LineDraft> {
        if (prefill.items.isEmpty()) return listOf(empty(defaultTaxRate))
        return prefill.items.mapIndexed { index, item ->
            empty(defaultTaxRate).copy(
                key = "ocr_${index}_${item.sortOrder}",
                description = item.description,
                quantity = item.quantity.ifBlank { "1" },
                unitPrice = if (item.unitPrice == "0") "" else item.unitPrice,
                taxRate = item.taxRate ?: defaultTaxRate,
            )
        }
    }
}

/** A receipt shows what was paid, VAT included; books prices bill lines excluding it and rounds each line's tax to the cent. */
object QuickExpense {
    /** Gaps above this are an OCR misread, not rounding. */
    private const val MAX_ROUNDING_CENTS = 5L

    private fun cents(amount: BigDecimal): Long = amount.movePointRight(2).setScale(0, java.math.RoundingMode.HALF_UP).toLong()

    private fun taxCents(netCents: Long, rate: BigDecimal): Long =
        BigDecimal(netCents).multiply(rate).divide(BigDecimal(100)).setScale(0, java.math.RoundingMode.HALF_UP).toLong()

    data class Split(val net: BigDecimal, val tax: BigDecimal, val rounding: BigDecimal)

    /** The net price of [total] (VAT included) at [rate], and the cent left over. */
    fun split(total: BigDecimal, rate: BigDecimal): Split {
        val totalCents = cents(total)
        if (rate.signum() <= 0) return Split(BigDecimal(totalCents).movePointLeft(2), BigDecimal.ZERO.setScale(2), BigDecimal.ZERO.setScale(2))
        val guess = BigDecimal(totalCents).divide(BigDecimal.ONE + rate.divide(BigDecimal(100)), 0, java.math.RoundingMode.HALF_UP).toLong()
        var best = guess
        var bestGap = Long.MAX_VALUE
        for (net in guess - 2..guess + 2) {
            val gap = kotlin.math.abs(totalCents - (net + taxCents(net, rate)))
            if (gap < bestGap) {
                best = net
                bestGap = gap
            }
        }
        val tax = taxCents(best, rate)
        return Split(BigDecimal(best).movePointLeft(2), BigDecimal(tax).movePointLeft(2), BigDecimal(totalCents - best - tax).movePointLeft(2))
    }

    /** The distinct rates on a receipt's lines, lowest first. */
    fun rates(prefill: BillPrefill): List<BigDecimal> =
        prefill.items.mapNotNull { it.taxRate?.takeIf { rate -> rate.isNotBlank() }?.let { rate -> Amounts.parse(rate) } }
            .map { it.stripTrailingZeros() }.distinct().sorted()

    /** What the lines add up to, VAT included and rounded per line. */
    fun linesTotal(items: List<PrefillLine>): BigDecimal {
        val total = items.sumOf { item ->
            val net = cents(Amounts.parse(item.quantity.ifBlank { "1" }).multiply(Amounts.parse(item.unitPrice.ifBlank { "0" })))
            net + taxCents(net, Amounts.parse(item.taxRate ?: "0"))
        }
        return BigDecimal(total).movePointLeft(2)
    }

    /** The receipt's own total, else what its lines add up to, else its subtotal. */
    fun totalFromPrefill(prefill: BillPrefill): BigDecimal? {
        prefill.total?.takeIf { it.signum() > 0 }?.let { return it }
        linesTotal(prefill.items).takeIf { it.signum() > 0 }?.let { return it }
        return prefill.subtotal?.takeIf { it.signum() > 0 }
    }

    /** The rate that carries most of the receipt's net amount. */
    fun mainRate(prefill: BillPrefill): String? {
        val byRate = linkedMapOf<String, BigDecimal>()
        for (item in prefill.items) {
            val rate = item.taxRate?.takeIf { it.isNotBlank() } ?: continue
            val net = Amounts.parse(item.quantity.ifBlank { "1" }).multiply(Amounts.parse(item.unitPrice.ifBlank { "0" }))
            byRate[rate] = (byRate[rate] ?: BigDecimal.ZERO) + net
        }
        return byRate.maxByOrNull { it.value }?.key
    }

    private fun roundingLine(gapCents: Long, description: String): List<LineInputValues> {
        if (gapCents == 0L || kotlin.math.abs(gapCents) > MAX_ROUNDING_CENTS) return emptyList()
        return listOf(LineInputValues(description, "1", Amounts.plain(BigDecimal(gapCents).movePointLeft(2)), "0", null, false, null, 0))
    }

    /**
     * The bill lines of a quick expense, adding up to [total]: the receipt's
     * own lines when they carry several rates and add up to it, else one line
     * at [rate]; any cent left over is an untaxed rounding line.
     */
    fun lines(
        total: BigDecimal,
        rate: BigDecimal,
        description: String,
        roundingDescription: String,
        accountId: String?,
        receiptLines: List<PrefillLine>?,
    ): List<LineInputValues> {
        if (!receiptLines.isNullOrEmpty()) {
            val gap = cents(total) - cents(linesTotal(receiptLines))
            if (kotlin.math.abs(gap) <= MAX_ROUNDING_CENTS) {
                val lines = receiptLines.map { item ->
                    LineInputValues(
                        description = item.description.ifBlank { description },
                        quantity = item.quantity.ifBlank { "1" },
                        unitPrice = item.unitPrice.ifBlank { "0" },
                        taxRate = item.taxRate ?: "0",
                        taxCode = null,
                        accrueUseTax = false,
                        accountId = accountId,
                        sortOrder = 0,
                    )
                }
                return (lines + roundingLine(gap, roundingDescription)).mapIndexed { index, line -> line.copy(sortOrder = index) }
            }
        }
        val split = split(total, rate)
        val main = LineInputValues(description, "1", Amounts.plain(split.net), Amounts.plain(rate), null, false, accountId, 0)
        return (listOf(main) + roundingLine(cents(split.rounding), roundingDescription)).mapIndexed { index, line -> line.copy(sortOrder = index) }
    }
}

/** Payment methods and where a received payment lands, per country. */
object Payments {
    val usMethods = listOf("check", "ach", "wire", "credit_card", "debit_card", "cash", "other")
    val defaultMethods = listOf("bank_transfer", "card", "cash", "direct_debit", "manual")

    fun methods(isUs: Boolean): List<String> = if (isUs) usMethods else defaultMethods

    fun defaultMethod(isUs: Boolean): String = if (isUs) "ach" else "bank_transfer"

    /** How a receipt is usually paid: at the till, by card. */
    fun defaultExpenseMethod(isUs: Boolean): String = if (isUs) "debit_card" else "card"

    /** Only a received check or cash payment can wait in Undeposited Funds. */
    fun offersDepositChoice(isUs: Boolean, received: Boolean, method: String): Boolean =
        isUs && received && (method == "check" || method == "cash")

    fun takesCheckNumber(isUs: Boolean, method: String): Boolean = isUs && method == "check"

    /** `••••1234`. */
    fun masked(last4: String?): String? = last4?.takeIf { Regex("^\\d{1,4}$").matches(it) }?.let { "••••$it" }

    val bankAccountTypes = listOf("checking", "savings", "credit_card", "money_market", "line_of_credit")

    /** "Chase · Checking ••••1234" for a US account, else its IBAN or bank name. */
    fun accountSubtitle(account: BankAccount, typeLabel: (String) -> String): String? {
        val masked = masked(account.accountNumberLast4)
        if (masked != null) {
            val type = account.accountType?.takeIf { it in bankAccountTypes }?.let(typeLabel)
            return listOfNotNull(account.bankName, listOfNotNull(type, masked).joinToString(" ")).joinToString(" · ")
        }
        return account.iban ?: account.bankName
    }
}

/** A document's tax, grouped as the detail screens show it. Nothing here calculates tax. */
object TaxBreakdown {
    private val levelOrder = mapOf("state" to 0, "county" to 1, "city" to 2, "district" to 3)

    data class Group(
        val key: String,
        val name: String,
        val level: String?,
        val rate: BigDecimal,
        val taxable: BigDecimal,
        val tax: BigDecimal,
        val exempt: BigDecimal,
        val kind: String,
    )

    /** Per jurisdiction (and rate), state first; US use tax after the tax charged. */
    fun groups(rows: List<TaxRow>): List<Group> {
        val groups = linkedMapOf<String, Group>()
        for (row in rows) {
            val kind = if (row.kind == "use") "use" else "tax"
            val name = row.jurisdictionName ?: row.name ?: row.jurisdictionCode.orEmpty()
            val key = listOf(kind, row.jurisdictionCode ?: name, row.level.orEmpty(), row.rate.stripTrailingZeros().toPlainString()).joinToString("|")
            val old = groups[key] ?: Group(key, name, row.level, row.rate, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO, kind)
            groups[key] = old.copy(
                taxable = Amounts.cents(old.taxable + row.taxableAmount),
                tax = Amounts.cents(old.tax + row.taxAmount),
                exempt = Amounts.cents(old.exempt + row.exemptAmount),
            )
        }
        return groups.values.sortedWith(
            compareBy<Group>({ if (it.kind == "tax") 0 else 1 }, { levelOrder[it.level] ?: 9 }, { it.name }),
        )
    }

    fun hasExempt(rows: List<TaxRow>): Boolean = rows.any { it.exemptAmount.signum() > 0 || it.exemptReason != null }

    fun exemptAmount(rows: List<TaxRow>): BigDecimal = rows.fold(BigDecimal.ZERO) { sum, row -> sum + row.exemptAmount }

    /** "resale" → "Resale", "non_profit" → "Non profit", without repeats. */
    fun exemptReasons(rows: List<TaxRow>): List<String> = rows.mapNotNull { it.exemptReason }.distinct().map { reason ->
        reason.replace('_', ' ').trim().replaceFirstChar { it.uppercase() }
    }

    fun chargedTotal(rows: List<TaxRow>): BigDecimal = Amounts.cents(rows.filter { it.kind != "use" }.fold(BigDecimal.ZERO) { s, r -> s + r.taxAmount })

    fun useTaxTotal(rows: List<TaxRow>): BigDecimal = Amounts.cents(rows.filter { it.kind == "use" }.fold(BigDecimal.ZERO) { s, r -> s + r.taxAmount })

    /** `not_registered_in_state` or `tax_engine_unavailable: it timed out` → the code and the detail. */
    fun parseWarning(warning: String): Pair<String, String?> {
        val index = warning.indexOf(':')
        if (index < 0) return warning.trim() to null
        return warning.substring(0, index).trim() to warning.substring(index + 1).trim().ifEmpty { null }
    }

    /** A warning in words: a known code's text, else the code made readable. */
    fun warningText(warning: String, known: (String) -> String?): String {
        val (code, detail) = parseWarning(warning)
        known(code)?.let { return it }
        val readable = code.replace('_', ' ')
        return if (detail != null) "$readable: $detail" else readable
    }

    // Brazil: how each tax sits in the total.

    val treatments = listOf("added", "embedded", "withheld", "informational")

    data class TreatmentTax(val key: String, val name: String, val rate: BigDecimal, val base: BigDecimal, val amount: BigDecimal)

    data class TreatmentGroup(val treatment: String, val taxes: List<TreatmentTax>, val total: BigDecimal)

    fun hasTreatments(rows: List<TaxRow>): Boolean = rows.any { it.treatment in treatments }

    fun byTreatment(rows: List<TaxRow>): List<TreatmentGroup> {
        val groups = linkedMapOf<String, LinkedHashMap<String, TreatmentTax>>()
        for (row in rows) {
            val treatment = row.treatment?.takeIf { it in treatments } ?: continue
            val name = row.name?.takeIf { it.isNotEmpty() } ?: row.component?.uppercase().orEmpty()
            val key = listOf(row.component ?: name, name, row.rate.stripTrailingZeros().toPlainString()).joinToString("|")
            val taxes = groups.getOrPut(treatment) { linkedMapOf() }
            val old = taxes[key] ?: TreatmentTax(key, name, row.rate, BigDecimal.ZERO, BigDecimal.ZERO)
            taxes[key] = old.copy(base = Amounts.cents(old.base + row.taxableAmount), amount = Amounts.cents(old.amount + row.taxAmount.abs()))
        }
        return treatments.mapNotNull { treatment ->
            val taxes = groups[treatment]?.values?.toList() ?: return@mapNotNull null
            TreatmentGroup(treatment, taxes, Amounts.cents(taxes.fold(BigDecimal.ZERO) { s, t -> s + t.amount }))
        }
    }

    /** What the taxes add to the subtotal and what is withheld from it. */
    fun treatmentTotals(rows: List<TaxRow>): Pair<BigDecimal, BigDecimal> {
        val groups = byTreatment(rows)
        val added = groups.firstOrNull { it.treatment == "added" }?.total ?: BigDecimal.ZERO
        val withheld = groups.firstOrNull { it.treatment == "withheld" }?.total ?: BigDecimal.ZERO
        return added to withheld
    }
}

/** Which expense account a quick-expense category books to, found by name in the company's own chart. */
object ExpenseCategories {
    val all = listOf("food", "transport", "office", "travel", "supplies", "utilities", "insurance", "other")

    private val patterns: Map<String, List<Regex>> = mapOf(
        "food" to listOf("\\bmeals?\\b", "representatie", "refei[çc]", "aliment", "kantine", "entertainment"),
        "transport" to listOf("autokosten", "car and truck", "vervoer", "conveyance", "ve[íi]cul", "combust"),
        "office" to listOf("kantoorkosten", "office expense", "escrit[óo]rio", "kantoorbenodigd"),
        "travel" to listOf("reiskosten", "\\btravel", "viage"),
        "supplies" to listOf("kantoorbenodigd", "\\bsupplies\\b", "material de", "consumo"),
        "utilities" to listOf("gas, water", "\\butilities\\b", "energia", "energie", "elektra", "telefoon"),
        "insurance" to listOf("verzekering", "\\binsurance\\b", "seguro"),
        "other" to listOf("algemene kosten", "general expense", "other expense", "despesas gerais"),
    ).mapValues { (_, list) -> list.map { Regex(it, RegexOption.IGNORE_CASE) } }

    /** The active expense accounts, by code (numbers compared as numbers). */
    fun expenseAccounts(accounts: List<GlAccount>): List<GlAccount> =
        accounts.filter { it.type == "expense" && it.isActive }.sortedWith { a, b -> naturalCompare(a.code, b.code) }

    fun accountFor(category: String, accounts: List<GlAccount>): GlAccount? {
        val candidates = expenseAccounts(accounts)
        for (pattern in patterns[category].orEmpty()) {
            candidates.firstOrNull { pattern.containsMatchIn(it.name) }?.let { return it }
        }
        return null
    }

    private fun naturalCompare(a: String, b: String): Int {
        val x = a.toLongOrNull()
        val y = b.toLongOrNull()
        return if (x != null && y != null) x.compareTo(y) else a.compareTo(b)
    }
}

/** The identity half of the new-contact form: a company or a person. */
data class ContactIdentityDraft(
    val kind: String = "company",
    val companyName: String = "",
    val nameOnInvoices: String = "",
    val firstName: String = "",
    val lastName: String = "",
    val taxId: String = "",
) {
    /** `companyName` or `personName` when the name is missing. */
    fun problem(): String? = if (kind == "company") {
        if (companyName.isBlank()) "companyName" else null
    } else {
        if (firstName.isBlank() && lastName.isBlank()) "personName" else null
    }

    data class Payload(
        val kind: String,
        val fullName: String,
        val companyName: String?,
        val firstName: String?,
        val lastName: String?,
        val vatNumber: String?,
    )

    /** Only the chosen kind's fields go out: a company's VAT number never lands on a person. */
    fun payload(withTaxId: Boolean): Payload {
        if (kind == "person") {
            val first = firstName.trim()
            val last = lastName.trim()
            return Payload("person", listOf(first, last).filter { it.isNotEmpty() }.joinToString(" "), null, first.ifEmpty { null }, last.ifEmpty { null }, null)
        }
        val company = companyName.trim()
        val tax = if (withTaxId) taxId.trim() else ""
        return Payload("company", nameOnInvoices.trim().ifEmpty { company }, company, null, null, tax.ifEmpty { null })
    }

    companion object {
        const val NAME_MAX = 255
        const val PERSON_NAME_MAX = 100
    }
}

/** Which workspace-hub topics touch which screens (the Expo app's sync map). */
object BooksTopics {
    val invoices = listOf("invoice", "payment", "accounting_entity")
    val bills = listOf("bill", "payment", "accounting_document", "accounting_entity")
    val dashboard = listOf(
        "invoice", "bill", "payment", "accounting_document", "bank_account", "bank_transaction",
        "journal_entry", "vat_return", "account", "accounting_entity",
    )
    val banking = listOf("bank_account", "bank_transaction", "accounting_entity")
    val contacts = listOf("accounting_contact", "accounting_entity")
    val vat = listOf("vat_return", "accounting_entity")
    val reports = listOf("invoice", "bill", "journal_entry", "account", "accounting_entity")
}

/** The printable invoice the server renders (HTML), made to show as a page on a phone. */
object DocumentHtml {
    /** The width the server lays the document out at (its container is 800 px wide). */
    const val PAGE_WIDTH = 800

    private val viewport = Regex("""<meta[^>]*name\s*=\s*["']?viewport["']?[^>]*>""", RegexOption.IGNORE_CASE)
    private val head = Regex("<head[^>]*>", RegexOption.IGNORE_CASE)

    /**
     * The document with a viewport of the page's width instead of the phone's,
     * so it shows as the whole page scaled to the screen, like a PDF, and not
     * reflowed to phone width with its table cut off.
     */
    fun fitToPage(html: String, width: Int = PAGE_WIDTH): String {
        val meta = "<meta name=\"viewport\" content=\"width=$width\">"
        if (viewport.containsMatchIn(html)) return viewport.replaceFirst(html, meta)
        val opening = head.find(html) ?: return meta + html
        return html.substring(0, opening.range.last + 1) + meta + html.substring(opening.range.last + 1)
    }
}
