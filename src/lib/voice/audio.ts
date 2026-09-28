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

/** Gemini PCM16 24 kHz (little-endian bytes) -> Twilio mu-law 8 kHz. Handles chunks that do not align to 3 samples. */
export class Pcm24kToMulaw {
  private carry: number[] = [];

  convert(pcm: Buffer): Buffer {
    const samples: number[] = this.carry;
    this.carry = [];
    for (let i = 0; i + 1 < pcm.length; i += 2) samples.push(pcm.readInt16LE(i));
    const usable = samples.length - (samples.length % 3);
    const out = Buffer.alloc(usable / 3);
    for (let i = 0, o = 0; i < usable; i += 3, o++) {
      // Box filter over 3 samples = cheap anti-alias before the 3:1 decimation.
      out[o] = mulawEncodeSample(Math.round((samples[i] + samples[i + 1] + samples[i + 2]) / 3));
    }
    this.carry = samples.slice(usable);
    return out;
  }
}
