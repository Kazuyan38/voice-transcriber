import * as store from "./store.js";
import * as cloud from "./cloud.js";
import * as asr from "./asr.js";
import { Recording, supported as canRecord, recoverOrphans } from "./recorder.js";

const VERSION = "1.0.0";
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`;

let recs = [];
let asrState = { phase: "idle" };
let active = null;          // 録音中の Recording
let navigated = false;      // 一覧からハッシュ遷移したか（戻るを history.back にするため）

// ---------- 表示用の整形 ----------

const pad = (n) => String(n).padStart(2, "0");
function clock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
const fmtDateTime = (iso) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(iso) === dayKey(now.toISOString())) return "今日";
  if (dayKey(iso) === dayKey(y.toISOString())) return "昨日";
  const w = "日月火水木金土"[d.getDay()];
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日（${w}）` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}
const titleOf = (r) => r.title?.trim() || `${fmtTime(r.recorded_at)} の録音`;
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n >= 1e6 ? `${Math.round(n / 1e6)}MB` : `${Math.round(n / 1e3)}KB`);

// 一覧・詳細で共通の状態表示
function statusOf(r) {
  if (r.recording) return { text: "録音中", strong: true };
  if (asr.currentId() === r.id) {
    const p = asrState.id === r.id || asrState.phase === "download" ? asrState : { phase: "loading" };
    if (p.phase === "download") return { text: `モデルを取得中 ${Math.round((p.progress ?? 0) * 100)}%`, strong: true, progress: p.progress };
    if (p.phase === "running") return { text: `文字起こし中 ${Math.round((p.progress ?? 0) * 100)}%`, strong: true, progress: p.progress };
    if (p.phase === "decoding") return { text: "音声を読み込み中", strong: true, progress: 0 };
    return { text: "準備中", strong: true, progress: 0 };
  }
  if (r.transcript_status === "failed") return { text: "文字起こし失敗" };
  if (r.transcript_status === "pending") {
    if (asr.isQueued(r.id)) return { text: "文字起こし待ち" };
    return { text: r.has_audio || r.audio_path ? "未文字起こし" : "音声なし" };
  }
  return r.minutes ? { text: "議事録あり" } : { text: "議事録待ち" };
}

// ---------- 一覧 ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(async () => {
    renderQueued = false;
    recs = await store.all();
    renderList();
    if (!$("#view-detail").hidden) renderDetailDynamic();
  });
}

function renderList() {
  const visible = recs.filter((r) => !r.deleted_at).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  const banner = cloud.needsRelogin()
    ? `<div class="card row" style="justify-content:space-between;margin-top:8px"><span class="note">ログインの有効期限が切れました。録音はこの端末に保存されています。</span><button class="btn small" data-act="relogin">再ログイン</button></div>`
    : "";
  if (!visible.length) {
    $("#list").innerHTML = banner + `<div class="empty"><b>録音はまだありません</b>下の ＋ を押すと録音を始めます。</div>`;
    return;
  }
  const groups = [];
  for (const r of visible) {
    const k = dayKey(r.recorded_at);
    if (groups.at(-1)?.k !== k) groups.push({ k, label: dayLabel(r.recorded_at), items: [] });
    groups.at(-1).items.push(r);
  }
  const unsynced = (r) => cloud.mode() === "cloud" && (r.dirty || (r.has_audio && !r.audio_path && !r.audio_too_large)) && !r.recording;
  $("#list").innerHTML = banner + groups.map((g) => `
    <section class="group">
      <h2>${esc(g.label)}</h2>
      <ul class="items">${g.items.map((r) => {
        const st = statusOf(r);
        const done = Boolean(r.minutes);
        return `<li class="item${done ? " done" : ""}" data-id="${r.id}" tabindex="0" role="button" aria-label="${esc(titleOf(r))}">
          <span class="check${done ? " done" : ""}${r.recording ? " live" : ""}" aria-label="${done ? "議事録作成済み" : "議事録未作成"}">${ICON_CHECK}</span>
          <div style="min-width:0">
            <div class="title">${esc(titleOf(r))}</div>
            <div class="meta num">
              ${r.title?.trim() ? `<span>${fmtTime(r.recorded_at)}</span>` : ""}
              <span>${clock(r.duration_sec)}</span>
              <span class="${st.strong ? "strong" : ""}">${esc(st.text)}</span>
              ${unsynced(r) ? `<span>未同期</span>` : ""}
            </div>
            ${st.progress !== undefined ? `<div class="bar"><i style="width:${Math.round((st.progress ?? 0) * 100)}%"></i></div>` : ""}
          </div>
          <span class="chev" aria-hidden="true">›</span>
        </li>`;
      }).join("")}</ul>
    </section>`).join("");
}

$("#list").addEventListener("click", (e) => {
  if (e.target.closest("[data-act=relogin]")) return showAuth(true);
  const li = e.target.closest(".item");
  if (li) go(`#/r/${li.dataset.id}`);
});
$("#list").addEventListener("keydown", (e) => {
  const li = e.target.closest(".item");
  if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(`#/r/${li.dataset.id}`); }
});

function renderSync(s = cloud.syncState()) {
  const el = $("#sync");
  el.dataset.phase = s.phase;
  const pending = s.pending ? `未送信 ${s.pending}` : "";
  el.textContent = {
    ok: pending || "同期済み",
    syncing: "同期中",
    offline: pending ? `オフライン・${pending}` : "オフライン",
    local: "この端末のみ",
    error: "同期エラー",
  }[s.phase] ?? "";
  el.title = s.error ?? "";
}

// ---------- 画面遷移 ----------

function go(hash) {
  navigated = true;
  location.hash = hash;
}
function back() {
  if (navigated) history.back();
  else history.replaceState(null, "", location.pathname + location.search), route();
}

function route() {
  const h = location.hash;
  const detail = h.match(/^#\/r\/([0-9a-f-]{36})$/);
  if (detail) {
    closeSheet("#view-settings");
    openDetail(detail[1]);
  } else if (h === "#/settings") {
    closeSheet("#view-detail");
    openSettings();
  } else {
    closeSheet("#view-detail");
    closeSheet("#view-settings");
  }
}
addEventListener("hashchange", route);

function closeSheet(sel) {
  const el = $(sel);
  if (el.hidden) return;
  el.hidden = true;
  if (sel === "#view-detail") releasePlayer();
  syncScrollLock();
}
function syncScrollLock() {
  const anyOpen = [...document.querySelectorAll(".sheet")].some((s) => !s.hidden);
  document.body.style.overflow = anyOpen ? "hidden" : "";
}

addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || active) return;
  if (!$("#view-detail").hidden || !$("#view-settings").hidden) back();
});

// ---------- 詳細 ----------

let detailId = null;
let playerKey = "";
let playerUrl = null;
let titleTimer;
let confirmDelete = false;

function releasePlayer() {
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = null;
  playerKey = "";
  detailId = null;
}

async function openDetail(id) {
  const r = await store.get(id);
  if (!r || r.deleted_at) { back(); return; }
  releasePlayer();
  detailId = id;
  confirmDelete = false;
  const v = $("#view-detail");
  v.innerHTML = `
    <div class="sheet-top"><div class="col">
      <button class="back" data-act="back">${ICON_BACK}録音</button>
      <span class="note num" id="d-when"></span>
    </div></div>
    <div class="col">
      <input class="title-input" id="d-title" maxlength="200" aria-label="タイトル">
      <div class="meta num" id="d-meta"></div>
      <div id="d-player"></div>
      <div id="d-body"></div>
    </div>`;
  const title = $("#d-title", v);
  title.value = r.title ?? "";
  title.placeholder = titleOf({ ...r, title: "" });
  title.addEventListener("input", () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => store.patch(id, { title: title.value.trim() }), 500);
  });
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") title.blur(); });
  v.hidden = false;
  v.scrollTop = 0;
  syncScrollLock();
  renderDetailDynamic();
}

async function renderDetailDynamic() {
  if (!detailId) return;
  const r = await store.get(detailId);
  if (!r || r.deleted_at) { back(); return; }
  const v = $("#view-detail");
  const st = statusOf(r);
  $("#d-when", v).textContent = fmtDateTime(r.recorded_at);
  $("#d-meta", v).innerHTML = `<span>${clock(r.duration_sec)}</span><span class="${st.strong ? "strong" : ""}">${esc(st.text)}</span>`;

  // 再生中にプレイヤーを作り直さないよう、音声の有無が変わったときだけ描き直す
  const key = r.has_audio ? "local" : r.audio_path ? "remote" : "none";
  if (key !== playerKey) {
    playerKey = key;
    const box = $("#d-player", v);
    if (key === "local") {
      const blob = await store.getAudio(r.id);
      if (playerUrl) URL.revokeObjectURL(playerUrl);
      playerUrl = URL.createObjectURL(blob);
      box.innerHTML = `<audio controls preload="metadata" src="${playerUrl}"></audio>`;
      fixDuration($("audio", box));
    } else if (key === "remote") {
      box.innerHTML = `<div class="row" style="margin-top:16px"><button class="btn ghost small" data-act="fetch-audio">音声をこの端末に取得</button><span class="note">クラウドに保存されています</span></div>`;
    } else {
      box.innerHTML = r.recording ? "" : `<p class="note" style="margin-top:16px">${r.audio_too_large ? "" : "この端末には音声がありません。"}</p>`;
    }
  }

  const parts = [];
  // 文字起こしの状態と操作
  if (r.transcript_status !== "done" && !r.recording) {
    const running = asr.currentId() === r.id;
    let action = "";
    if (!running && !asr.isQueued(r.id)) {
      if (r.has_audio) action = `<button class="btn" data-act="transcribe">${r.transcript_status === "failed" ? "もう一度文字起こしする" : "文字起こしを開始"}</button>`;
      else if (r.audio_path) action = `<button class="btn" data-act="fetch-transcribe">音声を取得して文字起こし</button>`;
    }
    parts.push(`<div class="card" style="margin-top:20px">
      <div class="row" style="justify-content:space-between"><b>${esc(st.text)}</b>${action}</div>
      ${st.progress !== undefined ? `<div class="bar"><i style="width:${Math.round((st.progress ?? 0) * 100)}%"></i></div>` : ""}
      ${r.asr_error ? `<p class="error">${esc(r.asr_error)}</p>` : ""}
      ${running ? `<p class="note">文字起こしはこの端末の中で行います（音声は外部に送られません）。画面を開いたままにしてください。</p>` : ""}
    </div>`);
  }
  if (r.audio_too_large) parts.push(`<p class="note">音声が 50MB を超えるため、クラウドには文字起こしだけを同期しています。</p>`);

  // 議事録
  parts.push(`<h2>議事録</h2>`);
  if (r.minutes) {
    parts.push(`<div class="row" style="justify-content:space-between;margin-bottom:10px">
        <span class="badge"><span class="check done">${ICON_CHECK}</span>MCP で作成${r.minutes_at ? ` · ${fmtDateTime(r.minutes_at)}` : ""}</span>
        <button class="btn quiet small" data-act="copy-minutes">コピー</button>
      </div>
      <div class="md">${markdown(r.minutes)}</div>`);
  } else {
    parts.push(`<p class="note">Claude や ChatGPT から MCP 経由で議事録を作成すると、ここに表示され、一覧にチェックが付きます。${cloud.mode() === "cloud" ? `<br><button class="linkish" data-act="settings">MCP の接続方法</button>` : "（MCP の利用にはログインが必要です）"}</p>`);
  }

  // 文字起こし
  const segs = r.transcript_status === "done" ? r.segments : r.asr?.segments;
  parts.push(`<div class="row" style="justify-content:space-between;margin-top:32px;margin-bottom:10px">
      <h2 style="margin:0">文字起こし</h2>
      ${r.transcript_status === "done" ? `<button class="btn quiet small" data-act="copy-transcript">コピー</button>` : ""}
    </div>`);
  if (segs?.length) {
    parts.push(`<ul class="transcript">${segs.map((s) => `<li><button class="ts num" data-t="${s.t}">${clock(s.t)}</button><span>${esc(s.text)}</span></li>`).join("")}</ul>`);
  } else if (r.transcript_status === "done") {
    parts.push(`<p class="note">${r.transcript ? esc(r.transcript) : "発話は検出されませんでした。"}</p>`);
  } else {
    parts.push(`<p class="note">まだありません。</p>`);
  }

  parts.push(`<div style="margin-top:48px">${confirmDelete
    ? `<p class="note">この録音を削除します。${cloud.mode() === "cloud" ? "他の端末とクラウドからも削除されます。" : ""}</p>
       <div class="row"><button class="btn danger" data-act="delete-yes">削除する</button><button class="btn quiet" data-act="delete-no">やめる</button></div>`
    : `<button class="btn quiet" data-act="delete" ${r.recording ? "disabled" : ""}>この録音を削除</button>`}</div>`);

  // 選択中のテキストを壊さないよう、内容が同じなら書き換えない
  const html = parts.join("");
  const body = $("#d-body", v);
  if (body.dataset.html !== html) {
    body.innerHTML = html;
    body.dataset.html = html;
  }
}

// MediaRecorder の webm は長さ情報を持たないため、末尾までシークさせて長さを確定させる
function fixDuration(audio) {
  audio.addEventListener("loadedmetadata", () => {
    if (audio.duration !== Infinity) return;
    audio.currentTime = 1e101;
    audio.addEventListener("timeupdate", () => { audio.currentTime = 0; }, { once: true });
  }, { once: true });
}

$("#view-detail").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act], .ts");
  if (!t) return;
  const id = detailId;
  if (t.classList.contains("ts")) {
    const a = $("#d-player audio");
    if (a) { a.currentTime = Number(t.dataset.t); a.play().catch(() => {}); }
    return;
  }
  const r = await store.get(id);
  switch (t.dataset.act) {
    case "back": return back();
    case "settings": return go("#/settings");
    case "transcribe":
      await store.patch(id, { transcript_status: "pending", asr_error: null });
      asr.enqueue(id);
      return scheduleRender();
    case "fetch-audio":
    case "fetch-transcribe":
      t.disabled = true;
      t.textContent = "取得中…";
      try {
        await store.putAudio(id, await cloud.downloadAudio(r));
        await store.patch(id, { has_audio: true });
        if (t.dataset.act === "fetch-transcribe") asr.enqueue(id);
      } catch (err) {
        toast(navigator.onLine ? "音声を取得できませんでした" : "オフラインのため取得できません");
        t.disabled = false;
      }
      return scheduleRender();
    case "copy-minutes": return copy(r.minutes, "議事録をコピーしました");
    case "copy-transcript":
      return copy((r.segments ?? []).map((s) => `[${clock(s.t)}] ${s.text}`).join("\n") || r.transcript || "", "文字起こしをコピーしました");
    case "delete": confirmDelete = true; return renderDetailDynamic();
    case "delete-no": confirmDelete = false; return renderDetailDynamic();
    case "delete-yes": {
      const neverSent = !r.updated_at && !r.audio_path;
      if (neverSent) await store.remove(id);
      else {
        await store.patch(id, { deleted_at: new Date().toISOString() });
        await store.deleteAudio(id);
        await store.patch(id, { has_audio: false });
      }
      toast("削除しました");
      return back();
    }
  }
});

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(msg);
}

// 議事録表示用の最小 Markdown（見出し・箇条書き・番号付き・表・太字・コード）。入力は必ずエスケープしてから整形する。
function markdown(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/^\[( |x)\]\s*/i, (m, x) => (x.trim() ? "☑ " : "☐ "));
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let list = null, para = [], table = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((l) => !/^[\s|:-]+$/.test(l))
      .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim())));
    out.push(`<div class="table-wrap"><table>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`).join("")}</table></div>`);
    table = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };
  for (const line of lines) {
    let m;
    if (/^\s*\|/.test(line)) { flushPara(); flushList(); table.push(line); continue; }
    flushTable();
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushAll(); const n = Math.min(3, m[1].length); out.push(`<h${n}>${inline(m[2])}</h${n}>`); }
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (list?.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (list?.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); }
    else if (!line.trim()) flushAll();
    else if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushAll(); out.push("<hr>"); }
    else { flushList(); para.push(line); }
  }
  flushAll();
  return out.join("");
}

// ---------- 設定 ----------

let mcpIssued = null;     // 発行直後の URL（この画面を閉じるまで表示）
let confirmLogout = false;
let preloadState = "";

async function openSettings() {
  confirmLogout = false;
  mcpIssued = null;
  const v = $("#view-settings");
  v.hidden = false;
  v.scrollTop = 0;
  syncScrollLock();
  await renderSettings();
  if (cloud.mode() === "cloud" && navigator.onLine && !cloud.needsRelogin()) {
    cloud.mcpTokenStatus().then((s) => { mcpStatus = s ?? "none"; renderSettings(); }).catch(() => {});
  }
}
let mcpStatus = null;

async function renderSettings() {
  const v = $("#view-settings");
  if (v.hidden) return;
  const m = cloud.mode();
  const user = cloud.currentUser();
  const s = cloud.syncState();
  const a = asr.settings();
  let usage = "";
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) usage = `${fmtBytes(est.usage ?? 0)} 使用中（上限の目安 ${fmtBytes(est.quota ?? 0)}）`;
  } catch { /* 取得できないブラウザ */ }

  const account = m === "cloud"
    ? `<div class="card">
        <div class="row" style="justify-content:space-between"><div><b>${esc(user?.email ?? "")}</b><div class="note">${cloud.needsRelogin() ? "ログインの有効期限切れ" : "ログイン中・クラウド同期オン"}</div></div>
        ${cloud.needsRelogin() ? `<button class="btn small" data-act="relogin">再ログイン</button>` : ""}</div>
        <div style="margin-top:14px">${confirmLogout
          ? `<p class="note">ログアウトすると、この端末内の録音データを消去します（クラウドに同期済みのものは残ります）。${s.pending ? `<br><b class="error">未送信の録音が ${s.pending} 件あります。消去すると失われます。</b>` : ""}</p>
             <div class="row"><button class="btn danger small" data-act="logout-yes">ログアウトする</button><button class="btn quiet small" data-act="logout-no">やめる</button></div>`
          : `<button class="btn quiet small" data-act="logout">ログアウト</button>`}</div>
      </div>`
    : `<div class="card"><b>この端末だけで使用中</b>
        <p class="note">録音と文字起こしはこの端末に保存されます。${cloud.configured ? "ログインすると、他の端末との同期と、MCP による議事録作成が使えます（今ある録音も引き継がれます）。" : ""}</p>
        ${cloud.configured ? `<button class="btn small" data-act="login">ログイン / 新規登録</button>` : ""}</div>`;

  const sync = m === "cloud" ? `
      <h2>同期</h2>
      <div class="card row" style="justify-content:space-between">
        <div><b>${esc({ ok: "同期済み", syncing: "同期中…", offline: "オフライン", error: "同期エラー" }[s.phase] ?? "待機中")}</b>
          <div class="note">${s.lastSync ? `最終同期 ${s.lastSync.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` : ""}${s.pending ? `・未送信 ${s.pending} 件` : ""}${s.error ? `<br><span class="error">${esc(s.error)}</span>` : ""}</div></div>
        <button class="btn quiet small" data-act="sync" ${navigator.onLine ? "" : "disabled"}>今すぐ同期</button>
      </div>` : "";

  const mcp = m === "cloud" ? `
      <h2>MCP 接続（Claude / ChatGPT で議事録を作成）</h2>
      <div class="card">
        <p class="note" style="margin-top:0">発行した接続 URL を Claude や ChatGPT に登録すると、AI が文字起こしを読み、議事録を作ってこのアプリに保存します。保存された録音には一覧でチェックが付きます。</p>
        <p class="note">${mcpStatus && mcpStatus !== "none" ? `発行済み（${fmtDateTime(mcpStatus.created_at)}）${mcpStatus.last_used_at ? `・最終利用 ${fmtDateTime(mcpStatus.last_used_at)}` : "・未使用"}` : mcpStatus === "none" ? "未発行" : ""}</p>
        ${mcpIssued ? `
          <div class="copybox"><input readonly value="${esc(mcpIssued)}" id="mcp-url" aria-label="MCP 接続 URL"><button class="btn small" data-act="copy-mcp">コピー</button></div>
          <p class="note">この URL はパスワードと同じ扱いです。表示は今回だけです。紛失したら再発行してください（古い URL は無効になります）。</p>` : ""}
        <div class="row">
          <button class="btn small" data-act="issue-mcp" ${navigator.onLine ? "" : "disabled"}>${mcpStatus && mcpStatus !== "none" ? "URL を再発行" : "接続 URL を発行"}</button>
          ${mcpStatus && mcpStatus !== "none" ? `<button class="btn quiet small" data-act="revoke-mcp">接続を解除</button>` : ""}
        </div>
      </div>
      <details><summary>Claude（Web・デスクトップ・スマホ）</summary><ol>
        <li>claude.ai の［設定］→［コネクタ］→［カスタムコネクタを追加］</li>
        <li>名前に「録音」、URL に発行した接続 URL を貼って追加（認証の設定は不要）</li>
        <li>チャットで「議事録が未作成の録音から議事録を作って」と頼む</li></ol></details>
      <details><summary>ChatGPT</summary><ol>
        <li>［設定］→［アプリとコネクタ］→［詳細設定］で開発者モードをオン</li>
        <li>［コネクタを作成］で URL に接続 URL を貼り、認証は「なし」を選ぶ</li>
        <li>新しいチャットでそのコネクタを有効にして「議事録が未作成の録音から議事録を作って」と頼む</li></ol></details>
      <details><summary>Claude Code</summary><ol>
        <li>ターミナルで <code class="inline">claude mcp add --transport http voice-transcriber "&lt;接続 URL&gt;"</code></li>
        <li>「/mcp」で接続を確認し、議事録の作成を頼む</li></ol></details>` : "";

  const modelOptions = asr.MODELS.map((x) => `<option value="${x.id}" ${x.id === a.model ? "selected" : ""}>${esc(x.label)}</option>`).join("");
  v.innerHTML = `
    <div class="sheet-top"><div class="col"><button class="back" data-act="back">${ICON_BACK}録音</button><b>設定</b><span style="width:60px"></span></div></div>
    <div class="col">
      <h2>アカウント</h2>${account}
      ${sync}
      ${mcp}
      <h2>文字起こし</h2>
      <div class="card">
        <div class="field"><label for="set-model">モデル（端末の中で動きます。音声は外部に送られません）</label><select id="set-model">${modelOptions}</select></div>
        <label class="switch"><span>録音後に自動で文字起こし</span><input type="checkbox" id="set-auto" ${a.auto ? "checked" : ""}></label>
        <div class="row" style="margin-top:8px"><button class="btn quiet small" data-act="preload">モデルを事前に取得</button><span class="note" id="preload-state">${esc(preloadState)}</span></div>
        <p class="note">初回だけモデルをダウンロードします。取得後はオフラインでも文字起こしできます。${self.crossOriginIsolated ? "" : "（マルチスレッド無効：再読み込みすると速くなる場合があります）"}</p>
      </div>
      <h2>この端末</h2>
      <p class="note">${esc(usage)}</p>
      <p class="note">Voice Transcriber ${VERSION}</p>
    </div>`;

  $("#set-model", v).addEventListener("change", (e) => { asr.saveSettings({ model: e.target.value }); preloadState = ""; });
  $("#set-auto", v).addEventListener("change", (e) => asr.saveSettings({ auto: e.target.checked }));
}

$("#view-settings").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  switch (t.dataset.act) {
    case "back": return back();
    case "login": case "relogin": return showAuth(true);
    case "logout": confirmLogout = true; return renderSettings();
    case "logout-no": confirmLogout = false; return renderSettings();
    case "logout-yes":
      await cloud.signOut();
      confirmLogout = false;
      history.replaceState(null, "", location.pathname);
      route();
      showAuth(false);
      return;
    case "sync": await cloud.sync(); return renderSettings();
    case "issue-mcp":
      t.disabled = true;
      try {
        mcpIssued = await cloud.issueMcpToken();
        mcpStatus = (await cloud.mcpTokenStatus()) ?? "none";
      } catch {
        toast("発行できませんでした。通信状態を確認してください");
      }
      return renderSettings();
    case "revoke-mcp":
      try {
        await cloud.revokeMcpToken();
        mcpIssued = null;
        mcpStatus = "none";
        toast("MCP 接続を解除しました");
      } catch {
        toast("解除できませんでした");
      }
      return renderSettings();
    case "copy-mcp": return copy(mcpIssued, "接続 URL をコピーしました");
    case "preload":
      t.disabled = true;
      preloadState = "準備中…";
      renderPreload();
      try {
        await asr.preload();
        preloadState = "取得済み（オフラインで使えます）";
      } catch (err) {
        preloadState = `失敗: ${err.message}`;
      }
      renderPreload();
      t.disabled = false;
  }
});
const renderPreload = () => { const el = $("#preload-state"); if (el) el.textContent = preloadState; };

// ---------- ログイン ----------

let authMode = "login";
function showAuth(cancellable) {
  const v = $("#view-auth");
  $("#auth-cancel").hidden = !cancellable;
  $("#auth-local").hidden = cancellable;
  $("#auth-error").hidden = true;
  $("#auth-info").hidden = true;
  if (cloud.currentUser()?.email) $("#auth-email").value = cloud.currentUser().email;
  setAuthMode("login");
  v.hidden = false;
  syncScrollLock();
}
function hideAuth() {
  $("#view-auth").hidden = true;
  syncScrollLock();
}
function setAuthMode(m) {
  authMode = m;
  $("#tab-login").setAttribute("aria-selected", m === "login");
  $("#tab-signup").setAttribute("aria-selected", m === "signup");
  $("#auth-submit").textContent = m === "login" ? "ログイン" : "登録する";
  $("#auth-pass").autocomplete = m === "login" ? "current-password" : "new-password";
  $("#auth-pass").placeholder = m === "signup" ? "8 文字以上" : "";
}
$("#tab-login").addEventListener("click", () => setAuthMode("login"));
$("#tab-signup").addEventListener("click", () => setAuthMode("signup"));
$("#auth-local").addEventListener("click", () => { cloud.useLocalOnly(); hideAuth(); cloud.sync(); scheduleRender(); });
$("#auth-cancel").addEventListener("click", hideAuth);
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const pass = $("#auth-pass").value;
  const err = $("#auth-error"), info = $("#auth-info"), btn = $("#auth-submit");
  err.hidden = info.hidden = true;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "メールアドレスを入力してください。"; err.hidden = false; return; }
  if (pass.length < 8) { err.textContent = "パスワードは 8 文字以上にしてください。"; err.hidden = false; return; }
  if (!navigator.onLine) { err.textContent = "ログインと新規登録にはインターネット接続が必要です。"; err.hidden = false; return; }
  btn.disabled = true;
  try {
    if (authMode === "login") {
      await cloud.signIn(email, pass);
      afterLogin();
    } else {
      await cloud.signUp(email, pass);
      afterLogin();
    }
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
function afterLogin() {
  $("#auth-pass").value = "";
  hideAuth();
  toast("ログインしました");
  cloud.sync();
  scheduleRender();
  renderSettings();
}

// ---------- 録音 ----------

let raf = 0;
let levels = [];
let lastLevelAt = 0;
let cancelArmed = 0;

$("#btn-rec").addEventListener("click", startRecording);

async function startRecording() {
  if (active) return;
  if (!canRecord()) return toast("このブラウザは録音に対応していません");
  const rec = store.newRecord({ recording: true });
  const r = new Recording(rec.id);
  try {
    await r.start();
  } catch (e) {
    r.release?.();
    return toast(e?.name === "NotAllowedError" ? "マイクの使用が許可されていません。ブラウザの設定で許可してください" : "マイクを開始できませんでした");
  }
  active = r;
  await store.put({ ...rec, mime: r.mime });
  navigator.storage?.persist?.().catch(() => {});
  levels = [];
  cancelArmed = 0;
  $("#rec-pause").textContent = "一時停止";
  $("#rec-cancel").textContent = "破棄";
  $("#rec-state").textContent = "録音中";
  $("#rec-state").classList.remove("paused");
  $("#view-rec").hidden = false;
  syncScrollLock();
  draw();
}

function draw() {
  if (!active) return;
  const now = performance.now();
  $("#rec-timer").textContent = clock(active.elapsedMs / 1000);
  if (now - lastLevelAt > 70) {
    lastLevelAt = now;
    levels.push(active.level());
    if (levels.length > 64) levels.shift();
  }
  const c = $("#wave"), g = c.getContext("2d");
  const n = 64, gap = c.width / n, w = gap * 0.42, mid = c.height / 2;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "#000";
  for (let i = 0; i < n; i++) {
    const v = levels[i - (n - levels.length)] ?? 0;
    const h = Math.max(6, v * c.height * 0.92);
    const x = i * gap + (gap - w) / 2;
    g.globalAlpha = 0.25 + 0.75 * (i / n);
    g.beginPath();
    if (g.roundRect) g.roundRect(x, mid - h / 2, w, h, w / 2);
    else g.rect(x, mid - h / 2, w, h);
    g.fill();
  }
  g.globalAlpha = 1;
  raf = requestAnimationFrame(draw);
}

$("#rec-pause").addEventListener("click", () => {
  if (!active) return;
  if (active.paused) active.resume(); else active.pause();
  $("#rec-pause").textContent = active.paused ? "再開" : "一時停止";
  $("#rec-state").textContent = active.paused ? "一時停止中" : "録音中";
  $("#rec-state").classList.toggle("paused", active.paused);
});

$("#rec-stop").addEventListener("click", async () => {
  if (!active) return;
  const r = active;
  $("#rec-stop").disabled = true;
  try {
    const { blob, mime, duration } = await r.stop();
    if (!blob.size) {
      await store.remove(r.id);
      toast("録音できませんでした");
    } else {
      await store.putAudio(r.id, blob);
      await store.patch(r.id, { recording: false, has_audio: true, mime, duration_sec: Math.round(duration * 10) / 10 });
      await store.clearChunks(r.id);
      if (asr.settings().auto) asr.enqueue(r.id);
      toast("保存しました");
    }
  } finally {
    endRecordingUi();
    $("#rec-stop").disabled = false;
  }
});

$("#rec-cancel").addEventListener("click", async () => {
  if (!active) return;
  if (Date.now() - cancelArmed > 3000) {
    cancelArmed = Date.now();
    $("#rec-cancel").textContent = "もう一度で破棄";
    setTimeout(() => { if (active) $("#rec-cancel").textContent = "破棄"; }, 3000);
    return;
  }
  const r = active;
  await r.cancel();
  await store.remove(r.id);
  endRecordingUi();
  toast("録音を破棄しました");
});

function endRecordingUi() {
  active = null;
  cancelAnimationFrame(raf);
  $("#view-rec").hidden = true;
  syncScrollLock();
}

addEventListener("beforeunload", (e) => {
  if (active) { e.preventDefault(); e.returnValue = ""; }
});

// ---------- 共通 ----------

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

$("#btn-settings").addEventListener("click", () => go("#/settings"));

store.events.addEventListener("change", (e) => {
  scheduleRender();
  if (e.detail.dirty) cloud.syncSoon();
});
let asrRenderAt = 0;
asr.status.addEventListener("change", (e) => {
  asrState = e.detail;
  const now = performance.now();
  if (e.detail.phase === "download" && now - asrRenderAt < 250) return; // ダウンロード進捗は間引く
  asrRenderAt = now;
  scheduleRender();
  if (e.detail.phase === "download" && !$("#view-settings").hidden) {
    preloadState = `ダウンロード中 ${Math.round(e.detail.progress * 100)}%（${fmtBytes(e.detail.loaded)} / ${fmtBytes(e.detail.total)}）`;
    renderPreload();
  }
});
cloud.status.addEventListener("change", (e) => {
  renderSync(e.detail);
  if (e.detail.phase !== "syncing") renderSettings();
  scheduleRender();
});
addEventListener("online", () => cloud.sync());
addEventListener("offline", () => cloud.sync());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") cloud.sync(); });
setInterval(() => { if (document.visibilityState === "visible") cloud.sync(); }, 20_000);

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("sw.js");
    // 初回は SW の管理下に入っておらず、COOP/COEP（マルチスレッド文字起こしに必要）が付かない。1 回だけ読み直す。
    if (!self.crossOriginIsolated && !sessionStorage.getItem("vt.coi-reload")) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (active || asr.currentId()) return;
        sessionStorage.setItem("vt.coi-reload", "1");
        location.reload();
      }, { once: true });
    }
  } catch (e) {
    console.warn("service worker", e);
  }
}

async function init() {
  registerSW();
  if (cloud.configured) {
    try {
      if (await cloud.consumeRedirect()) toast("メールアドレスを確認しました");
    } catch { /* リンクの期限切れなど。通常のログイン画面へ */ }
  } else if (!cloud.mode()) {
    cloud.useLocalOnly();
  }

  await recoverOrphans().then((ids) => ids.length && toast(`中断された録音を ${ids.length} 件復元しました`)).catch(() => {});
  for (const r of await store.all()) {
    // 断片が 1 つも書かれないうちに落ちた録音の残骸
    if (r.recording) await store.remove(r.id);
  }
  recs = await store.all();
  renderList();
  renderSync();
  if (!cloud.mode()) showAuth(false);
  route();

  if (asr.settings().auto) {
    for (const r of recs.filter((r) => !r.deleted_at && r.has_audio && r.transcript_status === "pending")
      .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))) asr.enqueue(r.id);
  }
  cloud.sync();
}

init();
