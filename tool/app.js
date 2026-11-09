"use strict";
/* Flap annotator (static page; reads and writes a folder the user picks). Times: every stored time is VIDEO time (seconds in the source video).
   Clip time = video time - D.clip_start. Frames: clip frame f shows video time clip_start + f/25.
   Video only: no tag lanes, no behaviour lanes, one editable lane. */
const TOOL_VERSION = "v2.0";
const CLOSE_MARK_S = 0.08;                            // warn when two marks are this close (seconds) or closer
const AUTOSAVE_MS = 1000;
const FPS = 25;
const $ = id => document.getElementById(id);
const vid = $("vid"), lc = $("lc"), ictx = $("inset").getContext("2d");

let clips = [], idx = -1, D = null, S = null;          // clip list, current index, lane data, annotation state
let savedMap = {};                                      // clip_id -> saved file (round folder only)
let cfg = { round: "" };
let root = null, curURL = null, saveErr = null, saveTimer = null, saveChain = Promise.resolve();
let zoomStack = [], zdrag = null;                       // zoom levels (rectangles in unzoomed stage fractions), drag in progress
let mode = "seek";                                      // "seek" | "add" | "move"
let undoStack = [];
let dirty = false, lastSaved = null;
let hover = null, drag = null;
const MARKCOL = "#ffd479", UNSURECOL = "#ff7ad9", OUTCOL = "#ff3b30";

// ---- lane geometry -----------------------------------------------------------------------------
const GAP = 3;
const ROWS = [{ key: "axis", h: 22, y: 0 }, { key: "blank", h: 34, y: 25, flaps: true, blank: true }];
const TOTAL_H = 25 + 34 + GAP;
const blankName = () => (D && D.mark_label) || "Wings fully raised";

// ---- helpers -----------------------------------------------------------------------------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cs = () => D.clip_start;
const frameOf = vt => Math.round((vt - cs()) * FPS);
const snap = vt => cs() + clamp(frameOf(vt), 0, D.n_frames - 1) / FPS;
const curFrame = () => clamp(Math.floor(vid.currentTime * FPS + 1e-3), 0, D.n_frames - 1);
const curVT = () => cs() + curFrame() / FPS;           // playhead (frame start) in video time
const spanOf = () => [cs(), cs() + D.duration];
const same = (a, b) => Math.abs(a - b) < 1 / (2 * FPS);
const xOf = vt => (vt - cs()) / D.duration * W();
const tOfX = x => cs() + x / W() * D.duration;
const W = () => lc.clientWidth;
const fmt = t => t.toFixed(2);
function seekFrame(f) { f = clamp(f, 0, D.n_frames - 1); vid.currentTime = (f + 0.5) / FPS; }
function seekVT(vt) { seekFrame(frameOf(vt)); }

// ---- loading -----------------------------------------------------------------------------------
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function fileAt(path) {   // path relative to the picked folder; returns a File or null
  const parts = String(path || "").split("/").filter(p => p && p !== ".");
  if (!parts.length || parts.includes("..")) return null;
  try {
    let d = root; for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
  } catch (e) { return null; }
}
async function jget(path) { const f = await fileAt(path); if (!f) return null; try { return JSON.parse(await f.text()); } catch (e) { return null; } }
async function listDir(h) { const out = []; for await (const [name, ent] of h.entries()) out.push([name, ent.kind]); return out; }

async function scanFolder(h) {
  root = h; const R = { name: h.name, top: await listDir(h) };
  R.topNames = R.top.map(t => t[0]);
  if (!R.topNames.includes("clips.json")) { R.notRound = true; return R; }
  const cl = await jget("clips.json");
  if (!cl || !Array.isArray(cl.clips)) { R.badJson = true; return R; }
  R.clips = cl.clips; R.total = R.clips.reduce((a, c) => a + (Number(c.duration) || 0), 0);
  R.missing = { mp4: [], data: [], prior: [] }; R.found = { mp4: 0, data: 0, prior: 0 };
  R.species = {}; R.sessions = new Set(); R.fpsOdd = [];
  for (const c of R.clips) {
    const dd = await jget(c.data);
    for (const [k, path] of [["mp4", c.file], ["data", c.data], ["prior", "prior/" + c.clip_id + ".json"]]) {
      if (k === "data" ? dd : await fileAt(path)) R.found[k]++; else R.missing[k].push(c.clip_id);
    }
    R.sessions.add((dd && dd.session) || c.session);
    if (dd && dd.species) R.species[dd.species] = (R.species[dd.species] || 0) + 1;
    if (dd && dd.fps !== undefined && Math.abs(Number(dd.fps) - FPS) > 1e-6) R.fpsOdd.push(c.clip_id + " (" + dd.fps + ")");
  }
  R.ann = { n: 0, done: 0, unusable: 0 };
  try {
    for (const [name, kind] of await listDir(await h.getDirectoryHandle("annotations"))) {
      if (kind !== "file" || !name.endsWith(".json")) continue;       // .json.bak is ignored
      const a = await jget("annotations/" + name); if (!a) continue;
      R.ann.n++; if (a.done) R.ann.done++; if (a.unusable) R.ann.unusable++;
    }
  } catch (e) { /* no annotations folder yet */ }
  const used = ["clips.json", "clips", "data", "prior", "annotations"];
  R.other = R.top.filter(t => !used.includes(t[0])).map(t => t[0] + (t[1] === "directory" ? "/" : ""));
  return R;
}
function renderReport(R) {
  const rep = $("ld-report"); rep.style.display = ""; $("ld-pick").style.display = "none";
  const again = '<button id="ld-again">Choose a different folder</button>';
  if (R.notRound || R.badJson) {
    const list = R.top.length ? R.top.map(t => esc(t[0]) + (t[1] === "directory" ? "/" : "")).join(", ") : "(nothing)";
    rep.innerHTML = `<div class="ldmsg bad">${R.notRound ? "This is not a round folder (there is no clips.json in it)." : "clips.json in this folder could not be read."}</div>
      <p>Folder "${esc(R.name)}" contains: ${list}</p><div class="btns">${again}</div>`;
    $("ld-again").onclick = chooseFolder; return;
  }
  const miss = (k, label, optional) => {
    const m = R.missing[k], n = R.clips.length;
    return `<tr><td>${label}</td><td class="${m.length && !optional ? "bad" : ""}">${R.found[k]} of ${n} found${m.length ? "; missing: " + esc(m.slice(0, 12).join(", ")) + (m.length > 12 ? " ... (" + m.length + " in all)" : "") : ""}</td></tr>`;
  };
  const sp = Object.entries(R.species).map(([k, v]) => `${esc(k)}: ${v} clips`).join(", ");
  const essential = R.missing.mp4.length + R.missing.data.length;
  rep.innerHTML = `<table>
    <tr><td>Folder</td><td>${esc(R.name)}</td></tr>
    <tr><td>Clips in clips.json</td><td>${R.clips.length}, ${(R.total / 60).toFixed(1)} minutes in all</td></tr>
    ${miss("mp4", "Video files (mp4)")}${miss("data", "Data files")}${miss("prior", "Prior-mark files (optional)", true)}
    ${sp ? `<tr><td>Species</td><td>${sp}</td></tr>` : ""}
    <tr><td>Videos (sessions)</td><td>${R.sessions.size}</td></tr>
    <tr><td>Clips whose fps is not ${FPS}</td><td>${R.fpsOdd.length ? '<span class="bad">' + esc(R.fpsOdd.join(", ")) + "</span>" : "none"}</td></tr>
    <tr><td>Annotations already there</td><td>${R.ann.n} saved, ${R.ann.done} done, ${R.ann.unusable} unusable</td></tr>
    <tr><td>Other items in the folder (not used)</td><td>${R.other.length ? esc(R.other.join(", ")) : "none"}</td></tr>
    <tr><td>Your marks will be saved in</td><td>${esc(R.name)}/annotations/&lt;clip_id&gt;.json</td></tr></table>
    ${essential ? '<div class="ldmsg bad">Some video or data files are missing. Download the round folder again before starting.</div>' : ""}
    <div class="btns"><button id="ld-start" ${essential || !R.clips.length ? "disabled" : ""}>Start</button>${again}</div>`;
  $("ld-again").onclick = chooseFolder; $("ld-start").onclick = () => startRound(R);
}
async function chooseFolder() {
  let h; try { h = await window.showDirectoryPicker({ mode: "readwrite" }); } catch (e) { return; }   // cancelled
  try { renderReport(await scanFolder(h)); } catch (e) { $("ld-report").style.display = ""; $("ld-report").innerHTML = '<div class="ldmsg bad">Could not read the folder: ' + esc(e) + '</div><div class="btns"><button id="ld-again">Choose a different folder</button></div>'; $("ld-again").onclick = chooseFolder; }
}
async function init() {
  if (!window.showDirectoryPicker) {
    $("ld-pick").style.display = "none"; const u = $("ld-unsupported"); u.style.display = "";
    u.textContent = "This page needs a browser that can read and write a folder: use Chrome or Edge on a computer. Firefox and Safari do not support this.";
    return;
  }
  $("ld-choose").onclick = chooseFolder;
}
async function startRound(R) {
  clips = R.clips; cfg.round = R.name; $("h-round").textContent = "round: " + cfg.round;
  $("loader").style.display = "none";
  await refreshSaved();
  const h = decodeURIComponent(location.hash.slice(1)); const i = Math.max(0, clips.findIndex(c => c.clip_id === h));
  await loadClip(i);
  requestAnimationFrame(loop);
}
async function refreshSaved() {
  savedMap = {};
  for (const c of clips) { const a = await jget("annotations/" + c.clip_id + ".json"); if (a) savedMap[c.clip_id] = a; }
}
const round4 = t => +t.toFixed(4);

async function loadClip(i) {
  clearTimeout(saveTimer);
  if (idx >= 0 && dirty && !(await save(true))) return;     // failed save: stay on this clip, the red message stays
  idx = i; const c = clips[i];
  D = await jget(c.data); let a = await jget("annotations/" + c.clip_id + ".json");
  let isPrior = false;
  if (!a) { a = await jget("prior/" + c.clip_id + ".json"); isPrior = !!a; }
  const fromPrior = isPrior && Array.isArray(a.flaps_video_s) && a.flaps_video_s.length > 0;
  S = { flaps: [], unsure: [], obs: [], pend: null, confidence: "high", note: "", done: false, unusable: false, fromPrior };
  lastSaved = null;
  if (a) {
    S.flaps = (a.flaps_video_s || []).map(Number).sort((p, q) => p - q);
    S.unsure = (a.unsure_video_s || []).map(Number).filter(u => S.flaps.some(f => same(f, u)));
    S.confidence = a.confidence === "low" ? "low" : "high"; S.note = a.note || "";
    if (!isPrior) {
      S.done = !!a.done; S.unusable = !!a.unusable; lastSaved = a.saved_at || null;
      S.obs = normWin(winList(a.observed_s).map(w => [Number(w[0]), Number(w[1])]));
    }
  }
  undoStack = []; dirty = false; saveErr = null; drag = null; $("c-win").checked = false;
  location.hash = c.clip_id;
  vid.loop = $("c-loop").checked;
  if (curURL) URL.revokeObjectURL(curURL);
  const vf = await fileAt(c.file); curURL = vf ? URL.createObjectURL(vf) : null;
  zoomReset();
  if (curURL) { vid.src = curURL; await new Promise(res => { vid.onloadeddata = res; vid.onerror = res; vid.load(); }); } else { vid.removeAttribute("src"); vid.load(); }
  vid.currentTime = 0.5 / FPS;
  syncUI(); resize(); updateList(); setState(); updateLabels();
}

// ---- state / saving ----------------------------------------------------------------------------
function snapshot() { return { flaps: S.flaps.slice(), unsure: S.unsure.slice(), obs: S.obs.map(w => w.slice()) }; }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 200) undoStack.shift(); }
function restore(s) { S.flaps = s.flaps.slice(); S.unsure = s.unsure.slice(); S.obs = s.obs.map(w => w.slice()); S.pend = null; syncUI(); updateLabels(); }
function touch() { dirty = true; setState(); updateLabels(); clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (dirty && D) save(true); }, AUTOSAVE_MS); }
function setFlaps(arr) {
  pushUndo(); S.flaps = arr.slice().sort((a, b) => a - b);
  S.unsure = S.unsure.filter(u => S.flaps.some(f => same(f, u))); touch();      // a deleted mark takes its unsure flag with it
}
const isUnsureT = t => S.unsure.some(u => same(u, t));
function payload() {
  const kept = S.flaps.filter(inObs), fl = kept.map(round4);     // marks outside the windows are not saved
  return {
    tool_version: TOOL_VERSION, round: cfg.round, clip_id: D.clip_id, session: D.session, clip_start_video_s: D.clip_start, core_video_s: D.core,
    observed_s: S.obs.map(w => w.map(round4)), unusable: S.unusable,
    flaps_video_s: fl, unsure_video_s: kept.filter(isUnsureT).map(round4), flaps_clip_frame: kept.map(frameOf),
    n_flaps: kept.length, n_flaps_in_core: kept.filter(t => t >= D.core[0] - 1e-6 && t <= D.core[1] + 1e-6).length,
    source: "blank", use_log: [], shift_s: null, confidence: S.confidence, note: S.note, done: S.done,
    saved_at: new Date().toISOString(),
    ...(D.exercise ? { exercise: D.exercise } : {}),
    ...(D.event_type ? { event_type: D.event_type } : {}),
  };
}
function save(quiet) { const r = saveChain.then(doSave); saveChain = r.catch(() => {}); return r; }
async function doSave() {
  if (!D) return false;
  const p = payload(), id = D.clip_id;
  try {
    const dir = await root.getDirectoryHandle("annotations", { create: true });
    let old = null; try { old = await (await dir.getFileHandle(id + ".json")).getFile(); } catch (e) { /* first save */ }
    if (old) { const bk = await (await dir.getFileHandle(id + ".json.bak", { create: true })).createWritable(); await bk.write(await old.text()); await bk.close(); }
    const w = await (await dir.getFileHandle(id + ".json", { create: true })).createWritable(); await w.write(JSON.stringify(p, null, 1)); await w.close();
    dirty = false; saveErr = null; lastSaved = p.saved_at; savedMap[id] = p; S.fromPrior = false;
  } catch (e) { saveErr = "SAVE FAILED, your changes are NOT saved: " + (e && e.message || e); setState(); return false; }
  setState(); updateList(); return true;
}
function setState(msg) {
  const el = $("h-state"); if (saveErr) msg = saveErr;
  if (msg) { el.textContent = msg; el.className = saveErr ? "state err" : "state unsaved"; return; }
  if (!D) return;
  const t = lastSaved ? new Date(lastSaved).toLocaleTimeString() : null;
  let txt = dirty ? "unsaved changes" : (t ? "saved " + t : "nothing saved yet");
  if (S.unusable) txt += " | UNUSABLE"; else if (S.done) txt += " | DONE";
  el.textContent = txt; el.className = "state " + (dirty ? "unsaved" : S.done ? "done" : t ? "saved" : "");
  $("b-done").textContent = S.done ? "Done (click to reopen)" : "Mark as done"; $("b-done").classList.toggle("done", S.done);
  $("b-unus").textContent = S.unusable ? "Unusable (click to undo)" : "Unusable clip"; $("b-unus").classList.toggle("on", S.unusable);
  $("h-prior").style.display = S.fromPrior ? "" : "none";
  $("b-undo").disabled = !undoStack.length;
}
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

// ---- UI building -------------------------------------------------------------------------------
function updateLabels() {
  if (!S) return;
  const L = $("labels"); L.style.height = TOTAL_H + "px";
  if (!L.firstChild) { const d = document.createElement("div"); d.className = "lab sel"; d.style.top = ROWS[1].y + "px"; d.style.height = ROWS[1].h + "px"; d.innerHTML = '<span class="nm"></span>'; L.appendChild(d); }
  L.firstChild.querySelector(".nm").innerHTML = blankName() + `<br><small>${S.flaps.length} marks, ${S.unsure.length} unsure</small>`;
}
function statusOf(a) { return !a ? "not started" : a.unusable ? "unusable" : a.done ? "done" : "in progress"; }
function updateList() {
  const ul = $("cliplist"); ul.innerHTML = "";
  clips.forEach((c, i) => {
    const li = document.createElement("li"); if (i === idx) li.className = "cur";
    const st = statusOf(savedMap[c.clip_id]), cls = { "done": "mk", "in progress": "ip", "unusable": "uu", "not started": "ns" }[st];
    li.innerHTML = `<span>${i + 1}. ${esc(c.session)} ${c.clip_start} s<small>${esc(c.clip_id)}</small></span><span class="${cls}">${st}</span>`;
    li.onclick = () => { if (i !== idx) loadClip(i); }; ul.appendChild(li);
  });
  $("h-clip").textContent = `clip ${idx + 1} of ${clips.length}`;
  $("h-session").textContent = D ? `${D.session} | ${D.clip_id}` : "";
}
function syncUI() {
  $("conf").value = S.confidence; $("note").value = S.note;
  const instr = (D.mark_label ? D.mark_label + ". " : "") + "Marks and windows are in video time. Tick Edit windows and click start and end to mark the parts of the clip you could judge; with no window the whole clip counts.";
  $("instr").textContent = instr; $("instr").style.display = "block";
  $("inset").style.display = D.boxes.some(b => b[1] !== null) ? "block" : "none";
}
function setMode(m) {
  mode = m; $("m-add").classList.toggle("on", m === "add"); $("m-move").classList.toggle("on", m === "move");
  lc.className = "m-" + m;
  $("modehint").textContent = { seek: "click on the strip: jump to that time", add: "left click: add mark | right click: delete nearest", move: "drag a mark" }[m];
}

let flashT = null;
function flash(msg) { const e = $("flash"); e.textContent = msg; e.style.display = "inline"; clearTimeout(flashT); flashT = setTimeout(() => { e.style.display = "none"; }, 2000); }
const HANDLE_PX = 6;
// observed_s: a list of [start, end] windows; files saved before 2026-11-08 hold one flat [start, end] (one window)
function winList(o) {
  if (!Array.isArray(o)) return [];
  if (o.length === 2 && !Array.isArray(o[0]) && !Array.isArray(o[1])) return [[Number(o[0]), Number(o[1])]];
  return o.filter(w => Array.isArray(w) && w.length === 2);
}
function normWin(ws) {   // sort, clip to the clip span, merge overlaps
  const sp = spanOf(), out = [];
  for (const w of ws.map(w => [clamp(Math.min(...w), sp[0], sp[1]), clamp(Math.max(...w), sp[0], sp[1])]).filter(w => w[1] - w[0] > 1e-6).sort((p, q) => p[0] - q[0])) {
    if (out.length && w[0] <= out[out.length - 1][1] + 1e-6) out[out.length - 1][1] = Math.max(out[out.length - 1][1], w[1]); else out.push(w);
  }
  return out;
}
function inObs(t) { return !S.obs.length || S.obs.some(w => t >= w[0] - 1e-6 && t <= w[1] + 1e-6); }
const editWin = () => $("c-win").checked;
function winClick(vt) {   // Edit windows ticked: first click = start, second = end
  const t = snap(vt);
  if (S.pend === null) { S.pend = t; return; }
  if (Math.abs(t - S.pend) < 1e-6) return;
  pushUndo(); S.obs = normWin(S.obs.concat([[S.pend, t]])); S.pend = null; touch();
}
function edgeAt(x) {
  let best = null, bd = HANDLE_PX + 1e-9;
  S.obs.forEach((w, i) => [0, 1].forEach(k => { const d = Math.abs(xOf(w[k]) - x); if (d <= bd) { bd = d; best = { i, k }; } }));
  return best;
}
function winIndexAt(t) { return S.obs.findIndex(w => t >= w[0] && t <= w[1]); }

// ---- drawing -----------------------------------------------------------------------------------
function resize() {
  if (!D) return;
  const dpr = window.devicePixelRatio || 1, w = lc.clientWidth;
  lc.style.height = TOTAL_H + "px"; lc.width = Math.round(w * dpr); lc.height = Math.round(TOTAL_H * dpr);
  const ov = $("boxov"); ov.width = ov.clientWidth; ov.height = ov.clientHeight;
  draw();
}
window.addEventListener("resize", resize);

const w_ = () => lc.clientWidth;
function draw() {
  if (!D || !S) return;
  const dpr = window.devicePixelRatio || 1, ctx = lc.getContext("2d"), w = lc.clientWidth;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, TOTAL_H);
  const ax = ROWS[0]; ctx.font = "11px system-ui"; ctx.textAlign = "center";
  for (let t = Math.ceil(cs()); t <= cs() + D.duration; t++) {
    const x = xOf(t); ctx.fillStyle = "#555"; ctx.fillRect(x, ax.y + 14, 1, 8); ctx.fillStyle = "#cfd3d8"; ctx.fillText(t + " s", x, ax.y + 11);
  }
  const r = ROWS[1];
  ctx.fillStyle = "#1d2025"; ctx.fillRect(0, r.y, w, r.h); ctx.strokeStyle = MARKCOL; ctx.lineWidth = 2; ctx.strokeRect(1, r.y - 1, w - 2, r.h + 2);
  S.flaps.forEach((t, i) => {
    const x = Math.round(xOf(t)) + .5, u = isUnsure(i), cy = r.y + r.h / 2;
    ctx.strokeStyle = !inObs(t) ? OUTCOL : u ? UNSURECOL : MARKCOL; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x, r.y + 2); ctx.lineTo(x, r.y + r.h - 2); ctx.stroke();
    if (u) {   // hollow diamond on the line: unsure
      ctx.fillStyle = "#1d2025"; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(x, cy - 7); ctx.lineTo(x + 6, cy); ctx.lineTo(x, cy + 7); ctx.lineTo(x - 6, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  });
  if (S.obs.length) {   // grey out everything outside the windows (all rows)
    ctx.fillStyle = "rgba(20,22,25,0.72)"; let x = 0;
    for (const w of S.obs) { const a = xOf(w[0]); if (a > x) ctx.fillRect(x, 0, a - x, TOTAL_H); x = Math.max(x, xOf(w[1])); }
    if (x < w_()) ctx.fillRect(x, 0, w_() - x, TOTAL_H);
    ctx.strokeStyle = "#4da3ff"; ctx.lineWidth = editWin() ? 3 : 1.5;
    for (const w of S.obs) for (const t of w) { const xx = Math.round(xOf(t)) + .5; ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, TOTAL_H); ctx.stroke(); }
  }
  if (S.pend !== null) { ctx.strokeStyle = "#4da3ff"; ctx.setLineDash([4, 3]); ctx.lineWidth = 2; const xx = Math.round(xOf(S.pend)) + .5; ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, TOTAL_H); ctx.stroke(); ctx.setLineDash([]); }
  if (hover !== null) { ctx.strokeStyle = "#ffffff55"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(xOf(hover)) + .5, 0); ctx.lineTo(Math.round(xOf(hover)) + .5, TOTAL_H); ctx.stroke(); }
  const px = xOf(curVT()); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, TOTAL_H); ctx.stroke();
}
function isUnsure(i) { return drag && drag.orig && drag.i === i ? drag.wasUnsure : isUnsureT(S.flaps[i]); }

// ---- box / inset -------------------------------------------------------------------------------
function boxAt(vt) {
  const B = D.boxes; let lo = -1;
  for (let i = 0; i < B.length; i++) { if (B[i][0] <= vt + 1e-9) lo = i; else break; }
  const a = lo >= 0 ? B[lo] : null, b = lo + 1 < B.length ? B[lo + 1] : null;
  const ok = r => r && r[1] !== null;
  if (ok(a) && ok(b) && b[0] > a[0]) { const f = clamp((vt - a[0]) / (b[0] - a[0]), 0, 1); return [1, 2, 3, 4].map(k => a[k] + f * (b[k] - a[k])); }
  const near = [a, b].filter(ok).sort((p, q) => Math.abs(p[0] - vt) - Math.abs(q[0] - vt))[0];
  if (near && Math.abs(near[0] - vt) <= 0.25) return near.slice(1);
  return null;
}
function drawInset() {
  const vw = vid.videoWidth || 1920, vh = vid.videoHeight || 1080;
  ictx.fillStyle = "#111"; ictx.fillRect(0, 0, 300, 300);
  const bx = boxAt(cs() + vid.currentTime);
  const ov = $("boxov"), o = ov.getContext("2d"); o.clearRect(0, 0, ov.width, ov.height);
  if (!bx) { ictx.fillStyle = "#777"; ictx.font = "14px system-ui"; ictx.fillText("no box", 12, 24); return; }
  const [x0, y0, x1, y1] = bx; const bw = x1 - x0, bh = y1 - y0;
  const side = Math.min(Math.max(Math.max(bw, bh) * 2.0, 120), vh);   // padded 0.5 per side, min 120 px (as the talk demo)
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const sx = clamp(cx - side / 2, 0, vw - side), sy = clamp(cy - side / 2, 0, vh - side);
  try { ictx.drawImage(vid, sx, sy, side, side, 0, 0, 300, 300); } catch (e) {}
  ictx.strokeStyle = "#ffe14d"; ictx.lineWidth = 1.5; const k = 300 / side; ictx.strokeRect((x0 - sx) * k, (y0 - sy) * k, bw * k, bh * k);
  const kx = ov.width / vw, ky = ov.height / vh;
  o.strokeStyle = "#ffe14d99"; o.lineWidth = 1; o.strokeRect(x0 * kx, y0 * ky, bw * kx, bh * ky);
  o.strokeStyle = "#fff8"; o.strokeRect(sx * kx, sy * ky, side * kx, side * ky);
}

function updateWarnings() {
  const f = S.flaps.slice().sort((a, b) => a - b); let close = 0;
  for (let i = 1; i < f.length; i++) if (f[i] - f[i - 1] <= CLOSE_MARK_S + 1e-6) close++;
  const out = S.flaps.filter(t => !inObs(t)).length;
  const wc = $("w-close"), wo = $("w-out");
  wc.style.display = close ? "block" : "none";
  wc.textContent = close ? `${close} pair${close > 1 ? "s" : ""} of marks ${CLOSE_MARK_S} s apart or closer. Check that they are separate wing tops.` : "";
  wo.style.display = out ? "block" : "none";
  wo.textContent = out ? `${out} mark${out > 1 ? "s" : ""} outside the windows (red): not saved. Move or remove ${out > 1 ? "them" : "it"}, or undo the window.` : "";
}
function loop() {
  if (D && S) {
    $("h-time").textContent = `video t = ${fmt(curVT())} s | frame ${curFrame()} / ${D.n_frames - 1}`;
    drawInset(); draw(); updateWarnings();
  }
  requestAnimationFrame(loop);
}

// ---- lane mouse interaction --------------------------------------------------------------------
const evX = e => e.clientX - lc.getBoundingClientRect().left;
const evY = e => e.clientY - lc.getBoundingClientRect().top;
function nearestIdx(vt, maxPx) {   // nearest mark
  let best = -1, bd = Infinity;
  S.flaps.forEach((t, i) => { const d = Math.abs(xOf(t) - xOf(vt)); if (d < bd) { bd = d; best = i; } });
  return best >= 0 && (maxPx === undefined || bd <= maxPx) ? best : -1;
}
function addFlap(vt) {
  const t = snap(vt);
  if (!inObs(t)) { flash("Outside the observed window"); return false; }
  if (S.flaps.some(f => same(f, t))) return false;
  setFlaps(S.flaps.concat([t])); return true;
}
function toggleAt(vt) {
  // Space: remove the mark on the displayed frame if there is one, else add one there
  const t = snap(vt), i = S.flaps.findIndex(f => same(f, t));
  if (i < 0) return addFlap(vt);
  const a = S.flaps.slice(); a.splice(i, 1); setFlaps(a); return true;
}
function delNearest(vt) {
  const i = nearestIdx(vt); if (i < 0) return false;
  const a = S.flaps.slice(); a.splice(i, 1); setFlaps(a); return true;
}
function toggleUnsure(vt) {
  const i = nearestIdx(vt); if (i < 0) { flash("No mark to flag"); return false; }
  pushUndo(); const t = S.flaps[i];
  if (isUnsureT(t)) S.unsure = S.unsure.filter(u => !same(u, t)); else S.unsure.push(t);
  touch(); return true;
}
lc.addEventListener("contextmenu", e => {
  e.preventDefault();
  if (editWin()) {
    const i = winIndexAt(tOfX(evX(e)));
    if (i >= 0) { pushUndo(); S.obs.splice(i, 1); touch(); }
    return;
  }
  if (mode === "add") delNearest(tOfX(evX(e)));
});
lc.addEventListener("mousedown", e => {
  if (!D || e.button !== 0) return;
  if (editWin()) {
    const ed = edgeAt(evX(e));
    if (ed) drag = { edge: ed, before: S.obs.map(w => w.slice()) }; else winClick(tOfX(evX(e)));
    return;
  }
  const vt = tOfX(evX(e));
  if (mode === "add") addFlap(vt);
  else if (mode === "move") {
    const i = nearestIdx(vt, 10);
    if (i >= 0) drag = { i, orig: S.flaps.slice(), t: S.flaps[i], wasUnsure: isUnsureT(S.flaps[i]) };
  } else { drag = { seek: true }; seekVT(vt); }
});
window.addEventListener("mousemove", e => {
  if (!D) return;
  const r = lc.getBoundingClientRect(), inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (drag && drag.seek) { seekVT(tOfX(clamp(evX(e), 0, W()))); return; }
  if (drag && drag.edge) {
    const t = snap(tOfX(clamp(evX(e), 0, W()))), sp = spanOf(), w = S.obs[drag.edge.i];
    if (drag.edge.k === 0) w[0] = clamp(t, sp[0], w[1] - 1 / FPS); else w[1] = clamp(t, w[0] + 1 / FPS, sp[1]);
    return;
  }
  if (drag && drag.orig) {
    const t = snap(tOfX(clamp(evX(e), 0, W()))); drag.t = t; S.flaps[drag.i] = t; return;
  }
  if (inside) { hover = tOfX(evX(e)); showTip(e); lc.style.cursor = editWin() ? (edgeAt(evX(e)) ? "ew-resize" : "crosshair") : ""; } else { hover = null; $("tip").style.display = "none"; }
});
window.addEventListener("mouseup", () => {
  if (drag && drag.edge) {
    const now = S.obs.map(w => w.slice()), changed = JSON.stringify(now) !== JSON.stringify(drag.before);
    if (changed) { S.obs = drag.before; pushUndo(); S.obs = normWin(now); touch(); }
  } else if (drag && drag.orig) {
    const others = drag.orig.filter((_, k) => k !== drag.i);
    if (others.some(f => same(f, drag.t)) || Math.abs(drag.t - drag.orig[drag.i]) < 1e-6) S.flaps = drag.orig;
    else {
      const after = S.flaps.slice().sort((a, b) => a - b);
      S.flaps = drag.orig; pushUndo();
      S.flaps = after;
      S.unsure = S.unsure.filter(u => !same(u, drag.orig[drag.i]));
      if (drag.wasUnsure) S.unsure.push(drag.t);               // the flag moves with its mark
      touch();
    }
  }
  drag = null;
});
function showTip(e) {
  const tip = $("tip"), y = evY(e), vt = tOfX(evX(e));
  let txt = `video t = ${fmt(vt)} s`;
  if (y >= ROWS[1].y) txt = `${blankName()}: ${S.flaps.length} marks, ${S.unsure.length} unsure\n${fmt(vt)} s`;
  tip.textContent = txt; tip.style.display = "block"; tip.style.left = (e.clientX + 12) + "px"; tip.style.top = (e.clientY + 14) + "px";
}

// ---- zoom (CSS transform on the video + box overlay; the inset is outside it) -------------------
const stage = $("stage");
const fullView = { x: 0, y: 0, w: 1, h: 1 };
const zoomView = () => zoomStack.length ? zoomStack[zoomStack.length - 1] : fullView;
function applyZoom() {
  const v = zoomView();
  $("zoomwrap").style.transform = zoomStack.length ? `scale(${1 / v.w}) translate(${-v.x * 100}%, ${-v.y * 100}%)` : "";
  $("b-zreset").disabled = !zoomStack.length;
}
function zoomReset() { zoomStack = []; zdrag = null; $("zrect").style.display = "none"; applyZoom(); }
function zoomBox(e) {   // the dragged rectangle widened to the stage's shape, in stage pixels
  const r = stage.getBoundingClientRect(), Sw = r.width, Sh = r.height;
  const px = clamp(e.clientX - r.left, 0, Sw), py = clamp(e.clientY - r.top, 0, Sh);
  const dx = Math.abs(px - zdrag.x), dy = Math.abs(py - zdrag.y);
  let pw = Math.min(Math.max(dx, dy * Sw / Sh), Sw), ph = pw * Sh / Sw;
  const left = clamp((px + zdrag.x) / 2 - pw / 2, 0, Sw - pw), top = clamp((py + zdrag.y) / 2 - ph / 2, 0, Sh - ph);
  return { left, top, pw, ph, Sw, Sh, small: Math.max(dx, dy) < 10 };
}
stage.addEventListener("mousedown", e => {
  if (!D || e.button !== 0) return;
  const r = stage.getBoundingClientRect(); zdrag = { x: clamp(e.clientX - r.left, 0, r.width), y: clamp(e.clientY - r.top, 0, r.height) };
});
window.addEventListener("mousemove", e => {
  if (!zdrag) return;
  const b = zoomBox(e), el = $("zrect");
  el.style.display = b.small ? "none" : "block";
  el.style.left = b.left + "px"; el.style.top = b.top + "px"; el.style.width = b.pw + "px"; el.style.height = b.ph + "px";
});
window.addEventListener("mouseup", e => {
  if (!zdrag) return;
  const b = zoomBox(e), v = zoomView(); zdrag = null; $("zrect").style.display = "none";
  if (b.small) return;
  zoomStack.push({ x: v.x + b.left / b.Sw * v.w, y: v.y + b.top / b.Sh * v.h, w: b.pw / b.Sw * v.w, h: b.ph / b.Sh * v.h });
  applyZoom();
});
stage.addEventListener("contextmenu", e => { e.preventDefault(); if (zoomStack.length) { zoomStack.pop(); applyZoom(); } });
$("b-zreset").onclick = zoomReset;
applyZoom();

// ---- controls ----------------------------------------------------------------------------------
function togglePlay() { vid.paused ? vid.play() : vid.pause(); }
vid.addEventListener("play", () => $("b-play").textContent = "Pause");
vid.addEventListener("pause", () => $("b-play").textContent = "Play");
$("b-play").onclick = togglePlay;
$("b-back").onclick = () => { vid.pause(); seekFrame(curFrame() - 1); };
$("b-fwd").onclick = () => { vid.pause(); seekFrame(curFrame() + 1); };
function setRate(r) { vid.playbackRate = r; document.querySelectorAll("#speeds button").forEach(b => b.classList.toggle("on", +b.dataset.r === r)); }
document.querySelectorAll("#speeds button").forEach(b => b.onclick = () => setRate(+b.dataset.r));
$("c-loop").onchange = e => { vid.loop = e.target.checked; };
$("m-add").onclick = () => setMode(mode === "add" ? "seek" : "add");
$("m-move").onclick = () => setMode(mode === "move" ? "seek" : "move");
function clearAll() {      // removes every mark; Undo brings them back
  if (!S.flaps.length) return;
  pushUndo(); S.flaps = []; S.unsure = []; touch();
}
function undo() { const s = undoStack.pop(); if (!s) return; restore(s); touch(); }
$("b-undo").onclick = undo;
$("b-clear").onclick = clearAll;
$("c-win").onchange = () => { S.pend = null; lc.style.cursor = ""; };
$("b-export").onclick = exportAll;
$("conf").onchange = e => { S.confidence = e.target.value; touch(); e.target.blur(); };
$("note").oninput = e => { S.note = e.target.value; touch(); };
$("b-save").onclick = () => save();
$("b-done").onclick = async () => { S.done = !S.done; if (!S.done) S.unusable = false; dirty = true; await save(); };
$("b-unus").onclick = async () => { S.unusable = !S.unusable; S.done = S.unusable; dirty = true; await save(); };
$("b-next").onclick = () => { if (idx + 1 < clips.length) loadClip(idx + 1); };
$("b-prev").onclick = () => { if (idx > 0) loadClip(idx - 1); };
document.addEventListener("keydown", e => {
  if (!D || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== "range" && e.target.type !== "checkbox") return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === "z") { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === " ") { e.preventDefault(); toggleAt(curVT()); }
  else if (k === "k") togglePlay();
  else if (k === "q") { vid.pause(); seekFrame(curFrame() - 1); }
  else if (k === "e") { vid.pause(); seekFrame(curFrame() + 1); }
  else if ("1234".includes(k) && k.length === 1) setRate([0.1, 0.25, 0.5, 1][+k - 1]);
  else if (k === "f") addFlap(curVT());
  else if (k === "u") toggleUnsure(curVT());
  else if (k === "d") delNearest(curVT());
  else if (k === "n") $("b-next").click();
  else if (k === "p") $("b-prev").click();
});
// a focused button would otherwise also be "clicked" by Space (on keyup)
document.addEventListener("keyup", e => { if (e.key === " " && (e.target.tagName === "BUTTON" || e.target.type === "checkbox")) e.preventDefault(); });
setMode("seek"); setRate(1);
function csvCell(v) { v = String(v ?? ""); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
async function exportAll() {
  if (dirty && D) await save(true);
  await refreshSaved(); updateList();
  const head = ["clip_id", "session", "observed_windows", "marks", "unsure_marks", "n_marks", "confidence", "unusable", "done", "note", "saved_at"];
  const rows = [head];
  for (const c of clips) {
    const a = savedMap[c.clip_id]; if (!a) continue;
    const ws = winList(a.observed_s).length ? winList(a.observed_s) : [[c.clip_start, c.clip_start + c.duration]];
    const fl = (a.flaps_video_s || []);
    rows.push([a.clip_id, a.session ?? c.session, ws.map(w => w[0] + "-" + w[1]).join(";"), fl.join(";"), (a.unsure_video_s || []).join(";"), fl.length,
      a.confidence ?? "", !!a.unusable, !!a.done, a.note ?? "", a.saved_at ?? ""]);
  }
  const csv = rows.map(r => r.map(csvCell).join(",")).join("\n") + "\n";
  const el = document.createElement("a");
  el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  el.download = `flap_review_${cfg.round || "round"}.csv`; document.body.appendChild(el); el.click(); el.remove();
}
window.__dbg = () => ({ D, S, mode, idx, dirty, undo: undoStack.length });   // for the test script
init();
