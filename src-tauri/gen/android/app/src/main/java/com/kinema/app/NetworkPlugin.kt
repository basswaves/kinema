package com.kinema.app

import android.app.Activity
import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.net.Inet4Address
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class TextArgs {
  lateinit var text: String
}

/** How long the network is listened to for servers announcing themselves. */
private const val LOOK_MS = 4000L

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
 * never from the page (build.rs lets the page call `findServers` only).
 *
 * `findServers` lists the file servers on the network that announce
 * themselves (mDNS, `_smb._tcp`): most NAS boxes and Macs do, Windows PCs
 * mostly do not — the folder browser offers typing an address beside them.
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

  /**
   * The file servers that announce themselves, by name and address, after
   * listening for a few seconds. Android resolves one at a time before
   * Android 14, so the found ones wait their turn. IPv4 addresses only: an
   * address is what the person sees and what netshare.rs is given.
   */
  @Command
  fun findServers(invoke: Invoke) {
    val nsd = activity.getSystemService(Context.NSD_SERVICE) as NsdManager
    val lock = Any()
    val found = LinkedHashMap<String, String>()
    val waiting = ArrayDeque<NsdServiceInfo>()
    var resolving = false
    val answered = AtomicBoolean(false)

    fun answer() {
      if (!answered.compareAndSet(false, true)) return
      val list = JSArray()
      synchronized(lock) {
        for ((name, host) in found) list.put(JSObject().apply { put("name", name); put("host", host) })
      }
      invoke.resolve(JSObject().apply { put("servers", list) })
    }

    fun resolveNext() {
      val next = synchronized(lock) {
        if (resolving) return
        waiting.removeFirstOrNull()?.also { resolving = true }
      } ?: return
      @Suppress("DEPRECATION")
      nsd.resolveService(next, object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, code: Int) {
          synchronized(lock) { resolving = false }
          resolveNext()
        }

        override fun onServiceResolved(info: NsdServiceInfo) {
          @Suppress("DEPRECATION")
          val host = info.host
          synchronized(lock) {
            if (host is Inet4Address) found.putIfAbsent(info.serviceName, host.hostAddress ?: "")
            resolving = false
          }
          resolveNext()
        }
      })
    }

    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onServiceLost(info: NsdServiceInfo) {}
      override fun onStopDiscoveryFailed(serviceType: String, code: Int) {}
      override fun onStartDiscoveryFailed(serviceType: String, code: Int) = answer()
      override fun onServiceFound(info: NsdServiceInfo) {
        synchronized(lock) { waiting.addLast(info) }
        resolveNext()
      }
    }
    try {
      nsd.discoverServices("_smb._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (e: Exception) {
      answer()
      return
    }
    Handler(Looper.getMainLooper()).postDelayed({
      try {
        nsd.stopServiceDiscovery(listener)
      } catch (e: Exception) {
      }
      answer()
    }, LOOK_MS)
  }
}
