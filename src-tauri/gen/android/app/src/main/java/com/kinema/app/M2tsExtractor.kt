package com.kinema.app

import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.util.TimestampAdjuster
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.extractor.ts.TsExtractor
import java.io.EOFException

/**
 * Where things are in a Blu-ray stream file (`.m2ts`): a transport stream whose
 * every 188-byte packet has 4 bytes (a copy flag and a time stamp) put before
 * it, so the file is 192-byte packets. Media3's transport stream reader knows
 * only 188, so [M2tsExtractor] shows it the file without those 4 bytes.
 *
 * The two ways to number a place: "raw", in the file as it is, and "logical",
 * in the file with the 4 bytes taken out. Small and exact, so they can be
 * tried on their own (BdStreamParsingTest.kt).
 */
internal object BdavLayout {
  const val RAW = 192
  const val HEAD = 4
  const val TS = 188

  /** Packets moved in one go when there is room to: reading each one on its own is thousands of small reads a second. */
  const val BULK_PACKETS = 64

  /**
   * A raw place as a logical one. A place inside the 4 bytes is the start of
   * that packet's data, since those bytes are not there to be at.
   * `0` -> 0, `4` -> 0, `5` -> 1, `192` -> 188 (the next packet's start), `196` -> 188, `100` -> 96.
   */
  fun logicalOf(raw: Long): Long {
    val p = raw / RAW
    val o = raw - p * RAW
    return p * TS + (if (o > HEAD) o - HEAD else 0)
  }

  /** A logical place as a raw one: `0` -> 4, `187` -> 191, `188` -> 196, `376` -> 388. */
  fun rawOf(logical: Long): Long {
    val p = logical / TS
    return p * RAW + HEAD + (logical - p * TS)
  }

  /**
   * Where to start reading to get to a logical place: the same as [rawOf],
   * except that a packet's very start is given as the start of the packet
   * (`188` -> 192, not 196), so that what is read from there starts on the
   * 4 bytes it should skip. Both read the same data.
   */
  fun rawSeekOf(logical: Long): Long = if (logical % TS == 0L) logical / TS * RAW else rawOf(logical)

  /**
   * The logical length of a file of `rawLength` bytes; a length not known
   * (negative) stays as it is. `1960` (10 whole packets and 40 bytes of an
   * 11th: 4 extra and 36 data) -> 1880 + 36 = 1916.
   */
  fun lengthOf(rawLength: Long): Long {
    if (rawLength < 0) return rawLength
    val full = rawLength / RAW
    val rest = rawLength - full * RAW
    return full * TS + (if (rest > HEAD) rest - HEAD else 0)
  }

  /** How many of a packet's 4 extra bytes lie ahead of `raw`: 4 at a packet's start, 1 at its 4th byte, 0 from its 5th. */
  fun headerLeft(raw: Long): Int {
    val o = (raw % RAW).toInt()
    return if (o < HEAD) HEAD - o else 0
  }

  /** The data bytes from `raw` (past any extra bytes) to the end of its packet: 188 at a packet's start or its 4th byte, 92 at byte 100. */
  fun payloadLeft(raw: Long): Int {
    val o = (raw % RAW).toInt()
    return RAW - (if (o < HEAD) HEAD else o)
  }

  /**
   * How many whole packets (at least 2, at most `max`) can be read in one go
   * from `raw` to get `wanted` logical bytes: only from where a packet starts
   * (its 4 extra bytes ahead) or where its data begins (just past them), only
   * as many as are in the file, so none is a read past its end. From a
   * packet's start k packets are k x 192 raw bytes; from its data, k x 192 - 4
   * (the last one's extra bytes are the next packet's). Starting at the
   * packet's start saves a separate read of 4 bytes for every batch. 0 means
   * one at a time.
   */
  fun bulkPackets(raw: Long, wanted: Int, rawLength: Long, max: Int = BULK_PACKETS): Int {
    if (rawLength < 0) return 0
    val o = raw % RAW
    val room = when (o) {
      0L -> rawLength - raw
      HEAD.toLong() -> rawLength - raw + HEAD
      else -> return 0
    }
    val k = minOf(max.toLong(), (wanted / TS).toLong(), room / RAW)
    return if (k >= 2) k.toInt() else 0
  }

  /** The raw bytes `packets` packets take from `raw` (see [bulkPackets]): 384 for 2 from a packet's start, 380 from its data. */
  fun bulkSpan(raw: Long, packets: Int): Int = packets * RAW - (if (raw % RAW == 0L) 0 else HEAD)

  /** Where the first packet's data is in what was read from `raw`: 4 in from a packet's start, 0 from its data. */
  fun firstData(raw: Long): Int = if (raw % RAW == 0L) HEAD else 0

  /**
   * `scratch` holds k packets as read (from `first`: data, then the next
   * packet's 4 extra bytes, then its data...); `target` gets the data alone.
   */
  fun compact(scratch: ByteArray, packets: Int, target: ByteArray, offset: Int, first: Int = 0) {
    for (i in 0 until packets) System.arraycopy(scratch, first + i * RAW, target, offset + i * TS, TS)
  }

  /**
   * Whether `b` starts with Blu-ray stream file packets: a transport stream
   * sync byte (0x47) 4 bytes into each of the first 5 packets of 192 bytes,
   * and not at the start of each of the first 5 of 188 (which is a plain
   * transport stream, Media3's own to read).
   */
  fun looksLikeBdav(b: ByteArray, count: Int): Boolean {
    if (count < RAW * 5) return false
    for (i in 0 until 5) if (b[i * RAW + HEAD] != 0x47.toByte()) return false
    for (i in 0 until 5) if (b[i * TS] != 0x47.toByte()) return true
    return false
  }
}

/**
 * The file as the transport stream reader wants it: 188-byte packets. Every
 * place it is asked about or told of is logical; the file's own input is
 * read, peeked and skipped over the extra 4 bytes, all worked out from
 * where that input is, so this holds nothing that must be kept in step with it.
 */
internal class BdavInput(private val src: ExtractorInput, private val scratch: ByteArray) : ExtractorInput {

  private fun cursor(peek: Boolean) = if (peek) src.peekPosition else src.position

  /** Past the packet's 4 extra bytes if the cursor is in them. False: the input ended right there (and the caller allowed it). */
  private fun skipHeader(peek: Boolean, allowEnd: Boolean): Boolean {
    val n = BdavLayout.headerLeft(cursor(peek))
    if (n == 0) return true
    return if (peek) src.advancePeekPosition(n, allowEnd) else src.skipFully(n, allowEnd)
  }

  private fun rawFully(peek: Boolean, target: ByteArray, offset: Int, length: Int, allowEnd: Boolean): Boolean =
    if (peek) src.peekFully(target, offset, length, allowEnd) else src.readFully(target, offset, length, allowEnd)

  private fun fully(peek: Boolean, target: ByteArray, offset: Int, length: Int, allowEnd: Boolean): Boolean {
    // Nothing to move still goes to the input: it takes it as the end of a read, which puts the peek position back.
    if (length == 0) return rawFully(peek, target, offset, 0, allowEnd)
    var done = 0
    while (done < length) {
      val here = cursor(peek)
      val packets = BdavLayout.bulkPackets(here, length - done, src.length)
      if (packets > 0) {
        rawFully(peek, scratch, 0, BdavLayout.bulkSpan(here, packets), false)
        BdavLayout.compact(scratch, packets, target, offset + done, BdavLayout.firstData(here))
        done += packets * BdavLayout.TS
        continue
      }
      if (!skipHeader(peek, allowEnd && done == 0)) return false
      val pos = cursor(peek)
      val n = minOf(length - done, BdavLayout.payloadLeft(pos))
      if (!rawFully(peek, target, offset + done, n, allowEnd && done == 0)) return false
      done += n
    }
    return true
  }

  /** One read or peek, of as much as comes at once. */
  private fun single(peek: Boolean, target: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return if (peek) src.peek(target, offset, 0) else src.read(target, offset, 0)
    val here = cursor(peek)
    val packets = BdavLayout.bulkPackets(here, length, src.length)
    if (packets > 0) {
      rawFully(peek, scratch, 0, BdavLayout.bulkSpan(here, packets), false)
      BdavLayout.compact(scratch, packets, target, offset, BdavLayout.firstData(here))
      return packets * BdavLayout.TS
    }
    // A file cut off inside the extra bytes ends here, as one cut off between packets does.
    try {
      if (!skipHeader(peek, true)) return C.RESULT_END_OF_INPUT
    } catch (_: EOFException) {
      return C.RESULT_END_OF_INPUT
    }
    val pos = cursor(peek)
    val n = minOf(length, BdavLayout.payloadLeft(pos))
    return if (peek) src.peek(target, offset, n) else src.read(target, offset, n)
  }

  /** Forward by `length` logical bytes: over the extra bytes too, in one move. */
  private fun skipLogical(peek: Boolean, length: Int, allowEnd: Boolean): Boolean {
    if (length == 0) return if (peek) src.advancePeekPosition(0, allowEnd) else src.skipFully(0, allowEnd)
    if (!skipHeader(peek, allowEnd)) return false
    val pos = cursor(peek)
    val logicalEnd = BdavLayout.logicalOf(pos) + length
    var rawEnd = BdavLayout.rawOf(logicalEnd)
    val total = src.length
    // A move that ends exactly at the file's end would, by the 4 bytes of a next packet, be past it.
    if (total >= 0 && logicalEnd <= BdavLayout.lengthOf(total) && rawEnd > total) rawEnd = total
    val delta = (rawEnd - pos).toInt()
    return if (peek) src.advancePeekPosition(delta, allowEnd) else src.skipFully(delta, allowEnd)
  }

  override fun read(target: ByteArray, offset: Int, length: Int): Int = single(false, target, offset, length)
  override fun peek(target: ByteArray, offset: Int, length: Int): Int = single(true, target, offset, length)

  override fun readFully(target: ByteArray, offset: Int, length: Int, allowEndOfInput: Boolean) =
    fully(false, target, offset, length, allowEndOfInput)

  override fun readFully(target: ByteArray, offset: Int, length: Int) {
    fully(false, target, offset, length, false)
  }

  override fun peekFully(target: ByteArray, offset: Int, length: Int, allowEndOfInput: Boolean) =
    fully(true, target, offset, length, allowEndOfInput)

  override fun peekFully(target: ByteArray, offset: Int, length: Int) {
    fully(true, target, offset, length, false)
  }

  override fun skip(length: Int): Int {
    if (length == 0) return src.skip(0)
    try {
      if (!skipHeader(false, true)) return C.RESULT_END_OF_INPUT
    } catch (_: EOFException) {
      return C.RESULT_END_OF_INPUT
    }
    return src.skip(minOf(length, BdavLayout.payloadLeft(src.position)))
  }

  override fun skipFully(length: Int, allowEndOfInput: Boolean) = skipLogical(false, length, allowEndOfInput)

  override fun skipFully(length: Int) {
    skipLogical(false, length, false)
  }

  override fun advancePeekPosition(length: Int, allowEndOfInput: Boolean) = skipLogical(true, length, allowEndOfInput)

  override fun advancePeekPosition(length: Int) {
    skipLogical(true, length, false)
  }

  override fun resetPeekPosition() = src.resetPeekPosition()
  override fun getPeekPosition(): Long = BdavLayout.logicalOf(src.peekPosition)
  override fun getPosition(): Long = BdavLayout.logicalOf(src.position)
  override fun getLength(): Long = BdavLayout.lengthOf(src.length)

  override fun <E : Throwable> setRetryPosition(position: Long, e: E) {
    src.setRetryPosition(BdavLayout.rawSeekOf(position), e)
  }
}

/** The seek map of the 188-byte view, with its places given as the file's own. */
internal class MappedSeekMap(private val inner: SeekMap) : SeekMap {
  override fun isSeekable() = inner.isSeekable
  override fun getDurationUs() = inner.durationUs
  override fun isEstimated() = inner.isEstimated

  override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints {
    val points = inner.getSeekPoints(timeUs)
    val first = map(points.first)
    return if (points.second == points.first) SeekMap.SeekPoints(first) else SeekMap.SeekPoints(first, map(points.second))
  }

  private fun map(p: SeekPoint) = SeekPoint(p.timeUs, BdavLayout.rawSeekOf(p.position))
}

/**
 * Reads Blu-ray stream files (`.m2ts`), which Media3 does not: 192-byte
 * packets, and sound and subtitle kinds a disc uses that a broadcast stream
 * does not (BdTsPayloadReaderFactory.kt). Media3's own transport stream reader
 * does the work, fed the file without the 4 extra bytes of each packet; the
 * places it gives out (where to seek, what the file's seek map says) are
 * turned back into the file's own on the way out.
 *
 * A plain `.ts` is left to Media3's reader: this takes only a file whose
 * packets are 192 long.
 */
internal class M2tsExtractor(
  transcodeText: Boolean,
  subtitleParserFactory: SubtitleParser.Factory,
) : Extractor {
  /** Packet ids of TrueHD streams that have a Dolby Digital core as well, found when the file was sniffed. */
  private val withCore = HashSet<Int>()
  private val scratch = ByteArray(BdavLayout.BULK_PACKETS * BdavLayout.RAW)
  private val where = PositionHolder()
  private var view: BdavInput? = null
  private var viewOf: ExtractorInput? = null

  private val inner = TsExtractor(
    TsExtractor.MODE_SINGLE_PMT,
    if (transcodeText) 0 else TsExtractor.FLAG_EMIT_RAW_SUBTITLE_DATA,
    subtitleParserFactory,
    TimestampAdjuster(0),
    // A disc's H.264 often starts its pictures to be seeked to at non-IDR I pictures.
    BdTsPayloadReaderFactory(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES) { pid -> pid in withCore },
    TsExtractor.DEFAULT_TIMESTAMP_SEARCH_BYTES,
  )

  override fun sniff(input: ExtractorInput): Boolean {
    val start = ByteArray(BdavLayout.RAW * 5)
    try {
      input.peekFully(start, 0, start.size)
    } catch (_: EOFException) {
      return false
    }
    if (!BdavLayout.looksLikeBdav(start, start.size)) return false
    // Read ahead for what the tracks depend on (BdCoreScan). The same bytes
    // are read again for playing, from the input's own buffer.
    val length = input.length
    val limit = if (length in 0 until SCAN_BYTES.toLong()) length.toInt() else SCAN_BYTES
    val head = start.copyOf(maxOf(limit, start.size))
    var have = start.size
    while (have < limit) {
      val n = input.peek(head, have, limit - have)
      if (n == C.RESULT_END_OF_INPUT) break
      have += n
    }
    withCore.clear()
    withCore.addAll(BdCoreScan.pidsWithCore(head, have))
    Log.i("Kinema", "media3: a Blu-ray stream file (192-byte packets); TrueHD with a Dolby Digital core in ${withCore.size} stream(s)")
    return true
  }

  override fun init(output: ExtractorOutput) {
    inner.init(object : ExtractorOutput by output {
      override fun seekMap(seekMap: SeekMap) = output.seekMap(MappedSeekMap(seekMap))
    })
  }

  override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
    // Called for every few packets: the same input and holder are used again (the input is the same until a seek).
    val adapter = view?.takeIf { viewOf === input } ?: BdavInput(input, scratch).also { view = it; viewOf = input }
    val result = inner.read(adapter, where)
    if (result == Extractor.RESULT_SEEK) seekPosition.position = BdavLayout.rawSeekOf(where.position)
    return result
  }

  override fun seek(position: Long, timeUs: Long) = inner.seek(BdavLayout.logicalOf(position), timeUs)

  override fun release() = inner.release()

  private companion object {
    /**
     * How far into the file to look for a Dolby Digital core. A frame is 32 ms
     * of sound; 1 MB is about 80 ms of even the heaviest disc stream (100+
     * Mbit/s), a second or more of an ordinary one. It is also read twice by
     * the input (as peeked bytes, then as played), and every read of the peeked
     * bytes moves the rest of them down, so a longer look costs more than its
     * length.
     */
    const val SCAN_BYTES = 1024 * 1024
  }
}
