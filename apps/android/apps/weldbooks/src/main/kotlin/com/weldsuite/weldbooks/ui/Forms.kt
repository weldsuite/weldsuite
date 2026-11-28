package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import org.weldsuite.ui.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.weldsuite.weldbooks.PaymentValues
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.AddressDraft
import com.weldsuite.weldbooks.logic.Amounts
import com.weldsuite.weldbooks.logic.Days
import com.weldsuite.weldbooks.logic.Identifiers
import com.weldsuite.weldbooks.logic.LineDraft
import com.weldsuite.weldbooks.logic.LineItems
import com.weldsuite.weldbooks.logic.Payments
import com.weldsuite.weldbooks.logic.TaxBreakdown
import com.weldsuite.weldbooks.logic.TaxMode
import com.weldsuite.weldbooks.logic.TaxRow
import com.weldsuite.weldbooks.logic.UsAddressProblems
import com.weldsuite.weldbooks.logic.UsRules
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.math.BigDecimal

/** US address fields: street lines, city, a state picker and ZIP. */
@Composable
fun AddressFields(value: AddressDraft, onChange: (AddressDraft) -> Unit, problems: UsAddressProblems = UsAddressProblems()) {
    FormField(stringResource(R.string.weldbooks_address_line1), value.line1, { onChange(value.copy(line1 = it)) }, placeholder = stringResource(R.string.weldbooks_address_line1_placeholder))
    FormField(stringResource(R.string.weldbooks_address_line2), value.line2, { onChange(value.copy(line2 = it)) }, placeholder = stringResource(R.string.weldbooks_address_line2_placeholder))
    FormField(stringResource(R.string.weldbooks_address_city), value.city, { onChange(value.copy(city = it)) })
    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Dropdown(
            label = stringResource(R.string.weldbooks_address_state),
            value = UsRules.stateCode(value.state).ifEmpty { null },
            options = UsRules.states.map { (code, name) -> code to "$name ($code)" },
            onChange = { onChange(value.copy(state = it)) },
            placeholder = stringResource(R.string.weldbooks_address_select_state),
            error = when (problems.state) {
                "required" -> stringResource(R.string.weldbooks_address_state_required)
                "invalid" -> stringResource(R.string.weldbooks_address_state_invalid)
                else -> null
            },
            modifier = Modifier.weight(1.3f),
        )
        FormField(
            stringResource(R.string.weldbooks_address_zip),
            value.postalCode,
            { onChange(value.copy(postalCode = Identifiers.formatZipInput(it))) },
            placeholder = stringResource(R.string.weldbooks_address_zip_placeholder),
            keyboard = KeyboardType.Number,
            error = when (problems.postalCode) {
                "required" -> stringResource(R.string.weldbooks_address_zip_required)
                "invalid" -> stringResource(R.string.weldbooks_address_zip_invalid)
                else -> null
            },
            modifier = Modifier.weight(1f),
        )
    }
}

/** The server's tax of a US invoice, once it has calculated it. */
data class ServerTax(val taxTotal: BigDecimal, val total: BigDecimal, val loading: Boolean)

/** The invoice and bill forms' lines, with totals. How a line is taxed depends on [mode]. */
@Composable
fun LineItemsEditor(
    lines: List<LineDraft>,
    onChange: (List<LineDraft>) -> Unit,
    mode: TaxMode,
    defaultTaxRate: String,
    currency: String,
    error: String?,
    serverTax: ServerTax? = null,
) {
    val books = LocalBooks.current
    val totals = LineItems.totals(lines, mode, books.decimalPoint)
    val taxCodes = UsRules.taxCodes.map { it to taxCodeLabel(it) }
    fun update(key: String, change: (LineDraft) -> LineDraft) = onChange(lines.map { if (it.key == key) change(it) else it })

    SectionCard(
        title = stringResource(R.string.weldbooks_line_items_title),
        action = {
            TextButton(onClick = { onChange(lines + LineItems.empty(defaultTaxRate)) }, modifier = Modifier.tagged("add-line")) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Text(stringResource(R.string.weldbooks_line_items_add))
            }
        },
    ) {
        lines.forEachIndexed { index, line ->
            if (index > 0) HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.m))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.weldbooks_line_items_item, (index + 1).toString()),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                if (lines.size > 1) {
                    IconButton(onClick = { onChange(lines.filterNot { it.key == line.key }) }) {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = stringResource(R.string.weldbooks_line_items_remove, (index + 1).toString()),
                            tint = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
            FormField(stringResource(R.string.weldbooks_line_items_description), line.description, { text -> update(line.key) { it.copy(description = text) } }, tag = "line-description-$index")
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                FormField(stringResource(R.string.weldbooks_line_items_qty), line.quantity, { text -> update(line.key) { it.copy(quantity = text) } }, keyboard = KeyboardType.Decimal, modifier = Modifier.weight(1f), tag = "line-quantity-$index")
                FormField(stringResource(R.string.weldbooks_line_items_unit_price), line.unitPrice, { text -> update(line.key) { it.copy(unitPrice = text) } }, keyboard = KeyboardType.Decimal, placeholder = "0.00", modifier = Modifier.weight(1.5f), tag = "line-price-$index")
                if (mode != TaxMode.CODE) {
                    FormField(
                        if (mode == TaxMode.COST) stringResource(R.string.weldbooks_line_items_tax_paid_percent) else books.labels.taxPercent,
                        line.taxRate,
                        { text -> update(line.key) { it.copy(taxRate = text) } },
                        keyboard = KeyboardType.Decimal,
                        placeholder = defaultTaxRate,
                        modifier = Modifier.weight(1f),
                        tag = "line-tax-$index",
                    )
                }
            }
            if (mode == TaxMode.CODE) {
                Dropdown(stringResource(R.string.weldbooks_sales_tax_tax_code), line.taxCode, taxCodes, { code -> update(line.key) { it.copy(taxCode = code) } })
            }
            if (mode == TaxMode.COST) {
                SwitchRow(stringResource(R.string.weldbooks_line_items_accrue_use_tax), line.accrueUseTax, { on -> update(line.key) { it.copy(accrueUseTax = on) } })
                HintText(stringResource(R.string.weldbooks_line_items_accrue_use_tax_hint))
                if (line.accrueUseTax) {
                    Dropdown(stringResource(R.string.weldbooks_sales_tax_tax_code), line.taxCode, taxCodes, { code -> update(line.key) { it.copy(taxCode = code) } })
                }
            }
            Text(
                stringResource(R.string.weldbooks_line_items_line_total, books.money(LineItems.lineTotal(line, books.decimalPoint), currency)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.End,
            )
        }
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = Tokens.Spacing.s))
    }

    val taxRow: Pair<String, String>
    var grandTotal = totals.total
    when (mode) {
        TaxMode.CODE -> {
            taxRow = books.labels.tax to if (serverTax != null && !serverTax.loading) books.money(serverTax.taxTotal, currency) else stringResource(R.string.weldbooks_line_items_tax_pending)
            if (serverTax != null && !serverTax.loading) grandTotal = serverTax.total
        }
        TaxMode.COST -> taxRow = stringResource(R.string.weldbooks_line_items_tax_paid) to books.money(totals.taxTotal, currency)
        TaxMode.RATE -> taxRow = books.labels.tax to books.money(totals.taxTotal, currency)
    }
    SectionCard(title = stringResource(R.string.weldbooks_line_items_totals)) {
        TotalsBlock(
            rows = listOf(stringResource(R.string.weldbooks_line_items_subtotal) to books.money(totals.subtotal, currency), taxRow),
            total = stringResource(R.string.weldbooks_line_items_total) to books.money(grandTotal, currency),
        )
    }
}


@Composable
fun taxCodeLabel(code: String): String = when (code) {
    "saas" -> stringResource(R.string.weldbooks_sales_tax_codes_saas)
    "digital_goods" -> stringResource(R.string.weldbooks_sales_tax_codes_digital_goods)
    "services" -> stringResource(R.string.weldbooks_sales_tax_codes_services)
    "professional_services" -> stringResource(R.string.weldbooks_sales_tax_codes_professional_services)
    "shipping" -> stringResource(R.string.weldbooks_sales_tax_codes_shipping)
    "handling" -> stringResource(R.string.weldbooks_sales_tax_codes_handling)
    "food_grocery" -> stringResource(R.string.weldbooks_sales_tax_codes_food_grocery)
    "prepared_food" -> stringResource(R.string.weldbooks_sales_tax_codes_prepared_food)
    "clothing" -> stringResource(R.string.weldbooks_sales_tax_codes_clothing)
    "prescription_drugs" -> stringResource(R.string.weldbooks_sales_tax_codes_prescription_drugs)
    "non_taxable" -> stringResource(R.string.weldbooks_sales_tax_codes_non_taxable)
    else -> stringResource(R.string.weldbooks_sales_tax_codes_general)
}

@Composable
private fun levelLabel(level: String?): String? = when (level) {
    "state" -> stringResource(R.string.weldbooks_sales_tax_levels_state)
    "county" -> stringResource(R.string.weldbooks_sales_tax_levels_county)
    "city" -> stringResource(R.string.weldbooks_sales_tax_levels_city)
    "district" -> stringResource(R.string.weldbooks_sales_tax_levels_district)
    else -> null
}

@Composable
private fun warningLabel(code: String): String? = when (code) {
    "not_registered_in_state" -> stringResource(R.string.weldbooks_sales_tax_warnings_not_registered_in_state)
    "address_unverified" -> stringResource(R.string.weldbooks_sales_tax_warnings_address_unverified)
    "no_ship_to" -> stringResource(R.string.weldbooks_sales_tax_warnings_no_ship_to)
    "certificate_expired" -> stringResource(R.string.weldbooks_sales_tax_warnings_certificate_expired)
    "certificate_missing" -> stringResource(R.string.weldbooks_sales_tax_warnings_certificate_missing)
    "marketplace_facilitated" -> stringResource(R.string.weldbooks_sales_tax_warnings_marketplace_facilitated)
    "zone_not_found" -> stringResource(R.string.weldbooks_sales_tax_warnings_zone_not_found)
    "no_use_tax_registration" -> stringResource(R.string.weldbooks_sales_tax_warnings_no_use_tax_registration)
    "rates_not_configured" -> stringResource(R.string.weldbooks_sales_tax_warnings_rates_not_configured)
    "override_not_applied" -> stringResource(R.string.weldbooks_sales_tax_warnings_override_not_applied)
    "provider_rate_date_ignored" -> stringResource(R.string.weldbooks_sales_tax_warnings_provider_rate_date_ignored)
    "provider_not_supported" -> stringResource(R.string.weldbooks_sales_tax_warnings_provider_not_supported)
    "provider_nexus_missing" -> stringResource(R.string.weldbooks_sales_tax_warnings_provider_nexus_missing)
    "tax_engine_unavailable" -> stringResource(R.string.weldbooks_sales_tax_warnings_tax_engine_unavailable)
    "commit_failed" -> stringResource(R.string.weldbooks_sales_tax_warnings_commit_failed)
    "reverse_failed" -> stringResource(R.string.weldbooks_sales_tax_warnings_reverse_failed)
    "reverse_unsupported" -> stringResource(R.string.weldbooks_sales_tax_warnings_reverse_unsupported)
    "reverse_skipped" -> stringResource(R.string.weldbooks_sales_tax_warnings_reverse_skipped)
    else -> null
}

/** US sales tax as the server calculated it: the total, a per-jurisdiction breakdown, exemptions and warnings. */
@Composable
fun TaxBreakdownCard(
    rows: List<TaxRow>,
    warnings: List<String>,
    currency: String,
    title: String? = null,
    initiallyExpanded: Boolean = false,
    footnote: String? = null,
) {
    val books = LocalBooks.current
    val groups = TaxBreakdown.groups(rows)
    val charged = groups.filter { it.kind == "tax" }
    val used = groups.filter { it.kind == "use" }
    if (groups.isEmpty() && warnings.isEmpty()) return
    var expanded by rememberSaveable { mutableStateOf(initiallyExpanded) }
    val canExpand = groups.isNotEmpty()
    val warningTexts = warnings.map { warning ->
        val code = TaxBreakdown.parseWarning(warning).first
        warningLabel(code) ?: TaxBreakdown.warningText(warning) { null }
    }
    SectionCard {
        Row(
            Modifier.fillMaxWidth().let { if (canExpand) it.clickable { expanded = !expanded } else it }.tagged("tax-breakdown"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(title ?: stringResource(R.string.weldbooks_sales_tax_title), style = MaterialTheme.typography.titleSmall)
                if (canExpand) {
                    Text(
                        stringResource(if (expanded) R.string.weldbooks_sales_tax_hide_breakdown else R.string.weldbooks_sales_tax_show_breakdown),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            val headline = when {
                charged.isNotEmpty() -> books.money(TaxBreakdown.chargedTotal(rows), currency)
                used.isNotEmpty() -> books.money(TaxBreakdown.useTaxTotal(rows), currency)
                else -> stringResource(R.string.weldbooks_common_dash)
            }
            Text(headline, style = MaterialTheme.typography.titleSmall)
            if (canExpand) Icon(if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, contentDescription = null)
        }
        if (expanded && canExpand) {
            HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.s))
            charged.forEach { JurisdictionRow(it, currency) }
            if (used.isNotEmpty()) {
                if (charged.isNotEmpty()) HintText(stringResource(R.string.weldbooks_sales_tax_use_tax_accrued))
                used.forEach { JurisdictionRow(it, currency) }
            }
        }
        if (groups.isEmpty()) HintText(stringResource(R.string.weldbooks_sales_tax_no_tax_charged))
        if (footnote != null) HintText(footnote)
        if (TaxBreakdown.hasExempt(rows)) {
            val reasons = TaxBreakdown.exemptReasons(rows)
            val amount = books.money(TaxBreakdown.exemptAmount(rows), currency)
            Banner(
                text = if (reasons.isNotEmpty()) stringResource(R.string.weldbooks_sales_tax_exempt_notice, amount, reasons.joinToString(", "))
                else stringResource(R.string.weldbooks_sales_tax_exempt_notice_no_reason, amount),
                title = stringResource(R.string.weldbooks_sales_tax_exempt_title),
            )
        }
        if (warningTexts.isNotEmpty()) {
            Banner(warningTexts.joinToString("\n"), tone = "warning", title = stringResource(R.string.weldbooks_sales_tax_warnings_title))
        }
    }
}

@Composable
private fun JurisdictionRow(group: TaxBreakdown.Group, currency: String) {
    val books = LocalBooks.current
    val detail = if (group.rate.signum() > 0) stringResource(R.string.weldbooks_sales_tax_rate_on, Amounts.percent(group.rate), books.money(group.taxable, currency)) else null
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Column(Modifier.weight(1f)) {
            Text(group.name, style = MaterialTheme.typography.bodyMedium)
            val line = listOfNotNull(levelLabel(group.level), detail).joinToString(" · ")
            if (line.isNotEmpty()) Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(books.money(group.tax, currency), style = MaterialTheme.typography.bodyMedium)
    }
}

/** A Brazilian document's taxes by how they sit in its total. */
@Composable
fun TreatmentBreakdownCard(rows: List<TaxRow>, currency: String) {
    val books = LocalBooks.current
    val groups = TaxBreakdown.byTreatment(rows)
    if (groups.isEmpty()) return
    SectionCard(title = stringResource(R.string.weldbooks_tax_treatment_title)) {
        groups.forEachIndexed { index, group ->
            if (index > 0) HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.s))
            HintText(
                when (group.treatment) {
                    "added" -> stringResource(R.string.weldbooks_tax_treatment_added)
                    "embedded" -> stringResource(R.string.weldbooks_tax_treatment_embedded)
                    "withheld" -> stringResource(R.string.weldbooks_tax_treatment_withheld)
                    else -> stringResource(R.string.weldbooks_tax_treatment_informational)
                },
            )
            val informational = group.treatment == "informational"
            group.taxes.forEach { tax ->
                val amount = books.money(tax.amount, currency)
                val color = if (informational) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(tax.name, style = MaterialTheme.typography.bodyMedium, color = color)
                        if (tax.rate.signum() > 0) {
                            Text(
                                stringResource(R.string.weldbooks_sales_tax_rate_on, Amounts.percent(tax.rate), books.money(tax.base, currency)),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Text(if (group.treatment == "withheld") "−$amount" else amount, style = MaterialTheme.typography.bodyMedium, color = color)
                }
            }
        }
    }
}

/** Record a payment against an invoice or bill: the open balance by default, less for a partial payment. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaymentSheet(balanceDue: BigDecimal, currency: String, received: Boolean, busy: Boolean, onDismiss: () -> Unit, onSubmit: (PaymentValues) -> Unit) {
    val books = LocalBooks.current
    val isUs = books.isUs
    var amount by rememberSaveable { mutableStateOf(if (balanceDue.signum() > 0) Amounts.cents(balanceDue).toPlainString() else "") }
    var date by remember { mutableStateOf(Days.today()) }
    var method by rememberSaveable { mutableStateOf(Payments.defaultMethod(isUs)) }
    var checkNumber by rememberSaveable { mutableStateOf("") }
    var depositTo by rememberSaveable { mutableStateOf("undeposited_funds") }
    var error by remember { mutableStateOf<String?>(null) }
    val amountError = stringResource(R.string.weldbooks_payments_amount_error)
    val exceedError = stringResource(R.string.weldbooks_payments_exceed_balance, books.money(balanceDue, currency))
    val value = Amounts.parse(amount, books.decimalPoint)
    val remaining = balanceDue - value
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.verticalScroll(rememberScrollState()).imePadding().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)) {
            Text(stringResource(R.string.weldbooks_payments_title), style = MaterialTheme.typography.titleLarge)
            Column(Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.m)) {
                Text(stringResource(R.string.weldbooks_payments_open_balance), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(books.money(balanceDue, currency), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            }
            FormField(
                stringResource(R.string.weldbooks_payments_amount),
                amount,
                {
                    amount = it
                    error = null
                },
                keyboard = KeyboardType.Decimal,
                placeholder = "0.00",
                error = error,
                helper = if (remaining > BigDecimal("0.005")) stringResource(R.string.weldbooks_payments_remaining, books.money(remaining, currency)) else null,
                tag = "payment-amount",
            )
            DateField(stringResource(R.string.weldbooks_payments_payment_date), date, { date = it }, tag = "payment-date")
            Dropdown(stringResource(R.string.weldbooks_payments_method), method, Payments.methods(isUs).map { it to paymentMethodLabel(it) }, { method = it }, tag = "payment-method")
            if (Payments.takesCheckNumber(isUs, method)) {
                FormField(stringResource(R.string.weldbooks_payments_check_number), checkNumber, { checkNumber = it }, placeholder = stringResource(R.string.weldbooks_payments_check_number_placeholder), keyboard = KeyboardType.Number)
            }
            if (Payments.offersDepositChoice(isUs, received, method)) {
                Dropdown(
                    stringResource(R.string.weldbooks_payments_deposit_to),
                    depositTo,
                    listOf(
                        "undeposited_funds" to stringResource(R.string.weldbooks_payments_undeposited_funds),
                        "bank" to stringResource(R.string.weldbooks_payments_bank_account),
                    ),
                    { depositTo = it },
                )
                HintText(stringResource(if (depositTo == "bank") R.string.weldbooks_payments_bank_hint else R.string.weldbooks_payments_undeposited_hint))
            }
            Button(
                onClick = {
                    when {
                        value.signum() <= 0 -> error = amountError
                        balanceDue.signum() > 0 && value > balanceDue + BigDecimal("0.005") -> error = exceedError
                        else -> onSubmit(
                            PaymentValues(
                                amount = value,
                                date = date.toString(),
                                method = method,
                                checkNumber = checkNumber.trim().takeIf { Payments.takesCheckNumber(isUs, method) && it.isNotEmpty() },
                                depositTo = depositTo.takeIf { Payments.offersDepositChoice(isUs, received, method) },
                            ),
                        )
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.l).tagged("payment-submit"),
            ) { Text(stringResource(R.string.weldbooks_payments_title)) }
        }
    }
}

@Composable
fun paymentMethodLabel(method: String): String = when (method) {
    "check" -> stringResource(R.string.weldbooks_payments_check)
    "ach" -> stringResource(R.string.weldbooks_payments_ach)
    "wire" -> stringResource(R.string.weldbooks_payments_wire)
    "credit_card" -> stringResource(R.string.weldbooks_payments_credit_card)
    "debit_card" -> stringResource(R.string.weldbooks_payments_debit_card)
    "cash" -> stringResource(R.string.weldbooks_payments_cash)
    "bank_transfer" -> stringResource(R.string.weldbooks_payments_bank_transfer)
    "card" -> stringResource(R.string.weldbooks_payments_card)
    "direct_debit" -> stringResource(R.string.weldbooks_payments_direct_debit)
    else -> stringResource(R.string.weldbooks_payments_other)
}


/** Re-run [block] whenever [key] changes, after [delayMillis] without another change. */
@Composable
fun Debounced(key: Any?, delayMillis: Long, block: suspend () -> Unit) {
    LaunchedEffect(key) {
        kotlinx.coroutines.delay(delayMillis)
        block()
    }
}
