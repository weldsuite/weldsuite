package com.weldsuite.weldbooks.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.res.stringResource
import com.weldsuite.weldbooks.BooksRepository
import com.weldsuite.weldbooks.EntityState
import com.weldsuite.weldbooks.OfflineQueue
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.Entity
import com.weldsuite.weldbooks.logic.Features
import com.weldsuite.weldbooks.logic.Jurisdiction
import com.weldsuite.weldbooks.logic.Jurisdictions
import com.weldsuite.weldbooks.logic.Terminology
import org.weldsuite.core.AppEnvironment
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Currency
import java.util.Locale

/** The words that differ per country, in the app's language. */
data class Labels(
    val tax: String,
    val taxPercent: String,
    val taxId: String,
    val taxIdPlaceholder: String,
    val registrationId: String,
    val supplier: String,
    val suppliers: String,
    val creditNote: String,
    /** `{rate}% VAT`. */
    val taxRate: (String) -> String,
) {
    /** `{supplier}` and friends in the middle of a sentence. */
    val supplierLower: String get() = supplier.lowercase()
    val suppliersLower: String get() = suppliers.lowercase()
    val creditNoteLower: String get() = creditNote.lowercase()
}

/** What every screen needs to know about the open company. */
data class Books(
    val env: AppEnvironment,
    val repository: BooksRepository,
    val entities: EntityState,
    val queue: OfflineQueue,
    val workspaceId: String,
    val entity: Entity?,
    val jurisdictions: List<Jurisdiction>?,
    val labels: Labels,
) {
    val code: String? get() = entity?.jurisdictionCode?.uppercase()
    val jurisdiction: Jurisdiction? get() = Jurisdictions.find(code, jurisdictions)
    val features: Features get() = jurisdiction?.features ?: Features()
    val terminology: Terminology get() = jurisdiction?.terminology ?: Terminology()
    val isUs: Boolean get() = Jurisdictions.isUs(code)
    val isBr: Boolean get() = Jurisdictions.isBr(code)
    val currency: String get() = entity?.baseCurrency ?: jurisdiction?.defaultCurrency ?: Jurisdictions.FALLBACK_CURRENCY
    val locale: Locale get() = Jurisdictions.formatLocale(entity?.locale ?: jurisdiction?.defaultLocale)

    /** US English types `1,234.56`; everyone else may type a decimal comma. */
    val decimalPoint: Boolean get() = locale.language == "en" && locale.country == "US"

    fun money(amount: BigDecimal, currency: String? = null): String = formatMoney(amount, currency ?: this.currency, locale)

    /** For KPI tiles: `€12.3K` above a thousand, exact below. */
    fun compactMoney(amount: BigDecimal, currency: String? = null): String = formatCompact(amount, currency ?: this.currency, locale)

    /** `27 Nov 2026`, or `11/27/2026` for a US company. */
    fun date(text: String?): String = com.weldsuite.weldbooks.logic.Days.of(text)?.let { formatDay(it, locale) } ?: "—"

    /** `27 Nov`, or `11/27`. */
    fun shortDate(text: String?): String = com.weldsuite.weldbooks.logic.Days.of(text)?.let { day ->
        val pattern = if (locale.country == "US") "MM/dd" else "d MMM"
        day.format(DateTimeFormatter.ofPattern(pattern, locale))
    } ?: "—"
}

val LocalBooks = staticCompositionLocalOf<Books> { error("No WeldBooks context") }

fun formatDay(day: LocalDate, locale: Locale): String =
    if (locale.country == "US") day.format(DateTimeFormatter.ofPattern("MM/dd/yyyy", locale))
    else day.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))

fun formatMoney(amount: BigDecimal, currency: String?, locale: Locale): String =
    org.weldsuite.core.Money.format(amount, currency, locale)

fun formatCompact(amount: BigDecimal, currency: String?, locale: Locale): String {
    val abs = amount.abs()
    val known = currency?.let { runCatching { Currency.getInstance(it.uppercase()) }.getOrNull() }
    if (abs < BigDecimal(1000) || known == null) return formatMoney(amount, currency, locale)
    val (scaled, suffix) = when {
        abs >= BigDecimal(1_000_000_000) -> amount.divide(BigDecimal(1_000_000_000)) to "B"
        abs >= BigDecimal(1_000_000) -> amount.divide(BigDecimal(1_000_000)) to "M"
        else -> amount.divide(BigDecimal(1_000)) to "K"
    }
    val format = NumberFormat.getCurrencyInstance(locale).apply {
        this.currency = known
        minimumFractionDigits = 0
        maximumFractionDigits = 1
    }
    val text = format.format(scaled.setScale(1, RoundingMode.HALF_UP))
    // `€ 12,3` → `€ 12,3K`; `12,3 €` → `12,3K €`.
    val lastDigit = text.indexOfLast { it.isDigit() }
    return if (lastDigit < 0) text else text.substring(0, lastDigit + 1) + suffix + text.substring(lastDigit + 1)
}

/** The country's words, translated. */
@Composable
fun terminologyLabels(terminology: Terminology): Labels {
    val tax = when (terminology.tax) {
        "gst" -> R.string.weldbooks_terminology_tax_gst
        "sales_tax" -> R.string.weldbooks_terminology_tax_sales_tax
        "tributos" -> R.string.weldbooks_terminology_tax_tributos
        else -> R.string.weldbooks_terminology_tax_vat
    }
    val taxPercent = when (terminology.tax) {
        "gst" -> R.string.weldbooks_terminology_tax_percent_gst
        "sales_tax" -> R.string.weldbooks_terminology_tax_percent_sales_tax
        "tributos" -> R.string.weldbooks_terminology_tax_percent_tributos
        else -> R.string.weldbooks_terminology_tax_percent_vat
    }
    val taxRate = when (terminology.tax) {
        "gst" -> R.string.weldbooks_terminology_tax_rate_gst
        "sales_tax" -> R.string.weldbooks_terminology_tax_rate_sales_tax
        "tributos" -> R.string.weldbooks_terminology_tax_rate_tributos
        else -> R.string.weldbooks_terminology_tax_rate_vat
    }
    val (taxId, taxIdPlaceholder) = when (terminology.taxId) {
        "gstin" -> R.string.weldbooks_terminology_tax_id_gstin to R.string.weldbooks_terminology_tax_id_placeholder_gstin
        "ein" -> R.string.weldbooks_terminology_tax_id_ein to R.string.weldbooks_terminology_tax_id_placeholder_ein
        "cnpj" -> R.string.weldbooks_terminology_tax_id_cnpj to R.string.weldbooks_terminology_tax_id_placeholder_cnpj
        else -> R.string.weldbooks_terminology_tax_id_vat_number to R.string.weldbooks_terminology_tax_id_placeholder_vat_number
    }
    val registration = when (terminology.registrationId) {
        "kvk" -> R.string.weldbooks_terminology_registration_id_kvk
        "pan" -> R.string.weldbooks_terminology_registration_id_pan
        "state_id" -> R.string.weldbooks_terminology_registration_id_state_id
        "ie" -> R.string.weldbooks_terminology_registration_id_ie
        else -> R.string.weldbooks_terminology_registration_id_company_number
    }
    val vendor = terminology.supplier == "vendor"
    val creditMemo = terminology.creditNote == "credit_memo"
    val rateTemplate = stringResource(taxRate, "%RATE%")
    return Labels(
        tax = stringResource(tax),
        taxPercent = stringResource(taxPercent),
        taxId = stringResource(taxId),
        taxIdPlaceholder = stringResource(taxIdPlaceholder),
        registrationId = stringResource(registration),
        supplier = stringResource(if (vendor) R.string.weldbooks_terminology_supplier_vendor else R.string.weldbooks_terminology_supplier_supplier),
        suppliers = stringResource(if (vendor) R.string.weldbooks_terminology_suppliers_vendor else R.string.weldbooks_terminology_suppliers_supplier),
        creditNote = stringResource(if (creditMemo) R.string.weldbooks_terminology_credit_note_credit_memo else R.string.weldbooks_terminology_credit_note_credit_note),
        taxRate = { rate -> rateTemplate.replace("%RATE%", rate) },
    )
}
