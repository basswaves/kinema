package com.kinema.app

import java.io.ByteArrayOutputStream

/*
 * What the Blu-ray stream file reader (M2tsExtractor.kt, BdTsPayloadReaderFactory.kt)
 * needs to read from the bytes themselves: Dolby Digital frames, the access
 * units of Dolby TrueHD, and the Blu-ray habit of putting both in one stream.
 * Plain functions on byte arrays, nothing from Android or Media3, so they can
 * be tried on their own (BdStreamParsingTest.kt).
 */

/**
 * A Dolby Digital (AC-3) frame: `0B 77`, two bytes of checksum, then a byte
 * holding the sample-rate code (top 2 bits) and the size code (low 6 bits).
 */
internal object Ac3Frame {
  /** Bit rates by size code / 2, in kbit/s. */
  private val KBPS = intArrayOf(32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640)
  private val SAMPLE_RATES = intArrayOf(48000, 44100, 32000)

  /** Every frame holds 6 blocks of 256 samples. */
  const val SAMPLES = 1536

  /**
   * The size in bytes of the frame that starts at `data[at]`, or -1 when what
   * is there is not a frame header (no `0B 77`, the reserved sample-rate code,
   * a size code past 37). Needs 5 bytes.
   *
   * The size is the bit rate over one frame's time, in 16-bit words:
   * - 48 kHz: words = kbit/s x 2.      `0B 77 .. .. 14` -> code 20 = 192 kbit/s -> 384 words = 768 bytes.
   * - 32 kHz: words = kbit/s x 3.      `0B 77 .. .. 94` -> 192 kbit/s -> 576 words = 1152 bytes.
   * - 44.1 kHz: words = floor(kbit/s x 2.17687) + (the size code's lowest bit),
   *   because a frame is not a whole number of words: `0B 77 .. .. 54` -> 192 kbit/s,
   *   code 20 (even) -> 417 words = 834 bytes; `.. 55` (code 21) -> 418 words = 836 bytes.
   */
  fun sizeOf(data: ByteArray, at: Int, end: Int = data.size): Int {
    if (end - at < 5) return -1
    if (data[at] != 0x0B.toByte() || data[at + 1] != 0x77.toByte()) return -1
    val b = data[at + 4].toInt() and 0xFF
    val rate = b shr 6
    val code = b and 0x3F
    if (rate == 3 || code > 37) return -1
    val kbps = KBPS[code shr 1]
    val words = when (rate) {
      0 -> kbps * 2
      2 -> kbps * 3
      // kbps x 1536 x 1000 / (44100 x 16) = kbps x 320 / 147
      else -> kbps * 320 / 147 + (code and 1)
    }
    return words * 2
  }

  /** The sample rate the header at `data[at]` says, or 0. Needs 5 bytes. */
  fun sampleRateOf(data: ByteArray, at: Int): Int {
    val rate = (data[at + 4].toInt() and 0xFF) shr 6
    return if (rate < 3) SAMPLE_RATES[rate] else 0
  }

  /**
   * Whether the frame's own checksum holds. The frame, from the byte after
   * `0B 77` to its last, is a polynomial (x^16 + x^15 + x^2 + 1) that divides
   * with no remainder when the encoder's two checksums are in it. A hit by
   * chance on random bytes is 1 in 65 536, which is what lets a frame found by
   * scanning be believed.
   */
  fun checksumHolds(data: ByteArray, at: Int, size: Int): Boolean {
    var crc = 0
    for (i in at + 2 until at + size) {
      crc = crc xor ((data[i].toInt() and 0xFF) shl 8)
      repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x8005) and 0xFFFF else (crc shl 1) and 0xFFFF }
    }
    return crc == 0
  }
}

/**
 * A Dolby TrueHD access unit: 40 samples at 48 kHz (80 at 96, 160 at 192).
 * It starts with two bytes, a 4-bit check and a 12-bit length counted in
 * 16-bit words, then a 16-bit time; an access unit that can be started from
 * (the "major sync") has `F8 72 6F BA` next, then the stream's format.
 */
internal object TrueHdUnit {
  /** An access unit's longest length: 12 bits of words. */
  const val MAX_BYTES = 4095 * 2

  /**
   * Length in bytes of the access unit at `data[at]`: the low 12 bits, times 2.
   * `A7 4E ..` -> 0x74E = 1870 words = 3740 bytes (the `A` is the check, not read).
   */
  fun lengthOf(data: ByteArray, at: Int): Int =
    (((data[at].toInt() and 0x0F) shl 8) or (data[at + 1].toInt() and 0xFF)) * 2

  /** Whether the unit of `length` bytes at `data[at]` is a major sync one (TrueHD's `BA`, not MLP's `BB`). */
  fun isMajorSync(data: ByteArray, at: Int, length: Int): Boolean =
    length >= 12 &&
      data[at + 4] == 0xF8.toByte() && data[at + 5] == 0x72.toByte() &&
      data[at + 6] == 0x6F.toByte() && data[at + 7] == 0xBA.toByte()

  private val RATES = intArrayOf(48000, 96000, 192000, 0, 0, 0, 0, 0, 44100, 88200, 176400, 0, 0, 0, 0, 0)

  /** What a channel assignment's bits (bit 0 first) each add: L+R, C, LFE, Ls+Rs, Lvh+Rvh, Lc+Rc, Lrs+Rrs, Cs, Ts, Lsd+Rsd, Lw+Rw, Cvh, LFE2. */
  private val CHANNELS_PER_BIT = intArrayOf(2, 1, 1, 2, 2, 2, 2, 1, 1, 2, 2, 1, 1)

  /** `0x4F` = bits 0, 1, 2, 3, 6 = L R, C, LFE, Ls Rs, Lrs Rrs = 8 channels (7.1). `0x0F` = 6 (5.1). */
  fun channelsOf(assignment: Int): Int {
    var n = 0
    for (bit in CHANNELS_PER_BIT.indices) if (assignment shr bit and 1 != 0) n += CHANNELS_PER_BIT[bit]
    return n
  }

  /** What a major sync unit says about the stream. `sampleRate` and `channels` are 0 when it says nothing usable. */
  class Format(val sampleRate: Int, val samplesPerUnit: Int, val channels: Int)

  /**
   * Bytes 8 to 11 of a major sync unit: the sample-rate code (top 4 bits),
   * 8 bits of presentation details, the 6-channel assignment (5 bits), 2 bits
   * more, and the 8-channel assignment (13 bits). The 8-channel presentation
   * is the full one where there is one; a 5.1 stream has the 6-channel only.
   *
   * `00 07 80 4F` -> w = 0x0007804F: rate code 0 (48 kHz), 6-channel
   * assignment (w >> 15 & 31) = 0x0F (5.1), 8-channel assignment
   * (w & 0x1FFF) = 0x4F -> 8 channels (7.1).
   */
  fun parseFormat(data: ByteArray, at: Int, length: Int): Format? {
    if (!isMajorSync(data, at, length)) return null
    val w = ((data[at + 8].toInt() and 0xFF) shl 24) or ((data[at + 9].toInt() and 0xFF) shl 16) or
      ((data[at + 10].toInt() and 0xFF) shl 8) or (data[at + 11].toInt() and 0xFF)
    val code = w ushr 28
    val six = (w ushr 15) and 0x1F
    val eight = w and 0x1FFF
    val channels = channelsOf(if (eight != 0) eight else six)
    return Format(RATES[code], 40 shl (code and 7), channels)
  }
}

/**
 * Splits a Blu-ray Dolby TrueHD elementary stream, which carries the
 * TrueHD access units and, between them, a Dolby Digital frame (the
 * "core" a player without TrueHD plays), one after another with no marker
 * but each one's own header.
 *
 * It starts at the first major sync unit (or at a Dolby Digital frame that the
 * stream begins with), so it does not start in the middle
 * of anything, and takes it as lost sync when the next bytes are neither a
 * Dolby Digital frame nor a plausible access unit: it then looks for the next
 * major sync, which comes every few milliseconds of sound.
 *
 * What this relies on, and what has been tried only on streams put together
 * to that layout (not on a disc): that frames and units follow each other
 * whole, each starting where the last ended.
 */
internal class BdTrueHdSplitter(private val sink: Sink) {
  interface Sink {
    /** A whole Dolby Digital frame; `streamOffset` is where it began, counted from the first byte pushed. */
    fun ac3Frame(data: ByteArray, at: Int, size: Int, streamOffset: Long)

    /** A whole TrueHD access unit; `major` when it can be started from. */
    fun accessUnit(data: ByteArray, at: Int, size: Int, streamOffset: Long, major: Boolean)
  }

  /** Bytes pushed so far, over the splitter's life. A caller's marks (a PES packet's time) are against this. */
  var total = 0L
    private set

  /** Times the sync was lost after having had it. */
  var lostSyncCount = 0
    private set

  private var buf = ByteArray(16 * 1024)
  private var start = 0
  private var end = 0
  private var synced = false

  /** Forget what is held, as after a seek. The count of bytes pushed goes on. */
  fun reset() {
    start = 0
    end = 0
    synced = false
  }

  fun push(data: ByteArray, offset: Int, length: Int) {
    if (end + length > buf.size) {
      if (start > 0) {
        System.arraycopy(buf, start, buf, 0, end - start)
        end -= start
        start = 0
      }
      if (end + length > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, end + length))
    }
    System.arraycopy(data, offset, buf, end, length)
    end += length
    total += length
    step()
  }

  private fun offsetOf(index: Int) = total - (end - index)

  private fun step() {
    while (true) {
      if (!synced && startsWithCoreFrame()) {
        // The stream's first bytes (or the first after a seek that lands on one) are a core frame.
        if (end - start < Ac3Frame.sizeOf(buf, start, end)) return
        synced = true
      }
      if (!synced) {
        val at = findMajorSyncUnit()
        if (at < 0) {
          // The last 7 bytes could be the start of one.
          start = maxOf(start, end - 7)
          return
        }
        start = at
        synced = true
      }
      val available = end - start
      if (available < 2) return
      if (buf[start] == 0x0B.toByte() && buf[start + 1] == 0x77.toByte()) {
        if (available < 5) return
        val size = Ac3Frame.sizeOf(buf, start, end)
        if (size < 0) {
          lose()
          continue
        }
        if (available < size) return
        sink.ac3Frame(buf, start, size, offsetOf(start))
        start += size
      } else {
        val length = TrueHdUnit.lengthOf(buf, start)
        if (length < 4) {
          lose()
          continue
        }
        if (available < length) return
        sink.accessUnit(buf, start, length, offsetOf(start), TrueHdUnit.isMajorSync(buf, start, length))
        start += length
      }
    }
  }

  /**
   * Whether the held bytes begin with a whole Dolby Digital frame whose
   * checksum holds. Only then is it taken as where the stream starts: a
   * start that lands in the middle of one has no `0B 77` to see.
   * (False while the frame is not all here yet; the caller waits for it.)
   */
  private fun startsWithCoreFrame(): Boolean {
    val size = Ac3Frame.sizeOf(buf, start, end)
    if (size < 0) return false
    // A frame not all here yet cannot be told by its checksum: it is waited for.
    return end - start < size || Ac3Frame.checksumHolds(buf, start, size)
  }

  private fun lose() {
    synced = false
    lostSyncCount++
    start++
  }

  /** Where a major sync unit starts (4 bytes before its `F8 72 6F BA`), whole enough to be taken, or -1. */
  private fun findMajorSyncUnit(): Int {
    var p = start
    while (p + 8 <= end) {
      if (buf[p + 4] == 0xF8.toByte() && buf[p + 5] == 0x72.toByte() && buf[p + 6] == 0x6F.toByte() && buf[p + 7] == 0xBA.toByte()) {
        val length = TrueHdUnit.lengthOf(buf, p)
        if (length >= 12) return p
      }
      p++
    }
    return -1
  }
}

/**
 * One Dolby Digital (AC-3) or Dolby Digital Plus (E-AC-3) frame's header, as
 * far as grouping frames and counting channels need it.
 *
 * `channels` are those the frame's own header counts (front, surround, LFE);
 * `chanmap` is what a dependent E-AC-3 frame says it adds to the independent
 * one's (-1 when it says nothing).
 */
internal class Eac3Frame(
  val size: Int,
  val isEac3: Boolean,
  val strmtyp: Int,
  val substreamId: Int,
  val sampleRate: Int,
  val samples: Int,
  val channels: Int,
  val chanmap: Int,
  val locations: Int,
)

internal object Eac3Header {
  private val BLOCKS = intArrayOf(1, 2, 3, 6)
  private val RATES = intArrayOf(48000, 44100, 32000)
  private val RATES_HALF = intArrayOf(24000, 22050, 16000)
  private val CHANNELS_BY_ACMOD = intArrayOf(2, 1, 2, 3, 3, 4, 4, 5)

  /**
   * What each of the channel map's 16 bits stands for, the first (most
   * significant) bit first (ETSI TS 102 366, annex E, "custom channel map"):
   * L, C, R, Ls, Rs, Lc+Rc, Lrs+Rrs, Cs, Ts, Lsd+Rsd, Lw+Rw, Lvh+Rvh, Cvh,
   * LFE2, (reserved), LFE. A pair is two channels.
   */
  private val CHANMAP_CHANNELS = intArrayOf(1, 1, 1, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1, 1, 0, 1)

  /** The map bits of the channels an `acmod` (and LFE) mode has: 3/2 is L C R Ls Rs = bits 15 to 11. */
  private fun locationsOf(acmod: Int, lfe: Int): Int {
    val l = 1 shl 15
    val c = 1 shl 14
    val r = 1 shl 13
    val ls = 1 shl 12
    val rs = 1 shl 11
    val front = when (acmod) {
      0, 2 -> l or r // 1+1 (two mono programs) and 2/0
      1 -> c
      3 -> l or c or r
      4 -> l or r or ls // 2/1: one surround
      5 -> l or c or r or ls // 3/1
      6 -> l or r or ls or rs
      else -> l or c or r or ls or rs
    }
    return front or (if (lfe == 1) 1 else 0)
  }

  private fun bsidOf(data: ByteArray, at: Int) = (data[at + 5].toInt() and 0xFF) shr 3

  /**
   * The size in bytes of the frame at `data[at]`, from its first 6 bytes, or -1
   * if what is there is not a frame. The bit stream id (the 5 bits after the
   * sync word, checksum or size, and rate bytes) tells which kind: up to 10 is
   * AC-3, 11 to 16 is E-AC-3.
   *
   * E-AC-3 states its size outright: 11 bits, in 16-bit words minus one.
   * `0B 77 01 7F ..` -> 0x17F = 383 -> 384 words = 768 bytes.
   */
  fun sizeOf(data: ByteArray, at: Int, end: Int = data.size): Int {
    if (end - at < 6) return -1
    if (data[at] != 0x0B.toByte() || data[at + 1] != 0x77.toByte()) return -1
    val bsid = bsidOf(data, at)
    if (bsid <= 10) return Ac3Frame.sizeOf(data, at, end)
    if (bsid > 16) return -1
    val size = ((((data[at + 2].toInt() and 7) shl 8) or (data[at + 3].toInt() and 0xFF)) + 1) * 2
    return if (size >= 8) size else -1
  }

  /**
   * Whether the frame at `data[at]` (its first 6 bytes being here) begins a
   * new group: any AC-3 frame, or an E-AC-3 one that is independent (type 0
   * or 2, not 1) and of the first program (substream 0). A dependent frame
   * belongs to the independent one before it.
   */
  fun startsUnit(data: ByteArray, at: Int): Boolean {
    if (bsidOf(data, at) <= 10) return true
    val b = data[at + 2].toInt() and 0xFF
    return (b shr 6) != 1 && ((b shr 3) and 7) == 0
  }

  /** The frame of `size` bytes at `data[at]` (all of it here), or null when its header is not sensible. */
  fun parse(data: ByteArray, at: Int, size: Int): Eac3Frame? {
    val bits = Bits(data, at, at + size)
    if (bsidOf(data, at) <= 10) {
      val rate = Ac3Frame.sampleRateOf(data, at)
      if (rate == 0) return null
      bits.skip(48) // sync, checksum, rate and size code, stream id, mode
      val acmod = bits.read(3)
      if ((acmod and 1) != 0 && acmod != 1) bits.skip(2) // centre mix level
      if ((acmod and 4) != 0) bits.skip(2) // surround mix level
      if (acmod == 2) bits.skip(2) // Dolby Surround mode
      val lfe = bits.read(1)
      return Eac3Frame(size, false, 0, 0, rate, Ac3Frame.SAMPLES, CHANNELS_BY_ACMOD[acmod] + lfe, -1, locationsOf(acmod, lfe))
    }
    bits.skip(16)
    val strmtyp = bits.read(2)
    val substream = bits.read(3)
    bits.skip(11)
    val rate: Int
    val blocks: Int
    val rateCode = bits.read(2)
    if (rateCode == 3) {
      val half = bits.read(2)
      if (half == 3) return null
      rate = RATES_HALF[half]
      blocks = 6
    } else {
      rate = RATES[rateCode]
      blocks = BLOCKS[bits.read(2)]
    }
    val acmod = bits.read(3)
    val lfe = bits.read(1)
    bits.skip(10) // stream id, dialogue level
    if (bits.read(1) == 1) bits.skip(8) // compression
    if (acmod == 0) {
      bits.skip(5)
      if (bits.read(1) == 1) bits.skip(8)
    }
    val chanmap = if (strmtyp == 1 && bits.read(1) == 1) bits.read(16) else -1
    return Eac3Frame(size, true, strmtyp, substream, rate, blocks * 256, CHANNELS_BY_ACMOD[acmod] + lfe, chanmap, locationsOf(acmod, lfe))
  }

  /**
   * Channels in a channel map: the first bit is bit 15, so `0x0200` (the
   * seventh: Lrs+Rrs) is 2 channels, `0x0600` (and Lc+Rc is the sixth, 0x0400)
   * is 4, and `0x8000` (L alone) is 1.
   */
  fun chanmapChannels(map: Int): Int {
    var n = 0
    for (i in CHANMAP_CHANNELS.indices) if ((map shr (15 - i)) and 1 != 0) n += CHANMAP_CHANNELS[i]
    return n
  }

  /** The most channels given out: what Android's sound outputs take for Dolby Digital Plus. */
  const val MAX_CHANNELS = 8

  /**
   * The channels of a group of frames played together: the places the
   * independent frame has (from its mode) and those a dependent frame's map
   * adds, each place counted once, never more than [MAX_CHANNELS]. 5.1 and a
   * dependent frame with Lrs+Rrs (`0x0200`) is 8, which is 7.1. A dependent
   * frame with no map adds its own channels.
   */
  fun channelsOf(frames: List<Eac3Frame>): Int {
    var places = frames[0].locations
    var extra = 0
    for (i in 1 until frames.size) {
      val f = frames[i]
      if (!f.isEac3 || f.strmtyp != 1) continue
      if (f.chanmap >= 0) places = places or f.chanmap else extra += f.channels
    }
    return minOf(MAX_CHANNELS, chanmapChannels(places) + extra)
  }

  /** Reads bits, most significant first; past the end it reads zeros. */
  private class Bits(private val data: ByteArray, at: Int, private val end: Int) {
    private var pos = at * 8

    fun skip(n: Int) {
      pos += n
    }

    fun read(n: Int): Int {
      var v = 0
      repeat(n) {
        val byte = pos shr 3
        val bit = if (byte < end) (data[byte].toInt() shr (7 - (pos and 7))) and 1 else 0
        v = (v shl 1) or bit
        pos++
      }
      return v
    }
  }
}

/**
 * Splits a Blu-ray Dolby Digital Plus stream into groups to be played as one:
 * an independent frame (on a disc often an AC-3 frame, a core any decoder
 * can play) with the E-AC-3 dependent frames that follow it, which carry the
 * rest of the channels. Media3's own reader takes each frame as a sample on
 * its own, and so flips between Dolby Digital and Dolby Digital Plus.
 *
 * A group is given when the next one has begun (or at [flush]). A stream
 * that is all E-AC-3 (independent frames, each with its dependent ones)
 * splits the same way.
 */
internal class BdEac3Splitter(private val sink: Sink) {
  interface Sink {
    /** A whole group: `size` bytes at `data[at]`, begun `streamOffset` bytes into what was pushed. */
    fun unit(data: ByteArray, at: Int, size: Int, streamOffset: Long, frames: List<Eac3Frame>)
  }

  var total = 0L
    private set
  var lostSyncCount = 0
    private set

  private var buf = ByteArray(16 * 1024)
  private var start = 0 // where the group being collected begins
  private var scan = 0 // after the last whole frame of it
  private var end = 0
  private var synced = false
  private val frames = ArrayList<Eac3Frame>()

  fun reset() {
    start = 0
    scan = 0
    end = 0
    synced = false
    frames.clear()
  }

  fun push(data: ByteArray, offset: Int, length: Int) {
    if (end + length > buf.size) {
      if (start > 0) {
        System.arraycopy(buf, start, buf, 0, end - start)
        end -= start
        scan -= start
        start = 0
      }
      if (end + length > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, end + length))
    }
    System.arraycopy(data, offset, buf, end, length)
    end += length
    total += length
    step()
  }

  /** The stream has ended: the group being collected is whole. */
  fun flush() {
    emit()
  }

  private fun offsetOf(index: Int) = total - (end - index)

  private fun emit() {
    if (frames.isEmpty()) return
    sink.unit(buf, start, scan - start, offsetOf(start), ArrayList(frames))
    start = scan
    frames.clear()
  }

  private fun step() {
    while (true) {
      if (!synced) {
        val at = findStart()
        if (at == WAIT) return
        if (at < 0) {
          // The last 5 bytes could be the start of a header.
          start = maxOf(start, end - 5)
          scan = start
          return
        }
        start = at
        scan = at
        synced = true
        frames.clear()
      }
      if (end - scan < 6) return
      val size = Eac3Header.sizeOf(buf, scan, end)
      if (size < 0) {
        lose()
        continue
      }
      // A new group has begun: the one collected is whole.
      if (frames.isNotEmpty() && Eac3Header.startsUnit(buf, scan)) {
        emit()
        continue
      }
      if (end - scan < size) return
      val frame = Eac3Header.parse(buf, scan, size)
      if (frame == null) {
        lose()
        continue
      }
      frames.add(frame)
      scan += size
    }
  }

  private fun lose() {
    emit()
    synced = false
    lostSyncCount++
    start = scan + 1
    scan = start
  }

  /**
   * Where a group begins, searching from `start`: a header that starts one and
   * is believed, by its checksum or by another frame's sync word right after
   * it. WAIT when that cannot be told yet, -1 when there is none.
   */
  private fun findStart(): Int {
    var p = start
    while (p + 6 <= end) {
      if (buf[p] == 0x0B.toByte() && buf[p + 1] == 0x77.toByte()) {
        val size = Eac3Header.sizeOf(buf, p, end)
        if (size > 0 && Eac3Header.startsUnit(buf, p)) {
          val have = end - p
          if (have < size) {
            start = p
            scan = p
            return WAIT
          }
          val followed = have >= size + 2 && buf[p + size] == 0x0B.toByte() && buf[p + size + 1] == 0x77.toByte()
          if (followed || Ac3Frame.checksumHolds(buf, p, size)) return p
          if (have < size + 2) {
            start = p
            scan = p
            return WAIT
          }
        }
      }
      p++
    }
    return -1
  }

  private companion object {
    const val WAIT = -2
  }
}


/**
 * Which TrueHD streams in a Blu-ray stream file have a Dolby Digital core,
 * looked for in the file's first stretch. It has to be known before the
 * tracks are made: a track Media3 is told of must get its format, and a core
 * that never comes would leave the film unopened.
 *
 * Cheap on purpose: it runs on the thread that reads the film, before the
 * film starts, and on a weak box a loop over every byte of a megabyte is
 * seconds. It reads the packets' headers, the program's stream list (the
 * PMT) to know which packet ids are TrueHD, and looks through the bytes of
 * those streams only.
 */
internal object BdCoreScan {
  private const val RAW = 192
  private const val TRUEHD = 0x83
  private const val MAX_PER_STREAM = 96 * 1024
  private const val MAX_STREAMS = 8

  /** A table (PAT or PMT) put together from the packets of one packet id. */
  private class Section {
    private var buf = ByteArray(1024)
    private var size = 0
    private var started = false

    /** `at` and `end`: the packet's payload in `raw`. Returns the section once it is whole. */
    fun feed(raw: ByteArray, at: Int, end: Int, start: Boolean): ByteArray? {
      var from = at
      if (start) {
        val pointer = raw[from].toInt() and 0xFF
        from += 1 + pointer
        size = 0
        started = true
      }
      if (!started || from >= end) return null
      if (size + (end - from) > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, size + end - from))
      System.arraycopy(raw, from, buf, size, end - from)
      size += end - from
      if (size < 3) return null
      val total = 3 + (((buf[1].toInt() and 0x0F) shl 8) or (buf[2].toInt() and 0xFF))
      return if (size >= total) buf.copyOf(total) else null
    }
  }

  /**
   * The packet ids whose stream is TrueHD and holds a Dolby Digital frame
   * whose checksum holds. `raw` is the file's start, 192-byte packets; the
   * bytes of a stream are put together with the PES headers taken out, so a
   * frame that runs over two PES packets is whole again.
   *
   * The stream list comes with the PAT (packet id 0: which packet id has the
   * program's PMT) and the PMT (stream type, packet id of each stream; 0x83
   * is TrueHD). A file whose tables are not in the stretch gives none.
   */
  fun pidsWithCore(raw: ByteArray, count: Int): Set<Int> {
    var pmtPid = -1
    val pat = Section()
    val pmt = Section()
    val trueHd = HashSet<Int>()
    var p = 0
    while (p + RAW <= count && trueHd.isEmpty()) {
      val t = p + 4
      p += RAW
      if (raw[t] != 0x47.toByte()) continue
      val pid = ((raw[t + 1].toInt() and 0x1F) shl 8) or (raw[t + 2].toInt() and 0xFF)
      if (pid != 0 && pid != pmtPid) continue
      val payload = payloadAt(raw, t) ?: continue
      val start = raw[t + 1].toInt() and 0x40 != 0
      if (pid == 0 && pmtPid < 0) {
        val table = pat.feed(raw, payload, t + 188, start) ?: continue
        // After the 8 bytes of header: program number (2) and packet id (2) each, then the checksum.
        var i = 8
        while (i + 4 <= table.size - 4) {
          val program = ((table[i].toInt() and 0xFF) shl 8) or (table[i + 1].toInt() and 0xFF)
          if (program != 0) {
            pmtPid = ((table[i + 2].toInt() and 0x1F) shl 8) or (table[i + 3].toInt() and 0xFF)
            break
          }
          i += 4
        }
      } else if (pid == pmtPid) {
        val table = pmt.feed(raw, payload, t + 188, start) ?: continue
        val programInfo = ((table[10].toInt() and 0x0F) shl 8) or (table[11].toInt() and 0xFF)
        var i = 12 + programInfo
        while (i + 5 <= table.size - 4) {
          val type = table[i].toInt() and 0xFF
          val esPid = ((table[i + 1].toInt() and 0x1F) shl 8) or (table[i + 2].toInt() and 0xFF)
          if (type == TRUEHD && trueHd.size < MAX_STREAMS) trueHd.add(esPid)
          i += 5 + (((table[i + 3].toInt() and 0x0F) shl 8) or (table[i + 4].toInt() and 0xFF))
        }
        if (trueHd.isEmpty()) return emptySet()
      }
    }
    if (trueHd.isEmpty()) return emptySet()

    val streams = HashMap<Int, ByteArrayOutputStream>()
    p = 0
    while (p + RAW <= count) {
      val t = p + 4
      p += RAW
      if (raw[t] != 0x47.toByte()) continue
      val pid = ((raw[t + 1].toInt() and 0x1F) shl 8) or (raw[t + 2].toInt() and 0xFF)
      if (pid !in trueHd) continue
      var at = payloadAt(raw, t) ?: continue
      if (raw[t + 1].toInt() and 0x40 != 0) {
        // PES packet start: 00 00 01, stream id, length (2), flags (2), header length, header.
        if (t + 188 - at < 9 || raw[at].toInt() != 0 || raw[at + 1].toInt() != 0 || raw[at + 2].toInt() != 1) continue
        at += 9 + (raw[at + 8].toInt() and 0xFF)
        if (at >= t + 188) continue
      }
      val out = streams.getOrPut(pid) { ByteArrayOutputStream() }
      if (out.size() < MAX_PER_STREAM) out.write(raw, at, t + 188 - at)
    }
    val found = HashSet<Int>()
    for ((pid, out) in streams) if (hasCore(out.toByteArray())) found.add(pid)
    return found
  }

  /** Where the payload of the transport packet at `t` begins in `raw`, or null if it has none. */
  private fun payloadAt(raw: ByteArray, t: Int): Int? {
    val control = (raw[t + 3].toInt() shr 4) and 3
    if (control and 1 == 0) return null
    var at = t + 4
    if (control and 2 != 0) at += 1 + (raw[at].toInt() and 0xFF)
    return if (at < t + 188) at else null
  }

  private fun hasCore(es: ByteArray): Boolean {
    var i = 0
    while (i + 5 <= es.size) {
      if (es[i] == 0x0B.toByte() && es[i + 1] == 0x77.toByte()) {
        val size = Ac3Frame.sizeOf(es, i)
        if (size > 0 && i + size <= es.size && Ac3Frame.checksumHolds(es, i, size)) return true
      }
      i++
    }
    return false
  }
}
