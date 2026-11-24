package expo.modules.weldpassnative.autofill

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The offline copy's key, for the autofill service (ADR PASS-010).
 *
 * The app keeps the key in expo-secure-store; the service can't read it there
 * without depending on that library's private format. So right after each
 * unlock the app hands the raw key to `store`, which wraps it with a Keystore
 * key of our own. That key works only within 30 s of the person proving who
 * they are (biometrics, or the screen lock on Android 11+): the app's own
 * unlock prompt opens that window for `store`, and `AutofillAuthActivity`'s
 * prompt opens it for `unwrap`. The wrapped key sits in no-backup storage and
 * goes with the copy.
 */
object AutofillKey {
  private const val ALIAS = "weldpass.autofill.wrap"
  private const val FILE = "weldpass-autofill.key"
  private const val AUTH_WINDOW_SECONDS = 30

  private fun file(context: Context) = File(context.noBackupFilesDir, FILE)

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun wrappingKey(create: Boolean): SecretKey? {
    (keyStore().getKey(ALIAS, null) as? SecretKey)?.let { return it }
    if (!create) return null
    val builder =
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setUserAuthenticationRequired(true)
        .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(
        AUTH_WINDOW_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(AUTH_WINDOW_SECONDS)
    }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
      .apply { init(builder.build()) }
      .generateKey()
  }

  /** Wrap and keep the copy's key. Call within 30 s of an unlock; false otherwise. */
  fun store(context: Context, rawKeyBase64: String): Boolean =
    try {
      val raw = Base64.decode(rawKeyBase64, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(create = true))
      val wrapped = cipher.doFinal(raw)
      raw.fill(0)
      file(context).writeBytes(cipher.iv + wrapped)
      true
    } catch (_: Exception) {
      // Not authenticated recently, or the key was invalidated (new
      // biometrics): start over with a fresh wrapping key next time.
      clear(context)
      false
    }

  /** The raw key. Call within 30 s of the person authenticating; null otherwise. */
  fun unwrap(context: Context): ByteArray? {
    val stored = file(context).takeIf { it.exists() }?.readBytes() ?: return null
    if (stored.size < 13) return null
    val key = wrappingKey(create = false) ?: return null
    return try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, stored.copyOfRange(0, 12)))
      cipher.doFinal(stored, 12, stored.size - 12)
    } catch (_: Exception) {
      null
    }
  }

  fun hasKey(context: Context): Boolean = file(context).exists()

  fun clear(context: Context) {
    file(context).delete()
    try {
      keyStore().deleteEntry(ALIAS)
    } catch (_: Exception) {
      // Nothing to delete.
    }
  }
}
