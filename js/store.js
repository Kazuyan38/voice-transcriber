// 端末内の正本（IndexedDB）。録音・文字起こしはオフラインでもここに確定し、同期は後から追いつく。
//   recs   … 録音のメタデータと文字起こし（keyPath id）
//   audio  … 録音ファイル本体（key = 録音 id）
//   chunks … 録音中の断片（[id, seq]）。録音中にタブが落ちても復元できるように 5 秒ごとに書く
//   kv     … 同期カーソルなど

const DB_NAME = "voice-transcriber";
const DB_VERSION = 1;

// サーバ側の列のうち、端末が書く列。これが変わると dirty（未送信）になる。
export const CLIENT_FIELDS = ["title", "recorded_at", "duration_sec", "mime", "audio_path", "transcript", "segments", "transcript_status", "deleted_at"];

export const events = new EventTarget();
// dirty=true の変更だけが同期を起こす（同期自身の書き込みで同期が再起動し続けないように）。
const changed = (id, dirty = false) => events.dispatchEvent(new CustomEvent("change", { detail: { id, dirty: Boolean(dirty) } }));

let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("recs", { keyPath: "id" });
      d.createObjectStore("audio");
      d.createObjectStore("chunks", { keyPath: ["id", "seq"] });
      d.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(stores, mode, fn) {
  const t = (await db()).transaction(stores, mode);
  const result = await fn(...[].concat(stores).map((s) => t.objectStore(s)));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result;
}

export const all = () => tx("recs", "readonly", (s) => done(s.getAll()));
export const get = (id) => tx("recs", "readonly", (s) => done(s.get(id)));

export async function put(rec) {
  await tx("recs", "readwrite", (s) => done(s.put(rec)));
  changed(rec.id, rec.dirty);
  return rec;
}

// 一度も送信していない録音（破棄した録音など）を跡形なく消す。
export async function remove(id) {
  await tx(["recs", "audio"], "readwrite", (recs, audio) => Promise.all([done(recs.delete(id)), done(audio.delete(id))]));
  await clearChunks(id);
  changed(id);
}

// 端末側の変更。CLIENT_FIELDS に触れたら rev を進めて未送信にする（送信中に再変更されても取りこぼさない）。
export async function patch(id, fields) {
  const rec = await tx("recs", "readwrite", async (s) => {
    const cur = await done(s.get(id));
    if (!cur) return null;
    const next = { ...cur, ...fields };
    if (CLIENT_FIELDS.some((k) => k in fields)) {
      next.rev = (cur.rev ?? 0) + 1;
      next.dirty = true;
    }
    await done(s.put(next));
    return next;
  });
  if (rec) changed(id, rec.dirty);
  return rec;
}

export async function putAudio(id, blob) {
  await tx("audio", "readwrite", (s) => done(s.put(blob, id)));
}
export const getAudio = (id) => tx("audio", "readonly", (s) => done(s.get(id)));
export async function deleteAudio(id) {
  await tx("audio", "readwrite", (s) => done(s.delete(id)));
}

export async function addChunk(id, seq, blob, meta) {
  await tx("chunks", "readwrite", (s) => done(s.put({ id, seq, blob, ...meta })));
}
export async function chunksOf(id) {
  return tx("chunks", "readonly", (s) => done(s.getAll(IDBKeyRange.bound([id, 0], [id, Infinity]))));
}
export async function clearChunks(id) {
  await tx("chunks", "readwrite", (s) => done(s.delete(IDBKeyRange.bound([id, 0], [id, Infinity]))));
}
export async function chunkIds() {
  const keys = await tx("chunks", "readonly", (s) => done(s.getAllKeys()));
  return [...new Set(keys.map((k) => k[0]))];
}

export const kvGet = (k) => tx("kv", "readonly", (s) => done(s.get(k)));
export async function kvSet(k, v) {
  await tx("kv", "readwrite", (s) => done(s.put(v, k)));
}

// ログアウト時・別アカウントでのログイン時に端末内のデータを消す。
export async function wipe() {
  await tx(["recs", "audio", "chunks", "kv"], "readwrite", async (...stores) => {
    for (const s of stores) await done(s.clear());
  });
  changed(null);
}

// 題名を付けなかった録音の既定の題名「11月11日 14:30」（録音を始めた日時）
export function defaultTitle(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function newRecord(fields) {
  const rec = {
    id: crypto.randomUUID(),
    recorded_at: new Date().toISOString(),
    duration_sec: 0,
    mime: null,
    audio_path: null,
    has_audio: false,         // この端末に音声本体があるか
    transcript: null,
    segments: null,
    transcript_status: "pending",
    asr: null,                // 文字起こしの途中経過 { next: 秒, segments: [...] }（端末内だけ）
    asr_error: null,
    minutes: null,
    minutes_at: null,
    deleted_at: null,
    updated_at: null,
    rev: 1,
    dirty: true,
    ...fields,
  };
  rec.title ??= defaultTitle(rec.recorded_at); // サーバ由来の行は title を持つので、空でもそのまま
  return rec;
}
