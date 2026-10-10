package com.kinema.app

import android.util.Log
import android.util.SparseArray
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.ParsableBitArray
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.extractor.Ac3Util
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.extractor.ts.ElementaryStreamReader
import androidx.media3.extractor.ts.PesReader
import androidx.media3.extractor.ts.TsPayloadReader

/**
 * Which reader takes which kind of stream in a Blu-ray stream file. Media3's
 * own factory knows the broadcast kinds; a disc uses some of the numbers for
 * other things:
 *
 * - 0x80 is uncompressed sound on a disc, and video to Media3's factory: left out.
 * - 0x83 is Dolby TrueHD, with a Dolby Digital core in the same stream.
 * - 0x84 and 0xA1 are Dolby Digital Plus (the second one for a second, "secondary", sound): an AC-3 or E-AC-3 frame and the dependent frames after it, read together by BdEac3Reader.
 * - 0x85 and 0x86 are DTS-HD (High Resolution, Master Audio), a DTS core and the rest after it; Media3 reads DTS-HD as 0x88.
 * - 0x82 is DTS, which Media3 reads when told to.
 * - 0x90 is picture subtitles (PGS).
 *
 * The rest (video, Dolby Digital 0x81, MPEG sound) is Media3's.
 * `hasCore` says whether the TrueHD stream with this packet id has the
 * core (BdCoreScan).
 */
internal class BdTsPayloadReaderFactory(
  flags: Int,
  private val hasCore: (Int) -> Boolean,
) : TsPayloadReader.Factory {
  private val base = DefaultTsPayloadReaderFactory(flags or DefaultTsPayloadReaderFactory.FLAG_ENABLE_HDMV_DTS_AUDIO_STREAMS)

  override fun createInitialPayloadReaders(): SparseArray<TsPayloadReader> = base.createInitialPayloadReaders()

  /**
   * Only the first video stream is read. A UHD disc with Dolby Vision keeps
   * its enhancement layer (the extra picture and metadata that only a Dolby
   * decoder uses) as a second video stream beside the base layer, which is a
   * plain HDR10 film on its own. A second video track would be offered to the
   * player as a picture of its own, and its data is not one a hardware HEVC
   * decoder can show. The first one listed in the disc's table is the base.
   */
  private var videoRead = false

  override fun createPayloadReader(streamType: Int, esInfo: TsPayloadReader.EsInfo): TsPayloadReader? {
    if (streamType in VIDEO_TYPES) {
      if (videoRead) return null
      videoRead = true
    }
    return when (streamType) {
      LPCM -> null
      TRUEHD -> PesReader(BdTrueHdReader(esInfo.language, esInfo.roleFlags, hasCore))
      DD_PLUS_BD, DD_PLUS_SECONDARY -> PesReader(BdEac3Reader(esInfo.language, esInfo.roleFlags))
      DTS_HD_HRA, DTS_HD_MA -> base.createPayloadReader(DTS_HD_MEDIA3, esInfo)
      PGS -> PesReader(BdPgsReader(esInfo.language, esInfo.roleFlags))
      else -> base.createPayloadReader(streamType, esInfo)
    }
  }

  private companion object {
    const val LPCM = 0x80
    const val TRUEHD = 0x83
    const val DD_PLUS_BD = 0x84
    const val DD_PLUS_SECONDARY = 0xA1
    const val DTS_HD_HRA = 0x85
    const val DTS_HD_MA = 0x86
    const val PGS = 0x90
    const val DTS_HD_MEDIA3 = 0x88

    /** MPEG-1, MPEG-2, MPEG-4, H.264 and H.265 video. */
    val VIDEO_TYPES = setOf(0x01, 0x02, 0x10, 0x1B, 0x24)
  }
}

/**
 * A disc's picture subtitles: each PES packet holds some segments of a
 * display set (one picture of text, or the clearing of it), a set ending
 * with the "end" segment (0x80). The player's reader (PgsParser) wants a
 * whole set in one sample, as Matroska keeps them, so this puts the packets
 * of a set together and gives it at the time of its first.
 */
internal class BdPgsReader(
  private val language: String?,
  private val roleFlags: Int,
) : ElementaryStreamReader {
  private var output: TrackOutput? = null
  private var buf = ByteArray(32 * 1024)
  private var size = 0
  private var timeUs = C.TIME_UNSET
  private var packetTimeUs = C.TIME_UNSET

  override fun seek() {
    size = 0
    timeUs = C.TIME_UNSET
    packetTimeUs = C.TIME_UNSET
  }

  override fun createTracks(extractorOutput: ExtractorOutput, idGenerator: TsPayloadReader.TrackIdGenerator) {
    idGenerator.generateNewId()
    output = extractorOutput.track(idGenerator.trackId, C.TRACK_TYPE_TEXT).also {
      it.format(
        Format.Builder()
          .setId(idGenerator.formatId)
          .setContainerMimeType(MimeTypes.VIDEO_MP2T)
          .setSampleMimeType(MimeTypes.APPLICATION_PGS)
          .setLanguage(language)
          .setRoleFlags(roleFlags)
          .build()
      )
    }
  }

  override fun packetStarted(pesTimeUs: Long, flags: Int) {
    if (pesTimeUs != C.TIME_UNSET) packetTimeUs = pesTimeUs
    if (size == 0) timeUs = packetTimeUs
  }

  override fun consume(data: ParsableByteArray) {
    val n = data.bytesLeft()
    if (size + n > MAX_SET_BYTES) {
      // Not a subtitle stream any longer: start over rather than grow.
      size = 0
      data.skipBytes(n)
      return
    }
    if (size + n > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, size + n))
    data.readBytes(buf, size, n)
    size += n
  }

  override fun packetFinished() {
    // Whole segments: type (1), length (2), body. A set is complete at its end segment.
    var p = 0
    while (size - p >= 3) {
      val type = buf[p].toInt() and 0xFF
      if (type !in SEGMENT_TYPES) {
        size = 0
        return
      }
      val end = p + 3 + (((buf[p + 1].toInt() and 0xFF) shl 8) or (buf[p + 2].toInt() and 0xFF))
      if (end > size) break
      p = end
      if (type == END_SEGMENT) {
        if (timeUs != C.TIME_UNSET) {
          output?.sampleData(ParsableByteArray(buf, p), p)
          output?.sampleMetadata(timeUs, C.BUFFER_FLAG_KEY_FRAME, p, 0, null)
        }
        // What follows, if anything, is the next set, begun in this packet.
        System.arraycopy(buf, p, buf, 0, size - p)
        size -= p
        p = 0
        timeUs = packetTimeUs
      }
    }
  }

  private companion object {
    /** Palette, object, presentation, window, end: 0x14 to 0x17 and 0x80 (0x16 is the one that has the time). */
    val SEGMENT_TYPES = setOf(0x14, 0x15, 0x16, 0x17, 0x80)
    const val END_SEGMENT = 0x80
    const val MAX_SET_BYTES = 4 * 1024 * 1024
  }
}


/**
 * A disc's Dolby Digital Plus: an independent frame (often an AC-3 frame, which
 * any decoder plays) followed by E-AC-3 dependent frames that add the other
 * channels, all in one stream. Media3's own reader makes a sample of each
 * frame and flips the track between Dolby Digital and Dolby Digital Plus, so
 * the sound output reopens several times a second. This makes one sample
 * of the independent frame and the dependent frames after it, and gives the
 * track one format: Dolby Digital Plus (with Atmos where Media3 finds that in
 * a frame), the channels of all the frames together, the rate of the first.
 *
 * A stream of AC-3 frames alone (nothing of E-AC-3 in its first few
 * groups) stays Dolby Digital. The format is given once it is known, so up
 * to [UNDECIDED_UNITS] groups are held until then.
 */
internal class BdEac3Reader(
  private val language: String?,
  private val roleFlags: Int,
) : ElementaryStreamReader, BdEac3Splitter.Sink {
  private val splitter = BdEac3Splitter(this)
  private var output: TrackOutput? = null
  private var formatId: String? = null
  private var pid = 0
  private var formatGiven = false

  private class Mark(val offset: Long, val timeUs: Long)

  private class Held(val bytes: ByteArray, val timeUs: Long)

  private val marks = ArrayDeque<Mark>()
  private val held = ArrayList<Held>()
  private var clockUs = C.TIME_UNSET
  private var clockSamples = 0L
  private var lostLogged = 0

  override fun seek() {
    splitter.reset()
    marks.clear()
    held.clear()
    clockUs = C.TIME_UNSET
    clockSamples = 0
  }

  override fun createTracks(extractorOutput: ExtractorOutput, idGenerator: TsPayloadReader.TrackIdGenerator) {
    idGenerator.generateNewId()
    pid = idGenerator.trackId
    output = extractorOutput.track(pid, C.TRACK_TYPE_AUDIO)
    formatId = idGenerator.formatId
  }

  override fun packetStarted(pesTimeUs: Long, flags: Int) {
    if (pesTimeUs != C.TIME_UNSET) marks.addLast(Mark(splitter.total, pesTimeUs))
  }

  override fun consume(data: ParsableByteArray) {
    val n = data.bytesLeft()
    splitter.push(data.data, data.position, n)
    data.skipBytes(n)
    if (splitter.lostSyncCount > lostLogged && lostLogged < MAX_LOGGED) {
      lostLogged = splitter.lostSyncCount
      Log.i("Kinema", "media3: Dolby Digital Plus stream $pid lost its place ($lostLogged times so far, ${splitter.total} bytes in)")
    }
  }

  override fun endOfInputReached() {
    splitter.flush()
  }

  override fun unit(data: ByteArray, at: Int, size: Int, streamOffset: Long, frames: List<Eac3Frame>) {
    val out = output ?: return
    var mark: Mark? = null
    while (marks.isNotEmpty() && marks.first().offset <= streamOffset) mark = marks.removeFirst()
    if (mark != null) {
      clockUs = mark.timeUs
      clockSamples = 0
    }
    if (clockUs == C.TIME_UNSET) return
    val first = frames[0]
    val time = clockUs + clockSamples * 1_000_000L / first.sampleRate
    clockSamples += first.samples

    if (!formatGiven) {
      held.add(Held(data.copyOfRange(at, at + size), time))
      val plus = frames.any { it.isEac3 }
      if (!plus && held.size < UNDECIDED_UNITS) return
      out.format(format(data, at, frames, plus))
      formatGiven = true
      held.forEach { write(out, it.bytes, 0, it.bytes.size, it.timeUs) }
      held.clear()
      return
    }
    write(out, data, at, size, time)
  }

  private fun write(out: TrackOutput, data: ByteArray, at: Int, size: Int, timeUs: Long) {
    val bytes = ParsableByteArray(data, at + size)
    bytes.setPosition(at)
    out.sampleData(bytes, size)
    out.sampleMetadata(timeUs, C.BUFFER_FLAG_KEY_FRAME, size, 0, null)
  }

  private fun format(data: ByteArray, at: Int, frames: List<Eac3Frame>, plus: Boolean): Format {
    var mime = if (plus) MimeTypes.AUDIO_E_AC3 else MimeTypes.AUDIO_AC3
    if (plus) {
      // Media3 says a frame is Atmos from its additional bit stream information.
      var p = at
      for (f in frames) {
        if (f.isEac3) {
          try {
            if (Ac3Util.parseAc3SyncframeInfo(ParsableBitArray(data.copyOfRange(p, p + f.size))).mimeType == MimeTypes.AUDIO_E_AC3_JOC) {
              mime = MimeTypes.AUDIO_E_AC3_JOC
            }
          } catch (_: RuntimeException) {
            // Not a frame it can read: no word on Atmos from this one.
          }
        }
        p += f.size
      }
    }
    return Format.Builder()
      .setId(formatId)
      .setContainerMimeType(MimeTypes.VIDEO_MP2T)
      .setSampleMimeType(mime)
      .setChannelCount(Eac3Header.channelsOf(frames))
      .setSampleRate(frames[0].sampleRate)
      .setLanguage(language)
      .setRoleFlags(roleFlags)
      .build()
      .also { Log.i("Kinema", "media3: Dolby Digital Plus stream $pid: $mime, ${it.channelCount} channels, ${it.sampleRate} Hz, ${frames.size} frames to a group") }
  }

  private companion object {
    const val UNDECIDED_UNITS = 4
    const val MAX_LOGGED = 8
  }
}

/**
 * A disc's Dolby TrueHD: one stream holding the TrueHD access units and a
 * Dolby Digital frame now and then, which is what a player without TrueHD
 * is meant to play. Given out as two tracks (TrueHD, then the Dolby Digital
 * "core", labelled as such so that its line in the track list says what it
 * is) or as TrueHD alone when the stream has no core (the core track would
 * otherwise wait for a format that never comes).
 *
 * TrueHD is given as Media3 gets it from Matroska: its access units in
 * groups of 16 per sample, the first group starting at a major sync, a
 * sample counted as one to seek to when a major sync is in it. The sound
 * output's counting of time depends on the groups being 16
 * (Ac3Util.TRUEHD_RECHUNK_SAMPLE_COUNT).
 */
internal class BdTrueHdReader(
  private val language: String?,
  private val roleFlags: Int,
  private val hasCore: (Int) -> Boolean,
) : ElementaryStreamReader, BdTrueHdSplitter.Sink {
  private val splitter = BdTrueHdSplitter(this)
  private var trueHd: TrackOutput? = null
  private var trueHdFormatId: String? = null
  private var ac3: TrackOutput? = null
  private var ac3FormatId: String? = null
  private var ac3Format: Format? = null
  private var trueHdFormatGiven = false
  private var pid = 0

  /** A PES packet's time, and where in the stream (bytes pushed) its data began. */
  private class Mark(val offset: Long, val timeUs: Long)

  /**
   * One kind of item's time: the last PES packet's time that it was set to,
   * and the samples counted since. Time is the one over the other, worked out
   * whole each time rather than added up in microseconds, which would be a
   * rounding error more with every item.
   */
  private class Clock {
    var markUs = C.TIME_UNSET
    var samples = 0L

    fun timeUs(rate: Int): Long = if (markUs == C.TIME_UNSET) C.TIME_UNSET else markUs + samples * 1_000_000L / maxOf(rate, 1)

    fun set(timeUs: Long) {
      markUs = timeUs
      samples = 0
    }

    fun reset() = set(C.TIME_UNSET)
  }

  private val marks = ArrayDeque<Mark>()
  private val trueHdClock = Clock()
  private val ac3Clock = Clock()

  private var rate = 0
  private var unitSamples = SAMPLES_AT_48K
  private var started = false
  private var chunk = ByteArray(16 * 4096)
  private var chunkSize = 0
  private var chunkUnits = 0
  private var chunkTimeUs = 0L
  private var chunkHasMajor = false

  private var lostLogged = 0

  override fun seek() {
    splitter.reset()
    marks.clear()
    trueHdClock.reset()
    ac3Clock.reset()
    started = false
    chunkSize = 0
    chunkUnits = 0
  }

  override fun createTracks(extractorOutput: ExtractorOutput, idGenerator: TsPayloadReader.TrackIdGenerator) {
    // The first id is the stream's packet id.
    idGenerator.generateNewId()
    pid = idGenerator.trackId
    val withCore = hasCore(pid)
    trueHd = extractorOutput.track(pid, C.TRACK_TYPE_AUDIO)
    trueHdFormatId = idGenerator.formatId
    if (withCore) {
      idGenerator.generateNewId()
      ac3 = extractorOutput.track(idGenerator.trackId, C.TRACK_TYPE_AUDIO)
      ac3FormatId = idGenerator.formatId
    }
  }

  override fun packetStarted(pesTimeUs: Long, flags: Int) {
    if (pesTimeUs != C.TIME_UNSET) marks.addLast(Mark(splitter.total, pesTimeUs))
  }

  override fun consume(data: ParsableByteArray) {
    val n = data.bytesLeft()
    splitter.push(data.data, data.position, n)
    data.skipBytes(n)
    // A stream that is not laid out as expected shows here and nowhere else: its sound is cut.
    if (splitter.lostSyncCount > lostLogged && lostLogged < MAX_LOGGED) {
      lostLogged = splitter.lostSyncCount
      Log.i("Kinema", "media3: TrueHD stream $pid lost its place ($lostLogged times so far, ${splitter.total} bytes in)")
    }
  }

  override fun endOfInputReached() {
    flushChunk()
  }

  /**
   * The time of the item that starts `offset` bytes into the stream: its
   * PES packet's if it is the first to start in it, else the item before's
   * time and length on. C.TIME_UNSET before any packet has said one.
   */
  private fun timeAt(offset: Long, forAc3: Boolean): Long {
    var mark: Mark? = null
    while (marks.isNotEmpty() && marks.first().offset <= offset) mark = marks.removeFirst()
    val own = if (forAc3) ac3Clock else trueHdClock
    val other = if (forAc3) trueHdClock else ac3Clock
    if (mark != null) {
      own.set(mark.timeUs)
      // The other kind has no time of its own yet: start it from here.
      if (other.markUs == C.TIME_UNSET) other.set(mark.timeUs)
    }
    return own.timeUs(if (forAc3) ac3Format?.sampleRate ?: 0 else rate)
  }

  override fun ac3Frame(data: ByteArray, at: Int, size: Int, streamOffset: Long) {
    val out = ac3 ?: return
    val time = timeAt(streamOffset, true)
    if (time == C.TIME_UNSET) return
    if (ac3Format == null) {
      val info = Ac3Util.parseAc3SyncframeInfo(ParsableBitArray(data.copyOfRange(at, at + size)))
      val format = Format.Builder()
        .setId(ac3FormatId)
        .setContainerMimeType(MimeTypes.VIDEO_MP2T)
        .setSampleMimeType(info.mimeType)
        .setChannelCount(info.channelCount)
        .setSampleRate(info.sampleRate)
        .setLanguage(language)
        .setRoleFlags(roleFlags)
        .setPeakBitrate(info.bitrate)
        // The line in Kinema's track list ends with this.
        .setLabel("Core of the TrueHD track")
        .build()
      out.format(format)
      ac3Format = format
    }
    val bytes = ParsableByteArray(data, at + size)
    bytes.setPosition(at)
    out.sampleData(bytes, size)
    out.sampleMetadata(time, C.BUFFER_FLAG_KEY_FRAME, size, 0, null)
    ac3Clock.samples += Ac3Frame.SAMPLES
  }

  override fun accessUnit(data: ByteArray, at: Int, size: Int, streamOffset: Long, major: Boolean) {
    val out = trueHd ?: return
    // Sound starts at a major sync: nothing before the first one can be played.
    if (!started && !major) return
    val time = timeAt(streamOffset, false)
    if (time == C.TIME_UNSET) return
    if (!started) {
      val info = TrueHdUnit.parseFormat(data, at, size) ?: return
      if (!trueHdFormatGiven) {
        out.format(
          Format.Builder()
            .setId(trueHdFormatId)
            .setContainerMimeType(MimeTypes.VIDEO_MP2T)
            .setSampleMimeType(MimeTypes.AUDIO_TRUEHD)
            .setChannelCount(if (info.channels > 0) info.channels else Format.NO_VALUE)
            .setSampleRate(if (info.sampleRate > 0) info.sampleRate else Format.NO_VALUE)
            .setLanguage(language)
            .setRoleFlags(roleFlags)
            .build()
        )
        trueHdFormatGiven = true
        Log.i("Kinema", "media3: TrueHD stream $pid: ${info.channels} channels, ${info.sampleRate} Hz" + if (ac3 != null) ", with a Dolby Digital core" else "")
      }
      rate = if (info.sampleRate > 0) info.sampleRate else 48000
      unitSamples = info.samplesPerUnit
      started = true
    }
    if (chunkUnits == 0) {
      chunkTimeUs = time
      chunkHasMajor = false
    }
    if (chunkSize + size > chunk.size) chunk = chunk.copyOf(maxOf(chunk.size * 2, chunkSize + size))
    System.arraycopy(data, at, chunk, chunkSize, size)
    chunkSize += size
    chunkUnits++
    if (major) chunkHasMajor = true
    trueHdClock.samples += unitSamples
    if (chunkUnits == CHUNK_UNITS) flushChunk()
  }

  private fun flushChunk() {
    val out = trueHd ?: return
    if (chunkUnits == 0) return
    out.sampleData(ParsableByteArray(chunk, chunkSize), chunkSize)
    out.sampleMetadata(chunkTimeUs, if (chunkHasMajor) C.BUFFER_FLAG_KEY_FRAME else 0, chunkSize, 0, null)
    chunkSize = 0
    chunkUnits = 0
  }

  private companion object {
    /** Access units per sample, as Media3 gives them from Matroska (Ac3Util.TRUEHD_RECHUNK_SAMPLE_COUNT). */
    const val CHUNK_UNITS = Ac3Util.TRUEHD_RECHUNK_SAMPLE_COUNT
    const val SAMPLES_AT_48K = 40
    const val MAX_LOGGED = 8
  }
}
