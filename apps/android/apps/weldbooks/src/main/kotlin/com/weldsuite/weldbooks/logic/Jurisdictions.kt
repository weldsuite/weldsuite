package com.weldsuite.weldbooks.logic

import java.util.Locale

/** Which country modules an entity gets (`GET /accounting-entities/jurisdictions`). */
data class Features(
    val vatReturn: Boolean = false,
    val icp: Boolean = false,
    val xafExport: Boolean = false,
    val smallBusinessScheme: Boolean = false,
    val gstReturn: Boolean = false,
    val salesTax: Boolean = false,
    val form1099: Boolean = false,
    val brTaxReturn: Boolean = false,
    val fiscalDocuments: Boolean = false,
    val spedEcd: Boolean = false,
)

/** Codes of the words that differ per country; the app translates them. */
data class Terminology(
    val tax: String = "vat",
    val taxId: String = "vat_number",
    val registrationId: String = "company_number",
    val supplier: String = "supplier",
    val creditNote: String = "credit_note",
)

data class UsClassification(val value: String, val form: String, val formLabel: String)

data class UsEntityType(
    val type: String,
    val label: String,
    val defaultClassification: String,
    val classifications: List<UsClassification>,
)

data class Jurisdiction(
    val code: String,
    val name: String,
    val defaultLocale: String,
    val defaultCurrency: String,
    val features: Features,
    val terminology: Terminology,
    /** The company fields an invoice can't be finalised without; null from an older server. */
    val invoiceRequiredFields: List<String>? = null,
    /** US only. */
    val entityTypes: List<UsEntityType>? = null,
)

/** Country rules, mirroring the server's adapters, for before (or without) the server's list. */
object Jurisdictions {
    const val FALLBACK_CURRENCY = "EUR"

    val builtIn: List<Jurisdiction> = listOf(
        Jurisdiction(
            "NL", "Netherlands", "nl-NL", "EUR",
            Features(vatReturn = true, icp = true, xafExport = true, smallBusinessScheme = true),
            Terminology("vat", "vat_number", "kvk", "supplier", "credit_note"),
        ),
        Jurisdiction(
            "IN", "India", "en-IN", "INR",
            Features(gstReturn = true),
            Terminology("gst", "gstin", "pan", "supplier", "credit_note"),
        ),
        Jurisdiction(
            "US", "United States", "en-US", "USD",
            Features(salesTax = true, form1099 = true),
            Terminology("sales_tax", "ein", "state_id", "vendor", "credit_memo"),
        ),
        Jurisdiction(
            "BR", "Brazil", "pt-BR", "BRL",
            Features(brTaxReturn = true, fiscalDocuments = true, spedEcd = true),
            Terminology("tributos", "cnpj", "ie", "supplier", "credit_note"),
        ),
    )

    private val defaultTaxRates = mapOf("NL" to "21", "IN" to "18", "BR" to "0")

    /** What a company with these fields needs on an invoice, per country (address added everywhere). */
    val builtInInvoiceFields: Map<String, List<String>> = mapOf(
        "NL" to listOf("vatNumber", "registrationNumber", "iban", "address"),
        "IN" to listOf("vatNumber", "registrationNumber", "address"),
        "BR" to listOf("vatNumber", "address"),
        "US" to listOf("address"),
    )

    val invoiceFields = listOf("vatNumber", "registrationNumber", "iban", "bic", "address")

    private val ibanCountries = setOf(
        "AD", "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GI", "GR",
        "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MT", "NL", "NO", "PL", "PT", "RO",
        "SE", "SI", "SK", "SM", "VA",
    )

    fun isUs(code: String?): Boolean = code?.uppercase() == "US"

    fun isBr(code: String?): Boolean = code?.uppercase() == "BR"

    fun usesIban(code: String?): Boolean = code != null && code.uppercase() in ibanCountries

    /** The server's jurisdiction for a code, else the built-in one. */
    fun find(code: String?, loaded: List<Jurisdiction>?): Jurisdiction? {
        val wanted = code?.uppercase() ?: return null
        return loaded?.firstOrNull { it.code.uppercase() == wanted } ?: builtIn.firstOrNull { it.code == wanted }
    }

    /** The VAT/GST percentage a new line starts with; a US line carries a tax code instead. */
    fun defaultTaxRate(code: String?): String = code?.uppercase()?.let { defaultTaxRates[it] } ?: "0"

    /** The country setup starts on: the phone's region when supported, else the Netherlands. */
    fun defaultCode(locale: Locale = Locale.getDefault()): String =
        builtIn.firstOrNull { it.code == locale.country.uppercase() }?.code ?: "NL"

    /** The fields a company here needs to finalise an invoice: the server's list, else the built-in one, plus the address. */
    fun requiredInvoiceFields(code: String?, loaded: List<Jurisdiction>?): List<String> {
        val wanted = code?.uppercase() ?: return listOf("address")
        val fromServer = loaded?.firstOrNull { it.code.uppercase() == wanted }?.invoiceRequiredFields
        val listed = (fromServer ?: builtInInvoiceFields[wanted].orEmpty()).filter { it in invoiceFields }
        return (listed + "address").distinct()
    }

    /** The locale money and dates are shown in: US and Brazilian companies read in their own format. */
    fun formatLocale(entityLocale: String?, device: Locale = Locale.getDefault()): Locale {
        val tag = entityLocale?.replace('_', '-') ?: return device
        return when {
            tag.equals("en-US", ignoreCase = true) -> Locale.US
            tag.equals("pt-BR", ignoreCase = true) -> Locale.forLanguageTag("pt-BR")
            device.language == "en" && Regex("^en-[A-Za-z]{2}$").matches(tag) -> Locale.forLanguageTag(tag)
            else -> device
        }
    }
}

/** The company whose books are open: the one picked before when it still exists, else the default, else the first. */
fun <T> resolveActiveEntity(entities: List<T>, selectedId: String?, id: (T) -> String, isDefault: (T) -> Boolean): T? {
    if (selectedId != null) entities.firstOrNull { id(it) == selectedId }?.let { return it }
    return entities.firstOrNull(isDefault) ?: entities.firstOrNull()
}
