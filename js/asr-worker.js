// Whisper（transformers.js）をブラウザ内で動かすワーカー。モデルは初回だけ Hugging Face から取得し、
// 以後は Cache Storage（transformers-cache）から読むのでオフラインでも動く。
import { pipeline, env } from "../vendor/transformers-3.8.1/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/transformers-3.8.1/", import.meta.url).href;

let asr = null;
let loaded = "";

async function load({ model, device, mobile }) {
  const key = `${model}|${device}`;
  if (asr && loaded === key) return;
  if (asr) await asr.dispose?.();
  asr = null;
  // 端末によってはスレッド数が多いとメモリ不足で落ちるため、スマホは 1 スレッド。
  if (mobile) env.backends.onnx.wasm.numThreads = 1;
  const dtype = device === "webgpu"
    ? { encoder_model: model.includes("large") ? "fp16" : "fp32", decoder_model_merged: "q4" }
    : { encoder_model: "q8", decoder_model_merged: "q8" };
  const progress = {};
  asr = await pipeline("automatic-speech-recognition", model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.total) return;
      progress[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(progress).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      postMessage({ type: "download", loaded: l, total: t });
    },
  });
  loaded = key;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      await load(data);
      postMessage({ type: "loaded", id: data.id });
    } else if (data.type === "run") {
      const out = await asr(data.audio, {
        language: "japanese",
        task: "transcribe",
        return_timestamps: true,
        no_repeat_ngram_size: 6,
      });
      postMessage({ type: "result", id: data.id, text: out.text, chunks: out.chunks ?? [] });
    }
  } catch (e) {
    postMessage({ type: "error", id: data.id, message: String(e?.message ?? e) });
  }
};
