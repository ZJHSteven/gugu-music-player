/**
 * 可离线保管的音乐歌单备份（无压缩 ZIP）。
 *
 * 不把音频或备份上传到 Cloudflare / Owlbear。ZIP 同时存储歌单描述和
 * 逐个 SHA-256 命名的完整音频，之后可在任意 GM 设备上导入恢复。
 * ZIP 采用无压缩条目，不依赖浏览器专有的压缩格式或第三方 CDN。
 */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_TRACKS = 256;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
const FORMAT = "gugu-cloud-backup-v1";

const u16 = (v, n, value) => v.setUint16(n, value, true);
const u32 = (v, n, value) => v.setUint32(n, value >>> 0, true);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

async function checksum(blob) {
  let crc = 0xffffffff;
  // 分片核对 CRC，避免一次读取几百 MB 的单一 ArrayBuffer。
  for (let at = 0; at < blob.size; at += 1024 * 1024) {
    const bytes = new Uint8Array(await blob.slice(at, at + 1024 * 1024).arrayBuffer());
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function filenameFor(hash) {
  if (!HASH_RE.test(hash)) throw new Error("备份中存在非法音频 SHA-256");
  return `audio/${hash}`;
}

export async function createBackupArchive(tracks, fileByHash) {
  if (!Array.isArray(tracks) || tracks.length > MAX_TRACKS) {
    throw new Error("备份歌曲数量超出限制");
  }
  const playlist = tracks.map((t) => ({
    title: String(t.title || "").slice(0, 120),
    hash: String(t.hash || ""),
    mime: String(t.mime || "audio/mpeg").slice(0, 100),
    size: Number(t.size),
    duration: Number(t.duration || 0),
    folder: String(t.folder || "").slice(0, 24),
  }));
  const manifest = { format: FORMAT, createdAt: new Date().toISOString(), tracks: playlist };
  const meta = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const unique = [...new Set(playlist.map((t) => t.hash))];
  const entries = [{ name: "manifest.json", blob: meta }];
  let size = meta.size;
  for (const hash of unique) {
    const blob = fileByHash.get(hash);
    if (!(blob instanceof Blob) || blob.size > MAX_AUDIO_BYTES || !blob.size) {
      throw new Error(`曲目 ${hash.slice(0, 12)} 的完整本地文件不可用`);
    }
    const known = playlist.find((t) => t.hash === hash);
    if (known.size !== blob.size) throw new Error("本地音频大小与歌单不符");
    entries.push({ name: filenameFor(hash), blob });
    size += blob.size;
  }
  if (size > MAX_BACKUP_BYTES) throw new Error("备份内容超过 256 MiB，请分批备份");

  const parts = [];
  const directory = [];
  let offset = 0;
  for (const { name, blob } of entries) {
    const filename = textEncoder.encode(name);
    const crc = await checksum(blob);
    const header = new Uint8Array(30 + filename.byteLength);
    const view = new DataView(header.buffer);
    u32(view, 0, 0x04034b50);
    u16(view, 4, 20); // ZIP 2.0
    u16(view, 6, 0x0800); // 文件名 UTF-8
    u16(view, 8, 0); // store：不压缩，跨浏览器易恢复
    u32(view, 14, crc);
    u32(view, 18, blob.size);
    u32(view, 22, blob.size);
    u16(view, 26, filename.byteLength);
    header.set(filename, 30);
    parts.push(header, blob);
    directory.push({ filename, crc, bytes: blob.size, offset });
    offset += header.byteLength + blob.size;
  }

  const directoryOffset = offset;
  for (const { filename, crc, bytes, offset: fileOffset } of directory) {
    const header = new Uint8Array(46 + filename.byteLength);
    const view = new DataView(header.buffer);
    u32(view, 0, 0x02014b50);
    u16(view, 4, 20);
    u16(view, 6, 20);
    u16(view, 8, 0x0800);
    u32(view, 16, crc);
    u32(view, 20, bytes);
    u32(view, 24, bytes);
    u16(view, 28, filename.byteLength);
    u32(view, 42, fileOffset);
    header.set(filename, 46);
    parts.push(header);
    offset += header.byteLength;
  }
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  u32(e, 0, 0x06054b50);
  u16(e, 8, directory.length);
  u16(e, 10, directory.length);
  u32(e, 12, offset - directoryOffset);
  u32(e, 16, directoryOffset);
  parts.push(end);
  return new Blob(parts, { type: "application/zip" });
}

export async function readBackupArchive(file) {
  if (!(file instanceof Blob) || !file.size || file.size > MAX_BACKUP_BYTES + 1024 * 1024) {
    throw new Error("无效备份或备份文件超出 256 MiB 上限");
  }
  const files = new Map();
  let offset = 0;
  while (offset + 4 <= file.size) {
    const prefix = new DataView(await file.slice(offset, offset + 30).arrayBuffer());
    const signature = prefix.getUint32(0, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || prefix.byteLength < 30) {
      throw new Error("备份 ZIP 文件结构损坏");
    }
    const method = prefix.getUint16(8, true);
    const flags = prefix.getUint16(6, true);
    const crc = prefix.getUint32(14, true);
    const packed = prefix.getUint32(18, true);
    const unpacked = prefix.getUint32(22, true);
    const nameLength = prefix.getUint16(26, true);
    const extraLength = prefix.getUint16(28, true);
    if (method !== 0 || flags !== 0x0800 || packed !== unpacked ||
        unpacked > MAX_AUDIO_BYTES || nameLength > 80) {
      throw new Error("备份包含不支持的压缩方式或异常文件");
    }
    const nameBytes = await file.slice(offset + 30, offset + 30 + nameLength).arrayBuffer();
    const name = textDecoder.decode(nameBytes);
    if (name !== "manifest.json" && !/^audio\/[0-9a-f]{64}$/.test(name)) {
      throw new Error("备份包含未知文件");
    }
    const from = offset + 30 + nameLength + extraLength;
    const to = from + unpacked;
    if (to > file.size || files.has(name) || files.size >= MAX_TRACKS + 1) {
      throw new Error("备份文件不完整或包含重复条目");
    }
    const data = file.slice(from, to);
    if ((await checksum(data)) !== crc) throw new Error(`文件校验失败：${name}`);
    files.set(name, data);
    offset = to;
  }
  const meta = files.get("manifest.json");
  if (!meta || meta.size > 1024 * 1024) throw new Error("备份缺少有效的歌单清单");
  let manifest;
  try { manifest = JSON.parse(await meta.text()); }
  catch { throw new Error("备份歌单清单无法解析"); }
  if (manifest.format !== FORMAT || !Array.isArray(manifest.tracks) ||
      manifest.tracks.length > MAX_TRACKS) throw new Error("不是受支持的咕咕点歌台备份");
  for (const track of manifest.tracks) {
    const body = files.get(filenameFor(track.hash));
    if (!body || body.size !== track.size || !body.size ||
        !Number.isFinite(track.duration) || track.duration < 0) {
      throw new Error(`备份音频缺失或元数据损坏：${String(track.title).slice(0, 60)}`);
    }
  }
  return { tracks: manifest.tracks, files };
}
