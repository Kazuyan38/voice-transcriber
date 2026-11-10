// 文字起こしの制御（メインスレッド側）。録音を 16kHz モノラルに直し、静かな箇所で 20〜30 秒に区切ってワーカーへ渡す。
// 区切りごとに途中経過を IndexedDB に残すので、タブを閉じても続きから再開できる。
import * as store from "./store.js";

const SR = 16000;
const MIN_WIN = 20, MAX_WIN = 29.5;
const SILENCE_RMS = 0.004;
const SETTINGS_KEY = "vt.asr";

export const MODELS = [
  { id: "onnx-community/whisper-base", label: "標準（約 80MB・スマホ向け）" },
  { id: "onnx-community/whisper-small", label: "高精度（約 250MB・PC 向け）" },
  { id: "onnx-community/whisper-large-v3-turbo", label: "最高精度（約 1GB・WebGPU 対応 PC 向け）" },
];

export const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));

export function settings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}; } catch { /* 既定値で続行 */ }
  return { model: s.model ?? (isMobile() ? MODELS[0].id : MODELS[1].id), auto: s.auto ?? true };
}
export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings(), ...s }));
}

export const status = new EventTarget();
const emit = (detail) => status.dispatchEvent(new CustomEvent("change", { detail }));

let worker = null;
let seq = 0;
const waiting = new Map();
let deviceCache = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "download") {
      emit({ phase: "download", progress: data.total ? data.loaded / data.total : 0, loaded: data.loaded, total: data.total });
      return;
    }
    const w = waiting.get(data.id);
    if (!w) return;
    waiting.delete(data.id);
    data.type === "error" ? w.reject(new Error(data.message)) : w.resolve(data);
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || "worker error"));
    waiting.clear();
    worker = null;
  };
  return worker;
}

function ask(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

async function pickDevice() {
  if (deviceCache) return deviceCache;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    deviceCache = adapter ? "webgpu" : "wasm";
  } catch {
    deviceCache = "wasm";
  }
  return deviceCache;
}

async function ensureModel() {
  const { model } = settings();
  let device = await pickDevice();
  if (model.includes("large") && device !== "webgpu") throw new Error("最高精度モデルは WebGPU 対応ブラウザが必要です。設定でモデルを変更してください。");
  emit({ phase: "loading" });
  try {
    await ask({ type: "load", model, device, mobile: isMobile() });
  } catch (e) {
    if (device !== "webgpu") throw e;
    // WebGPU の初期化に失敗する端末がある。WASM で取り直す。
    deviceCache = device = "wasm";
    await ask({ type: "load", model, device, mobile: isMobile() });
  }
  return { model, device };
}

// 事前ダウンロード（オフラインで使う前に）
export async function preload() {
  await ensureModel();
  emit({ phase: "idle" });
}

async function decode(blob) {
  const buf = await blob.arrayBuffer();
  let audio;
  try {
    audio = await new OfflineAudioContext(1, SR, SR).decodeAudioData(buf.slice(0));
  } catch {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try { audio = await ctx.decodeAudioData(buf); } finally { ctx.close().catch(() => {}); }
  }
  let mono = audio.getChannelData(0);
  if (audio.numberOfChannels > 1) {
    mono = new Float32Array(mono);
    for (let c = 1; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i];
    }
    for (let i = 0; i < mono.length; i++) mono[i] /= audio.numberOfChannels;
  }
  return audio.sampleRate === SR ? mono : resample(mono, audio.sampleRate, SR);
}

function resample(x, from, to) {
  const n = Math.floor(x.length * to / from);
  const y = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r, j = Math.floor(p), f = p - j;
    y[i] = x[j] * (1 - f) + (x[j + 1] ?? x[j]) * f;
  }
  return y;
}

function rms(x, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

// start 秒から始まる区間の終わりを、MIN_WIN〜MAX_WIN 秒のうち最も静かな 0.1 秒の位置に置く。
export function windowEnd(x, start) {
  const total = x.length / SR;
  if (total - start <= MAX_WIN) return total;
  const frame = SR / 10;
  let best = start + MAX_WIN, bestE = Infinity;
  for (let t = start + MIN_WIN; t <= start + MAX_WIN; t += 0.1) {
    const a = Math.floor(t * SR);
    const e = rms(x, a, a + frame);
    if (e < bestE) { bestE = e; best = t + 0.05; }
  }
  return best;
}

// 無音区間で Whisper がよく出す定型の幻聴
const HALLUCINATIONS = [/^ご視聴ありがとうございました。?$/, /^チャンネル登録.*$/, /^字幕.*$/, /^おやすみなさい。?$/, /^\(.*\)$/, /^（.*）$/, /^♪+$/];
export function clean(text) {
  const t = text.trim();
  if (!t || HALLUCINATIONS.some((re) => re.test(t))) return "";
  // 同じ語の暴走的な繰り返しを 1 回に畳む（例: 「はいはいはいはい…」が 10 回以上）
  return t.replace(/(.{1,8}?)\1{9,}/g, "$1");
}

let queue = [];
let running = false;
let current = null;

export const currentId = () => current;
export const isQueued = (id) => queue.includes(id);
export function enqueue(id) {
  if (!queue.includes(id) && current !== id) queue.push(id);
  run();
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      current = queue.shift();
      try {
        await transcribe(current);
      } catch (e) {
        console.error(e);
        await store.patch(current, { transcript_status: "failed", asr_error: String(e.message ?? e) });
      }
    }
  } finally {
    current = null;
    running = false;
    emit({ phase: "idle" });
  }
}

async function transcribe(id) {
  const rec = await store.get(id);
  if (!rec || rec.deleted_at || rec.transcript_status === "done") return;
  const blob = await store.getAudio(id);
  if (!blob) throw new Error("この端末に音声がありません。");
  await store.patch(id, { asr_error: null, asr: rec.asr ?? { next: 0, segments: [] } });
  emit({ phase: "loading", id });
  await ensureModel();
  emit({ phase: "decoding", id });
  const x = await decode(blob);
  const total = x.length / SR;
  let { next, segments } = (await store.get(id)).asr;

  while (next < total - 0.3) {
    const cur = await store.get(id);
    if (!cur || cur.deleted_at) return;
    const end = windowEnd(x, next);
    const a = Math.floor(next * SR), b = Math.min(x.length, Math.floor(end * SR));
    if (rms(x, a, b) >= SILENCE_RMS) {
      const slice = x.slice(a, b);
      const out = await ask({ type: "run", audio: slice }, [slice.buffer]);
      const parts = out.chunks.length ? out.chunks : [{ timestamp: [0, end - next], text: out.text }];
      for (const c of parts) {
        const text = clean(c.text);
        if (text) segments.push({ t: Math.round((next + (c.timestamp?.[0] ?? 0)) * 10) / 10, text });
      }
    }
    next = end;
    await store.patch(id, { asr: { next, segments } }); // 端末内だけの途中経過（未送信にはしない）
    emit({ phase: "running", id, progress: Math.min(1, next / total) });
  }

  await store.patch(id, {
    segments,
    transcript: segments.map((s) => s.text).join("\n"),
    transcript_status: "done",
    duration_sec: rec.duration_sec || total,
  });
  await store.patch(id, { asr: null });
}
