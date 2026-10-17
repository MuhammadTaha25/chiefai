/**
 * Telephony <-> Gemini audio conversion. Pure functions, no I/O.
 *
 * Twilio Media Streams speak 8 kHz G.711 mu-law. Gemini Live takes 16 kHz
 * 16-bit little-endian PCM in and returns 24 kHz PCM out. This module is the
 * whole translation layer between the two.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function mulawDecodeSample(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

export function mulawEncodeSample(pcm: number): number {
  let sign = 0;
  if (pcm < 0) {
    pcm = -pcm;
    sign = 0x80;
  }
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Twilio mu-law 8 kHz (bytes) -> PCM16 16 kHz (little-endian bytes) for Gemini. */
export class MulawToPcm16k {
  private prev = 0;

  convert(mulaw: Buffer): Buffer {
    const out = Buffer.alloc(mulaw.length * 4);
    for (let i = 0; i < mulaw.length; i++) {
      const cur = mulawDecodeSample(mulaw[i]);
      // Linear interpolation: 8k -> 16k inserts one midpoint per sample.
      out.writeInt16LE(Math.round((this.prev + cur) / 2), i * 4);
      out.writeInt16LE(cur, i * 4 + 2);
      this.prev = cur;
    }
    return out;
  }
}

const TAPS = 31;
/** Windowed-sinc low-pass, cutoff 3.6 kHz at 24 kHz: removes everything above the phone band before 3:1 decimation. */
const LOWPASS: number[] = (() => {
  const fc = 3600 / 24000;
  const m = (TAPS - 1) / 2;
  const h = Array.from({ length: TAPS }, (_, k) => {
    const x = k - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (TAPS - 1)));
  });
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / sum);
})();

/** Gemini PCM16 24 kHz (little-endian bytes) -> Twilio mu-law 8 kHz. Handles chunks that do not align to 3 samples. */
export class Pcm24kToMulaw {
  // Filter history (TAPS-1 samples) followed by samples not yet consumed.
  private buf: number[] = new Array(TAPS - 1).fill(0);

  convert(pcm: Buffer): Buffer {
    const buf = this.buf;
    for (let i = 0; i + 1 < pcm.length; i += 2) buf.push(pcm.readInt16LE(i));
    const outs: number[] = [];
    let pos = TAPS - 1;
    while (pos + 3 <= buf.length) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += LOWPASS[k] * buf[pos + 2 - k];
      outs.push(mulawEncodeSample(Math.max(-32768, Math.min(32767, Math.round(acc)))));
      pos += 3;
    }
    this.buf = buf.slice(pos - (TAPS - 1));
    return Buffer.from(outs);
  }
}
