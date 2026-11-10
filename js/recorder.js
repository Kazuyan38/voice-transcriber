// MediaRecorder による録音。5 秒ごとの断片を IndexedDB に書き、停止時に 1 ファイルへまとめる。
import * as store from "./store.js";

const SLICE_MS = 5000;
const BITRATE = 32000; // 会話には十分。1 時間 ≈ 14MB（無料枠の 50MB/ファイルで約 3.5 時間）

function pickMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
  return candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) ?? "";
}

export const supported = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

export class Recording {
  constructor(id) {
    this.id = id;
    this.seq = 0;
    this.parts = [];
    this.elapsedBefore = 0;   // 一時停止までに経過した ms
    this.startedAt = 0;
    this.paused = false;
    this.writes = Promise.resolve();
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mime = pickMime();
    this.rec = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: BITRATE });
    this.mime = this.rec.mimeType || mime || "audio/webm";
    this.rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      this.parts.push(e.data);
      const seq = this.seq++;
      this.writes = this.writes.then(() => store.addChunk(this.id, seq, e.data, { mime: this.mime, at: Date.now() })).catch(() => {});
    };

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);

    this.rec.start(SLICE_MS);
    this.startedAt = performance.now();
    this.lockScreen();
    this.onVisible = () => { if (document.visibilityState === "visible") this.lockScreen(); };
    document.addEventListener("visibilitychange", this.onVisible);
  }

  async lockScreen() {
    try { this.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* 非対応・省電力モード */ }
  }

  get elapsedMs() {
    return this.elapsedBefore + (this.paused ? 0 : performance.now() - this.startedAt);
  }

  // 0..1 の入力レベル（RMS をざっくり対数化）
  level() {
    if (!this.analyser || this.paused) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    const rms = Math.sqrt(sum / this.buf.length);
    return Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 60) / 50));
  }

  pause() {
    if (this.paused || this.rec.state !== "recording") return;
    this.rec.pause();
    this.elapsedBefore += performance.now() - this.startedAt;
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.rec.resume();
    this.startedAt = performance.now();
    this.paused = false;
  }

  async stop() {
    const duration = this.elapsedMs / 1000;
    const stopped = new Promise((resolve) => { this.rec.onstop = resolve; });
    if (this.rec.state !== "inactive") this.rec.stop();
    await stopped;
    await this.writes;
    this.release();
    return { blob: new Blob(this.parts, { type: this.mime }), mime: this.mime, duration };
  }

  async cancel() {
    if (this.rec && this.rec.state !== "inactive") {
      const stopped = new Promise((resolve) => { this.rec.onstop = resolve; });
      this.rec.stop();
      await stopped;
    }
    await this.writes;
    this.release();
    await store.clearChunks(this.id);
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.wakeLock?.release().catch(() => {});
    document.removeEventListener("visibilitychange", this.onVisible);
  }
}

// 前回の録音中にタブが落ちた場合、残った断片から録音を復元する。
export async function recoverOrphans() {
  const recovered = [];
  for (const id of await store.chunkIds()) {
    const chunks = (await store.chunksOf(id)).sort((a, b) => a.seq - b.seq);
    if (!chunks.length) continue;
    const existing = await store.get(id);
    if (existing?.has_audio && !existing.recording) {
      await store.clearChunks(id);
      continue;
    }
    const mime = chunks[0].mime;
    const blob = new Blob(chunks.map((c) => c.blob), { type: mime });
    await store.putAudio(id, blob);
    const fields = { mime, has_audio: true, recording: false, duration_sec: chunks.length * (SLICE_MS / 1000) };
    if (existing) await store.patch(id, fields);
    else await store.put(store.newRecord({ id, title: "", recorded_at: new Date(chunks[0].at - SLICE_MS).toISOString(), ...fields }));
    await store.clearChunks(id);
    recovered.push(id);
  }
  return recovered;
}
