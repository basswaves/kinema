package com.kinema.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parts of Blu-ray stream file reading that are plain arithmetic on bytes:
 * where things are once the 4 extra bytes of each packet are taken out, the
 * sizes of Dolby Digital frames and TrueHD access units, and the splitting of
 * the stream that has both. Streams are made here, to the layout the code
 * expects, so these hold the code to its own reading of that layout; the real
 * thing is tried by playing a disc's file.
 */
class BdStreamParsingTest {

  // ---- where things are in a file of 192-byte packets --------------------

  @Test fun logicalPlacesSkipTheExtraBytes() {
    assertEquals(0L, BdavLayout.logicalOf(0))
    assertEquals(0L, BdavLayout.logicalOf(4))
    assertEquals(1L, BdavLayout.logicalOf(5))
    assertEquals(96L, BdavLayout.logicalOf(100))
    assertEquals(188L, BdavLayout.logicalOf(192))
    assertEquals(188L, BdavLayout.logicalOf(196))
  }

  @Test fun rawPlacesAreAfterTheExtraBytes() {
    assertEquals(4L, BdavLayout.rawOf(0))
    assertEquals(191L, BdavLayout.rawOf(187))
    assertEquals(196L, BdavLayout.rawOf(188))
    assertEquals(388L, BdavLayout.rawOf(376))
  }

  @Test fun aSeekToAPacketsStartReadsFromTheStartOfItsExtraBytes() {
    assertEquals(192L, BdavLayout.rawSeekOf(188))
    assertEquals(197L, BdavLayout.rawSeekOf(189))
    assertEquals(0L, BdavLayout.rawSeekOf(0))
  }

  @Test fun everyLogicalPlaceComesBackFromItsRawOnes() {
    for (l in 0L..4000L) {
      assertEquals(l, BdavLayout.logicalOf(BdavLayout.rawOf(l)))
      assertEquals(l, BdavLayout.logicalOf(BdavLayout.rawSeekOf(l)))
    }
  }

  @Test fun lengthsLeaveOutTheExtraBytes() {
    assertEquals(1916L, BdavLayout.lengthOf(1960)) // 10 packets + 4 extra + 36 data
    assertEquals(1880L, BdavLayout.lengthOf(1923)) // ends inside the extra bytes of an 11th
    assertEquals(-1L, BdavLayout.lengthOf(-1))
  }

  @Test fun theBytesLeftInAPacket() {
    assertEquals(4, BdavLayout.headerLeft(0))
    assertEquals(1, BdavLayout.headerLeft(3))
    assertEquals(0, BdavLayout.headerLeft(4))
    assertEquals(4, BdavLayout.headerLeft(192))
    assertEquals(188, BdavLayout.payloadLeft(0))
    assertEquals(188, BdavLayout.payloadLeft(4))
    assertEquals(92, BdavLayout.payloadLeft(100))
    assertEquals(1, BdavLayout.payloadLeft(191))
  }

  @Test fun manyPacketsAreMovedAtOnceOnlyFromADataStartAndNotPastTheFile() {
    assertEquals(0, BdavLayout.bulkPackets(100, 5000, 100_000))
    assertEquals(0, BdavLayout.bulkPackets(4, 188, 100_000)) // one packet: one at a time
    assertEquals(10, BdavLayout.bulkPackets(4, 1880, 100_000))
    assertEquals(64, BdavLayout.bulkPackets(4, 100_000, 1_000_000))
    // 2 packets from the data start at 4 are 2 x 192 - 4 = 380 bytes: a file of 384 holds them, 383 does not.
    assertEquals(2, BdavLayout.bulkPackets(4, 376, 384))
    assertEquals(0, BdavLayout.bulkPackets(4, 376, 383))
    assertEquals(0, BdavLayout.bulkPackets(4, 5000, -1))
    // From a packet's start the 4 extra bytes ahead are read with the rest: 2 packets are 384 bytes.
    assertEquals(2, BdavLayout.bulkPackets(0, 376, 384))
    assertEquals(0, BdavLayout.bulkPackets(0, 376, 383))
    assertEquals(10, BdavLayout.bulkPackets(192, 1880, 100_000))
    assertEquals(384, BdavLayout.bulkSpan(0, 2))
    assertEquals(380, BdavLayout.bulkSpan(4, 2))
    assertEquals(4, BdavLayout.firstData(0))
    assertEquals(0, BdavLayout.firstData(4))
  }

  @Test fun compactingDropsTheExtraBytesBetweenPackets() {
    val scratch = ByteArray(380) { i -> if (i in 188..191) 0x7F else (i % 100).toByte() }
    val out = ByteArray(376)
    BdavLayout.compact(scratch, 2, out, 0)
    assertEquals(scratch[0], out[0])
    assertEquals(scratch[375 + 4], out[375])
    assertEquals(scratch[192], out[188])
    assertEquals(scratch[187], out[187])
    // Read from a packet's start, the first 4 bytes are the extra ones.
    val whole = ByteArray(384) { i -> i.toByte() }
    val out2 = ByteArray(376)
    BdavLayout.compact(whole, 2, out2, 0, BdavLayout.firstData(0))
    assertEquals(whole[4], out2[0])
    assertEquals(whole[196], out2[188])
  }

  @Test fun aBluRayStreamFileIsTakenAndAPlainOneIsNot() {
    val bd = ByteArray(192 * 5)
    for (i in 0 until 5) bd[i * 192 + 4] = 0x47
    assertTrue(BdavLayout.looksLikeBdav(bd, bd.size))
    val ts = ByteArray(192 * 5)
    for (i in 0 until 5) ts[i * 188] = 0x47
    assertFalse(BdavLayout.looksLikeBdav(ts, ts.size))
    assertFalse(BdavLayout.looksLikeBdav(ByteArray(100), 100))
    assertFalse(BdavLayout.looksLikeBdav(ByteArray(192 * 5), 192 * 5))
  }

  // ---- Dolby Digital frames --------------------------------------------

  private fun header(fifthByte: Int) = byteArrayOf(0x0B, 0x77, 0, 0, fifthByte.toByte())

  @Test fun dolbyDigitalFrameSizes() {
    assertEquals(768, Ac3Frame.sizeOf(header(0x14), 0)) // 48 kHz, code 20 = 192 kbit/s
    assertEquals(1152, Ac3Frame.sizeOf(header(0x94), 0)) // 32 kHz, 192 kbit/s
    assertEquals(834, Ac3Frame.sizeOf(header(0x54), 0)) // 44.1 kHz, 192 kbit/s, even code
    assertEquals(836, Ac3Frame.sizeOf(header(0x55), 0)) // the odd code is a word longer
    assertEquals(1792, Ac3Frame.sizeOf(header(30), 0)) // 448 kbit/s, what a disc's core often is
    assertEquals(2560, Ac3Frame.sizeOf(header(37), 0)) // 640 kbit/s
  }

  @Test fun notADolbyDigitalHeader() {
    assertEquals(-1, Ac3Frame.sizeOf(header(0xC0), 0)) // the reserved sample rate
    assertEquals(-1, Ac3Frame.sizeOf(header(38), 0)) // a size code past 37
    assertEquals(-1, Ac3Frame.sizeOf(byteArrayOf(0x0B, 0x78, 0, 0, 0x14), 0))
    assertEquals(-1, Ac3Frame.sizeOf(byteArrayOf(0x0B, 0x77, 0, 0), 0))
  }

  /** A frame of 768 bytes whose checksum is right. */
  private fun ac3Frame(seed: Int = 1): ByteArray {
    val f = ByteArray(768)
    f[0] = 0x0B; f[1] = 0x77; f[4] = 0x14
    for (i in 5 until 766) f[i] = ((i * 31 + seed) and 0xFF).toByte()
    var crc = 0
    for (i in 2 until 766) {
      crc = crc xor ((f[i].toInt() and 0xFF) shl 8)
      repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x8005) and 0xFFFF else (crc shl 1) and 0xFFFF }
    }
    f[766] = (crc shr 8).toByte(); f[767] = crc.toByte()
    return f
  }

  @Test fun theChecksumHoldsForAWholeFrameAndNotForAChangedOne() {
    val f = ac3Frame()
    assertTrue(Ac3Frame.checksumHolds(f, 0, 768))
    f[300] = (f[300].toInt() xor 0x10).toByte()
    assertFalse(Ac3Frame.checksumHolds(f, 0, 768))
  }

  // ---- TrueHD access units --------------------------------------------

  /** A unit of `words` x 2 bytes; a major sync one when `format` is given (the 4 bytes after the sync). */
  private fun unit(words: Int, format: ByteArray? = null, timing: Int = 0): ByteArray {
    val u = ByteArray(words * 2)
    u[0] = (0xF0 or (words shr 8)).toByte(); u[1] = words.toByte()
    u[2] = (timing shr 8).toByte(); u[3] = timing.toByte()
    if (format != null) {
      u[4] = 0xF8.toByte(); u[5] = 0x72; u[6] = 0x6F; u[7] = 0xBA.toByte()
      format.copyInto(u, 8)
    }
    for (i in (if (format != null) 12 else 4) until u.size) u[i] = (i and 0x7F).toByte()
    return u
  }

  private val format51 = byteArrayOf(0x00, 0x07, 0x80.toByte(), 0x0F)
  private val format71 = byteArrayOf(0x00, 0x07, 0x80.toByte(), 0x4F)

  @Test fun unitLengthsAreTwelveBitsOfWords() {
    assertEquals(190, TrueHdUnit.lengthOf(byteArrayOf(0xF0.toByte(), 0x5F, 0, 0), 0)) // 0x05F = 95 words
    assertEquals(3740, TrueHdUnit.lengthOf(byteArrayOf(0xA7.toByte(), 0x4E, 0, 0), 0)) // 0x74E = 1870 words, the A is the check
    assertEquals(8190, TrueHdUnit.lengthOf(byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0, 0), 0))
  }

  @Test fun aMajorSyncUnitSaysItsFormat() {
    val u51 = unit(95, format51)
    assertTrue(TrueHdUnit.isMajorSync(u51, 0, u51.size))
    val f = TrueHdUnit.parseFormat(u51, 0, u51.size)!!
    assertEquals(48000, f.sampleRate)
    assertEquals(40, f.samplesPerUnit)
    assertEquals(6, f.channels)
    assertEquals(8, TrueHdUnit.parseFormat(unit(95, format71), 0, 190)!!.channels)
    // 96 kHz is code 1: 80 samples a unit. 192 kHz code 2: 160. 44.1 kHz code 8: 40.
    val f96 = TrueHdUnit.parseFormat(unit(95, byteArrayOf(0x10, 0x07, 0x80.toByte(), 0x0F)), 0, 190)!!
    assertEquals(96000, f96.sampleRate)
    assertEquals(80, f96.samplesPerUnit)
    assertEquals(160, TrueHdUnit.parseFormat(unit(95, byteArrayOf(0x20, 0x07, 0x80.toByte(), 0x0F)), 0, 190)!!.samplesPerUnit)
    assertEquals(44100, TrueHdUnit.parseFormat(unit(95, byteArrayOf(0x80.toByte(), 0x07, 0x80.toByte(), 0x0F)), 0, 190)!!.sampleRate)
  }

  @Test fun anOrdinaryUnitIsNotAMajorSyncAndMlpIsNotTrueHd() {
    assertFalse(TrueHdUnit.isMajorSync(unit(95), 0, 190))
    val mlp = unit(95, format51)
    mlp[7] = 0xBB.toByte()
    assertFalse(TrueHdUnit.isMajorSync(mlp, 0, 190))
    assertNull(TrueHdUnit.parseFormat(unit(95), 0, 190))
  }

  @Test fun channelMasks() {
    assertEquals(6, TrueHdUnit.channelsOf(0x0F)) // L R, C, LFE, Ls Rs
    assertEquals(8, TrueHdUnit.channelsOf(0x4F)) // and Lrs Rrs
    assertEquals(2, TrueHdUnit.channelsOf(0x01))
    assertEquals(0, TrueHdUnit.channelsOf(0))
  }

  // ---- splitting the stream -------------------------------------------

  private class Seen : BdTrueHdSplitter.Sink {
    val events = ArrayList<String>()
    val offsets = ArrayList<Long>()
    val data = ArrayList<ByteArray>()
    override fun ac3Frame(data: ByteArray, at: Int, size: Int, streamOffset: Long) {
      events.add("ac3:$size"); offsets.add(streamOffset); this.data.add(data.copyOfRange(at, at + size))
    }
    override fun accessUnit(data: ByteArray, at: Int, size: Int, streamOffset: Long, major: Boolean) {
      events.add((if (major) "M:" else "u:") + size); offsets.add(streamOffset); this.data.add(data.copyOfRange(at, at + size))
    }
  }

  /** core frame, a major unit, then 4 ordinary ones; twice over. */
  private fun twoRounds(): ByteArray {
    val parts = ArrayList<ByteArray>()
    repeat(2) { r ->
      parts.add(ac3Frame(r + 1))
      parts.add(unit(95, format51))
      repeat(4) { parts.add(unit(60 + it, null, it)) }
    }
    return parts.reduce { a, b -> a + b }
  }

  private val expectedRounds = listOf("ac3:768", "M:190", "u:120", "u:122", "u:124", "u:126", "ac3:768", "M:190", "u:120", "u:122", "u:124", "u:126")

  @Test fun theStreamIsSplitWhateverSizeItComesIn() {
    val stream = twoRounds()
    for (piece in intArrayOf(1, 2, 3, 7, 100, 187, 188, 1000, stream.size)) {
      val seen = Seen()
      val s = BdTrueHdSplitter(seen)
      var p = 0
      while (p < stream.size) {
        val n = minOf(piece, stream.size - p)
        s.push(stream, p, n)
        p += n
      }
      assertEquals("pieces of $piece", expectedRounds, seen.events)
      assertEquals(0, s.lostSyncCount)
      assertEquals(stream.size.toLong(), s.total)
    }
  }

  @Test fun eachItemSaysWhereItBegan() {
    val stream = twoRounds()
    val seen = Seen()
    BdTrueHdSplitter(seen).push(stream, 0, stream.size)
    // 768 + 190 + 120 + 122 + 124 + 126 = 1450 per round.
    assertEquals(listOf(0L, 768L, 958L, 1078L, 1200L, 1324L, 1450L), seen.offsets.take(7))
  }

  @Test fun theBytesComeOutAsTheyWentIn() {
    val stream = twoRounds()
    val seen = Seen()
    BdTrueHdSplitter(seen).push(stream, 0, stream.size)
    assertArrayEquals(stream, seen.data.reduce { a, b -> a + b })
  }

  @Test fun startingInTheMiddleWaitsForAMajorSync() {
    val stream = twoRounds()
    val seen = Seen()
    // From 500 bytes into the first core frame: its rest and the units up to the first major sync are not used.
    BdTrueHdSplitter(seen).push(stream, 500, stream.size - 500)
    assertEquals(expectedRounds.drop(1), seen.events)
  }

  @Test fun startingOnACoreFrameUsesIt() {
    val stream = twoRounds()
    val seen = Seen()
    val s = BdTrueHdSplitter(seen)
    s.push(stream, 0, 700) // not all of the first frame
    assertEquals(emptyList<String>(), seen.events)
    s.push(stream, 700, stream.size - 700)
    assertEquals(expectedRounds, seen.events)
  }

  @Test fun aBrokenPlaceIsGotOverAtTheNextMajorSync() {
    val stream = twoRounds()
    val broken = stream.copyOf()
    // Wreck the third ordinary unit of round one: its length says nothing sensible.
    val at = 768 + 190 + 120 + 122
    broken[at] = 0xF0.toByte(); broken[at + 1] = 0x00
    val seen = Seen()
    val s = BdTrueHdSplitter(seen)
    s.push(broken, 0, broken.size)
    assertTrue(s.lostSyncCount >= 1)
    // Round two is whole again from its core frame on, the major sync being found on the way.
    assertEquals(expectedRounds.drop(6).takeLast(5), seen.events.takeLast(5))
  }

  @Test fun resetStartsOver() {
    val stream = twoRounds()
    val seen = Seen()
    val s = BdTrueHdSplitter(seen)
    s.push(stream, 0, 1000) // the core frame, the major unit and a part
    s.reset()
    s.push(stream, 1450, stream.size - 1450)
    assertEquals(listOf("ac3:768", "M:190", "u:120", "u:122", "u:124", "u:126"), seen.events.takeLast(6))
    assertEquals(1000L + (stream.size - 1450).toLong(), s.total)
  }

  // ---- which streams have a core ---------------------------------------

  /** One 192-byte packet of a stream with packet id `pid`: `payload` up to 184 bytes, `pes` begins a PES packet. */
  private fun packet(pid: Int, payload: ByteArray, pes: Boolean): ByteArray {
    val p = ByteArray(192)
    p[4] = 0x47
    p[5] = ((if (pes) 0x40 else 0) or (pid shr 8)).toByte()
    p[6] = pid.toByte()
    p[7] = 0x10 // payload only
    val body = if (pes) byteArrayOf(0, 0, 1, 0xBD.toByte(), 0, 0, 0x80.toByte(), 0, 0) + payload else payload
    body.copyInto(p, 8, 0, minOf(body.size, 184))
    return p
  }

  private fun streamOf(pid: Int, es: ByteArray): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    var p = 0
    var first = true
    while (p < es.size) {
      val room = if (first) 175 else 184
      val n = minOf(room, es.size - p)
      out.write(packet(pid, es.copyOfRange(p, p + n), first))
      p += n
      first = false
    }
    return out.toByteArray()
  }

  /** The file's tables: a PAT naming the PMT's packet id, and a PMT listing `streams` as (stream type, packet id). */
  private fun psi(pmtPid: Int, streams: List<Pair<Int, Int>>): ByteArray {
    fun section(tableId: Int, id: Int, body: ByteArray): ByteArray {
      val length = 5 + body.size + 4
      return byteArrayOf(tableId.toByte(), (0xB0 or (length shr 8)).toByte(), length.toByte(), (id shr 8).toByte(), id.toByte(), 0xC1.toByte(), 0, 0) + body + ByteArray(4)
    }
    fun packetOf(pid: Int, section: ByteArray): ByteArray {
      val p = ByteArray(192)
      p[4] = 0x47
      p[5] = (0x40 or (pid shr 8)).toByte()
      p[6] = pid.toByte()
      p[7] = 0x10
      (byteArrayOf(0) + section).copyInto(p, 8) // the pointer field, then the table
      return p
    }
    val pat = section(0, 1, byteArrayOf(0, 1, (0xE0 or (pmtPid shr 8)).toByte(), pmtPid.toByte()))
    var entries = byteArrayOf(0xE1.toByte(), 0x00, 0xF0.toByte(), 0) // PCR packet id, no program info
    for ((type, pid) in streams) {
      entries += byteArrayOf(type.toByte(), (0xE0 or (pid shr 8)).toByte(), pid.toByte(), 0xF0.toByte(), 0)
    }
    return packetOf(0, pat) + packetOf(pmtPid, section(2, 1, entries))
  }

  @Test fun aTrueHdStreamWithACoreIsFoundAndOneWithoutIsNot() {
    val withCore = ac3Frame() + unit(95, format51) + unit(60)
    val without = unit(95, format51) + unit(60) + unit(61)
    val tables = psi(0x100, listOf(0x1B to 0x1011, 0x83 to 0x1100, 0x83 to 0x1101))
    val file = tables + streamOf(0x1100, withCore) + streamOf(0x1101, without)
    assertEquals(setOf(0x1100), BdCoreScan.pidsWithCore(file, file.size))
    val alone = tables + streamOf(0x1101, without)
    assertEquals(emptySet<Int>(), BdCoreScan.pidsWithCore(alone, alone.size))
  }

  @Test fun aCoreFrameBrokenByAPacketBoundaryIsStillFoundBecauseTheHeadersAreTakenOut() {
    // The frame crosses from the first packet (175 bytes of data) into the second.
    val es = unit(95, format51) + ac3Frame() + unit(60)
    val file = psi(0x100, listOf(0x83 to 0x1100)) + streamOf(0x1100, es)
    assertTrue(file.size > 192 * 5)
    assertEquals(setOf(0x1100), BdCoreScan.pidsWithCore(file, file.size))
  }

  @Test fun aFrameWithABadChecksumIsNotACore() {
    val bad = ac3Frame()
    bad[100] = (bad[100].toInt() xor 1).toByte()
    val file = psi(0x100, listOf(0x83 to 0x1100)) + streamOf(0x1100, bad + unit(95, format51))
    assertEquals(emptySet<Int>(), BdCoreScan.pidsWithCore(file, file.size))
  }

  @Test fun onlyStreamsTheTableCallsTrueHdAreLookedAt() {
    // The same bytes, under a Dolby Digital stream type, or with no tables at all.
    val es = ac3Frame() + unit(95, format51)
    val listedAsAc3 = psi(0x100, listOf(0x81 to 0x1100)) + streamOf(0x1100, es)
    assertEquals(emptySet<Int>(), BdCoreScan.pidsWithCore(listedAsAc3, listedAsAc3.size))
    val noTables = streamOf(0x1100, es)
    assertEquals(emptySet<Int>(), BdCoreScan.pidsWithCore(noTables, noTables.size))
  }

  // ---- Dolby Digital Plus ----------------------------------------------

  private class BitWriter {
    private val bits = ArrayList<Int>()

    fun put(value: Int, n: Int) {
      for (i in n - 1 downTo 0) bits.add((value shr i) and 1)
    }

    fun bytes(size: Int): ByteArray {
      val out = ByteArray(size)
      for (i in bits.indices) if (bits[i] == 1) out[i / 8] = (out[i / 8].toInt() or (0x80 shr (i % 8))).toByte()
      return out
    }
  }

  /** The frame with its last two bytes set so that its checksum holds. */
  private fun withChecksum(f: ByteArray): ByteArray {
    var crc = 0
    for (i in 2 until f.size - 2) {
      crc = crc xor ((f[i].toInt() and 0xFF) shl 8)
      repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x8005) and 0xFFFF else (crc shl 1) and 0xFFFF }
    }
    f[f.size - 2] = (crc shr 8).toByte()
    f[f.size - 1] = crc.toByte()
    return f
  }

  /** An AC-3 frame of 768 bytes (48 kHz, 192 kbit/s, stream id 8), `acmod` 7 and LFE on being 5.1. */
  private fun core(acmod: Int = 7, lfe: Int = 1): ByteArray {
    val w = BitWriter()
    w.put(0x0B77, 16); w.put(0, 16); w.put(0x14, 8); w.put(8, 5); w.put(0, 3)
    w.put(acmod, 3)
    if ((acmod and 1) != 0 && acmod != 1) w.put(0, 2)
    if ((acmod and 4) != 0) w.put(0, 2)
    if (acmod == 2) w.put(0, 2)
    w.put(lfe, 1)
    return withChecksum(w.bytes(768))
  }

  /** An E-AC-3 frame (stream id 16, 48 kHz, 6 blocks): `strmtyp` 0 independent, 1 dependent, and a map for a dependent one. */
  private fun plus(strmtyp: Int, substream: Int, acmod: Int, lfe: Int, chanmap: Int = -1, size: Int = 400): ByteArray {
    val w = BitWriter()
    w.put(0x0B77, 16); w.put(strmtyp, 2); w.put(substream, 3); w.put(size / 2 - 1, 11)
    w.put(0, 2); w.put(3, 2); w.put(acmod, 3); w.put(lfe, 1); w.put(16, 5); w.put(0, 5); w.put(0, 1)
    if (strmtyp == 1) {
      if (chanmap >= 0) { w.put(1, 1); w.put(chanmap, 16) } else w.put(0, 1)
    }
    return withChecksum(w.bytes(size))
  }

  private class Groups : BdEac3Splitter.Sink {
    val sizes = ArrayList<Int>()
    val frames = ArrayList<Int>()
    val offsets = ArrayList<Long>()
    override fun unit(data: ByteArray, at: Int, size: Int, streamOffset: Long, frames: List<Eac3Frame>) {
      sizes.add(size); this.frames.add(frames.size); offsets.add(streamOffset)
    }
  }

  private fun pushIn(s: BdEac3Splitter, stream: ByteArray, from: Int, piece: Int) {
    var p = from
    while (p < stream.size) {
      val n = minOf(piece, stream.size - p)
      s.push(stream, p, n)
      p += n
    }
  }

  @Test fun plusFrameSizesAndWhichBeginAGroup() {
    assertEquals(768, Eac3Header.sizeOf(core(), 0)) // AC-3, 192 kbit/s
    // E-AC-3 says its size: 11 bits, words minus one. 400 bytes = 200 words = 199.
    assertEquals(400, Eac3Header.sizeOf(plus(0, 0, 7, 1), 0))
    assertEquals(-1, Eac3Header.sizeOf(ByteArray(10), 0))
    assertTrue(Eac3Header.startsUnit(core(), 0))
    assertTrue(Eac3Header.startsUnit(plus(0, 0, 7, 1), 0))
    assertTrue(Eac3Header.startsUnit(plus(2, 0, 7, 1), 0)) // AC-3 converted: independent
    assertFalse(Eac3Header.startsUnit(plus(1, 0, 2, 0, 0x0200), 0)) // dependent
    assertFalse(Eac3Header.startsUnit(plus(0, 1, 2, 0), 0)) // another program's
  }

  @Test fun plusChannelsAreTheFramesTogether() {
    val c = Eac3Header.parse(core(), 0, 768)!!
    assertEquals(6, c.channels) // acmod 7 (L C R Ls Rs) + LFE
    assertEquals(48000, c.sampleRate)
    assertEquals(1536, c.samples)
    val ind = Eac3Header.parse(plus(0, 0, 7, 1), 0, 400)!!
    assertEquals(6, ind.channels)
    assertEquals(1536, ind.samples) // 6 blocks of 256
    val dep = Eac3Header.parse(plus(1, 0, 2, 0, 0x0200), 0, 400)!!
    assertEquals(0x0200, dep.chanmap)
    assertEquals(2, Eac3Header.chanmapChannels(0x0200)) // the seventh bit: Lrs + Rrs
    assertEquals(4, Eac3Header.chanmapChannels(0x0600)) // Lc + Rc and Lrs + Rrs
    assertEquals(1, Eac3Header.chanmapChannels(0x0100)) // Cs
    assertEquals(2, Eac3Header.chanmapChannels(0x8001)) // L and LFE
    // 5.1 and Lrs + Rrs is 7.1.
    assertEquals(8, Eac3Header.channelsOf(listOf(c, dep)))
    assertEquals(6, Eac3Header.channelsOf(listOf(c)))
    // Without a map the dependent frame's own channels (2) are what it adds.
    assertEquals(8, Eac3Header.channelsOf(listOf(ind, Eac3Header.parse(plus(1, 0, 2, 0), 0, 400)!!)))
  }

  @Test fun eachPlaceIsCountedOnceAndNeverMoreThanEight() {
    val c = Eac3Header.parse(core(), 0, 768)!!
    // A dependent frame that names the places of a whole 5.1 and Lrs+Rrs again adds only Lrs+Rrs.
    val again = Eac3Header.parse(plus(1, 0, 7, 1, 0x8000 or 0x4000 or 0x2000 or 0x1000 or 0x0800 or 0x0200 or 0x0001), 0, 400)!!
    assertEquals(8, Eac3Header.channelsOf(listOf(c, again)))
    // Places beyond 7.1 (wide, top, direct surround...) are more than a sound output takes: eight.
    val many = Eac3Header.parse(plus(1, 0, 7, 0, 0x0FE0), 0, 400)!!
    assertEquals(8, Eac3Header.channelsOf(listOf(c, many)))
    // No map and five channels of its own (what a box once counted as 11 in all) is eight too.
    val five = Eac3Header.parse(plus(1, 0, 7, 0), 0, 400)!!
    assertEquals(5, five.channels)
    assertEquals(8, Eac3Header.channelsOf(listOf(c, five)))
    // Stereo alone is 2, and 3/0 with LFE is 4.
    assertEquals(2, Eac3Header.channelsOf(listOf(Eac3Header.parse(core(2, 0), 0, 768)!!)))
    assertEquals(4, Eac3Header.channelsOf(listOf(Eac3Header.parse(core(3, 1), 0, 768)!!)))
  }

  @Test fun anAc3FrameAndItsDependentFramesAreOneGroupWhateverSizeTheyComeIn() {
    val stream = (core() + plus(1, 0, 2, 0, 0x0200)) + (core() + plus(1, 0, 2, 0, 0x0200)) + (core() + plus(1, 0, 2, 0, 0x0200))
    for (piece in intArrayOf(1, 5, 187, 1000, stream.size)) {
      val g = Groups()
      val s = BdEac3Splitter(g)
      pushIn(s, stream, 0, piece)
      assertEquals("pieces of $piece, before the end", listOf(1168, 1168), g.sizes) // 768 + 400
      s.flush()
      assertEquals(listOf(1168, 1168, 1168), g.sizes)
      assertEquals(listOf(2, 2, 2), g.frames)
      assertEquals(listOf(0L, 1168L, 2336L), g.offsets)
      assertEquals(0, s.lostSyncCount)
    }
  }

  @Test fun aStreamOfEac3AloneIsGroupedByItsIndependentFrames() {
    val ind = plus(0, 0, 7, 1, size = 500)
    val dep = plus(1, 0, 2, 0, 0x0200)
    val stream = ind + dep + ind + ind + dep
    val g = Groups()
    val s = BdEac3Splitter(g)
    pushIn(s, stream, 0, 333)
    s.flush()
    assertEquals(listOf(900, 500, 900), g.sizes)
    assertEquals(listOf(2, 1, 2), g.frames)
  }

  @Test fun dependentFramesBeforeTheFirstIndependentOneAreLeftOut() {
    val one = core() + plus(1, 0, 2, 0, 0x0200)
    val stream = one + one + one
    val g = Groups()
    val s = BdEac3Splitter(g)
    // Start at the first dependent frame: its 400 bytes, then two whole groups.
    pushIn(s, stream, 768, 1000)
    s.flush()
    assertEquals(listOf(1168, 1168), g.sizes)
  }

  @Test fun aBrokenPlaceIsGotOverAtTheNextGroup() {
    val one = core() + plus(1, 0, 2, 0, 0x0200)
    val stream = one + ByteArray(30) + one + one
    val g = Groups()
    val s = BdEac3Splitter(g)
    pushIn(s, stream, 0, 700)
    s.flush()
    assertEquals(1, s.lostSyncCount)
    assertEquals(listOf(1168, 1168, 1168), g.sizes)
  }
}
