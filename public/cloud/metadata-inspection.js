/**
 * 仅返回房间元数据的匿名容量/状态信息，不复制其他插件的数据。
 *
 * Owlbear 的16KiB上限是整个 room.metadata 共用的。DO快照只能缩小咕咕
 * 自己的值，GM仍须先在 Owlbear 写入 {v,secret,rev,hash} 小指针。
 * 如果其他扩展已挤满全部额度，连指针都无法保存，PLAYER便无从找到DO。
 */
const encoder = new TextEncoder();
export const METADATA_ROOM_MAX = 16 * 1024;

export function estimatePointerRoomBytes(metadata, key, rev = 1) {
  const pointer = { v: 2, secret: "0".repeat(32),
    rev: Number.isSafeInteger(rev) && rev >= 1 ? rev : 1,
    hash: "0".repeat(64) };
  return encoder.encode(JSON.stringify({ ...metadata, [key]: pointer })).byteLength;
}

export function inspectRoomMetadata(metadata, key) {
  try {
    const safe = metadata && typeof metadata === "object" ? metadata : {};
    const present = Object.prototype.hasOwnProperty.call(safe, key);
    const value = safe[key];
    const totalBytes = encoder.encode(JSON.stringify(safe)).byteLength;
    const pointerRoomBytes = estimatePointerRoomBytes(safe, key, value?.rev);
    return {
      totalBytes,
      entryCount: Object.keys(safe).length,
      freeBytes: METADATA_ROOM_MAX - totalBytes,
      musicKeyPresent: present,
      musicValueKind: !present ? "missing" :
        value?.v === 1 ? "direct-v1" :
          value?.v === 2 ? "pointer-v2" : "unrecognized",
      pointerRoomBytes,
      pointerFits: pointerRoomBytes <= METADATA_ROOM_MAX,
    };
  } catch {
    // 诊断不能因为一个异常metadata对象把整个音乐扩展弄坏。
    return null;
  }
}

/** 两端相同房间生成相同匿名比对码；不包含或导出原房间ID。 */
export async function anonymousRoomCode(roomId) {
  if (typeof roomId !== "string" || !roomId) return null;
  try {
    const bytes = encoder.encode("gugu-metadata-diagnostics:v1:" + roomId);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
