// 浮窗界面：GM 看到控制台，玩家只看到「正在播放 + 自己的音量」。
import { initOBR, createBus, apiGet, apiPost, uploadTrack, mediaDuration, lsGet, lsSet, lsDel, tokenKey, report } from "./lib.js";
import { Engine } from "./engine.js";

window.__appBuild = "build-folders-1";

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.9l11.1-6.86a1.05 1.05 0 0 0 0-1.8L9.56 4.24A1.05 1.05 0 0 0 8 5.14Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.4"/><rect x="14" y="4.5" width="4" height="15" rx="1.4"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.2a1.1 1.1 0 0 1 2.2 0v13.6a1.1 1.1 0 0 1-2.2 0z"/><path d="M19.4 6.1c.7-.44 1.6.06 1.6.9v10.1c0 .84-.9 1.34-1.6.9l-8.7-5.05a1.05 1.05 0 0 1 0-1.8z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 5.2a1.1 1.1 0 0 0-2.2 0v13.6a1.1 1.1 0 0 0 2.2 0z"/><path d="M4.6 6.1c-.7-.44-1.6.06-1.6.9v10.1c0 .84.9 1.34 1.6.9l8.7-5.05a1.05 1.05 0 0 0 0-1.8z"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.60 12.00A7.4 7.4 0 0 1 18.06 7.76"/><path d="M19.27 9.48L16.55 8.82L19.58 6.69Z" fill="currentColor" stroke="none"/><path d="M19.40 12.00A7.4 7.4 0 0 1 5.94 16.24"/><path d="M4.73 14.52L7.45 15.18L4.42 17.31Z" fill="currentColor" stroke="none"/></svg>',
  loop1: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.60 12.00A7.4 7.4 0 0 1 18.06 7.76"/><path d="M19.27 9.48L16.55 8.82L19.58 6.69Z" fill="currentColor" stroke="none"/><path d="M19.40 12.00A7.4 7.4 0 0 1 5.94 16.24"/><path d="M4.73 14.52L7.45 15.18L4.42 17.31Z" fill="currentColor" stroke="none"/><text x="12" y="14.9" text-anchor="middle" font-size="8.6" font-weight="700" fill="currentColor" stroke="none">1</text></svg>',
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6.2c0-.5.3-.9.8-1L18 3.3c.7-.2 1.4.3 1.4 1v1.2c0 .5-.3.9-.8 1L11.5 8v10.2"/><circle cx="6.9" cy="18" r="2.6"/><circle cx="16.4" cy="18" r="2.6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.1c.5 0 1 .2 1.4.6L11.5 7h7A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7"/><path d="M9.5 7V5a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v2"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4.5"/><path d="M7.5 9 12 4.5 16.5 9"/><path d="M4 16.5v2A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-2"/></svg>',
  volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5.5 6.8 9H3.5v6h3.3l4.2 3.5z"/><path d="M15.5 8.7a4.7 4.7 0 0 1 0 6.6"/><path d="M18.2 6a8.4 8.4 0 0 1 0 12"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.8v5"/><path d="M12 16.2v.01"/></svg>',
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\/[\w\-.:/@%?=&#+~]+$/i.test(String(u || "")) ? String(u) : "");
const fmt = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const icon = (n) => `<span aria-hidden="true">${ICON[n] || ""}</span>`;

const S = {
  role: "PLAYER",
  roomId: "",
  now: null,
  state: null,
  status: { connected: true, volume: 0.85 },
  time: 0,
  skew: 0,
  tab: "list",
  busy: "",
  uploading: null,
  notice: null,
  claimError: "",
  biliUrl: "",
  drag: null,
  folderTab: "__all",
  openFolderFor: null,
  ask: null, // 自定义确认框 {text, cmd, action}
  creatingFolder: false,
  sliderActive: false,
  sliderTimer: null,
};

let bus = null;
let engine = null;
let heardBg = false;
let lastSig = "";
let queued = false;

// ---------- 渲染 ----------
function render(force) {
  // 正在拖滑块时绝不重建 DOM：否则 <input> 会被销毁替换，浏览器直接丢掉拖拽，
  // 表现就是"拖不动/一跳一跳"。松手后由 markSlider 的定时器统一补一次渲染。
  if (S.sliderActive) return;
  if (queued && !force) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const sig = JSON.stringify({
      role: S.role,
      tab: S.tab,
      track: S.now?.playback?.trackId,
      playing: S.now?.playback?.playing,
      title: S.now?.track?.title,
      artist: S.now?.track?.artist,
      cover: S.now?.track?.cover,
      list: (S.state?.playlist || []).map((t) => t.id + t.title).join("|"),
      busy: S.busy,
      up: S.uploading ? Math.round(S.uploading.pct * 20) + (S.uploading.done ? "d" : "") : "",
      notice: S.notice?.text || "",
      claim: S.claimError,
      blocked: S.status.blocked,
      buffering: Boolean(S.status.buffering),
      buf: Math.round(Number(S.status.buffered ?? 0)),
      drf: Math.round(Number(S.status.drift ?? 0)),
      connected: S.status.connected,
      hasToken: S.status.hasToken,
      hide: S.state?.settings?.hideTitle,
      err: S.status.error,
      owner: Boolean(S.now?.owner),
      folderTab: S.folderTab,
      folders: (S.state?.folders || []).join("|"),
      fmap: (S.state?.playlist || []).map((t) => t.folder || "").join("|"),
    });
    if (!force && sig === lastSig) return updateLive();
    lastSig = sig;

    const badge = document.getElementById("role");
    badge.textContent = S.role === "GM" ? "DM" : "玩家";
    badge.className = `badge ${S.role === "GM" ? "gm" : ""}`;
    document.getElementById("dot").className =
      "dot" + (S.claimError ? " err" : S.status.connected === false ? " warn" : " on");
    document.getElementById("view").innerHTML = S.role === "GM" ? gmView() : playerView();
    updateLive();
  });
}

function noticeHtml() {
  if (S.notice) {
    return `<div class="notice ${S.notice.kind || ""}">${S.notice.kind === "err" ? icon("alert") : ""}<span>${esc(
      S.notice.text
    )}</span><button class="x" data-act="dismiss">×</button></div>`;
  }
  if (S.role === "GM" && S.claimError) return `<div class="notice err">${icon("alert")}<span>${esc(S.claimError)}</span></div>`;
  if (S.status.error) return `<div class="notice err">${icon("alert")}<span>${esc(S.status.error)}</span></div>`;
  return "";
}

function nowCard(seekable) {
  const track = S.now?.track;
  if (!track) {
    return `<div class="now"><div class="empty">${
      S.role === "GM" ? "歌单是空的 —— 去「添加」放一首" : "GM 还没开始播放"
    }</div></div>`;
  }
  const dur = Number(track.duration || 0);
  const pct = dur > 0 ? Math.min(100, (S.time / dur) * 100) : 0;
  const cover = safeUrl(track.cover);
  // 隐藏曲目时服务端会把 title/artist 抹成 null。GM 自己有完整歌单，查回来显示真名；
  // 玩家查不到，就显示一个中性词，而不是"未命名"。
  const hidden = Boolean(S.now?.hidden);
  const own = hidden ? (S.state?.playlist || []).find((t) => t.id === track.id) : null;
  const title = own?.title || (hidden ? "背景音乐" : track.title || "未命名");
  const artist = own?.artist || (hidden ? "" : track.artist || "");
  return `<div class="now">
    ${cover ? `<div class="art" style="background-image:url('${cover}')"></div>` : ""}
    <div class="now-body">
      <div class="label">${
        S.status.buffering && S.now.playback.playing
          ? '<span class="pulse"></span>缓冲中…'
          : S.now.playback.playing
          ? '<span class="pulse"></span>正在播放'
          : "已暂停"
      }</div>
      <div class="title">${esc(title)}</div>
      <div class="artist">${esc(artist)}</div>
      <div class="progress ${seekable ? "seekable" : ""}" ${seekable ? 'data-act="seek"' : ""}>
        <span class="time" data-pos>${fmt(S.time)}</span>
        <div class="bar"><div class="fill" data-fill style="width:${pct}%"></div>${
          seekable ? `<div class="knob" data-knob style="left:${pct}%"></div>` : ""
        }</div>
        <span class="time" data-dur>${dur > 0 ? fmt(dur) : "--:--"}</span>
      </div>
    </div>
  </div>`;
}

function gmView() {
  const p = S.now?.playback;
  const list = S.state?.playlist || [];
  const loop = p?.loop || "list";
  const transport = `<div class="transport">
    <button class="tbtn" data-act="prev" ${list.length ? "" : "disabled"}>${icon("prev")}</button>
    <button class="tbtn play" data-act="toggle" ${S.now?.track || list.length ? "" : "disabled"}>${icon(
    p?.playing ? "pause" : "play"
  )}</button>
    <button class="tbtn" data-act="next" ${list.length ? "" : "disabled"}>${icon("next")}</button>
    <button class="tbtn loop-btn ${loop === "track" ? "active" : ""}" data-act="loop" onclick="window.__bardLoop()" data-loop="${
    loop === "track" ? "track" : "list"
  }" title="${loop === "track" ? "单曲循环：开（一直重复这首）" : "单曲循环：关（按列表依次播放）"}">${icon(loop === "track" ? "loop1" : "loop")}</button>
  </div>`;

  const tabs = `<div class="tabs">${[
    ["list", "歌单"],
    ["add", "添加"],
    ["settings", "设置"],
  ]
    .map(([k, t]) => `<button class="tab ${S.tab === k ? "active" : ""}" data-act="tab" data-tab="${k}">${t}</button>`)
    .join("")}</div>`;

  const body = S.tab === "add" ? addView() : S.tab === "settings" ? settingsView() : listView(list);
  const blocked = S.status.blocked
    ? `<button class="unlock" data-act="unlock">${icon("volume")}浏览器拦截了声音，点这里开启</button>`
    : "";
  return noticeHtml() + nowCard(true) + transport + blocked + tabs + body;
}

/** 插件自带的确认框：OBR 的 iframe 里 window.confirm/prompt 会被静默屏蔽。 */
function askConfirm(text, cmd, action = "") {
  S.ask = { text, cmd, action };
  render(true);
}

function askHtml() {
  if (!S.ask) return "";
  return `<div class="ask"><div class="ask-text">${esc(S.ask.text)}</div>
    <div class="ask-btns"><button class="btn" data-act="ask-yes">确定</button><button class="btn ghost" data-act="ask-no">取消</button></div></div>`;
}

function newFolderHtml() {
  if (!S.creatingFolder) return "";
  return `<div class="chips"><input class="folder-input" maxlength="24" placeholder="新分类名字，比如 城镇 / 恐怖 / 休整" />
    <button class="chip active" data-act="folder-create-ok">确定</button>
    <button class="chip" data-act="folder-create-cancel">取消</button></div>`;
}
function folderBar() {
  const folders = S.state?.folders || [];
  const tab = S.folderTab || "__all";
  const chip = (key, label, extra = "") =>
    `<button class="chip ${tab === key ? "active" : ""}" data-act="folder-tab" data-folder="${esc(key)}">${esc(label)}${extra}</button>`;

  const uncategorized = (S.state?.playlist || []).filter((t) => !t.folder).length;
  const chips = [
    chip("__all", "全部"),
    ...folders.map((f) =>
      chip(f, f, tab === f ? `<span class="chip-x" data-act="folder-del" data-folder="${esc(f)}" title="删除这个分类">×</span>` : "")
    ),
  ];
  if (uncategorized || !folders.length) chips.push(chip("__none", "未分类"));
  chips.push(`<button class="chip chip-add" data-act="folder-new" title="新建分类">＋</button>`);

  return `<div class="chips">${chips.join("")}</div>` + newFolderHtml();
}

function listView(list) {
  const folders = S.state?.folders || [];
  const tab = S.folderTab || "__all";
  // __all = 全部，__none = 未分类（空字符串不能当标记用，会被 || 吞掉）
  const target = tab === "__none" ? "" : tab;
  const shown = tab === "__all" ? list : list.filter((t) => (t.folder || "") === target);

  const bar = folderBar();
  if (!list.length) {
    return `${bar}<div class="empty">${icon("music")}<div>还没有曲目</div><div>切到「添加」，放本地文件或粘贴 B 站链接</div></div>`;
  }
  if (!shown.length) {
    return `${bar}<div class="empty">${icon("music")}<div>这个分类还是空的</div><div>切到「添加」上传，曲目会进到当前分类</div></div>`;
  }

  const cur = S.now?.playback?.trackId;
  const rows = shown
    .map((t, i) => {
      const on = t.id === cur;
      const open = S.openFolderFor === t.id;

      // 展开的「移到分类」菜单：用按钮而不是原生下拉，点得准、触屏也能用
      const menu = open
        ? `<div class="folder-menu">${["", ...folders]
            .map(
              (f) =>
                `<button class="chip ${(t.folder || "") === f ? "active" : ""}" data-act="set-folder" data-id="${esc(t.id)}" data-folder="${esc(f)}" onclick="window.__bardSetFolder(this)">${esc(f || "未分类")}</button>`
            )
            .join("")}<button class="chip chip-add" data-act="folder-new">＋</button></div>`
        : "";

      return `<div class="row ${on ? "playing" : ""}">
      <span class="idx">${on ? "▶" : i + 1}</span>
      <div class="row-main" data-act="pick" data-id="${esc(t.id)}">
        <div class="row-title">${esc(t.title || "未命名")}</div>
        <div class="row-sub"><span class="tag ${t.kind}">${t.kind === "bilibili" ? "B站" : "本地"}</span>
          <span>${esc(t.artist || "")}</span>${
            t.folder ? `<span class="tag folder-tag">${esc(t.folder)}</span>` : ""
          }${t.duration > 0 ? `<span>${fmt(t.duration)}</span>` : ""}</div>
      </div>
      <button class="icon-btn folder-btn ${open ? "active" : ""}" data-act="row-folder" data-id="${esc(t.id)}" title="移到分类">${icon(
        "folder"
      )}</button>
      <button class="icon-btn" data-act="remove" data-id="${esc(t.id)}">${icon("trash")}</button>
    </div>${menu}`;
    })
    .join("");

  const where = tab === "__all" ? "" : ` · 当前分类：${esc(tab === "__none" ? "未分类" : tab)}`;
  return askHtml() + bar + rows + `<div class="foot">共 ${shown.length} 首${where} · 点标题立即切换</div>`;
}

function addView() {
  const up = S.uploading;
  return `
  <div class="field">
    <div class="label">本地音乐 <span class="hint">mp3 / m4a / ogg / wav</span></div>
    <div class="drop" data-act="pick-file">${icon("upload")}<div>点击选择，或把音频拖进来</div>
      <small>上传后全房间都能听到</small></div>
    <input class="hidden" id="file" type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav,.flac" multiple />
    ${up ? `<div class="notice">${up.done ? "" : '<span class="spin"></span>'}<span>${
      up.done ? `已完成 ${up.done} 个` : `${esc(up.name)} · ${Math.round(up.pct * 100)}%`
    }</span></div>` : ""}
  </div>
  <div class="field">
    <div class="label">B 站视频 <span class="hint">只取音轨</span></div>
    <div class="row2">
      <input class="input" id="bili" placeholder="粘贴视频链接 / BV 号" value="${esc(S.biliUrl)}" />
      <button class="btn primary" data-act="add-bili" ${S.busy === "bili" ? "disabled" : ""}>${
    S.busy === "bili" ? "解析中…" : "添加"
  }</button>
    </div>
    <div class="foot" style="text-align:left;padding-top:6px">支持 bilibili.com/video/BV…、b23.tv 短链、av 号</div>
  </div>`;
}

function settingsView() {
  const ask = askHtml();
  const st = S.state?.settings || {};
  const master = Math.round((S.now?.playback?.volume ?? 1) * 100);
  const mine = Math.round((S.status.volume ?? 0.85) * 100);
  return ask + `
  <div class="section">播放</div>
  <div class="setting"><div class="setting-main"><div class="setting-title">我的音量</div>
    <div class="setting-desc">只影响你自己</div></div></div>
  <div class="vol"><input type="range" min="0" max="100" value="${mine}" data-act="vol" /><span class="vol-val">${mine}%</span></div>
  <div class="setting"><div class="setting-main"><div class="setting-title">全房间音量</div>
    <div class="setting-desc">广播给所有玩家，玩家还能各自再调</div></div></div>
  <div class="vol"><input type="range" min="0" max="100" value="${master}" data-act="master-vol" /><span class="vol-val" data-master>${master}%</span></div>

  <div class="section">可见性</div>
  <div class="setting"><div class="setting-main"><div class="setting-title">对玩家显示曲目</div>
    <div class="setting-desc">关掉后玩家只看到「正在播放」</div></div>
    <button class="switch ${st.hideTitle ? "" : "on"}" data-act="toggle-hide"></button></div>

  <div class="section">状态</div>
  <div class="kv"><span>同步服务</span><span>${S.status.connected === false ? "未连接" : "已连接"}</span></div>
  <div class="kv"><span>音频引擎</span><span>${S.status.kind === "background" ? "后台常驻" : "浮窗内"}</span></div>
  <div class="kv"><span>声音</span><span>${
    S.status.error ? esc(S.status.error) : S.status.blocked ? "被浏览器拦截（点上方按钮）" : "正常"
  }</span></div>
  <div class="kv"><span>缓冲余量</span><span>${Number(S.status.buffered ?? 0).toFixed(1)} 秒</span></div>
  <div class="kv"><span>同步偏差</span><span>${Number(S.status.drift ?? 0).toFixed(1)} 秒</span></div>
  <div class="kv"><span>播放速度</span><span>${Number(S.status.rate ?? 1).toFixed(2)}×</span></div>
  <div class="kv"><span>房间号</span><span>${esc(S.roomId.slice(0, 12))}…</span></div>
  <div class="kv"><span>控制权</span><span>${S.status.hasToken ? "已取得" : "未取得"}</span></div>
  <div class="kv"><span>曲目数</span><span>${S.state?.playlist?.length ?? 0}</span></div>
  <div class="row2" style="margin-top:14px">
    <button class="btn block" data-act="reclaim">重新取得控制权</button>
    <button class="btn block" data-act="release">让出控制权</button>
  </div>
  <div class="foot">控制权靠心跳保持，关掉浏览器 90 秒后别人可接管。</div>`;
}

function playerView() {
  const hasTrack = Boolean(S.now?.track);
  const vol = Math.round((S.status.volume ?? 0.85) * 100);
  // 房间还没人控制：给主持一个入口（OBR 偶尔会把 GM 报成 PLAYER）
  const canClaim = !S.now?.owner;
  return `
  ${nowCard(false)}
  ${S.status.blocked ? `<button class="unlock" data-act="unlock">${icon("volume")}开启声音</button>` : ""}
  ${
    canClaim
      ? `<button class="btn block" data-act="reclaim" style="margin-bottom:12px">我是主持，取得播放控制权</button>`
      : `<div class="player-note">音乐由 GM 统一播放，你只能调节自己的音量。关闭面板也不会中断。</div>`
  }
  <div class="field">
    <div class="label">我的音量 <span class="hint">${vol}%</span></div>
    <div class="vol"><input type="range" min="0" max="100" value="${vol}" data-act="vol" /></div>
  </div>
  ${hasTrack ? "" : '<div class="player-note">GM 一开始播放，你就会自动听到。</div>'}`;
}

// 把进度条画到指定位置（拖动时由指针驱动，不走轮询）
function paintProgress(time, dur) {
  const pct = dur > 0 ? Math.min(100, (Math.max(0, time) / dur) * 100) : 0;
  const fill = document.querySelector("[data-fill]");
  const knob = document.querySelector("[data-knob]");
  const pos = document.querySelector("[data-pos]");
  if (fill) fill.style.width = `${pct}%`;
  if (knob) knob.style.left = `${pct}%`;
  if (pos) pos.textContent = fmt(time);
}

function updateLive() {
  if (S.drag) return; // 拖动过程中不让轮询把条子拽回去
  const p = S.now?.playback;
  if (p) {
    S.time = p.playing ? p.position + (Date.now() + S.skew - p.anchor) / 1000 : p.position;
    // 小于 0 说明锚点在未来（刚 seek 过），夹到 0 免得出现负时间
    if (S.time < 0) S.time = 0;
  }
  const dur = Number(S.now?.track?.duration || 0);
  paintProgress(S.time, dur);
  const durEl = document.querySelector("[data-dur]");
  if (durEl && dur > 0) durEl.textContent = fmt(dur);
  const btn = document.querySelector('[data-act="toggle"]');
  if (btn) {
    const want = p?.playing ? "pause" : "play";
    if (btn.dataset.i !== want) {
      btn.dataset.i = want;
      btn.innerHTML = icon(want);
    }
  }
}
setInterval(updateLive, 200);

// ---------- 动作 ----------
function toast(text, kind = "info", ms = 4000) {
  S.notice = { text, kind };
  render(true);
  if (ms) {
    const mine = text;
    setTimeout(() => {
      if (S.notice?.text === mine) {
        S.notice = null;
        render(true);
      }
    }, ms);
  }
}

const token = () => lsGet(tokenKey(S.roomId), "") || "";

async function command(body) {
  if (!token()) return toast("还没有控制权", "err");
  try {
    const res = await apiPost(`/api/rooms/${encodeURIComponent(S.roomId)}/command`, body, token());
    if (res?.state) {
      S.state = res.state;
      render(true);
    }
  } catch (err) {
    toast(err.message, "err");
  }
}

/** 把曲目移到某个分类。单独成函数是为了出错时能上报，便于排查。 */
async function moveTrackTo(trackId, folder) {
  const t = token();
  if (!t) {
    report("folder-move", { ok: false, error: "no-token", trackId, folder });
    return toast("还没有控制权", "err");
  }
  try {
    const res = await apiPost(
      `/api/rooms/${encodeURIComponent(S.roomId)}/command`,
      { type: "track.folder", trackId, folder },
      t
    );
    if (res?.state) {
      S.state = res.state;
      render(true);
    }
    report("folder-move", { ok: true, trackId, folder });
  } catch (err) {
    report("folder-move", { ok: false, error: err.message, trackId, folder });
    toast(err.message, "err");
  }
}
// 内联 onclick 直接调用，避免事件委托在某些环境下收不到（也更好调试）
// 单曲循环开关：走内联 onclick，和分类按钮同一套写法
window.__bardLoop = () => {
  try {
    const on = S.now?.playback?.loop === "track";
    report("loop-click", { cur: S.now?.playback?.loop || "", next: on ? "list" : "track" });
    command({ type: "settings", loop: on ? "list" : "track" });
  } catch (e) {
    report("loop-error", { message: String((e && e.message) || e) });
  }
};
window.__bardSetFolder = (el) => {
  // 先取值再重绘（重绘会替换掉这个按钮元素）
  const folder = el.dataset.folder || "";
  const trackId = el.dataset.id;
  S.openFolderFor = null;
  render(true);
  // 走和所有按钮相同的指令通道，并且不论成败都给出可见反馈
  const t = token();
  if (!t) return toast("还没有控制权，先点「取得播放控制权」", "err");
  apiPost(`/api/rooms/${encodeURIComponent(S.roomId)}/command`, { type: "track.folder", trackId, folder }, t)
    .then((res) => {
      if (res?.state) {
        S.state = res.state;
        render(true);
      }
      toast(folder ? `已归到「${folder}」` : "已移出分类");
    })
    .catch((err) => toast(`归类失败：${err.message}`, "err"));
};
async function refreshState() {
  if (!token()) return;
  try {
    S.state = await apiGet(`/api/rooms/${encodeURIComponent(S.roomId)}/state`, token());
    render(true);
  } catch {}
}

// 控制权交给引擎处理：界面只发意图，否则引擎下一条状态会把角色覆盖回去
function claim() {
  bus?.post({ t: "claim" });
  toast("正在取得控制权…", "info", 2500);
}

function release() {
  bus?.post({ t: "release" });
  toast("已让出控制权");
}

async function addBilibili() {
  const url = (document.getElementById("bili")?.value || S.biliUrl || "").trim();
  if (!url) return toast("先粘贴一个 B 站链接", "warn");
  S.busy = "bili";
  render(true);
  try {
    await apiPost(`/api/rooms/${encodeURIComponent(S.roomId)}/tracks/bilibili`, { url, folder: activeFolder() }, token());
    S.biliUrl = "";
    toast("已加入歌单");
    await refreshState();
  } catch (err) {
    toast(err.message, "err");
  } finally {
    S.busy = "";
    render(true);
  }
}

function activeFolder() {
  const tab = S.folderTab || "__all";
  return tab === "__all" || tab === "__none" ? "" : tab;
}

async function doUpload(files) {
  const list = [...files].filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i.test(f.name));
  if (!list.length) return toast("请选择音频文件", "warn");
  let done = 0;
  for (const file of list) {
    try {
      S.uploading = { name: file.name, pct: 0 };
      render(true);
      const duration = await mediaDuration(file);
      await uploadTrack({
        roomId: S.roomId,
        folder: activeFolder(),
        token: token(),
        file,
        duration,
        onProgress: (p) => {
          S.uploading = { name: file.name, pct: p };
          render();
        },
      });
      done++;
    } catch (err) {
      toast(`${file.name}：${err.message}`, "err");
    }
  }
  S.uploading = { name: "", pct: 1, done };
  render(true);
  setTimeout(() => {
    S.uploading = null;
    render(true);
  }, 1500);
  await refreshState();
}

// ---------- 事件 ----------
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;

  if (act === "tab") S.tab = el.dataset.tab;
  else if (act === "dismiss") S.notice = null;
  else if (act === "toggle") command({ type: S.now?.playback?.playing ? "pause" : "play" });
  else if (act === "prev") command({ type: "prev" });
  else if (act === "next") command({ type: "next" });
  else if (act === "pick") command({ type: "select", trackId: id });
  else if (act === "remove") {
    askConfirm("从歌单移除这首？", { type: "playlist", op: "remove", trackId: id });
  } else if (act === "pick-file") document.getElementById("file")?.click();
  else if (act === "add-bili") addBilibili();
  else if (act === "toggle-hide") command({ type: "settings", hideTitle: !S.state?.settings?.hideTitle });
  else if (act === "unlock") bus?.post({ t: "unlock" });
  else if (act === "reclaim") claim();
  else if (act === "release") {
    askConfirm("让出控制权？其他 GM 可以接管。", null, "release");
  } else if (act === "seek") {
    // 真正的手势在下面的 pointerdown/up 里处理，这里不做事
  } else if (act === "ask-yes") {
    const pending = S.ask;
    S.ask = null;
    render(true);
    if (pending?.action === "release") release();
    else if (pending?.cmd) command(pending.cmd);
    return;
  } else if (act === "ask-no") {
    S.ask = null;
    render(true);
    return;
  } else if (act === "folder-create-ok") {
    // 必须先读值再重绘：重绘会换掉输入框元素，值就丢了
    const input = document.querySelector(".folder-input");
    const name = (input?.value || "").trim().slice(0, 24);
    S.creatingFolder = false;
    if (!name) {
      render(true);
      return;
    }
    S.folderTab = name;
    render(true);
    command({ type: "folder", op: "create", name });
    return;
  } else if (act === "folder-create-cancel") {
    S.creatingFolder = false;
    render(true);
    return;
  } else if (act === "row-folder") {
    S.openFolderFor = S.openFolderFor === id ? null : id;
    render(true);
    return;

  } else if (act === "folder-tab") {
    S.folderTab = el.dataset.folder ?? "__all";
    render(true);
    return;
  } else if (act === "folder-new") {
    S.creatingFolder = true;
    render(true);
    setTimeout(() => document.querySelector(".folder-input")?.focus(), 50);
    return;
  } else if (act === "folder-del") {
    const name = el.dataset.folder || "";
    if (name) askConfirm(`删除分类「${name}」？里面的曲目会移到「未分类」。`, { type: "folder", op: "remove", name });
    return;
  }
  render(true);
});

// 全房间音量：拖动时会连续触发 input，节流成每 200ms 最多发一次，
// 松手（change）时立刻补发最终值，保证最后一个位置一定送达。
let volTimer = null;
let volPending = null;
function queueMasterVolume(v) {
  volPending = v;
  if (volTimer) return;
  volTimer = setTimeout(() => {
    volTimer = null;
    if (volPending === null) return;
    const val = volPending;
    volPending = null;
    command({ type: "settings", volume: val });
  }, 200);
}
function flushMasterVolume(v) {
  if (volTimer) {
    clearTimeout(volTimer);
    volTimer = null;
  }
  volPending = null;
  command({ type: "settings", volume: v });
}
// ---------- 进度条拖动 ----------
// 按下就跟手，松手才发一次命令：拖动过程完全不碰网络，所以是平滑的。
function dragTimeFrom(ev) {
  const d = S.drag;
  if (!d) return 0;
  const ratio = Math.min(1, Math.max(0, (ev.clientX - d.rect.left) / d.rect.width));
  return Math.max(0, Math.min(d.dur, ratio * d.dur));
}

function applyDrag(ev) {
  const t = dragTimeFrom(ev);
  S.drag.time = t;
  S.time = t;
  paintProgress(t, S.drag.dur);
}

// 分类菜单用捕获阶段处理：先于任何冒泡处理器执行，不会被别处的 stopPropagation 吞掉。
document.addEventListener(
  "click",
  (ev) => {
    try {
      const chip = ev.target.closest && ev.target.closest('[data-act="set-folder"]');
      if (!chip) return;
      ev.preventDefault();
      ev.stopPropagation();
      report("folder-move", { ok: "click", trackId: chip.dataset.id, folder: chip.dataset.folder });
      moveTrackTo(chip.dataset.id, chip.dataset.folder || "");
    } catch (e) {
      report("folder-move-error", { message: String((e && e.message) || e) });
    }
  },
  true
);
document.addEventListener("pointerdown", (ev) => {
  const host = ev.target.closest('[data-act="seek"]');
  if (!host) return;
  const dur = Number(S.now?.track?.duration || 0);
  if (!(dur > 0)) return;
  const bar = host.querySelector(".bar");
  if (!bar) return;
  S.drag = { rect: bar.getBoundingClientRect(), dur, time: 0 };
  try {
    host.setPointerCapture(ev.pointerId);
  } catch {}
  applyDrag(ev);
  ev.preventDefault();
});

document.addEventListener("pointermove", (ev) => {
  if (S.drag) applyDrag(ev);
});

document.addEventListener("pointerup", (ev) => {
  if (!S.drag) return;
  const target = dragTimeFrom(ev);
  S.drag = null;
  seekTo(target);
});

document.addEventListener("pointercancel", () => {
  S.drag = null;
});

/** 松手后：界面先跳到目标位置（不等服务器），再发命令并让引擎立刻刷新。 */
async function seekTo(seconds) {
  const dur = Number(S.now?.track?.duration || 0);
  const pos = Math.max(0, Math.min(dur || 1e9, seconds));
  const p = S.now?.playback;
  if (p) S.now = { ...S.now, playback: { ...p, position: pos, anchor: Date.now() + S.skew } };
  S.time = pos;
  paintProgress(pos, dur);
  await command({ type: "seek", position: pos });
  bus?.post({ t: "refresh" });
}

document.addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.id === "bili") S.biliUrl = el.value;
  else if (el.dataset.act === "vol") {
    markSlider();
    const v = Number(el.value) / 100;
    S.status.volume = v;
    bus?.post({ t: "volume", value: v });
    const label = el.closest(".field")?.querySelector(".hint") || el.parentElement?.querySelector(".vol-val");
    if (label) label.textContent = `${Math.round(v * 100)}%`;
  } else if (el.dataset.act === "master-vol") {
    markSlider();
    const v = Number(el.value) / 100;
    const label = document.querySelector("[data-master]");
    if (label) label.textContent = `${Math.round(v * 100)}%`;
    queueMasterVolume(v);
  }
});

/** 标记"正在拖滑块"：期间冻结重绘，停手 400ms 后补一次渲染。 */
function markSlider() {
  S.sliderActive = true;
  clearTimeout(S.sliderTimer);
  S.sliderTimer = setTimeout(() => {
    S.sliderActive = false;
    render(true);
  }, 400);
}

document.addEventListener("change", (ev) => {
  if (ev.target.id === "file") {
    doUpload(ev.target.files || []);
    ev.target.value = "";
  } else if (ev.target.dataset.act === "master-vol") {
    // 松手：立刻把最终音量发出去，不依赖节流定时器
    flushMasterVolume(Number(ev.target.value) / 100);
  }
});

document.addEventListener("dragover", (ev) => {
  const drop = ev.target.closest(".drop");
  if (!drop) return;
  ev.preventDefault();
  drop.classList.add("over");
});
document.addEventListener("dragleave", (ev) => ev.target.closest(".drop")?.classList.remove("over"));
document.addEventListener("drop", (ev) => {
  const drop = ev.target.closest(".drop");
  if (!drop) return;
  ev.preventDefault();
  drop.classList.remove("over");
  if (ev.dataTransfer?.files?.length) doUpload(ev.dataTransfer.files);
});

// ---------- 启动 ----------
async function boot() {
  window.__bardBooted = true;
  const { OBR, role, roomId, attempts, ready } = await initOBR();
  S.role = role;
  S.roomId = roomId;
  const tab = new URLSearchParams(location.search).get("tab");
  if (["list", "add", "settings"].includes(tab)) S.tab = tab;

  bus = createBus({ onMessage: onBus });
  bus.post({ t: "who" });
  render(true);

  setTimeout(() => {
    if (!heardBg && !engine) {
      engine = new Engine({ OBR, role, roomId, kind: "popover", attempts });
      engine.start();
    }
  }, 900);

  if (role === "GM") {
    setTimeout(refreshState, 700);
    setInterval(() => {
      if (!S.state) refreshState();
    }, 5000);
  }
  if (!ready) toast("OBR 没给就绪信号，部分功能可能不可用", "warn", 6000);
}

function onBus(msg) {
  switch (msg.t) {
    case "hello":
      if (msg.kind === "background") heardBg = true;
      break;
    case "engine-stopped":
      if (msg.kind === "popover") engine = null;
      break;
    case "now":
      S.now = msg.now;
      if (msg.now?.serverTime) S.skew = msg.now.serverTime - Date.now();
      render();
      break;
    case "state":
      S.state = msg.state;
      render();
      break;
    case "status":
      S.status = msg.status || {};
      if (msg.status?.role && msg.status.role !== S.role) S.role = msg.status.role;
      if (msg.status?.hasToken) S.claimError = "";
      render();
      break;
    case "error":
      toast(msg.error, "err");
      break;
  }
}

boot().catch((err) => {
  console.error(err);
  const view = document.getElementById("view");
  if (view) {
    view.innerHTML = `<div class="notice err">${icon("alert")}<span>扩展初始化失败：${esc(
      err.message || err
    )}</span></div><button class="btn primary block" onclick="location.reload()">重新加载</button>`;
  }
});
