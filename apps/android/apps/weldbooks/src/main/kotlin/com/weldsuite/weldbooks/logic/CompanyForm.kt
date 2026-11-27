package com.weldsuite.weldbooks.logic

/** An address as the forms keep it while typing (text, never null). */
data class AddressDraft(
    val line1: String = "",
    val line2: String = "",
    val city: String = "",
    val state: String = "",
    val postalCode: String = "",
) {
    val isBlank: Boolean get() = listOf(line1, line2, city, state, postalCode).all { it.isBlank() }

    /** A ship-to the sales tax engine can work with: a real state and a ZIP. */
    val isUsTaxable: Boolean get() = UsRules.isStateCode(state) && Identifiers.normalizeZip(postalCode) != null

    companion object {
        fun of(address: Address?): AddressDraft = AddressDraft(
            line1 = address?.line1.orEmpty(),
            line2 = address?.line2.orEmpty(),
            city = address?.city.orEmpty(),
            state = UsRules.stateCode(address?.state),
            postalCode = address?.postalCode.orEmpty(),
        )
    }
}

/** What is wrong with a US address: `required` or `invalid` per field. */
data class UsAddressProblems(val state: String? = null, val postalCode: String? = null) {
    val isEmpty: Boolean get() = state == null && postalCode == null
}

object Addresses {
    /** A blank address is fine, unless [requireStateAndZip]; a started one needs a valid state and ZIP. */
    fun usProblems(draft: AddressDraft, requireStateAndZip: Boolean = false): UsAddressProblems {
        val mustHave = requireStateAndZip || !draft.isBlank
        val state = when {
            draft.state.isBlank() -> if (mustHave) "required" else null
            !UsRules.isStateCode(draft.state) -> "invalid"
            else -> null
        }
        val zip = when {
            draft.postalCode.isBlank() -> if (mustHave) "required" else null
            Identifiers.normalizeZip(draft.postalCode) == null -> "invalid"
            else -> null
        }
        return UsAddressProblems(state, zip)
    }

    /** A US address as the API takes it; null for a blank one. */
    fun usAddress(draft: AddressDraft): Address? {
        if (draft.isBlank) return null
        return Address(
            line1 = draft.line1.trim().ifEmpty { null },
            line2 = draft.line2.trim().ifEmpty { null },
            city = draft.city.trim().ifEmpty { null },
            state = UsRules.stateCode(draft.state).ifEmpty { null },
            postalCode = (Identifiers.normalizeZip(draft.postalCode) ?: draft.postalCode.trim()).ifEmpty { null },
            country = "US",
        )
    }

    /**
     * An address outside the US as the API takes it; null for a blank one. The
     * update replaces the stored address as a whole, so the parts the form
     * doesn't show ([stored] state, county) are carried through.
     */
    fun genericAddress(draft: AddressDraft, country: String, stored: Address? = null): Address? {
        if (draft.isBlank) return null
        val base = stored ?: Address()
        return base.copy(
            line1 = draft.line1.trim().ifEmpty { null },
            line2 = draft.line2.trim().ifEmpty { null },
            city = draft.city.trim().ifEmpty { null },
            postalCode = draft.postalCode.trim().ifEmpty { null },
            country = country,
        )
    }

    /** "Springfield, IL 62704". */
    fun cityLine(address: Address?): String {
        address ?: return ""
        val stateZip = listOfNotNull(address.state, address.postalCode).filter { it.isNotBlank() }.joinToString(" ")
        return listOfNotNull(address.city, stateZip).filter { it.isNotBlank() }.joinToString(", ")
    }

    /** The lines of an address to print, top to bottom. */
    fun lines(address: Address?): List<String> {
        address ?: return emptyList()
        return listOfNotNull(address.line1, address.line2, cityLine(address)).filter { it.isNotBlank() }
    }

    /** An address an invoice can print: a street and a city. */
    fun isInvoiceAddress(address: Address?): Boolean = !address?.line1.isNullOrBlank() && !address?.city.isNullOrBlank()
}

/** The company details the setup and edit sheets keep while typing. */
data class CompanyDraft(
    val name: String = "",
    /** BTW number, GSTIN, CNPJ or EIN. */
    val taxId: String = "",
    /** KvK number, PAN, state ID, IE. */
    val registrationNumber: String = "",
    val iban: String = "",
    val bic: String = "",
    val address: AddressDraft = AddressDraft(),
)

/** What is wrong with the company details, by field. Blank optional fields are fine. */
data class CompanyProblems(
    val name: Boolean = false,
    /** `einFormat`, `einPrefix`, `cnpjFormat`, `cnpjCheckDigits`, `btwFormat`. */
    val taxId: String? = null,
    /** `kvkFormat`. */
    val registrationNumber: String? = null,
    /** `ibanFormat`, `ibanChecksum`. */
    val iban: String? = null,
    val line1: Boolean = false,
    val city: Boolean = false,
) {
    val isEmpty: Boolean get() = !name && taxId == null && registrationNumber == null && iban == null && !line1 && !city
}

/** What `PATCH /accounting-entities/:id` changes; only what differs from the stored company. */
data class EntityUpdateValues(
    val name: String? = null,
    val vatNumber: String? = null,
    val einOrSsn: String? = null,
    val registrationNumber: String? = null,
    val iban: String? = null,
    val bic: String? = null,
    val address: Address? = null,
) {
    val isEmpty: Boolean get() = this == EntityUpdateValues()
    val changesTaxIdentifiers: Boolean get() = vatNumber != null || einOrSsn != null || registrationNumber != null
    val changesBank: Boolean get() = iban != null || bic != null
}

object CompanyForm {
    fun draft(entity: Entity?): CompanyDraft {
        entity ?: return CompanyDraft()
        val isUs = Jurisdictions.isUs(entity.jurisdictionCode)
        return CompanyDraft(
            name = entity.name,
            taxId = (if (isUs) entity.ein ?: entity.vatNumber else entity.vatNumber).orEmpty(),
            registrationNumber = entity.registrationNumber.orEmpty(),
            iban = entity.iban?.let(Identifiers::formatIbanInput).orEmpty(),
            bic = entity.bic.orEmpty(),
            address = AddressDraft.of(entity.address),
        )
    }

    /** The tax ID in the country's own normal form. */
    fun normalizeTaxId(value: String, code: String?): String = when (code?.uppercase()) {
        "US" -> if (value.isBlank()) "" else Identifiers.normalizeEin(value)
        "BR" -> Identifiers.normalizeCnpj(value)
        "NL" -> Identifiers.normalizeBtw(value)
        else -> value.trim()
    }

    private fun normalizeRegistration(value: String, code: String?): String =
        if (code?.uppercase() == "NL") Identifiers.normalizeKvk(value) else value.trim().replace(Regex("\\s+"), " ")

    /** Tax ID as typed: an EIN or a CNPJ takes shape while typing. */
    fun formatTaxIdInput(code: String?, text: String): String = when (code?.uppercase()) {
        "US" -> Identifiers.formatEinInput(text)
        "BR" -> Identifiers.formatCnpjInput(text)
        else -> text
    }

    fun problems(draft: CompanyDraft, code: String?, requireName: Boolean): CompanyProblems {
        val upper = code?.uppercase()
        val taxId = draft.taxId.takeIf { it.isNotBlank() }?.let { tax ->
            when (upper) {
                "US" -> Identifiers.einProblem(tax)?.let { if (it == "format") "einFormat" else "einPrefix" }
                "BR" -> Identifiers.cnpjProblem(tax)?.let { if (it == "format") "cnpjFormat" else "cnpjCheckDigits" }
                "NL" -> Identifiers.btwProblem(tax)?.let { "btwFormat" }
                else -> null
            }
        }
        val registration = if (upper == "NL" && draft.registrationNumber.isNotBlank() && Identifiers.kvkProblem(draft.registrationNumber) != null) "kvkFormat" else null
        val iban = draft.iban.takeIf { it.isNotBlank() }?.let(Identifiers::ibanProblem)?.let { if (it == "format") "ibanFormat" else "ibanChecksum" }
        // A US address is checked for its state and ZIP elsewhere; the others need a street and a city once started.
        val checkAddress = upper != "US" && !draft.address.isBlank
        return CompanyProblems(
            name = requireName && draft.name.isBlank(),
            taxId = taxId,
            registrationNumber = registration,
            iban = iban,
            line1 = checkAddress && draft.address.line1.isBlank(),
            city = checkAddress && draft.address.city.isBlank(),
        )
    }

    private fun sameAddress(draft: AddressDraft, address: Address?): Boolean {
        val stored = AddressDraft.of(address)
        return draft.line1.trim() == stored.line1.trim() && draft.line2.trim() == stored.line2.trim() &&
            draft.city.trim() == stored.city.trim() && draft.state.trim() == stored.state.trim() &&
            draft.postalCode.trim() == stored.postalCode.trim()
    }

    /** The changes [draft] makes to [entity]: an untouched field is not sent, and a blank address never clears one. */
    fun update(entity: Entity, draft: CompanyDraft): EntityUpdateValues {
        val code = entity.jurisdictionCode
        val isUs = Jurisdictions.isUs(code)
        val stored = draft(entity)
        var update = EntityUpdateValues()

        val name = draft.name.trim()
        if (name.isNotEmpty() && name != entity.name) update = update.copy(name = name)

        val taxId = normalizeTaxId(draft.taxId, code)
        if (taxId != normalizeTaxId(stored.taxId, code)) {
            update = if (isUs) update.copy(einOrSsn = taxId) else update.copy(vatNumber = taxId)
        }
        val registration = normalizeRegistration(draft.registrationNumber, code)
        if (registration != normalizeRegistration(stored.registrationNumber, code)) update = update.copy(registrationNumber = registration)

        val iban = Identifiers.normalizeIban(draft.iban)
        if (iban != Identifiers.normalizeIban(stored.iban)) update = update.copy(iban = iban)
        val bic = draft.bic.trim().uppercase()
        if (bic != stored.bic.trim().uppercase()) update = update.copy(bic = bic)

        if (!draft.address.isBlank && !sameAddress(draft.address, entity.address)) {
            val address = if (isUs) Addresses.usAddress(draft.address) else Addresses.genericAddress(draft.address, code.uppercase(), entity.address)
            if (address != null) update = update.copy(address = address)
        }
        return update
    }

    /** Which of [required] the company hasn't filled in. */
    fun missingInvoiceFields(entity: Entity?, required: List<String>): List<String> = required.filter { field ->
        when (field) {
            "vatNumber" -> entity?.vatNumber.isNullOrBlank()
            "registrationNumber" -> entity?.registrationNumber.isNullOrBlank()
            "iban" -> entity?.iban.isNullOrBlank()
            "bic" -> entity?.bic.isNullOrBlank()
            "address" -> !Addresses.isInvoiceAddress(entity?.address)
            else -> false
        }
    }

    /** "BTW-nummer, KvK-nummer and IBAN". */
    fun listFields(fields: List<String>, name: (String) -> String, and: String): String {
        val words = fields.map(name)
        if (words.size <= 1) return words.joinToString("")
        return "${words.dropLast(1).joinToString(", ")} $and ${words.last()}"
    }

    /** "1 January" in [locale] for a fiscal year starting in [month] (1-12). */
    fun fiscalYearStart(month: Int?, locale: java.util.Locale): String? {
        month ?: return null
        if (month !in 1..12) return month.toString()
        val date = java.time.LocalDate.of(2024, month, 1)
        val pattern = if (locale.country == "US") "MMMM d" else "d MMMM"
        return date.format(java.time.format.DateTimeFormatter.ofPattern(pattern, locale))
    }
}
