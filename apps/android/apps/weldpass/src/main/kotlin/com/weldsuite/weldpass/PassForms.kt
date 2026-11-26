package com.weldsuite.weldpass

import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.ItemFields
import org.weldsuite.api.weldpass.models.ItemInput
import java.security.SecureRandom
import kotlin.math.abs
import kotlin.math.ln

/**
 * Every field of every item type, flat, so one form edits any of them. The
 * same shape as the platform's `ItemFormValues`
 * (`@weldsuite/app-api-client/schemas/weldpass-items`).
 */
data class ItemFormValues(
    val type: Item.Type,
    val vaultId: String,
    val title: String = "",
    val url: String = "",
    val username: String = "",
    val password: String = "",
    val totp: String = "",
    val notes: String = "",
    val content: String = "",
    val cardholder: String = "",
    val number: String = "",
    val expiry: String = "",
    val cvc: String = "",
    /**
     * A login's Android apps. Carried through an edit: saving sends the whole
     * item, so a field the form left out would be wiped.
     */
    val apps: List<String> = emptyList(),
)

enum class Strength { WEAK, FAIR, STRONG }

object PassForms {
    const val MAX_LOGIN_APPS = 20
    private val androidPackage = Regex("^[A-Za-z]\\w*(\\.[A-Za-z]\\w*)+$")

    /** Prefill the form from a revealed item, for editing. */
    fun fromItem(item: Item, fields: ItemFields): ItemFormValues = ItemFormValues(
        type = item.type,
        vaultId = item.vaultId,
        title = item.title,
        url = item.url.orEmpty(),
        username = fields.username.orEmpty(),
        password = fields.password.orEmpty(),
        totp = fields.totp.orEmpty(),
        notes = fields.notes.orEmpty(),
        content = fields.content.orEmpty(),
        cardholder = fields.cardholder.orEmpty(),
        number = fields.number.orEmpty(),
        expiry = fields.expiry.orEmpty(),
        cvc = fields.cvc.orEmpty(),
        apps = fields.apps.orEmpty(),
    )

    /**
     * The whole item the API takes. Only the fields of the chosen type are
     * sent, so a login never carries a stale card number; a login's apps are
     * left out when there are none, so the sealed text stays as it was.
     */
    fun toInput(values: ItemFormValues): ItemInput {
        val title = values.title.trim()
        return when (values.type) {
            Item.Type.NOTE -> ItemInput(
                type = ItemInput.Type.NOTE,
                title = title,
                fields = ItemFields(content = values.content),
            )
            Item.Type.CARD -> ItemInput(
                type = ItemInput.Type.CARD,
                title = title,
                fields = ItemFields(
                    cardholder = values.cardholder.trim(),
                    number = values.number.trim(),
                    expiry = values.expiry.trim(),
                    cvc = values.cvc.trim(),
                    notes = values.notes,
                ),
            )
            else -> ItemInput(
                type = ItemInput.Type.LOGIN,
                title = title,
                url = values.url.trim().ifEmpty { null },
                fields = ItemFields(
                    username = values.username,
                    password = values.password,
                    totp = values.totp.trim(),
                    notes = values.notes,
                    apps = values.apps.ifEmpty { null },
                ),
            )
        }
    }

    /** Package names typed into a box, one per line (commas and spaces work too), without blanks or repeats. */
    fun parseAppList(text: String): List<String> =
        text.split(Regex("[\\s,;]+")).map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    /** The entries that aren't Android package names, for the form's message. */
    fun invalidApps(apps: List<String>): List<String> = apps.filterNot { androidPackage.matches(it) }

    // ── Strength ────────────────────────────────────────────────────────────

    /** The passwords attackers try first. Matched case-insensitively. */
    private val commonPasswords = setOf(
        "123456", "1234567", "12345678", "123456789", "1234567890", "111111", "000000", "123123",
        "password", "password1", "password123", "passw0rd", "p@ssw0rd", "qwerty", "qwerty123",
        "qwertyuiop", "azerty", "abc123", "letmein", "welcome", "welcome1", "welcome123", "admin",
        "admin123", "administrator", "root", "iloveyou", "monkey", "dragon", "football", "baseball",
        "master", "sunshine", "princess", "login", "changeme", "secret", "trustno1", "superman",
        "batman", "starwars", "whatever", "hello123", "freedom", "shadow", "michael", "jennifer",
        "welkom", "welkom01", "welkom123", "wachtwoord", "geheim",
    )

    /**
     * A rough entropy estimate, in bits: length times the size of the
     * character pool, except that characters which repeat or continue a run
     * ("aaaa", "1234") add nothing. The platform's `passwordEntropyBits`.
     */
    fun entropyBits(password: String): Double {
        if (password.isEmpty() || password.lowercase() in commonPasswords) return 0.0
        var pool = 0
        if (password.any { it in 'a'..'z' }) pool += 26
        if (password.any { it in 'A'..'Z' }) pool += 26
        if (password.any { it in '0'..'9' }) pool += 10
        if (password.any { it !in 'a'..'z' && it !in 'A'..'Z' && it !in '0'..'9' }) pool += 33
        var effectiveLength = 0
        password.forEachIndexed { index, char ->
            if (index == 0 || abs(char.code - password[index - 1].code) > 1) effectiveLength += 1
        }
        return effectiveLength * (ln(pool.toDouble()) / ln(2.0))
    }

    fun strength(password: String): Strength {
        val bits = entropyBits(password)
        return when {
            bits < 45 -> Strength.WEAK
            bits < 75 -> Strength.FAIR
            else -> Strength.STRONG
        }
    }

    // ── Generator ───────────────────────────────────────────────────────────

    private const val LOWER = "abcdefghijkmnopqrstuvwxyz"
    private const val UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    private const val DIGITS = "23456789"
    private const val SYMBOLS = "!@#$%^&*-_=+?"
    private val random = SecureRandom()

    /**
     * A random password. Look-alike characters (l/1/I, O/0) are left out, so
     * it can be read aloud or typed from a screen, and every chosen class of
     * character appears at least once. The platform's `generatePassword`.
     */
    fun generatePassword(
        length: Int = 20,
        uppercase: Boolean = true,
        digits: Boolean = true,
        symbols: Boolean = true,
    ): String {
        val size = length.coerceIn(8, 128)
        val classes = buildList {
            add(LOWER)
            if (uppercase) add(UPPER)
            if (digits) add(DIGITS)
            if (symbols) add(SYMBOLS)
        }
        val all = classes.joinToString("")
        val chars = classes.map { it[random.nextInt(it.length)] }.toMutableList()
        while (chars.size < size) chars += all[random.nextInt(all.length)]
        // Fisher–Yates, so the guaranteed characters aren't always at the front.
        for (index in chars.indices.reversed()) {
            val other = random.nextInt(index + 1)
            chars[index] = chars[other].also { chars[other] = chars[index] }
        }
        return chars.joinToString("")
    }
}
