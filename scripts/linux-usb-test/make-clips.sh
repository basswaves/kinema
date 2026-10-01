#!/usr/bin/env bash
# Generated test media for the Linux stick: no personal files, a pattern and a tone.
# Written to $KIT_MEDIA (default ~/kinema-kit/media).
set -eu
out="${KIT_MEDIA:-$HOME/kinema-kit/media}"; mkdir -p "$out"; cd "$out"
tone="sine=frequency=440:sample_rate=48000,volume=-20dB"
rate=24000/1001

# HDR10: 4K, HEVC Main10, PQ / BT.2020 with mastering metadata, 23.976 fps.
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=3840x2160:rate=$rate" -f lavfi -i "$tone" -t 15 \
  -vf format=yuv420p10le -c:v libx265 -preset ultrafast -crf 26 \
  -x265-params "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400:hdr10=1:log-level=error" \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -c:a ac3 -b:a 192k -ac 2 hdr10-2160p23.976.mkv

# One clip per bitstream format: 1080p H.264, 5.1 sound in that format.
for fmt in truehd eac3 dts ac3; do
  extra=""; [ "$fmt" = truehd ] || [ "$fmt" = dts ] && extra="-strict -2"
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=$rate" -f lavfi -i "$tone" -t 12 \
    -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p \
    -af "pan=5.1(side)|FL=c0|FR=c0|FC=c0|LFE=c0|SL=c0|SR=c0" -c:a "$fmt" $extra "sound-$fmt.mkv"
done
ls -la "$out"
for f in *.mkv; do echo "== $f"; ffprobe -v error -show_entries stream=codec_name,profile,width,height,pix_fmt,color_transfer,channels,channel_layout -of compact "$f"; done
