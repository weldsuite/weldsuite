package com.weldsuite.weldbooks.logic

/** Typo checks for the identifiers the company and contact forms take; the server checks them again. */
object Identifiers {
    // IBAN

    fun normalizeIban(raw: String): String = raw.filterNot { it.isWhitespace() }.uppercase()

    /** Upper case, in groups of four, as typed. */
    fun formatIbanInput(raw: String): String =
        normalizeIban(raw).filter { it in 'A'..'Z' || it in '0'..'9' }.take(34).chunked(4).joinToString(" ")

    /** `format`, `checksum` or null when the IBAN is fine. */
    fun ibanProblem(raw: String): String? {
        val iban = normalizeIban(raw)
        if (!Regex("^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$").matches(iban)) return "format"
        val rearranged = iban.drop(4) + iban.take(4)
        var remainder = 0
        for (char in rearranged) {
            val value = if (char in 'A'..'Z') (char.code - 55).toString() else char.toString()
            for (digit in value) remainder = (remainder * 10 + digit.digitToInt()) % 97
        }
        return if (remainder == 1) null else "checksum"
    }

    // Netherlands

    fun normalizeBtw(raw: String): String = raw.filterNot { it.isWhitespace() || it == '.' }.uppercase()

    fun btwProblem(raw: String): String? = if (Regex("^NL\\d{9}B\\d{2}$").matches(normalizeBtw(raw))) null else "format"

    fun normalizeKvk(raw: String): String = raw.filterNot { it.isWhitespace() }

    fun kvkProblem(raw: String): String? = if (Regex("^\\d{8}$").matches(normalizeKvk(raw))) null else "format"

    // US

    private val einPrefixes = listOf(1..6, 10..16, 20..27, 30..48, 50..68, 71..77, 80..88, 90..95, 98..99)

    fun formatEinInput(raw: String): String {
        val digits = raw.filter { it.isDigit() }.take(9)
        return if (digits.length > 2) "${digits.take(2)}-${digits.drop(2)}" else digits
    }

    /** `format`, `prefix` or null when the EIN is fine (or empty). */
    fun einProblem(raw: String): String? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        if (!Regex("^\\d{2}-\\d{7}$").matches(text) && !Regex("^\\d{9}$").matches(text)) return "format"
        val prefix = text.filter { it.isDigit() }.take(2).toInt()
        return if (einPrefixes.any { prefix in it }) null else "prefix"
    }

    fun normalizeEin(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        return if (digits.length == 9) "${digits.take(2)}-${digits.drop(2)}" else raw.trim()
    }

    /** `12345`, `12345-6789` or nine digits, as the canonical form; null for anything else. */
    fun normalizeZip(raw: String?): String? {
        val match = Regex("^(\\d{5})(?:-?(\\d{4}))?$").find(raw?.trim().orEmpty()) ?: return null
        val (five, four) = match.destructured
        if (five == "00000") return null
        return if (four.isNotEmpty()) "$five-$four" else five
    }

    fun formatZipInput(raw: String): String {
        val digits = raw.filter { it.isDigit() }.take(9)
        return if (digits.length > 5) "${digits.take(5)}-${digits.drop(5)}" else digits
    }

    // Brazil

    private val cnpjWeights1 = intArrayOf(5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)
    private val cnpjWeights2 = intArrayOf(6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)

    fun normalizeCnpj(raw: String): String = raw.filterNot { it.isWhitespace() || it == '.' || it == '/' || it == '-' }.uppercase()

    private fun checkDigit(values: List<Int>, weights: IntArray): Int {
        val sum = values.indices.sumOf { values[it] * weights[it] }
        val remainder = sum % 11
        return if (remainder < 2) 0 else 11 - remainder
    }

    fun cnpjCheckDigits(first12: String): String {
        val values = first12.map { it.code - 48 }
        val first = checkDigit(values, cnpjWeights1)
        val second = checkDigit(values + first, cnpjWeights2)
        return "$first$second"
    }

    fun formatCnpj(normalized: String): String {
        if (normalized.length != 14) return normalized
        return "${normalized.substring(0, 2)}.${normalized.substring(2, 5)}.${normalized.substring(5, 8)}/" +
            "${normalized.substring(8, 12)}-${normalized.substring(12)}"
    }

    fun formatCnpjInput(raw: String): String = formatCnpj(normalizeCnpj(raw).take(14))

    /** `format`, `checkDigits` or null when the CNPJ is fine (or empty). */
    fun cnpjProblem(raw: String): String? {
        val value = normalizeCnpj(raw)
        if (value.isEmpty()) return null
        if (!Regex("^[0-9A-Z]{12}\\d{2}$").matches(value) || value.all { it == value[0] }) return "format"
        return if (cnpjCheckDigits(value.take(12)) == value.takeLast(2)) null else "checkDigits"
    }

    val brEntityTypes = listOf("mei", "ei", "slu", "ltda", "sa")

    /** Which tax regimes a Brazilian legal form can be in. */
    fun allowedBrRegimes(entityType: String?): List<String> = when (entityType) {
        "mei" -> listOf("mei")
        "sa" -> listOf("lucro_presumido", "lucro_real")
        else -> listOf("simples_nacional", "lucro_presumido", "lucro_real")
    }

    fun validBrRegime(entityType: String?, value: String?): String {
        val allowed = allowedBrRegimes(entityType)
        return value?.takeIf { it in allowed } ?: if ("simples_nacional" in allowed) "simples_nacional" else allowed.first()
    }
}

/** US states and US company forms. */
object UsRules {
    val states: List<Pair<String, String>> = listOf(
        "AL" to "Alabama", "AK" to "Alaska", "AZ" to "Arizona", "AR" to "Arkansas", "CA" to "California",
        "CO" to "Colorado", "CT" to "Connecticut", "DE" to "Delaware", "DC" to "District of Columbia",
        "FL" to "Florida", "GA" to "Georgia", "HI" to "Hawaii", "ID" to "Idaho", "IL" to "Illinois",
        "IN" to "Indiana", "IA" to "Iowa", "KS" to "Kansas", "KY" to "Kentucky", "LA" to "Louisiana",
        "ME" to "Maine", "MD" to "Maryland", "MA" to "Massachusetts", "MI" to "Michigan", "MN" to "Minnesota",
        "MS" to "Mississippi", "MO" to "Missouri", "MT" to "Montana", "NE" to "Nebraska", "NV" to "Nevada",
        "NH" to "New Hampshire", "NJ" to "New Jersey", "NM" to "New Mexico", "NY" to "New York",
        "NC" to "North Carolina", "ND" to "North Dakota", "OH" to "Ohio", "OK" to "Oklahoma", "OR" to "Oregon",
        "PA" to "Pennsylvania", "RI" to "Rhode Island", "SC" to "South Carolina", "SD" to "South Dakota",
        "TN" to "Tennessee", "TX" to "Texas", "UT" to "Utah", "VT" to "Vermont", "VA" to "Virginia",
        "WA" to "Washington", "WV" to "West Virginia", "WI" to "Wisconsin", "WY" to "Wyoming",
        "AS" to "American Samoa", "GU" to "Guam", "MP" to "Northern Mariana Islands", "PR" to "Puerto Rico",
        "VI" to "U.S. Virgin Islands",
    )

    private val codes = states.map { it.first }.toSet()

    fun isStateCode(value: String?): Boolean = value != null && value.trim().uppercase() in codes

    /** `ca`, `CA` and `California` all become `CA`; anything else comes back trimmed. */
    fun stateCode(value: String?): String {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return ""
        val upper = text.uppercase()
        if (upper in codes) return upper
        return states.firstOrNull { it.second.uppercase() == upper }?.first ?: text
    }

    /** The product tax codes a US line can carry. */
    val taxCodes = listOf(
        "general", "saas", "digital_goods", "services", "professional_services", "shipping", "handling",
        "food_grocery", "prepared_food", "clothing", "prescription_drugs", "non_taxable",
    )
    const val DEFAULT_TAX_CODE = "general"

    private val forms = mapOf(
        "sole_proprietor" to ("sch_c" to "Schedule C (Form 1040)"),
        "disregarded" to ("sch_c" to "Schedule C (Form 1040)"),
        "partnership" to ("f1065" to "Form 1065"),
        "s_corp" to ("f1120s" to "Form 1120-S"),
        "c_corp" to ("f1120" to "Form 1120"),
        "exempt" to ("f990" to "Form 990"),
    )

    private fun type(type: String, vararg classifications: String) = UsEntityType(
        type = type,
        label = type,
        defaultClassification = classifications.first(),
        classifications = classifications.map { value ->
            val (form, label) = forms.getValue(value)
            UsClassification(value, form, label)
        },
    )

    val fallbackEntityTypes = listOf(
        type("sole_proprietorship", "sole_proprietor"),
        type("single_member_llc", "disregarded", "s_corp", "c_corp"),
        type("multi_member_llc", "partnership", "s_corp", "c_corp"),
        type("partnership", "partnership"),
        type("s_corp", "s_corp"),
        type("c_corp", "c_corp"),
        type("nonprofit", "exempt"),
    )

    fun entityTypes(loaded: List<UsEntityType>?): List<UsEntityType> = loaded?.takeIf { it.isNotEmpty() } ?: fallbackEntityTypes

    fun defaultClassification(types: List<UsEntityType>, type: String): String {
        val found = types.firstOrNull { it.type == type }
        return found?.defaultClassification?.takeIf { it.isNotEmpty() } ?: found?.classifications?.firstOrNull()?.value.orEmpty()
    }

    /** [value] when the legal form allows it, else the form's default. */
    fun validClassification(types: List<UsEntityType>, type: String, value: String?): String {
        val allowed = types.firstOrNull { it.type == type }?.classifications.orEmpty()
        return if (value != null && allowed.any { it.value == value }) value else defaultClassification(types, type)
    }
}
