package com.weldsuite.weldpass.offline

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import androidx.core.content.edit
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** AES-256-GCM in the combined layout: nonce (12 bytes) ‖ ciphertext ‖ tag (16 bytes). */
class AesGcmCipher(private val key: ByteArray) {
    init {
        require(key.size == 32) { "AES-256 needs a 32-byte key" }
    }

    fun seal(plaintext: ByteArray, additionalData: ByteArray): ByteArray {
        val nonce = ByteArray(NONCE_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(additionalData)
        return nonce + cipher.doFinal(plaintext)
    }

    fun open(combined: ByteArray, additionalData: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, combined, 0, NONCE_BYTES))
        cipher.updateAAD(additionalData)
        return cipher.doFinal(combined, NONCE_BYTES, combined.size - NONCE_BYTES)
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val NONCE_BYTES = 12
        const val TAG_BITS = 128
        val random = SecureRandom()
    }
}

/**
 * The copy's file format (ADR PASS-010): `WPO1` then the sealed JSON. The
 * additional data binds a file to its device and workspace, so a copy moved
 * to another slot fails to open instead of being read as that one's. The
 * Expo app's `lib/offline/envelope.ts`, byte for byte.
 */
object CopyEnvelope {
    private val MAGIC = byteArrayOf(0x57, 0x50, 0x4f, 0x31) // "WPO1"
    private const val OVERHEAD = 12 + 16

    fun additionalData(deviceId: String, workspaceId: String): ByteArray =
        "weldpass-offline:v1:$deviceId:$workspaceId".toByteArray(Charsets.UTF_8)

    fun seal(json: String, owner: CopyOwner, cipher: AesGcmCipher): ByteArray =
        MAGIC + cipher.seal(json.toByteArray(Charsets.UTF_8), additionalData(owner.deviceId, owner.workspaceId))

    /** The JSON, or null for a file that isn't a copy. Throws for a wrong key or tampering. */
    fun open(file: ByteArray, owner: CopyOwner, cipher: AesGcmCipher): String? {
        if (file.size <= MAGIC.size + OVERHEAD || !file.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) return null
        val sealed = file.copyOfRange(MAGIC.size, file.size)
        return String(cipher.open(sealed, additionalData(owner.deviceId, owner.workspaceId)), Charsets.UTF_8)
    }
}

/** The copy's key needs a fresh unlock: the app lock's prompt wasn't in the last [CopyKeyStore.VALIDITY_SECONDS]. */
class CopyLockedException(cause: Throwable) : Exception("The copy's key needs a fresh unlock", cause)

/**
 * The copy's key: 32 random bytes, kept on disk only wrapped by an AES key in
 * the Android Keystore that works within [VALIDITY_SECONDS] of the person
 * unlocking with their biometrics or screen lock. The app lock's prompt is
 * that unlock, so one prompt opens the app and the copy; the unwrapped key
 * stays in memory only while the app is unlocked.
 */
class CopyKeyStore(context: Context) {
    private val prefs = context.getSharedPreferences("weldpass.offline", Context.MODE_PRIVATE)

    /** The copy's key, made on first use. Throws [CopyLockedException] without a recent unlock. */
    fun open(): ByteArray {
        val wrapped = prefs.getString(WRAPPED, null)
        return try {
            if (wrapped != null) unwrap(Base64.decode(wrapped, Base64.NO_WRAP)) else create()
        } catch (error: UserNotAuthenticatedException) {
            throw CopyLockedException(error)
        } catch (error: KeyPermanentlyInvalidatedException) {
            // The screen lock was removed or changed in a way that voids the key:
            // start again with a new key and an empty copy.
            delete()
            try {
                create()
            } catch (locked: UserNotAuthenticatedException) {
                throw CopyLockedException(locked)
            }
        }
    }

    /** The key and its wrapping key: every copy it sealed can't be opened any more. */
    fun delete() {
        prefs.edit { remove(WRAPPED) }
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    private fun create(): ByteArray {
        val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val wrapped = cipher.iv + cipher.doFinal(key)
        prefs.edit { putString(WRAPPED, Base64.encodeToString(wrapped, Base64.NO_WRAP)) }
        return key
    }

    private fun unwrap(wrapped: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, wrapped, 0, 12))
        return cipher.doFinal(wrapped, 12, wrapped.size - 12)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun wrappingKey(): SecretKey {
        (keyStore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setUserAuthenticationParameters(
                        VALIDITY_SECONDS,
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                    )
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(VALIDITY_SECONDS)
                }
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(spec)
            generateKey()
        }
    }

    companion object {
        const val VALIDITY_SECONDS = 30
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "com.weldsuite.weldpass.offline.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val WRAPPED = "wrappedKey"
    }
}

/**
 * The copies on the phone, one file per workspace, outside backups, and an
 * index naming each copy's workspace and device (ids only), which the
 * autofill service needs to open them.
 */
class CopyFiles(context: Context) {
    private val directory = File(context.noBackupFilesDir, "weldpass-offline")
    private val indexFile = File(directory, "index.json")

    private fun file(workspaceId: String): File =
        File(directory, "${workspaceId.replace(Regex("[^A-Za-z0-9_-]"), "_")}.wpo")

    fun read(workspaceId: String): ByteArray? = file(workspaceId).takeIf { it.exists() }?.readBytes()

    fun write(workspaceId: String, deviceId: String, bytes: ByteArray) {
        directory.mkdirs()
        replace(file(workspaceId), bytes)
        writeIndex(index() + (workspaceId to deviceId))
    }

    fun delete(workspaceId: String) {
        file(workspaceId).delete()
        if (indexFile.exists()) writeIndex(index() - workspaceId)
    }

    fun deleteAll() {
        directory.deleteRecursively()
    }

    /** Workspace id → the device id its copy was sealed for. */
    fun index(): Map<String, String> = runCatching {
        val json = org.json.JSONObject(indexFile.readText())
        json.keys().asSequence().associateWith { json.getString(it) }
    }.getOrDefault(emptyMap())

    private fun writeIndex(entries: Map<String, String>) {
        directory.mkdirs()
        replace(indexFile, org.json.JSONObject(entries).toString().toByteArray(Charsets.UTF_8))
    }

    private fun replace(target: File, bytes: ByteArray) {
        val temporary = File(directory, "${target.name}.tmp")
        temporary.writeBytes(bytes)
        if (!temporary.renameTo(target)) {
            target.delete()
            temporary.renameTo(target)
        }
    }
}
