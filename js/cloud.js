// Supabase（Auth / PostgREST / Storage）を fetch で直接叩く。SDK を入れないのはオフライン同梱と軽さのため。
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import * as store from "./store.js";

const SESSION_KEY = "vt.session";
const MODE_KEY = "vt.mode"; // "cloud" | "local"
const AUDIO_LIMIT = 50 * 1024 * 1024; // Supabase 無料枠の 1 ファイル上限

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);
export const mcpUrlBase = configured ? `${SUPABASE_URL}/functions/v1/mcp` : "";

export const status = new EventTarget();
let state = { phase: "idle", error: null, lastSync: null, pending: 0 };
const setState = (s) => {
  state = { ...state, ...s };
  status.dispatchEvent(new CustomEvent("change", { detail: state }));
};
export const syncState = () => state;

// ---------- セッション ----------

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
let session = readSession();
export const currentUser = () => session?.user ?? null;
export const mode = () => localStorage.getItem(MODE_KEY) ?? (session ? "cloud" : null);
export const needsRelogin = () => mode() === "cloud" && session?.expired === true;

function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

function fromAuthResponse(j) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600),
    user: { id: j.user.id, email: j.user.email },
  };
}

async function authFetch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(authMessage(j));
  return j;
}

function authMessage(j) {
  const code = j.error_code ?? j.code ?? j.error ?? "";
  const map = {
    invalid_credentials: "メールアドレスまたはパスワードが違います。",
    invalid_grant: "メールアドレスまたはパスワードが違います。",
    email_not_confirmed: "メールアドレスの確認が済んでいません。届いたメールのリンクを開いてください。",
    user_already_exists: "このメールアドレスは登録済みです。ログインしてください。",
    weak_password: "パスワードが短すぎます（8 文字以上）。",
    over_email_send_rate_limit: "確認メールの送信回数が上限に達しました。しばらく待ってから再度お試しください。",
    over_request_rate_limit: "試行回数が多すぎます。しばらく待ってから再度お試しください。",
    validation_failed: "メールアドレスの形式が正しくありません。",
  };
  return map[code] ?? j.msg ?? j.error_description ?? j.message ?? "認証に失敗しました。";
}

// 端末内のデータが別アカウントのものなら消してから入る（ログインしていない「この端末だけ」のデータは引き継ぐ）。
async function adopt(newSession) {
  const owner = await store.kvGet("owner");
  if (owner && owner !== newSession.user.id) await store.wipe();
  await store.kvSet("owner", newSession.user.id);
  saveSession(newSession);
  localStorage.setItem(MODE_KEY, "cloud");
}

export async function signIn(email, password) {
  await adopt(fromAuthResponse(await authFetch("token?grant_type=password", { email, password })));
}

// 戻り値 true = 即ログイン済み / false = 確認メール待ち
export async function signUp(email, password) {
  const redirect = location.origin + location.pathname;
  const j = await authFetch(`signup?redirect_to=${encodeURIComponent(redirect)}`, { email, password });
  if (j.access_token) {
    await adopt(fromAuthResponse(j));
    return true;
  }
  return false;
}

// 確認メールのリンクから戻ってきたとき（#access_token=... 付き）
export async function consumeRedirect() {
  if (!location.hash.includes("access_token=")) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  const access_token = p.get("access_token");
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) return false;
  const user = await res.json();
  await adopt({
    access_token,
    refresh_token: p.get("refresh_token"),
    expires_at: Number(p.get("expires_at")) || Math.floor(Date.now() / 1000) + Number(p.get("expires_in") || 3600),
    user: { id: user.id, email: user.email },
  });
  return true;
}

export function useLocalOnly() {
  localStorage.setItem(MODE_KEY, "local");
}

export async function signOut() {
  const s = session;
  saveSession(null);
  localStorage.removeItem(MODE_KEY);
  await store.wipe();
  if (s && navigator.onLine) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => {});
  }
}

let refreshing = null;
async function accessToken() {
  if (!session || session.expired) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (res.status === 400 || res.status === 401) {
        // リフレッシュトークンが失効。端末内のデータは残し、再ログインを促す。
        saveSession({ ...session, expired: true });
        setState({ phase: "error", error: "ログインの有効期限が切れました。再ログインしてください。" });
        return null;
      }
      if (!res.ok) throw new Error(`refresh ${res.status}`);
      saveSession(fromAuthResponse(await res.json()));
      return session.access_token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function api(path, init = {}) {
  const token = await accessToken();
  if (!token) throw new Error("not_signed_in");
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  return res;
}

// ---------- MCP トークン ----------

export async function issueMcpToken() {
  const res = await api("/rest/v1/rpc/issue_mcp_token", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return `${mcpUrlBase}?key=${await res.json()}`;
}
export async function revokeMcpToken() {
  await api("/rest/v1/rpc/revoke_mcp_token", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}
export async function mcpTokenStatus() {
  const res = await api("/rest/v1/rpc/mcp_token_status", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return (await res.json())[0] ?? null;
}

// ---------- 音声 ----------

const extOf = (mime) => (mime?.includes("mp4") ? "m4a" : mime?.includes("ogg") ? "ogg" : "webm");

export async function downloadAudio(rec) {
  const res = await api(`/storage/v1/object/authenticated/audio/${rec.audio_path}`);
  const blob = await res.blob();
  return rec.mime ? new Blob([blob], { type: rec.mime }) : blob;
}

// ---------- 同期 ----------

const toServer = (r) => Object.fromEntries(store.CLIENT_FIELDS.map((k) => [k, r[k] ?? null]).concat([["id", r.id]]));

let running = null;
let again = false;
export function sync() {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

let debounce;
export function syncSoon(ms = 1500) {
  clearTimeout(debounce);
  debounce = setTimeout(() => sync(), ms);
}

async function countPending() {
  const recs = await store.all();
  return recs.filter((r) => r.dirty || (r.has_audio && !r.audio_path && !r.deleted_at && !r.audio_too_large)).length;
}

async function syncOnce() {
  if (mode() !== "cloud" || !session || session.expired) {
    setState({ phase: mode() === "cloud" ? "error" : "local", pending: await countPending() });
    return;
  }
  if (!navigator.onLine) {
    setState({ phase: "offline", pending: await countPending() });
    return;
  }
  setState({ phase: "syncing", error: null });
  try {
    await uploadAudio();
    await push();
    await pull();
    setState({ phase: "ok", lastSync: new Date(), pending: await countPending() });
  } catch (e) {
    console.warn("sync failed", e);
    const offline = !navigator.onLine || e instanceof TypeError;
    setState({
      phase: offline ? "offline" : "error",
      error: offline ? null : (session?.expired ? "ログインの有効期限が切れました。再ログインしてください。" : `同期に失敗しました（${e.message}）`),
      pending: await countPending(),
    });
  }
}

async function uploadAudio() {
  const uid = session.user.id;
  for (const r of await store.all()) {
    if (!r.has_audio || r.audio_path || r.audio_too_large || r.recording) continue;
    if (r.deleted_at) continue;
    const blob = await store.getAudio(r.id);
    if (!blob) continue;
    if (blob.size > AUDIO_LIMIT) {
      await store.patch(r.id, { audio_too_large: true });
      continue;
    }
    const path = `${uid}/${r.id}.${extOf(r.mime)}`;
    await api(`/storage/v1/object/audio/${path}`, {
      method: "POST",
      headers: { "Content-Type": r.mime || "application/octet-stream", "x-upsert": "true" },
      body: blob,
    });
    await store.patch(r.id, { audio_path: path });
  }
}

async function push() {
  const dirty = (await store.all()).filter((r) => r.dirty && !r.recording);
  // 削除済みの録音の音声はクラウドからも消す（行は墓標として残し、他端末に削除を伝える）
  for (const r of dirty) {
    if (r.deleted_at && r.audio_path) {
      await api(`/storage/v1/object/audio`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [r.audio_path] }),
      });
      r.audio_path = null;
      await store.patch(r.id, { audio_path: null });
      r.rev = (await store.get(r.id)).rev;
    }
  }
  for (let i = 0; i < dirty.length; i += 50) {
    const batch = dirty.slice(i, i + 50);
    const res = await api("/rest/v1/recordings?on_conflict=id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(batch.map(toServer)),
    });
    const rows = await res.json();
    for (const row of rows) {
      const sent = batch.find((b) => b.id === row.id);
      const cur = await store.get(row.id);
      if (!cur) continue;
      await store.put({
        ...cur,
        updated_at: row.updated_at,
        minutes: row.minutes,
        minutes_at: row.minutes_at,
        dirty: cur.rev !== sent.rev, // 送信中に手元で変わっていたら未送信のまま
      });
    }
  }
}

async function pull() {
  let cursor = (await store.kvGet("cursor")) ?? "1970-01-01T00:00:00Z";
  // 同時刻にコミットされた行の取りこぼしを防ぐため、少し巻き戻して取り直す（取り込みは冪等）
  const since = new Date(new Date(cursor).getTime() - 120_000).toISOString();
  let offset = 0;
  for (;;) {
    const res = await api(
      `/rest/v1/recordings?select=id,title,recorded_at,duration_sec,mime,audio_path,transcript,segments,transcript_status,minutes,minutes_at,deleted_at,updated_at` +
      `&updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc,id.asc&limit=500&offset=${offset}`,
    );
    const rows = await res.json();
    for (const row of rows) {
      await merge(row);
      if (row.updated_at > cursor) cursor = row.updated_at;
    }
    if (rows.length < 500) break;
    offset += rows.length;
  }
  await store.kvSet("cursor", cursor);
}

async function merge(row) {
  const cur = await store.get(row.id);
  const serverSide = { minutes: row.minutes, minutes_at: row.minutes_at, updated_at: row.updated_at };
  if (!cur) {
    if (row.deleted_at) return;
    await store.put(store.newRecord({ ...row, has_audio: false, dirty: false, rev: 0 }));
    return;
  }
  if (cur.dirty || cur.recording) {
    // 手元の未送信の変更を優先し、議事録（サーバだけが書く列）だけ取り込む
    await store.put({ ...cur, ...serverSide });
    return;
  }
  const next = { ...cur, ...row, dirty: false };
  // 手元で文字起こし中・完了済みのものを、古い pending で巻き戻さない
  if (cur.transcript_status === "done" && row.transcript_status !== "done") {
    Object.assign(next, { transcript: cur.transcript, segments: cur.segments, transcript_status: "done", dirty: true, rev: (cur.rev ?? 0) + 1 });
  }
  await store.put(next);
  if (row.deleted_at && cur.has_audio) {
    await store.deleteAudio(row.id);
    await store.put({ ...next, has_audio: false });
  }
}
