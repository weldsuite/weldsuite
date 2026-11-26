package org.weldsuite.core.auth

import android.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.weldsuite.core.WeldJson

/** The signed-in person, from the ID token. */
@Serializable
data class Person(
    val id: String,
    val name: String?,
    val email: String?,
)

/** A workspace from `GET /api/workspaces`; [id] is `workspaces.id`. */
@Serializable
data class WorkspaceRef(
    val id: String,
    val name: String,
    val slug: String? = null,
)

/** The claims of a JWT, unverified: only for reading the person after AppAuth checked the token. */
internal fun jwtClaims(token: String?): JsonObject? {
    val payload = token?.split('.')?.getOrNull(1) ?: return null
    return try {
        val json = String(Base64.decode(payload, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8)
        WeldJson.parseToJsonElement(json).jsonObject
    } catch (_: Exception) {
        null
    }
}

internal fun personFromClaims(claims: JsonObject?): Person? {
    val sub = claims?.string("sub") ?: return null
    val name = claims.string("name")
        ?: listOfNotNull(claims.string("given_name"), claims.string("family_name")).joinToString(" ").ifBlank { null }
    return Person(id = sub, name = name, email = claims.string("email"))
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }

/**
 * The active workspace after reading a fresh list: the current choice while
 * it's listed (or when it was made after the read began, for a workspace
 * created meanwhile); with none, a sole workspace is chosen without asking.
 */
fun chooseActiveWorkspace(
    list: List<WorkspaceRef>,
    current: String?,
    chosenAfterReadStarted: Boolean,
): String? {
    val ids = list.map { it.id }.toSet()
    val kept = current?.takeIf { it in ids || chosenAfterReadStarted }
    return kept ?: list.singleOrNull()?.id
}

/** `https://app.weldsuite.eu` → `app.weldsuite.eu`, safe for a storage key. */
fun storageIdFor(origin: String): String =
    origin.replace(Regex("^[a-z]+://", RegexOption.IGNORE_CASE), "").replace(Regex("[^A-Za-z0-9._-]"), "_")
