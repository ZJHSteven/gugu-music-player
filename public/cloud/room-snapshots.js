/**
 * Owlbear 共享 Room Metadata 只有 16 KiB，且与房间里所有其他扩展共用。
 * 空歌单和几十首歌曲直接写进这个配额，在插件较多的房间必定失败。
 *
 * v2 混合模式：
 * - Owlbear Room Metadata 只保存 {v:2,secret,rev,hash}（约 160 字节），
 *   该字段由宿主基于真正的 GM 权限保护，PLAYER 不能修改。
 * - 完整歌单、播放锚点、分类等小型 JSON 存在已有房间 DO 的持久存储中，
 *   以 SHA-256 内容地址定位。这里绝不存音频字节，音乐仍由玩家 OPFS 共享。
 * - 任意客户端即便往 DO 上传了其他快照，也不能使 PLAYER 采用它：
 *   只信任 Owlbear GM 授权写入的元数据中的 hash，并重新计算内容摘要。
 * - 老房间的 v1 直接存储兼容，不强制迁移或重写其他扩展的元数据。
 */
export const ROOM_METADATA_LIMIT = 16 * 1024;
export const ROOM_SNAPSHOT_THRESHOLD = 14 * 1024;
const pointerPattern = /^[a-f0-9]{64}$/;
const secretPattern = /^[a-f0-9]{32}$/;
const MAX_SNAPSHOT_BYTES = 60 * 1024;
const encoder = new TextEncoder();

export function encodedSize(value) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export function isSnapshotPointer(value) {
  return value?.v === 2 && secretPattern.test(value.secret) &&
    pointerPattern.test(value.hash) && Number.isSafeInteger(value.rev) && value.rev >= 1;
}

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function endpoint(roomId, secret, hash) {
  const params = new URLSearchParams({ room: roomId, key: secret, hash });
  return `/room-state?${params}`;
}

/** 写入不可变快照；写入完成后才允许更新 Owlbear 指针（失败不会破坏旧指针）。 */
export async function saveRoomSnapshot(roomId, secret, state) {
  const data = JSON.stringify(state);
  if (encoder.encode(data).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("歌单状态过大，请减少歌曲或缩短曲名");
  }
  const hash = await sha256(data);
  const response = await fetch(endpoint(roomId, secret, hash), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: data,
  });
  if (!response.ok) throw new Error(`云端歌单快照写入失败（HTTP ${response.status}）`);
  return { v: 2, secret, rev: state.rev, hash };
}

/** 下载并重新计算内容哈希，不信任未被 Owlbear 指针引用的 DO 数据。 */
export async function loadRoomSnapshot(roomId, pointer) {
  if (!isSnapshotPointer(pointer)) throw new Error("房间歌单指针格式不正确");
  const response = await fetch(endpoint(roomId, pointer.secret, pointer.hash),
    { cache: "no-store" });
  if (!response.ok) throw new Error(`房间歌单快照读取失败（HTTP ${response.status}）`);
  const data = await response.text();
  if (encoder.encode(data).byteLength > MAX_SNAPSHOT_BYTES ||
      (await sha256(data)) !== pointer.hash) {
    throw new Error("房间歌单快照与 Owlbear 指针校验不一致");
  }
  let state;
  try { state = JSON.parse(data); } catch { throw new Error("房间歌单快照内容损坏"); }
  if (state?.secret !== pointer.secret || state?.rev !== pointer.rev) {
    throw new Error("房间歌单快照与指定房间状态不匹配");
  }
  return state;
}
