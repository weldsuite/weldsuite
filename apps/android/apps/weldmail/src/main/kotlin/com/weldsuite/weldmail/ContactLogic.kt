package com.weldsuite.weldmail

/** The contact card's rules: which field shows what, and what an edit changes. */
object ContactLogic {
    enum class Field { DOMAINS, NAME, DESCRIPTION, TEAM, EMAIL, PHONE, ADDRESS }

    /** What an edit sends: only the field that changed (null: unchanged). */
    data class Change(
        val firstName: String? = null,
        val lastName: String? = null,
        val email: String? = null,
        val phone: String? = null,
        val notes: String? = null,
        val department: String? = null,
        val linkedinUrl: String? = null,
    )

    private val EMAIL = Regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$")

    fun isEmail(value: String): Boolean = EMAIL.matches(value.trim())

    /** Only digits and `+`: a sender wrote this, so nothing else goes into a `tel:` link. */
    fun dialable(phone: String): String = phone.filter { it.isDigit() || it == '+' }

    fun displayName(person: Person): String = person.name ?: person.email ?: "?"

    /** The search matches names and addresses anywhere; only the exact address is this sender. */
    fun exactMatch(people: List<Person>, email: String): Person? {
        val wanted = email.trim().lowercase()
        return people.firstOrNull { it.email?.trim()?.lowercase() == wanted }
    }

    /** A sender who isn't a contact: shown from the address, not editable. */
    fun placeholder(email: String) = Person(
        id = email,
        email = email,
        firstName = email.substringBefore('@'),
        lastName = null,
        fullName = null,
        phone = null,
        department = null,
        notes = null,
        linkedinUrl = null,
        bestTimeToContact = null,
        avatarUrl = null,
    )

    fun value(person: Person, field: Field): String? = when (field) {
        Field.DOMAINS -> person.linkedinUrl
        Field.NAME -> person.name
        Field.DESCRIPTION -> person.notes
        Field.TEAM -> person.department
        Field.EMAIL -> person.email
        Field.PHONE -> person.phone
        Field.ADDRESS -> person.bestTimeToContact
    }?.takeIf { it.isNotBlank() }

    /** A name splits at its first space: "Ada King Lovelace" → "Ada", "King Lovelace". */
    fun change(field: Field, value: String): Change = when (field) {
        Field.NAME -> Change(firstName = value.substringBefore(' '), lastName = value.substringAfter(' ', ""))
        Field.EMAIL -> Change(email = value)
        Field.PHONE -> Change(phone = value)
        Field.DESCRIPTION -> Change(notes = value)
        Field.TEAM -> Change(department = value)
        Field.DOMAINS -> Change(linkedinUrl = value)
        Field.ADDRESS -> Change()
    }
}
