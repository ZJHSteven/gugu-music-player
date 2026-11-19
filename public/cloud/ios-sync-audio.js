/**
 * iOS 真正受房间控制的前台音频输出，而不是可随意拖动的原生播放器。
 *
 * 为什么需要它：
 * - Owlbear 会把音乐后台引擎放在一个独立的 iframe。可见点歌面板上的
 *   点击事件通过 BroadcastChannel 通知后台时，Safari 的用户激活
 *   (userActivation) 无法作为普通 JSON 消息传递。
 * - 因此后台 audio.play() 可能 NotAllowedError；误用原生
 *   <audio controls> 虽然可以得到手势，却让 PLAYER 擅自拖动进度。
 *
 * 本播放器在「点歌面板 iframe」里持有唯一的 Audio 元素，提前从
 * OPFS 读取完整曲目并准备好 Blob URL；玩家点击唯一的
 * 「开启并同步房间声音」按钮时，同一事件栈立即调用 audio.play()，
 * 中间没有 await。播放器没有 controls、没有播放/暂停/快进按钮。
 * 它只按 GM 的播放锚点计算位置，并定期闭环纠偏。
 *
 * Safari 可能在 Owlbear 关闭点歌面板后销毁该 iframe；此时会交还后台
 * 播放引擎，但不能承诺后台一定具有 iOS 播放权限。此模块绝不通过
 * 伪造点击绕过浏览器政策，用户需要在必要时重新开启声音。
 */
import { getAudio } from "./storage.js";
import { playableAudioSource } from "./audio-source.js";

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 与 GM 时间锚点对齐：不以本地上一轮实际结束时刻计算下一轮。 */
export function expectedRoomPhase(now, at = Date.now()) {
  if (!now?.track || !now?.playback) return null;
  const p = now.playback;
  const duration = Number(now.track.duration);
  const elapsed = p.playing ? (at - p.anchor) / 1000 : 0;
  let phase = Math.max(0, Number(p.position || 0) + elapsed);
  if (Number.isFinite(duration) && duration > 0) {
    if (p.loop === "track") phase = phase % duration;
    else phase = Math.min(phase, Math.max(0, duration - 0.08));
  }
  return phase;
}

/** 比较循环相位而不是线性数轴，避免 12.4 秒转 0 时误判出 12 秒漂移。 */
export function phaseError(actual, expected, duration, looping) {
  let delta = actual - expected;
  if (looping && Number.isFinite(duration) && duration > 0) {
    delta = ((delta + duration / 2) % duration + duration) % duration -
      duration / 2;
  }
  return delta;
}

export class IosSyncAudio {
  constructor({ getNow, getVolume, onStatus, onActive,
    getFile = getAudio, prepareSource = playableAudioSource,
    createAudio = () => new Audio(), createUrl = (blob) => URL.createObjectURL(blob),
    revokeUrl = (url) => URL.revokeObjectURL(url),
    nowMs = () => Date.now() }) {
    this.getNow = getNow;
    this.getVolume = getVolume;
    this.onStatus = onStatus || (() => {});
    this.onActive = onActive || (() => {});
    this.getFile = getFile;
    this.prepareSource = prepareSource;
    this.createUrl = createUrl;
    this.revokeUrl = revokeUrl;
    this.nowMs = nowMs;
    this.audio = createAudio();
    // 不暴露浏览器原生控制条：PLAYER 没有本地 seek、暂停、切歌权。
    this.audio.controls = false;
    this.audio.preload = "auto";
    this.audio.playsInline = true;
    this.audio.loop = false;
    this.trackHash = "";
    this.url = null;
    this.ready = false;
    this.active = false;
    this.authorized = false;
    this.closed = false;
    this.loading = false;
    this.lastSeek = 0;
    this.largeSince = 0;
    // 任何 GM 手动暂停/继续/切歌/拖动都会更新房间 playback.seq。
    // 跟随者必须立即按新计划定位，不能把明确的控制指令误认为普通时钟漂移，
    // 再等待 6 秒才允许跳到正确进度。
    this.lastPlaybackSeq = null;
    this.error = "";
    this.timer = null;

    this.audio.addEventListener?.("error", () => {
      this.error = this.audio.error?.code === 4
        ? "当前浏览器无法解码歌曲，确认音轨为 MP3 或 M4A(AAC)"
        : "音频加载失败";
      this.notify();
    });
    this.audio.addEventListener?.("loadedmetadata", () => this.align(true));
    this.audio.addEventListener?.("ended", () => this.align(true));
  }

  status() {
    const p = this.getNow()?.playback;
    const expected = expectedRoomPhase(this.getNow(), this.nowMs());
    return {
      ready: this.ready,
      active: this.active,
      authorized: this.authorized,
      loading: this.loading,
      playingInRoom: Boolean(p?.playing),
      error: this.error,
      mediaError: this.audio.error?.code ?? null,
      paused: this.audio.paused,
      currentTime: Number(this.audio.currentTime.toFixed?.(3) || 0),
      expected: expected == null ? null : Number(expected.toFixed(3)),
      driftMs: expected == null ? null : Math.round(
        phaseError(this.audio.currentTime, expected, this.audio.duration,
          this.audio.loop) * 1000),
      hasNativeScrub: Boolean(this.audio.controls),
    };
  }

  notify() {
    this.onStatus(this.status());
  }

  /** 面板启动或收到 GM 当前歌曲时预载，不在此处自动替玩家播放。 */
  async prepare(now = this.getNow()) {
    const track = now?.track;
    if (this.closed || !track?.hash) return;
    if (this.trackHash === track.hash && (this.ready || this.loading)) {
      this.applyRoomState(now);
      return;
    }
    this.trackHash = track.hash;
    this.ready = false;
    this.loading = true;
    this.error = "";
    if (this.url) this.revokeUrl(this.url);
    this.url = null;
    this.audio.pause();
    this.audio.removeAttribute?.("src");
    this.audio.load?.();
    this.notify();
    try {
      const file = await this.getFile(track.hash);
      if (this.closed || this.trackHash !== track.hash) return;
      if (!file) {
        this.error = "音频尚未缓存完成；等候自动传输后再开启";
        return;
      }
      const source = await this.prepareSource(file, track.mime);
      if (this.closed || this.trackHash !== track.hash) return;
      this.url = this.createUrl(source.blob);
      this.audio.src = this.url;
      this.audio.loop = now.playback?.loop === "track";
      this.audio.load?.();
      this.ready = true;
      this.applyRoomState(now);
      // 不在 async 回调里代替首次用户激活。
      // 已经用同一元素成功播放过的 Safari，可能允许换曲后恢复；
      // 如新曲依然被拦截，通知用户重新按「开启并同步」即可。
      if (this.authorized && now.playback?.playing) this.resume();
    } catch (error) {
      this.error = String(error?.name || "MediaSourceError").slice(0, 40);
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  applyRoomState(now = this.getNow()) {
    if (!now?.playback) return;
    const seq = now.playback.seq;
    const gmChangedPlan = seq !== this.lastPlaybackSeq;
    this.lastPlaybackSeq = seq;
    this.audio.loop = now.playback.loop === "track";
    this.audio.volume = clamp(Number(this.getVolume() ?? 1) *
      Number(now.playback.volume ?? 1), 0, 1);
    if (!now.playback.playing) {
      this.audio.pause();
      this.notify();
      return;
    }
    if (this.active) {
      this.align(gmChangedPlan);
      this.resume();
    }
  }

  /**
   * 必须在可见按钮的同步 click 回调中直接调用。
   * 这个函数本身不是 async，不在 audio.play 前执行 Promise/await。
   */
  enableFromUserGesture() {
    if (this.closed) return false;
    if (!this.ready) {
      this.error = this.loading ? "正在准备音频，请稍后再点一次开启" :
        "歌曲尚未下载，请稍后再试";
      this.notify();
      return false;
    }
    const current = this.getNow();
    if (!current?.playback?.playing) {
      this.error = "GM 当前已暂停，等待房主继续后再开启";
      this.notify();
      return false;
    }
    this.error = "";
    this.applyRoomState(current);
    this.align(true);
    // 关键：这是当前 iframe 中用户点击事件调用栈内的 play()。
    // 不能将它发给另一个背景 iframe，也不能在 await getAudio 后调用。
    let result;
    try { result = this.audio.play(); }
    catch (error) {
      this.error = String(error?.name || "PlayFailed");
      this.notify();
      return false;
    }
    Promise.resolve(result).then(() => {
      if (this.closed) return;
      this.authorized = true;
      this.active = true;
      this.onActive(true);
      if (!this.timer) this.timer = setInterval(() => this.tick(), 250);
      this.notify();
    }).catch((error) => {
      this.active = false;
      this.error = String(error?.name || "PlayRejected");
      this.notify();
    });
    return true;
  }

  /** 此调用不用于首次授权，只用于 GM 后续计划变化及同元素恢复。 */
  resume() {
    if (this.closed || !this.active || !this.ready ||
        !this.getNow()?.playback?.playing || !this.audio.paused) return;
    try {
      Promise.resolve(this.audio.play()).catch((error) => {
        this.active = false;
        this.error = String(error?.name || "PlayRejected");
        this.onActive(false);
        this.notify();
      });
    } catch (error) {
      this.active = false;
      this.error = String(error?.name || "PlayRejected");
      this.onActive(false);
      this.notify();
    }
  }

  /** 主动把本地 Audio 追上 GM 时间表，不能让本地播放终点累计偏移。 */
  align(force = false) {
    if (this.closed || !this.ready || !this.getNow()?.playback?.playing) return;
    const target = expectedRoomPhase(this.getNow(), this.nowMs());
    if (target == null || this.audio.readyState < 1) return;
    const drift = phaseError(this.audio.currentTime, target,
      this.audio.duration, this.audio.loop);
    if (force || Math.abs(drift) > 2.5) {
      if (!force) {
        const now = this.nowMs();
        this.largeSince ||= now;
        if (now - this.largeSince < 6000 || now - this.lastSeek < 20000) return;
      }
      try {
        this.audio.currentTime = target;
        this.lastSeek = this.nowMs();
      } catch {}
      this.largeSince = 0;
      this.audio.playbackRate = 1;
      return;
    }
    this.largeSince = 0;
    // 不反复暂停；仅对 100ms 以上的偏差缓慢变速，幅度最大 1.5%。
    this.audio.playbackRate = Math.abs(drift) < .1 ? 1 :
      Number((1 + clamp(-drift * .045, -.015, .015)).toFixed(3));
  }

  tick() {
    if (this.closed || !this.active) return;
    this.applyRoomState();
    this.notify();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.audio.pause();
    this.audio.removeAttribute?.("src");
    this.audio.load?.();
    if (this.url) this.revokeUrl(this.url);
    this.url = null;
    if (this.active) this.onActive(false);
    this.active = false;
  }
}
