package org.weldsuite.core

import kotlinx.serialization.json.Json

/**
 * The JSON reader for every server response: fields a newer server adds are
 * ignored, and a missing nullable field reads as null.
 */
val WeldJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}
