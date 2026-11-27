package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.layout.Arrangement
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
import org.weldsuite.ui.Tokens
import java.math.BigDecimal

/** The open balance (or the total), the status and how far off the due date is. */
@Composable
fun DocumentSummary(
    balanceDue: BigDecimal,
    total: BigDecimal,
    currency: String,
    dueDate: String,
    status: String,
    balanceLabel: String,
    totalLabel: String,
    isInvoice: Boolean,
) {
    val books = LocalBooks.current
    val hasBalance = balanceDue.signum() > 0
    val due = Days.until(Days.of(dueDate))
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (hasBalance) balanceLabel else totalLabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(books.money(if (hasBalance) balanceDue else total, currency), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            }
            StatusPill(status)
        }
        if (hasBalance && due != null) {
            val days = due.toInt()
            val text = when {
                days < 0 -> pluralStringResource(if (isInvoice) R.plurals.weldbooks_invoice_detail_overdue_by else R.plurals.weldbooks_bill_detail_overdue_by, -days, -days)
                days == 0 -> stringResource(if (isInvoice) R.string.weldbooks_invoice_detail_due_today else R.string.weldbooks_bill_detail_due_today)
                else -> pluralStringResource(if (isInvoice) R.plurals.weldbooks_invoice_detail_due_in else R.plurals.weldbooks_bill_detail_due_in, days, days)
            }
            Text(
                text,
                style = MaterialTheme.typography.bodySmall,
                color = if (days < 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Tokens.Spacing.s),
            )
        }
    }
}

/** A document's lines: "2 × €10.00 · 21% VAT", the line total. */
@Composable
fun DocumentLines(lines: List<DocumentLine>, currency: String, title: String, isInvoice: Boolean) {
    if (lines.isEmpty()) return
    val books = LocalBooks.current
    val useTax = stringResource(R.string.weldbooks_sales_tax_use_tax_accrued)
    SectionCard(title = title) {
        lines.forEachIndexed { index, line ->
            if (index > 0) HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.s))
            Text(line.description, style = MaterialTheme.typography.bodyMedium)
            val parts = mutableListOf<String>()
            if (books.isUs && isInvoice) {
                line.taxCode?.let { parts += taxCodeLabel(it) }
            } else {
                if (line.taxRate.signum() > 0) parts += books.labels.taxRate(Amounts.percent(line.taxRate))
                if (books.isUs && line.accrueUseTax) parts += useTax
            }
            val suffix = if (parts.isEmpty()) "" else "  ·  " + parts.joinToString("  ·  ")
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
                Text(
                    "${Amounts.plain(line.quantity)} × ${books.money(line.unitPrice, currency)}$suffix",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Text(books.money(line.lineTotal, currency), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/**
 * Subtotal, tax, payments and what is open. A Brazilian document's tax row
 * becomes the taxes added on top and the withholdings taken off.
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
    val hasPayments = amountPaid.signum() > 0
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
        listOf(R.string.weldbooks_invoice_detail_totals, R.string.weldbooks_invoice_detail_subtotal, R.string.weldbooks_invoice_detail_total, R.string.weldbooks_invoice_detail_paid, R.string.weldbooks_invoice_detail_balance_due)
    } else {
        listOf(R.string.weldbooks_bill_detail_totals, R.string.weldbooks_bill_detail_subtotal, R.string.weldbooks_bill_detail_total, R.string.weldbooks_bill_detail_paid, R.string.weldbooks_bill_detail_balance_due)
    }.map { stringResource(it) }
    SectionCard(title = labels[0]) {
        TotalsBlock(
            rows = listOf(labels[1] to books.money(subtotal, currency)) + taxRows + extraRows +
                if (hasPayments) listOf(labels[2] to books.money(total, currency), labels[3] to "−" + books.money(amountPaid, currency)) else emptyList(),
            total = if (hasPayments) labels[4] to books.money(balanceDue.max(BigDecimal.ZERO), currency) else labels[2] to books.money(total, currency),
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
