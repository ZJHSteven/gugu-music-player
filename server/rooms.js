// 房间状态：歌单、播放时间轴、主持权。内存 + JSON 落盘。
//
// 同步靠「时间锚点」：{ position, anchor, playing }
//   客户端算 目标位置 = position + (服务端现在 - anchor)
// 这样不依赖每次推送的及时性，网络抖一下也能自己追回来。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const OWNER_TTL_MS = 90_000;

export const uid = (n = 8) => randomBytes(n).toString("hex");
export const cleanRoomId = (id) => String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

// 分类目录名：去空格、限长、禁止控制字符
export const cleanFolder = (name) =>
  String(name || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 24);

const DEFAULT_FOLDERS = ["探索", "战斗"];

const basePlayback = () => ({
  trackId: null,
  playing: false,
  position: 0,
  anchor: Date.now(),
  seq: 1,
  loop: "list", // off | track | list
  volume: 1,
});

export class Store {
  constructor(rootDir) {
    this.roomsDir = path.join(rootDir, "rooms");
    this.tracksRoot = path.join(rootDir, "tracks");
    fs.mkdirSync(this.roomsDir, { recursive: true });
    fs.mkdirSync(this.tracksRoot, { recursive: true });
    this.rooms = new Map();
    this.timers = new Map();
  }

  tracksDir(roomId) {
    const dir = path.join(this.tracksRoot, roomId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  get(roomId) {
    if (this.rooms.has(roomId)) return this.rooms.get(roomId);
    let room = {
      id: roomId,
      createdAt: Date.now(),
      owner: null,
      playlist: [],
      playback: basePlayback(),
      settings: { hideTitle: false },
      // 分类目录：GM 可自建，"探索/战斗" 是默认给的两个
      folders: DEFAULT_FOLDERS.slice(),
    };
    try {
      const file = path.join(this.roomsDir, `${roomId}.json`);
      if (fs.existsSync(file)) {
        // 去掉 BOM：手工编辑过的文件常带 BOM，JSON.parse 会直接失败
        const saved = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
        room = {
          ...room,
          ...saved,
          id: roomId,
          playback: { ...room.playback, ...(saved.playback || {}) },
          settings: { ...room.settings, ...(saved.settings || {}) },
          playlist: Array.isArray(saved.playlist) ? saved.playlist : [],
          // 老存档没有 folders 字段：补上默认目录，不动已有曲目
          folders: Array.isArray(saved.folders) ? saved.folders : DEFAULT_FOLDERS.slice(),
        };
      }
    } catch {}
    this.rooms.set(roomId, room);
    return room;
  }

  save(roomId) {
    if (this.timers.has(roomId)) return;
    const t = setTimeout(() => {
      this.timers.delete(roomId);
      const room = this.rooms.get(roomId);
      if (!room) return;
      const target = path.join(this.roomsDir, `${roomId}.json`);
      try {
        fs.writeFileSync(`${target}.tmp`, JSON.stringify(room, null, 2));
        fs.renameSync(`${target}.tmp`, target);
      } catch (err) {
        console.error("[rooms] 存档失败", err.message);
      }
    }, 200);
    t.unref?.();
    this.timers.set(roomId, t);
  }

  // ---------- 主持权 ----------

  ownerActive(room) {
    return Boolean(room.owner && Date.now() - room.owner.heartbeatAt < OWNER_TTL_MS);
  }

  claim(roomId, { clientId, name, token, adminKey, requiredKey }) {
    const room = this.get(roomId);
    const active = this.ownerActive(room);
    const keyOk = requiredKey ? adminKey === requiredKey : true;

    if (active && room.owner.token && token && token === room.owner.token) {
      room.owner.heartbeatAt = Date.now();
      this.save(roomId);
      return { ok: true, token: room.owner.token };
    }
    if (active) {
      if (room.owner.clientId === clientId) {
        room.owner.heartbeatAt = Date.now();
        this.save(roomId);
        return { ok: true, token: room.owner.token };
      }
      // 有人在活动：只有服务端配了密钥且密钥正确才允许接管
      if (!(requiredKey && keyOk)) return { ok: false, code: 423, error: "房间已有主持在活动", owner: publicOwner(room) };
    } else if (requiredKey && !keyOk) {
      return { ok: false, code: 403, error: "需要主持密钥" };
    }

    room.owner = {
      token: uid(24),
      clientId,
      name: String(name || "GM").slice(0, 32),
      claimedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    this.save(roomId);
    return { ok: true, fresh: true, token: room.owner.token };
  }

  authorize(roomId, token) {
    const room = this.get(roomId);
    if (!room.owner) return { ok: false, code: 401, error: "房间还没有主持" };
    if (!token || token !== room.owner.token) return { ok: false, code: 403, error: "不是本房间的主持" };
    if (!this.ownerActive(room)) return { ok: false, code: 401, error: "主持权已释放（太久没心跳）" };
    room.owner.heartbeatAt = Date.now();
    return { ok: true, room };
  }

  release(roomId, token) {
    const room = this.get(roomId);
    if (!room.owner || room.owner.token !== token) return false;
    room.owner = null;
    this.save(roomId);
    return true;
  }

  // ---------- 歌单 ----------

  addTrack(roomId, track) {
    const room = this.get(roomId);
    const item = {
      id: uid(6),
      title: "未命名",
      artist: "",
      cover: "",
      duration: 0,
      mime: "",
      folder: "",
      ...track,
      addedAt: Date.now(),
    };
    if (item.folder && !room.folders.includes(item.folder)) item.folder = "";
    room.playlist.push(item);
    this.save(roomId);
    return item;
  }

  getTrack(roomId, id) {
    return this.get(roomId).playlist.find((t) => t.id === id) || null;
  }

  updateTrack(roomId, id, patch) {
    const item = this.getTrack(roomId, id);
    if (!item) return null;
    for (const k of ["title", "artist", "cover", "duration", "mime"]) if (patch[k] !== undefined) item[k] = patch[k];
    this.save(roomId);
    return item;
  }

  removeTrack(roomId, id) {
    const room = this.get(roomId);
    const idx = room.playlist.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    const [gone] = room.playlist.splice(idx, 1);
    if (gone.kind === "upload" && gone.fileName) {
      try {
        fs.unlinkSync(path.join(this.tracksDir(roomId), gone.fileName));
      } catch {}
    }
    if (room.playback.trackId === id) {
      const next = room.playlist[idx] || room.playlist[idx - 1] || null;
      room.playback.trackId = next ? next.id : null;
      room.playback.position = 0;
      room.playback.anchor = Date.now();
      room.playback.playing = Boolean(next) && room.playback.playing;
      room.playback.seq += 1;
    }
    this.save(roomId);
    return true;
  }

  // ---------- 播放 ----------

  position(room) {
    const p = room.playback;
    return p.playing ? p.position + (Date.now() - p.anchor) / 1000 : p.position;
  }

  apply(roomId, cmd) {
    const room = this.get(roomId);
    const p = room.playback;
    const bump = () => {
      p.seq += 1;
      p.anchor = Date.now();
      this.save(roomId);
    };
    // 只改设置（音量/循环/隐藏曲名）或调整歌单顺序时，必须先把"播到哪了"冻结下来，
    // 否则 anchor 被重置成现在、position 还停在旧值，全房间会一起跳回旧位置。
    const freeze = () => {
      p.position = this.position(room);
    };
    const start = (id, autoplay = true) => {
      if (!room.playlist.some((t) => t.id === id)) return false;
      p.trackId = id;
      p.position = 0;
      p.playing = autoplay;
      bump();
      return true;
    };

    switch (cmd.type) {
      case "play": {
        if (!p.trackId) {
          if (!room.playlist.length) return { ok: false, error: "歌单是空的" };
          return start(room.playlist[0].id) ? { ok: true } : { ok: false };
        }
        freeze();
        const cur = room.playlist.find((t) => t.id === p.trackId);
        if (cur && cur.duration > 0 && p.position >= cur.duration - 0.3) p.position = 0;
        p.playing = true;
        bump();
        return { ok: true };
      }
      case "pause":
        freeze();
        p.playing = false;
        bump();
        return { ok: true };
      case "seek":
        p.position = Math.max(0, Number(cmd.position) || 0);
        bump();
        return { ok: true };
      case "select":
        return start(String(cmd.trackId), cmd.autoplay !== false) ? { ok: true } : { ok: false, error: "曲目不存在" };
      case "next":
        return this.step(roomId, 1);
      case "prev":
        return this.step(roomId, -1);
      case "ended":
        if (p.loop === "track") {
          p.position = 0;
          p.anchor = Date.now();
          p.playing = true;
          bump();
          return { ok: true };
        }
        return this.step(roomId, 1, true);
      case "stop":
        p.playing = false;
        p.position = 0;
        bump();
        return { ok: true };
      case "settings":
        freeze();
        if (cmd.loop && ["off", "track", "list"].includes(cmd.loop)) p.loop = cmd.loop;
        if (typeof cmd.volume === "number") p.volume = Math.min(1, Math.max(0, cmd.volume));
        if (typeof cmd.hideTitle === "boolean") room.settings.hideTitle = cmd.hideTitle;
        bump();
        return { ok: true };
      case "playlist": {
        if (cmd.op === "remove") return { ok: this.removeTrack(roomId, String(cmd.trackId)) };
        freeze();
        if (cmd.op === "clear") {
          room.playlist = [];
          room.playback.trackId = null;
          room.playback.playing = false;
          room.playback.position = 0;
        } else if (cmd.op === "move") {
          const from = Number(cmd.from);
          const to = Number(cmd.to);
          if (!(from >= 0 && from < room.playlist.length) || !(to >= 0 && to < room.playlist.length)) {
            return { ok: false, error: "索引越界" };
          }
          const [item] = room.playlist.splice(from, 1);
          room.playlist.splice(to, 0, item);
        } else return { ok: false, error: "未知歌单操作" };
        bump();
        return { ok: true };
      }
      case "track.update":
        freeze();
        if (!this.updateTrack(roomId, String(cmd.trackId), cmd.patch || {})) return { ok: false, error: "曲目不存在" };
        bump();
        return { ok: true };
      case "folder": {
        const name = cleanFolder(cmd.name);
        const op = String(cmd.op || "create");
        if (op === "create") {
          if (!name) return { ok: false, error: "名字不能为空" };
          if (room.folders.includes(name)) return { ok: true, folders: room.folders };
          freeze();
          room.folders.push(name);
          bump();
          return { ok: true, folders: room.folders };
        }
        if (!room.folders.includes(name)) return { ok: false, error: "目录不存在" };
        if (op === "rename") {
          const to = cleanFolder(cmd.newName);
          if (!to) return { ok: false, error: "新名字不能为空" };
          if (to === name) return { ok: true, folders: room.folders };
          if (room.folders.includes(to)) return { ok: false, error: "已经有同名目录" };
          freeze();
          room.folders = room.folders.map((f) => (f === name ? to : f));
          for (const t of room.playlist) if (t.folder === name) t.folder = to;
          bump();
          return { ok: true, folders: room.folders };
        }
        if (op === "remove") {
          freeze();
          room.folders = room.folders.filter((f) => f !== name);
          for (const t of room.playlist) if (t.folder === name) t.folder = "";
          bump();
          return { ok: true, folders: room.folders };
        }
        return { ok: false, error: "未知目录操作" };
      }
      case "track.folder": {
        const t = room.playlist.find((x) => x.id === String(cmd.trackId));
        if (!t) return { ok: false, error: "曲目不存在" };
        const to = cleanFolder(cmd.folder);
        if (to && !room.folders.includes(to)) return { ok: false, error: "目录不存在" };
        if ((t.folder || "") !== to) {
          freeze();
          t.folder = to;
          bump();
        }
        return { ok: true };
      }
      default:
        return { ok: false, error: `未知指令 ${cmd.type}` };
    }
  }

  step(roomId, dir, fromEnd = false) {
    const room = this.get(roomId);
    const list = room.playlist;
    const p = room.playback;
    if (!list.length) return { ok: false, error: "歌单是空的" };
    const cur = list.findIndex((t) => t.id === p.trackId);

    let idx = cur + dir;
    if (idx >= list.length) idx = p.loop === "list" ? 0 : -1;
    if (idx < 0 && fromEnd) {
      p.playing = false;
      p.position = 0;
      p.anchor = Date.now();
      p.seq += 1;
      this.save(roomId);
      return { ok: true };
    }
    if (idx < 0) idx = 0;

    p.trackId = list[idx].id;
    p.position = 0;
    p.playing = true;
    p.anchor = Date.now();
    p.seq += 1;
    this.save(roomId);
    return { ok: true };
  }
}

export function publicOwner(room) {
  return room.owner ? { name: room.owner.name, since: room.owner.claimedAt } : null;
}

/** 所有人可见：只有「正在播什么」，不含歌单。
 *  src 用「相对路径」：由客户端用自己访问到的地址解析。
 *  服务端拼绝对地址会踩两个坑——反向代理下 Host 可能是 localhost，
 *  而一旦客户端拿到 http://localhost/audio/... 就变成访问它自己电脑，必然加载失败。 */
export function buildNow(room) {
  const p = room.playback;
  const track = room.playlist.find((t) => t.id === p.trackId) || null;
  const hide = room.settings.hideTitle;
  return {
    serverTime: Date.now(),
    hidden: hide,
    playback: {
      trackId: p.trackId,
      playing: p.playing,
      position: p.position,
      anchor: p.anchor,
      seq: p.seq,
      volume: p.volume,
      loop: p.loop,
    },
    track: track
      ? {
          id: track.id,
          title: hide ? null : track.title,
          artist: hide ? null : track.artist,
          cover: hide ? "" : track.cover || "",
          duration: track.duration || 0,
          src: `/audio/${room.id}/${track.id}`,
        }
      : null,
    owner: publicOwner(room),
  };
}

/** 仅 GM：完整歌单与设置。 */
export function buildState(room) {
  return {
    serverTime: Date.now(),
    playback: { ...room.playback },
    settings: { ...room.settings },
    owner: publicOwner(room),
    folders: room.folders || [],
    playlist: room.playlist.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      artist: t.artist,
      cover: t.cover || "",
      duration: t.duration || 0,
      folder: t.folder || "",
      src: `/audio/${room.id}/${t.id}`,
    })),
  };
}
