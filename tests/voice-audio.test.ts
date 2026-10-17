import test from "node:test";
import assert from "node:assert/strict";
import { mulawDecodeSample, mulawEncodeSample, MulawToPcm16k, Pcm24kToMulaw } from "../src/lib/voice/audio.ts";

test("mu-law round trip stays close to the original sample", () => {
  for (const s of [0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]) {
    const back = mulawDecodeSample(mulawEncodeSample(s));
    assert.ok(Math.abs(back - s) <= Math.max(64, Math.abs(s) * 0.05), `${s} -> ${back}`);
  }
});

test("8k mu-law becomes 16k pcm (4 bytes out per byte in)", () => {
  const out = new MulawToPcm16k().convert(Buffer.alloc(160, 0xff));
  assert.equal(out.length, 640);
});

test("24k pcm becomes 8k mu-law, carrying a partial group across chunks", () => {
  const c = new Pcm24kToMulaw();
  const a = c.convert(Buffer.alloc(10)); // 5 samples -> 1 out, 2 carried
  const b = c.convert(Buffer.alloc(2)); // +1 sample -> completes the group
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test("downsampler removes content above the phone band and keeps speech-band tone", () => {
  const rms = (hz: number) => {
    const n = 2400; // 100 ms at 24 kHz
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / 24000)), i * 2);
    const out = new Pcm24kToMulaw().convert(b);
    let e = 0;
    for (let i = 20; i < out.length; i++) e += mulawDecodeSample(out[i]) ** 2;
    return Math.sqrt(e / (out.length - 20));
  };
  assert.ok(rms(1000) > 5000, "1 kHz tone passes");
  assert.ok(rms(9000) < 500, "9 kHz tone is filtered out");
});
