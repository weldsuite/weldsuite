package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Balance
import androidx.compose.material.icons.outlined.EventBusy
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.RadioButtonChecked
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.weldsuite.weldbooks.CompanyFieldsMissing
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.Amounts
import com.weldsuite.weldbooks.logic.Days
import com.weldsuite.weldbooks.logic.DocumentLine
import com.weldsuite.weldbooks.logic.TaxBreakdown
import com.weldsuite.weldbooks.logic.TaxRow
import kotlinx.coroutines.launch
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.math.BigDecimal

/** "Overdue by 3 days", "Due today", "Due in 5 days"; null when nothing is open or there is no due date. */
@Composable
fun dueNote(balanceDue: BigDecimal, dueDate: String, isInvoice: Boolean): Pair<String, Boolean>? {
    if (balanceDue.signum() <= 0) return null
    val days = Days.until(Days.of(dueDate))?.toInt() ?: return null
    val text = when {
        days < 0 -> pluralStringResource(if (isInvoice) R.plurals.weldbooks_invoice_detail_overdue_by else R.plurals.weldbooks_bill_detail_overdue_by, -days, -days)
        days == 0 -> stringResource(if (isInvoice) R.string.weldbooks_invoice_detail_due_today else R.string.weldbooks_bill_detail_due_today)
        else -> pluralStringResource(if (isInvoice) R.plurals.weldbooks_invoice_detail_due_in else R.plurals.weldbooks_bill_detail_due_in, days, days)
    }
    return text to (days < 0)
}

/**
 * The figures at the top of an invoice's or bill's details, as the platform's
 * panel lists them: total, paid, balance due and the status chip.
 */
@Composable
fun DocumentFigures(total: BigDecimal, amountPaid: BigDecimal, balanceDue: BigDecimal, currency: String, status: String, isInvoice: Boolean) {
    val books = LocalBooks.current
    PropertyRow(Icons.Outlined.Payments, stringResource(if (isInvoice) R.string.weldbooks_invoice_detail_total else R.string.weldbooks_bill_detail_total), books.money(total, currency))
    PropertyRow(Icons.Outlined.AccountBalanceWallet, stringResource(if (isInvoice) R.string.weldbooks_invoice_detail_paid else R.string.weldbooks_bill_detail_paid), books.money(amountPaid, currency))
    PropertyRow(
        Icons.Outlined.Balance,
        stringResource(if (isInvoice) R.string.weldbooks_invoice_detail_balance_due else R.string.weldbooks_bill_detail_balance_due),
        books.money(balanceDue.max(BigDecimal.ZERO), currency),
        tag = "balance-due",
    )
    PropertyRow(Icons.Outlined.RadioButtonChecked, stringResource(R.string.weldbooks_document_status), null) { StatusPill(status) }
}

/** The due date, with how far off it is under it (red once it has passed). */
@Composable
fun DueDateRow(label: String, dueDate: String, balanceDue: BigDecimal, isInvoice: Boolean) {
    val books = LocalBooks.current
    val note = dueNote(balanceDue, dueDate, isInvoice)
    PropertyRow(Icons.Outlined.EventBusy, label, null) {
        Column {
            Text(books.date(dueDate), style = MaterialTheme.typography.bodyMedium.merge(Tabular))
            if (note != null) {
                Text(
                    note.first,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (note.second) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** A document's lines, as the platform's line items: the description, "2 × €10.00 · 21% VAT" under it, the line total. */
@Composable
fun DocumentLines(lines: List<DocumentLine>, currency: String, title: String, isInvoice: Boolean) {
    if (lines.isEmpty()) return
    val books = LocalBooks.current
    val useTax = stringResource(R.string.weldbooks_sales_tax_use_tax_accrued)
    PanelSection(title = title) {
        lines.forEach { line ->
            Hairline()
            val parts = mutableListOf<String>()
            if (books.isUs && isInvoice) {
                line.taxCode?.let { parts += taxCodeLabel(it) }
            } else {
                if (line.taxRate.signum() > 0) parts += books.labels.taxRate(Amounts.percent(line.taxRate))
                if (books.isUs && line.accrueUseTax) parts += useTax
            }
            val meta = (listOf("${Amounts.plain(line.quantity)} × ${books.money(line.unitPrice, currency)}") + parts).joinToString(" · ")
            Row(Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.m), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(line.description, style = MaterialTheme.typography.bodyMedium)
                    Text(meta, style = MaterialTheme.typography.bodySmall.merge(Tabular), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(books.money(line.lineTotal, currency), style = MaterialTheme.typography.titleSmall.merge(Tabular))
            }
        }
        Hairline()
    }
}

/** `text-green-600 dark:text-green-400`: what has been paid, in the platform's totals. */
private val PaidColor = DayNight(Color(0xFF16A34A), Color(0xFF4ADE80))

/**
 * Subtotal, tax and the total, then what has been paid (green) and what is
 * still due, as the platform's totals. A Brazilian document's tax row becomes
 * the taxes added on top and the withholdings taken off.
 */
@Composable
fun DocumentTotals(
    subtotal: BigDecimal,
    taxTotal: BigDecimal,
    total: BigDecimal,
    amountPaid: BigDecimal,
    balanceDue: BigDecimal,
    currency: String,
    taxLabel: String,
    taxBreakdown: List<TaxRow>,
    isInvoice: Boolean,
    extraRows: List<Pair<String, String>> = emptyList(),
) {
    val books = LocalBooks.current
    val taxRows = if (TaxBreakdown.hasTreatments(taxBreakdown)) {
        val (added, withheld) = TaxBreakdown.treatmentTotals(taxBreakdown)
        listOfNotNull(
            (stringResource(R.string.weldbooks_tax_treatment_added_row) to books.money(added, currency)).takeIf { added.signum() > 0 },
            (stringResource(R.string.weldbooks_tax_treatment_withheld_row) to "−" + books.money(withheld, currency)).takeIf { withheld.signum() > 0 },
        )
    } else {
        listOf(taxLabel to books.money(taxTotal, currency))
    }
    val labels = if (isInvoice) {
        listOf(R.string.weldbooks_invoice_detail_subtotal, R.string.weldbooks_invoice_detail_total, R.string.weldbooks_invoice_detail_paid, R.string.weldbooks_invoice_detail_balance_due)
    } else {
        listOf(R.string.weldbooks_bill_detail_subtotal, R.string.weldbooks_bill_detail_total, R.string.weldbooks_bill_detail_paid, R.string.weldbooks_bill_detail_balance_due)
    }.map { stringResource(it) }
    val paid = PaidColor.current()
    val after = buildList<Triple<String, String, Color?>> {
        if (amountPaid.signum() > 0) add(Triple(labels[2], "−" + books.money(amountPaid, currency), paid))
        if (balanceDue.signum() > 0) add(Triple(labels[3], books.money(balanceDue, currency), null))
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged("document-totals")) {
        TotalsBlock(
            rows = listOf(labels[0] to books.money(subtotal, currency)) + taxRows + extraRows,
            total = labels[1] to books.money(total, currency),
            after = after,
        )
    }
}

/** Runs a document action, then reloads; a refusal stays on screen until the next attempt. */
class Mutations(
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val notify: (String) -> Unit,
    private val errors: ErrorTexts,
    private val failed: String,
) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    /** The company fields the server says are missing, when that is why an action was refused. */
    var missingFields by mutableStateOf<List<String>>(emptyList())
        private set

    fun run(success: String, reload: suspend () -> Unit, action: suspend () -> Unit) {
        busy = true
        error = null
        missingFields = emptyList()
        scope.launch {
            runCatching { action() }
                .onSuccess {
                    notify(success)
                    reload()
                }
                .onFailure { failure ->
                    val message = errors.describe(failure, failed)
                    error = message
                    missingFields = (failure as? CompanyFieldsMissing)?.fields.orEmpty()
                    notify(message)
                }
            busy = false
        }
    }

    /** Delete, then leave the screen. */
    fun remove(success: String, failMessage: String, leave: () -> Unit, action: suspend () -> Unit) {
        busy = true
        scope.launch {
            runCatching { action() }
                .onSuccess {
                    notify(success)
                    leave()
                }
                .onFailure { notify(errors.describe(it, failMessage)) }
            busy = false
        }
    }

    fun clear() {
        error = null
        missingFields = emptyList()
    }
}

@Composable
fun rememberMutations(): Mutations {
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val failed = stringResource(R.string.weldbooks_common_action_failed)
    return remember { Mutations(scope, notify, errors, failed) }
}

/** The invoice fields a company lacks, in words: "BTW-nummer, KvK-nummer and IBAN". */
@Composable
fun invoiceFieldNames(fields: List<String>): String {
    val books = LocalBooks.current
    val iban = stringResource(R.string.weldbooks_company_field_names_iban)
    val bic = stringResource(R.string.weldbooks_company_field_names_bic)
    val address = stringResource(R.string.weldbooks_company_field_names_address)
    val and = stringResource(R.string.weldbooks_company_list_and)
    return com.weldsuite.weldbooks.logic.CompanyForm.listFields(fields, { field ->
        when (field) {
            "vatNumber" -> books.labels.taxId
            "registrationNumber" -> books.labels.registrationId
            "iban" -> iban
            "bic" -> bic
            else -> address
        }
    }, and)
}
