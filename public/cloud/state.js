/**
 * 云版房间状态机。
 *
 * 原版 Node server/rooms.js 负责保存歌单并控制播放时间轴。本文件把相同的
 * 可观察行为移到浏览器纯函数，供 GM 使用 Owlbear 房间 Metadata 持久化。
 *
 * 重要限制：Owlbear 房间的整个 Metadata 总共只有 16 KB。因此这里只存音频
 * 摘要/歌名/播放位置，不会把任何音频字节或 Blob 写进 Metadata。
 */
export const METADATA_KEY = "com.zjhstudio.gugu-cloud/state";
export const BROADCAST_CHANNEL = "com.zjhstudio.gugu-cloud/playback";
export const MAX_STATE_BYTES = 14 * 1024;
import { projectPlayback, canPredictPlayback } from "./plan.js";

const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
const cleanFolder = (name) => String(name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 24);

export function createState(secret) {
  return {
    v: 1,
    secret,
    rev: 1,
    playlist: [],
    playback: {
      trackId: null, playing: false, position: 0, anchor: Date.now(),
      seq: 1, loop: "list", volume: 1, clockId: "",
    },
    settings: { hideTitle: false },
    folders: ["探索", "战斗"],
  };
}

/** 防止旧存档或其他扩展的非预期字段破坏当前播放器。 */
export function normalizeState(value) {
  if (!value || value.v !== 1 || !Array.isArray(value.playlist)) return null;
  if (!/^[a-f0-9]{32}$/.test(value.secret || "")) return null;
  return {
    ...value,
    folders: Array.isArray(value.folders) ? value.folders : ["探索", "战斗"],
    playback: { ...createState(value.secret).playback, ...(value.playback || {}) },
    settings: { hideTitle: Boolean(value.settings?.hideTitle) },
  };
}

export function assertMetadataSize(state) {
  const length = new TextEncoder().encode(JSON.stringify({ [METADATA_KEY]: state })).byteLength;
  if (length > MAX_STATE_BYTES) {
    throw new Error("房间歌单元数据已接近 Owlbear 16 KB 上限；请减少曲目或缩短歌名");
  }
  return length;
}

/** 本地时钟锚点：只需要状态变动事件，不需要逐秒往 DO 发送时间。 */
export function currentPosition(p, now = Date.now()) {
  return Math.max(0, p.position + (p.playing ? (now - p.anchor) / 1000 : 0));
}

export function publicNow(state, now = Date.now()) {
  const p = projectPlayback(state, now);
  const item = state.playlist.find((t) => t.id === p.trackId) || null;
  const hidden = state.settings.hideTitle;
  return {
    serverTime: now,
    hidden,
    playback: { ...p },
    track: item ? {
      id: item.id,
      title: hidden ? null : item.title,
      artist: hidden ? null : (item.artist || ""),
      cover: hidden ? "" : (item.cover || ""),
      duration: item.duration || 0,
      hash: item.hash,
      // 文件经 OPFS 存取后扩展名丢失，iOS Safari 需要原歌曲媒体类型
      // 才能稳定识别 blob: URL。曲名隐藏时 MIME 仍是非敏感技术元数据。
      mime: item.mime || "audio/mpeg",
      src: `cloud:${item.hash}`,
    } : null,
    // Owlbear 的房主角色决定控制权。保留非空 owner 兼容原版玩家视图，
    // 防止玩家看到“我是主持，取得播放控制权”这种错误入口。
    owner: { name: "Owlbear 房主", since: 0 },
  };
}

export function publicState(s) {
  return {
    serverTime: Date.now(),
    playback: { ...s.playback },
    settings: { ...s.settings },
    folders: [...s.folders],
    playlist: s.playlist.map((t) => ({
      ...t, src: `cloud:${t.hash}`,
    })),
    owner: { name: "Owlbear 房主", since: 0 },
  };
}

/** 相对原 Node 版保持指令名称，原来的 UI 不需要重新画。 */
export function applyCommand(state, cmd, now = Date.now()) {
  // 完整且具有已知时长的歌单会由每个设备本地预测自然切歌。
  // 保留旧 GM 客户端的 ended 请求兼容，但不能让它重写已预测的进度。
  if (cmd.type === "ended" && canPredictPlayback(state)) return state;
  const s = structuredClone(state);
  const p = s.playback;
  const oldPosition = () => currentPosition(p, now);
  const bump = () => { p.anchor = now; p.seq++; s.rev++; };
  const freeze = () => { p.position = oldPosition(); };
  const select = (id, playing = true) => {
    if (!s.playlist.some((t) => t.id === id)) throw new Error("曲目不存在");
    p.trackId = id; p.position = 0; p.playing = playing; bump();
  };
  const step = (dir, fromEnd = false) => {
    if (!s.playlist.length) throw new Error("歌单是空的");
    const cur = s.playlist.findIndex((t) => t.id === p.trackId);
    let target = cur + dir;
    if (target >= s.playlist.length) target = p.loop === "list" ? 0 : -1;
    if (target < 0 && fromEnd) {
      p.position = 0; p.playing = false; bump(); return;
    }
    select(s.playlist[Math.max(target, 0)].id);
  };

  switch (cmd.type) {
    case "play": {
      if (!p.trackId) select(s.playlist[0]?.id);
      else {
        freeze();
        const t = s.playlist.find((x) => x.id === p.trackId);
        if (t?.duration > 0 && p.position >= t.duration - 0.3) p.position = 0;
        p.playing = true; bump();
      }
      break;
    }
    case "pause": freeze(); p.playing = false; bump(); break;
    case "seek": p.position = clamp(cmd.position, 0, 86400); bump(); break;
    case "select": select(String(cmd.trackId), cmd.autoplay !== false); break;
    case "next": step(1); break;
    case "prev": step(-1); break;
    case "ended":
      // GM 后台可能先由媒体事件、后由本地时钟各报告一次结束。
      // 仅处理与当前播放序列一致的结束事件，避免延迟命令跳过新歌。
      if (cmd.expectedSeq !== undefined && cmd.expectedSeq !== p.seq) return s;
      if (!p.playing) return s;
      if (p.loop === "track") {
        const duration = Number(s.playlist.find((t) => t.id === p.trackId)?.duration);
        // 移动端在锁屏中可能暂停 JS 定时器，但 HTMLAudioElement 已自然
        // 循环多次。恢复后的 ended 不能再把目标位置强制设成 0：
        // 否则例如第 3 圈 2.1 秒时，所有正常播放的客户端都会突然倒退。
        // 使用源设备时间轴上的「实际相位」续写锚点，循环边界不打断声音。
        const phase = Number.isFinite(duration) && duration > 0
          ? oldPosition() % duration : 0;
        p.position = phase;
        p.playing = true;
        bump();
      }
      else step(1, true);
      break;
    case "stop": p.position = 0; p.playing = false; bump(); break;
    case "settings":
      freeze();
      if (["off", "track", "list"].includes(cmd.loop)) p.loop = cmd.loop;
      if (Number.isFinite(cmd.volume)) p.volume = clamp(cmd.volume, 0, 1);
      if (typeof cmd.hideTitle === "boolean") s.settings.hideTitle = cmd.hideTitle;
      bump();
      break;
    case "playlist": {
      freeze();
      if (cmd.op === "clear") {
        s.playlist = []; p.trackId = null; p.playing = false; p.position = 0;
      } else if (cmd.op === "remove") {
        const idx = s.playlist.findIndex((t) => t.id === String(cmd.trackId));
        if (idx < 0) throw new Error("曲目不存在");
        s.playlist.splice(idx, 1);
        if (p.trackId === cmd.trackId) {
          p.trackId = s.playlist[idx]?.id || s.playlist[idx - 1]?.id || null;
          p.position = 0; p.playing = Boolean(p.trackId) && p.playing;
        }
      } else if (cmd.op === "move") {
        const from = Number(cmd.from), to = Number(cmd.to);
        if (![from, to].every((n) => Number.isInteger(n) && n >= 0 && n < s.playlist.length)) {
          throw new Error("歌单索引越界");
        }
        const [item] = s.playlist.splice(from, 1); s.playlist.splice(to, 0, item);
      } else throw new Error("未知歌单操作");
      bump();
      break;
    }
    case "track.update": {
      const t = s.playlist.find((x) => x.id === String(cmd.trackId));
      if (!t) throw new Error("曲目不存在");
      freeze();
      for (const key of ["title", "artist", "cover", "duration"]) {
        if (cmd.patch && cmd.patch[key] !== undefined) {
          t[key] = typeof cmd.patch[key] === "string"
            ? cmd.patch[key].slice(0, key === "title" ? 120 : 200) : cmd.patch[key];
        }
      }
      bump();
      break;
    }
    case "folder": {
      const name = cleanFolder(cmd.name), op = cmd.op || "create";
      if (op === "create") {
        if (!name) throw new Error("目录名不能为空");
        if (!s.folders.includes(name)) s.folders.push(name);
      } else if (op === "rename") {
        const to = cleanFolder(cmd.newName);
        if (!to || !s.folders.includes(name) || (to !== name && s.folders.includes(to))) throw new Error("目录名称无效");
        s.folders = s.folders.map((f) => f === name ? to : f);
        s.playlist.forEach((t) => { if (t.folder === name) t.folder = to; });
      } else if (op === "remove") {
        s.folders = s.folders.filter((f) => f !== name);
        s.playlist.forEach((t) => { if (t.folder === name) t.folder = ""; });
      } else throw new Error("未知目录操作");
      freeze(); bump();
      break;
    }
    case "track.folder": {
      const t = s.playlist.find((x) => x.id === String(cmd.trackId));
      const folder = cleanFolder(cmd.folder);
      if (!t || (folder && !s.folders.includes(folder))) throw new Error("曲目或目录不存在");
      freeze(); t.folder = folder; bump();
      break;
    }
    default: throw new Error(`未知指令 ${cmd.type}`);
  }
  assertMetadataSize(s);
  return s;
}

export function addTrack(state, track) {
  const next = structuredClone(state);
  next.playlist.push({
    id: crypto.randomUUID().slice(0, 12),
    kind: "upload",
    title: String(track.title || "未命名").slice(0, 120),
    artist: "",
    cover: "",
    hash: track.hash,
    size: track.size,
    mime: track.mime || "audio/mpeg",
    duration: track.duration || 0,
    folder: next.folders.includes(track.folder) ? track.folder : "",
    addedAt: Date.now(),
  });
  next.rev++;
  assertMetadataSize(next);
  return next;
}
