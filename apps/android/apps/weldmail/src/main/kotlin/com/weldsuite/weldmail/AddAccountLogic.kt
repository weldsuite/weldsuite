package com.weldsuite.weldmail

/** The new-mailbox form's rules. */
object AddAccountLogic {
    /** What the availability check said. */
    sealed interface Check {
        data object Available : Check

        /** `reserved`, `taken`, or null when the check failed. */
        data class Unavailable(val reason: String?) : Check
    }

    fun check(availability: Availability): Check =
        if (availability.available) Check.Available else Check.Unavailable(availability.reason ?: "taken")

    /** What an address may hold: lower-case letters, digits, dots, dashes and underscores. */
    fun cleanAddress(input: String): String = input.lowercase().filter { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '_' || it == '-' }
}
