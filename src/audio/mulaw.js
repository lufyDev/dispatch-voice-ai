/**
 * G.711 mu-law codec.
 *
 * mu-law squeezes a 14-bit linear sample into 8 bits by spending its bits
 * logarithmically: fine resolution near silence, coarse resolution when loud.
 * Your ear works the same way, which is why it sounds better than you'd expect
 * from throwing away 6 bits.
 *
 * The shape of an encoded byte:
 *
 *     S EEE MMMM
 *     | |   |
 *     | |   +-- mantissa: position within the segment
 *     | +------ exponent: which power-of-two segment (8 of them)
 *     +-------- sign
 *
 * ...and then the whole byte is bitwise-inverted, a 1960s trick so that silence
 * encodes as 0xFF. Long runs of 1-bits kept the analogue repeaters on a copper
 * trunk line happy. We are still paying this tax in 2026.
 *
 * Written by hand rather than pulled from npm: it's the format under every phone
 * call, and it's 40 lines.
 */

const BIAS = 0x84; // 132. Added before encoding so small values land in segment 0.
const CLIP = 8159; // max magnitude representable in 14-bit mu-law space

// Upper bound of each of the 8 exponent segments, in 14-BIT space -- the encoder
// shifts the 16-bit sample right by 2 before it gets here. Writing this table in
// 16-bit space (every entry 4x too big) is a real and nasty bug: the encoder
// picks a segment that is too low, and the result is not silence or a crash but
// recognisable-yet-distorted speech. It passes a casual listen and ships.
const SEG_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

/** One 16-bit linear sample -> one mu-law byte. */
export function encodeSample(pcm) {
  let val = pcm >> 2; // 16-bit -> 14-bit; mu-law only ever had 14 bits of input
  let mask;

  if (val < 0) {
    val = -val;
    mask = 0x7f; // negative: invert everything except the sign bit
  } else {
    mask = 0xff;
  }

  if (val > CLIP) val = CLIP;
  val += BIAS >> 2;

  let seg = 0;
  while (seg < 8 && val > SEG_END[seg]) seg += 1;
  if (seg >= 8) return 0x7f ^ mask;

  return ((seg << 4) | ((val >> (seg + 1)) & 0x0f)) ^ mask;
}

/** One mu-law byte -> one 16-bit linear sample. */
export function decodeSample(u) {
  const inv = ~u & 0xff;
  let t = ((inv & 0x0f) << 3) + BIAS;
  t <<= (inv & 0x70) >> 4;
  return (inv & 0x80) ? BIAS - t : t - BIAS;
}

/** mu-law buffer -> 16-bit signed little-endian PCM buffer (2x the bytes). */
export function decode(mulawBuf) {
  const pcm = Buffer.allocUnsafe(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i += 1) {
    pcm.writeInt16LE(decodeSample(mulawBuf[i]), i * 2);
  }
  return pcm;
}

/** 16-bit signed little-endian PCM buffer -> mu-law buffer (half the bytes). */
export function encode(pcmBuf) {
  const out = Buffer.allocUnsafe(pcmBuf.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = encodeSample(pcmBuf.readInt16LE(i * 2));
  }
  return out;
}
