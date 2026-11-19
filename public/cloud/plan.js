/**
 * 完全确定的房间播放计划（纯函数，无网络操作）。
 *
 * GM 只需在播放/暂停/手动切歌/拖进度/编辑歌单时写一次 Owlbear Metadata。
 * 浏览器随后用相同的「计划、曲目时长、时钟锚点」自行推演现在应该播什么，
 * 不需要每次自然切歌都等 GM 的广播，更不用每秒向 Cloudflare DO 轮询。
 *
 * 未来随机播放也应由 GM 将已抽出的顺序写成确定列表/种子，绝不能让
 * 每个玩家自行 Math.random()，否则客户端必然在自然切歌时产生分叉。
 */
const validDuration = (t) => Number.isFinite(t?.duration) && t.duration > 0;
// 0.1 微秒内的浮点误差不是实际音频时间差。特别是 12.4 + 7.0
// 在二进制浮点下会得到 19.399999999...；不能因此滞留在旧歌曲尾部。
const EPSILON = 1e-7;

export function canPredictPlayback(state) {
  const p = state?.playback;
  const tracks = state?.playlist;
  if (!p?.playing || !p.trackId || !Array.isArray(tracks) || !tracks.length) return false;
  const current = tracks.find((t) => t.id === p.trackId);
  if (!validDuration(current)) return false;
  if (p.loop === "track") return true;
  if (p.loop !== "list" && p.loop !== "off") return false;
  // 任意未知时长都会使后续曲目边界不确定；回退到既有 GM ended 机制。
  return tracks.every(validDuration);
}

export function projectPlayback(state, now = Date.now()) {
  const original = state?.playback;
  if (!original || !canPredictPlayback(state) || !Number.isFinite(now)) {
    return original ? { ...original } : null;
  }
  const playlist = state.playlist;
  let index = playlist.findIndex((t) => t.id === original.trackId);
  let elapsed = Math.max(0, Number(original.position || 0) +
    (now - original.anchor) / 1000);
  if (!Number.isFinite(elapsed)) return { ...original };

  if (original.loop === "track") {
    return { ...original, position: elapsed % playlist[index].duration, anchor: now };
  }

  // 从锚点选择的当前歌曲往后推进。循环模式先扣去第一首的剩余部分，
  // 之后可以用整张歌单总时长取模，即使浏览器离线几天也不会 O(天数) 循环。
  const remaining = playlist[index].duration;
  if (elapsed < remaining - EPSILON) {
    return { ...original, position: elapsed, anchor: now };
  }
  elapsed -= remaining;
  if (original.loop === "list") {
    const total = playlist.reduce((sum, t) => sum + t.duration, 0);
    elapsed = ((elapsed % total) + total) % total;
    index = (index + 1) % playlist.length;
    for (let count = 0; count < playlist.length; count++) {
      const duration = playlist[index].duration;
      if (elapsed < duration - EPSILON) {
        return { ...original, trackId: playlist[index].id,
          position: elapsed, anchor: now };
      }
      elapsed -= duration;
      index = (index + 1) % playlist.length;
    }
    // 浮点边界保护：无论多少轮，结果都应是已知的一首歌。
    return { ...original, trackId: playlist[index].id, position: 0, anchor: now };
  }

  // 不循环：自然播放最后一首结束后，各个客户端自行停止。
  while (++index < playlist.length) {
    const duration = playlist[index].duration;
    if (elapsed < duration - EPSILON) {
      return { ...original, trackId: playlist[index].id,
        position: elapsed, anchor: now };
    }
    elapsed -= duration;
  }
  const last = playlist[playlist.length - 1];
  return { ...original, trackId: last.id, position: last.duration,
    anchor: now, playing: false };
}

/** 下一首由所有浏览器独立计算，不需要额外询问 GM。 */
export function upcomingTrack(state, now = Date.now()) {
  if (!canPredictPlayback(state)) return null;
  const p = projectPlayback(state, now);
  const list = state.playlist;
  const index = list.findIndex((t) => t.id === p.trackId);
  if (index < 0) return null;
  const remain = Math.max(0, list[index].duration - p.position);
  if (p.loop === "track") return { track: list[index], inSeconds: remain };
  if (index + 1 < list.length) return { track: list[index + 1], inSeconds: remain };
  if (p.loop === "list") return { track: list[0], inSeconds: remain };
  return null;
}
