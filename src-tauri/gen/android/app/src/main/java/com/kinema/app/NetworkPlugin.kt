package com.kinema.app

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class TextArgs {
  lateinit var text: String
}

/** The key's name in Android's key store; made the first time it is needed. */
private const val KEY = "kinema-network-shares"
private const val IV_BYTES = 12

/**
 * The Android half of network shares (`netshare.rs`, which speaks SMB itself).
 *
 * A NAS's password is kept in Kinema's library only locked (`seal`), with a
 * key that Android's key store holds and never hands out — so a copy of the
 * library, a safety copy included, is no use without this device. The core
 * unlocks (`unseal`) the kept sign-ins when Kinema starts. Called from Rust,
 * never from the page.
 */
@TauriPlugin
class NetworkPlugin(private val activity: Activity) : Plugin(activity) {

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  /** `text` locked: the cipher's own starting value, then the locked bytes, as Base64. */
  @Command
  fun seal(invoke: Invoke) {
    try {
      val text = invoke.parseArgs(TextArgs::class.java).text
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val sealed = cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
      invoke.resolve(JSObject().apply { put("text", Base64.encodeToString(sealed, Base64.NO_WRAP)) })
    } catch (e: Exception) {
      invoke.reject("could not lock it: ${e.message ?: e}")
    }
  }

  /** What `seal` locked. Fails if the key is gone (Kinema reinstalled, its data cleared). */
  @Command
  fun unseal(invoke: Invoke) {
    try {
      val sealed = Base64.decode(invoke.parseArgs(TextArgs::class.java).text, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
      val text = String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
      invoke.resolve(JSObject().apply { put("text", text) })
    } catch (e: Exception) {
      invoke.reject("could not unlock it: ${e.message ?: e}")
    }
  }
}
