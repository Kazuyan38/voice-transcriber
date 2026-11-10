// 文字起こしの制御（メインスレッド側）。録音を 16kHz モノラルに直し、静かな箇所で 20〜30 秒に区切ってワーカーへ渡す。
// 区切りごとに途中経過を IndexedDB に残すので、タブを閉じても続きから再開できる。
import * as store from "./store.js";

const SR = 16000;
const MIN_WIN = 20, MAX_WIN = 29.5;
const SILENCE_RMS = 0.004;
const SETTINGS_KEY = "vt.asr";

// スマホでこの長さを超える録音は自動で文字起こしを始めない（全体を一度にメモリへ展開するため）。実機で計測して調整する仮の値。
export const MOBILE_AUTO_MAX_SEC = 45 * 60;

export const MODELS = [
  { id: "onnx-community/whisper-base", short: "標準", label: "標準（約 80MB・スマホ向け）" },
  { id: "onnx-community/whisper-small", short: "高精度", label: "高精度（約 250MB・PC 向け）" },
  { id: "onnx-community/whisper-large-v3-turbo", short: "最高精度", label: "最高精度（約 1GB・WebGPU 対応 PC 向け）" },
];

export const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
export const exceedsAuto = (r) => isMobile() && (r.duration_sec ?? 0) > MOBILE_AUTO_MAX_SEC;

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
  // スマホの WebGPU は、モデル取得の直後（GPU 側へ展開する段階）でページごと落ちる例がある。スマホは WASM に固定する。
  if (isMobile()) return (deviceCache = "wasm");
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    deviceCache = adapter ? "webgpu" : "wasm";
  } catch {
    deviceCache = "wasm";
  }
  return deviceCache;
}

// WASM のメモリは増えるだけで縮まないため、長い録音では一定区間ごとにワーカーごと作り直して解放する。
const RECYCLE_EVERY = 30; // 区間数（1 区間 ≒ 25 秒）
function recycleWorker() {
  worker?.terminate();
  worker = null;
  waiting.clear();
}

async function ensureModel(model = settings().model) {
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
  // iOS はページのメモリ上限を超えると「問題が繰り返し起きた」で再読み込みされる。全体の複製を持たないようにする。
  let audio;
  try {
    audio = await new OfflineAudioContext(1, SR, SR).decodeAudioData(await blob.arrayBuffer());
  } catch {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try { audio = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close().catch(() => {}); }
  }
  const mono = audio.getChannelData(0); // AudioBuffer の実体を直接書き換えて平均する（複製しない）
  if (audio.numberOfChannels > 1) {
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
const redo = new Map(); // 完了済みの録音を別モデルでやり直すもの（id → モデル）
let wakeLock = null;

// 実行中の録音 id を控え、正常終了・失敗で消す。起動時に残っていれば前回はブラウザごと落ちている。
const RUN_KEY = "vt.asr.run";
export function takeCrashed() {
  let id = null;
  try { id = localStorage.getItem(RUN_KEY); localStorage.removeItem(RUN_KEY); } catch { /* なし扱い */ }
  return id;
}
const markRun = (id) => { try { id ? localStorage.setItem(RUN_KEY, id) : localStorage.removeItem(RUN_KEY); } catch { /* 検知できないだけ */ } };

export const currentId = () => current;
export const isQueued = (id) => queue.includes(id);
// model を渡すと、完了済みの録音でもそのモデルで最初からやり直す（完了まで元の文字起こしは残る）
export function enqueue(id, model) {
  if (model) redo.set(id, model);
  if (!queue.includes(id) && current !== id) queue.push(id);
  run();
}

// 文字起こし中は画面スリープで処理が止まらないようにする（タブが隠れると解除されるので戻ったら取り直す）
async function holdScreen() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* 非対応・省電力モード */ }
}
document.addEventListener("visibilitychange", () => {
  if (running && document.visibilityState === "visible" && (!wakeLock || wakeLock.released)) holdScreen();
});

async function run() {
  if (running) return;
  running = true;
  await holdScreen();
  try {
    while (queue.length) {
      current = queue.shift();
      markRun(current);
      try {
        await transcribe(current);
      } catch (e) {
        console.error(e);
        const message = String(e.message ?? e);
        // やり直しの失敗で、残してある元の文字起こしを「失敗」にしない
        const keep = (await store.get(current))?.transcript_status === "done";
        await store.patch(current, keep ? { asr_error: message } : { transcript_status: "failed", asr_error: message });
      }
    }
  } finally {
    current = null;
    markRun(null);
    running = false;
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    emit({ phase: "idle" });
  }
}

async function transcribe(id) {
  const rec = await store.get(id);
  const model = redo.get(id);
  redo.delete(id);
  if (!rec || rec.deleted_at || (rec.transcript_status === "done" && !model)) return;
  const blob = await store.getAudio(id);
  if (!blob) throw new Error("この端末に音声がありません。");
  await store.patch(id, { asr_error: null, asr: model ? { next: 0, segments: [] } : rec.asr ?? { next: 0, segments: [] } });
  emit({ phase: "loading", id });
  const used = (await ensureModel(model)).model;
  emit({ phase: "decoding", id });
  const x = await decode(blob);
  const total = x.length / SR;
  let { next, segments } = (await store.get(id)).asr;
  const t0 = performance.now(), from = next;
  let windows = 0;

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
    // 残り時間は、今回処理した分の実測から。60 秒分に満たないうちは当てにならないので出さない。
    const eta = next - from >= 60 ? ((performance.now() - t0) / 1000 / (next - from)) * (total - next) : null;
    emit({ phase: "running", id, progress: Math.min(1, next / total), eta });
    if (++windows % RECYCLE_EVERY === 0 && next < total - 0.3) {
      recycleWorker();
      await ensureModel(used);
    }
  }

  await store.patch(id, {
    asr_model: used,
    segments,
    transcript: segments.map((s) => s.text).join("\n"),
    transcript_status: "done",
    duration_sec: rec.duration_sec || total,
  });
  await store.patch(id, { asr: null });
}
