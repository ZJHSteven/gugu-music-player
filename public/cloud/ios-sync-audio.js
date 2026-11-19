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

/**
 * iOS 首次点击时，当前歌曲可能尚未下载。此时仍应立刻让音频元素接受
 * 一次真实用户激活，而不是直接 return 丢掉这次珍贵的触摸事件。
 *
 * 构造短而合法的静音 PCM/WAV（不联网，不上传，不改变 GM 房间进度）。
 * 用同一个 Audio 元素播放并循环这段静音；歌曲到达后再更换它的 src。
 * WebKit 不保证换源后一定继承许可，所以随后仍检查 play() Promise，
 * 如果被拒绝，明确提示用户再点一次，而不是伪称音乐已开始播放。
 */
export function silentUnlockWav() {
  const sampleRate = 8000;
  const samples = 2000; // 250ms，循环时不会产生可听见的声音
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const name = (at, value) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  name(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  name(8, "WAVE");
  name(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  name(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Blob([bytes], { type: "audio/wav" });
}

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
    this.armed = false; // 先获得音频用户激活，文件下载完成后自动接续
    this.priming = false;
    this.primingUrl = null; // 临时静音WAV Blob URL（不得长期占用存储）
    this.pendingSource = null; // 下载恰好与首次解锁并发时，延后换源
    this.retryTimer = null;
    this.retryAt = 0;
    this.retryAttempts = 0;

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
      armed: this.armed,
      waitingForFile: !this.ready && Boolean(this.getNow()?.track),
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
  async prepare(now = this.getNow(), { force = false } = {}) {
    const track = now?.track;
    if (this.closed || !track?.hash) return;
    if (force) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryAt = 0;
    }
    if (this.trackHash === track.hash &&
        (this.ready || this.loading || this.pendingSource)) {
      this.applyRoomState(now);
      return;
    }
    // 后台重复广播的 now 消息不是缓存完成事件，不应每隔100ms
    // 就在OPFS上读取一次同一个还没传完的文件。
    if (!force && this.trackHash === track.hash && this.nowMs() < this.retryAt) return;
    const differentTrack = this.trackHash !== track.hash;
    this.trackHash = track.hash;
    this.ready = false;
    this.loading = true;
    this.error = "";
    if (differentTrack) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryAt = 0;
      this.retryAttempts = 0;
      this.pendingSource = null;
    }
    if (this.url) {
      this.revokeUrl(this.url);
      this.url = null;
    }
    // 用户可能在文件下载期间已经点击并开始静音预授权。
    // 此时绝不能因为新的 now 事件而停止静音 Audio，再丢失 Safari 激活。
    if (!this.primingUrl) {
      this.audio.pause();
      this.audio.removeAttribute?.("src");
      this.audio.load?.();
    }
    this.notify();
    try {
      const file = await this.getFile(track.hash);
      if (this.closed || this.trackHash !== track.hash) return;
      if (!file) {
        // 下载尚未完成不是播放授权失败！本地OPFS稍后重读即可，
        // 不向DO发新心跳或重复文件传输请求。
        this.scheduleFileRetry();
        return;
      }
      const source = await this.prepareSource(file, track.mime);
      if (this.closed || this.trackHash !== track.hash) return;
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryAt = 0;
      this.retryAttempts = 0;
      if (this.priming) {
        // 静音 audio.play() 还没 resolve，换源会把这次用户手势取消。
        this.pendingSource = { hash: track.hash, source };
      } else {
        this.installSource(track.hash, source);
      }
    } catch (error) {
      this.error = String(error?.name || "MediaSourceError").slice(0, 40);
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  /** 只轮询本地缓存，最长5秒一轮；同源其他iframe完成文件后也能及时发现。 */
  scheduleFileRetry() {
    if (this.retryTimer || this.closed) return;
    const delay = Math.min(5000, 750 + this.retryAttempts * 450);
    this.retryAttempts++;
    this.retryAt = this.nowMs() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.prepare().catch((error) => {
        this.error = String(error?.name || "CacheRetryError");
        this.notify();
      });
    }, delay);
  }

  /** 使用同一 Audio 换入真实文件。控制权仍只来自 GM 的房间时间表。 */
  installSource(hash, source) {
    if (this.closed || this.trackHash !== hash) return;
    this.pendingSource = null;
    if (this.primingUrl) {
      this.audio.pause();
      this.audio.removeAttribute?.("src");
      this.audio.load?.();
      this.revokeUrl(this.primingUrl);
      this.primingUrl = null;
    }
    this.url = this.createUrl(source.blob);
    this.audio.src = this.url;
    this.audio.load?.();
    this.ready = true;
    this.error = "";
    this.applyRoomState(this.getNow());
    if (this.armed && this.getNow()?.playback?.playing) this.startArmedMusic();
    this.notify();
  }

  /** 初次点了静音授权后，真正的歌曲稍晚到达：尝试在同一个元素接上播放。 */
  startArmedMusic() {
    if (this.closed || !this.armed || !this.ready ||
        !this.getNow()?.playback?.playing) return;
    this.armed = false; // 防止元数据更新导致重复的 play() 并发
    this.align(true);
    let result;
    try { result = this.audio.play(); }
    catch (error) {
      this.authorized = false;
      this.error = String(error?.name || "PlayFailed");
      this.notify();
      return;
    }
    Promise.resolve(result).then(() => {
      if (this.closed) return;
      this.active = true;
      this.authorized = true;
      this.onActive(true);
      if (!this.timer) this.timer = setInterval(() => this.tick(), 250);
      this.notify();
    }).catch((error) => {
      this.authorized = false;
      this.active = false;
      this.error = String(error?.name || "PlayRejected");
      this.notify();
    });
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
      if (!this.primingUrl) this.audio.pause();
      this.notify();
      return;
    }
    if (this.active) {
      this.align(gmChangedPlan);
      this.resume();
    } else if (this.armed && this.ready) {
      this.startArmedMusic();
    }
  }

  /**
   * 必须在可见按钮的同步 click 回调中直接调用。
   * 这个函数本身不是 async，不在 audio.play 前执行 Promise/await。
   */
  enableFromUserGesture() {
    if (this.closed) return false;
    if (!this.ready) {
      // 关键修复：申请Safari音频播放权不依赖于DO已经把歌传完。
      // 点击的同步执行栈中先启动零样本WAV；完整歌曲到达后用相同
      // Audio换源并自动按GM时间轴播放，不要求玩家每12秒再点一次。
      if (this.priming || this.armed) return true;
      this.error = "";
      this.priming = true;
      this.primingUrl = this.createUrl(silentUnlockWav());
      this.audio.src = this.primingUrl;
      this.audio.loop = true;
      this.audio.volume = 1; // WAV样本本身是0，不借助muted绕过播放许可
      this.audio.load?.();
      let pending;
      try { pending = this.audio.play(); }
      catch (error) {
        this.priming = false;
        this.error = String(error?.name || "PlayFailed");
        this.notify();
        return false;
      }
      Promise.resolve(pending).then(() => {
        if (this.closed) return;
        this.priming = false;
        this.armed = true;
        this.authorized = true;
        if (this.pendingSource) {
          const { hash, source } = this.pendingSource;
          this.installSource(hash, source);
        }
        this.notify();
      }).catch((error) => {
        if (this.closed) return;
        this.priming = false;
        this.armed = false;
        this.authorized = false;
        this.error = String(error?.name || "PlayRejected");
        if (this.pendingSource) {
          const { hash, source } = this.pendingSource;
          this.installSource(hash, source);
        }
        this.notify();
      });
      this.notify();
      return true;
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
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
    this.audio.pause();
    this.audio.removeAttribute?.("src");
    this.audio.load?.();
    if (this.url) this.revokeUrl(this.url);
    if (this.primingUrl) this.revokeUrl(this.primingUrl);
    this.url = null;
    this.primingUrl = null;
    if (this.active) this.onActive(false);
    this.active = false;
  }
}
