// 音频引擎：真正发声、与服务端时间轴对齐、处理浏览器自动播放限制。
//
// 平时跑在 background.html（隐藏页面，面板关掉也不停）；
// 若 OBR 没加载后台页，浮窗会自己拉起一份（self-heal），后台上线后自动让位。
import { apiBase, apiGet, apiPost, lsGet, lsSet, lsDel, tokenKey, createBus, tabId, report } from "./lib.js";
import { initCloudBridge } from "./cloud/bridge.js";
import { getAudio } from "./cloud/storage.js";
import {
  shouldSnapOnCloudUpdate, initialCloudSeek, cloudPhaseDifference,
} from "./cloud/sync-policy.js";

// 同步策略（三层，由轻到重）：
//   1. 偏差 < DEADBAND      → 不动
//   2. 偏差 < HARD_SEEK     → 用 ±6% 的播放速度慢慢追（听不出来，也不会重新缓冲）
//   3. 偏差 ≥ HARD_SEEK     → 硬跳（通常只有"别人拖了进度条"这种量级才触发）
// 这样网络抖动造成的几十毫秒到一两秒偏差都不会再"突然跳一段"。
const DEADBAND = 0.2; // 秒
const HARD_SEEK = 3.0; // 秒
const RATE_LIMIT = 0.06; // ±6%
const SEEK_COOLDOWN = 3000; // 毫秒
const HEARTBEAT = 20000;

const clamp = (v, lo = 0, hi = 1) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const safeParse = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

export class Engine {
  constructor({ OBR, role, roomId, kind = "background", attempts = [] }) {
    this.OBR = OBR;
    this.role = role;
    this.roomId = roomId;
    this.kind = kind;
    this.attempts = attempts;

    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.volume = 0;

    this.now = null;
    this.state = null;
    this.token = lsGet(tokenKey(roomId), "") || "";
    this.clientId = (() => {
      const key = `bard:client:${roomId}`;
      let id = lsGet(key, "");
      if (!id) {
        id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        lsSet(key, id);
      }
      return id;
    })();

    this.skew = 0;
    this.src = "";
    this.pendingSeek = null;
    this.blocked = false;
    this.prompted = false;
    this.connected = false;
    this.stopped = false;
    this.claimError = "";
    this.fade = 1;
    this.localVolume = clamp(Number(lsGet("bard:vol", 0.85)));
    this.reportedFor = "";
    // 云版自动切歌需要同时防止：音频 ended 事件与播放时钟达到曲长时
    // 各触发一次；以及浏览器后台音频被禁播时完全收不到 ended 事件。
    // 按播放序列号去重，下一首/下一轮会产生新的 seq，允许再切换。
    this.lastEndedSeq = null;
    this.polling = false;
    this.settleUntil = 0;
    this.pollTimer = null;
    // ?sync=poll 可强制走轮询（调试/被代理缓冲时用）
    const syncMode = new URLSearchParams(location.search).get("sync") || lsGet("bard:sync") || "";
    this.forcePoll = syncMode === "poll";
    this.forceLong = syncMode === "long";

    this.bus = createBus({ onMessage: (m) => this.onBus(m) });
    this.timers = [];
    this.es = null;
    this.bindAudio();
  }

  async start() {
    this.bus.post({ t: "hello", kind: this.kind, role: this.role });
    this.emitStatus();
    report("engine-start", { kind: this.kind, role: this.role, roomId: this.roomId, tab: tabId(), attempts: this.attempts });

    // 云版播放控制走 Owlbear，不启动 SSE、轮询、Node 心跳或服务器时钟同步。
    if (window.BARD_CLOUD) {
      this.cloud = await initCloudBridge(this.OBR, this.role, this.roomId);
      this.token = this.role === "GM" ? "cloud-gm" : "";
      this.connected = true;
      this.cloud.subscribe((state, now) => {
        this.state = state;
        this.bus.post({ t: "state", state });
        this.onNow(now);
      });
      this.cloud.onFile((hash) => {
        if (this.now?.track?.hash === hash) {
          // 原本尚无本地文件时播放会暂停；新副本到达应直接重试。
          this.src = "";
          this.applyPlayback(true);
        }
      });
      this.emitStatus();
      this.timers.push(setInterval(() => this.tick(), 500));
      this.timers.push(setInterval(() => this.bus.post({ t: "hello", kind: this.kind, role: this.role }), 12000));
      return;
    }

    await this.syncClock();
    if (this.role === "GM") await this.ensureOwner();

    this.connect();
    this.timers.push(setInterval(() => this.tick(), 500));
    this.timers.push(setInterval(() => this.syncClock(), 60000));
    this.timers.push(setInterval(() => this.bus.post({ t: "hello", kind: this.kind, role: this.role }), 12000));
    if (this.role === "GM") this.startGmLoops();
  }

  /** 心跳 + 掉线重取令牌。可重复调用，只会挂一次。 */
  startGmLoops() {
    if (this.gmLoops) return;
    this.gmLoops = true;
    this.gmTimers = [
      setInterval(() => this.heartbeat(), HEARTBEAT),
      setInterval(() => {
        if (!this.token) this.ensureOwner();
      }, 30000),
    ];
  }

  stopGmLoops() {
    this.gmLoops = false;
    (this.gmTimers || []).forEach(clearInterval);
    this.gmTimers = [];
  }

  /**
   * 用户主动「取得播放控制权」。
   * 界面只发意图，认领、建连、心跳都在引擎里做——否则界面上一改角色，
   * 下一条引擎状态又会把它覆盖回玩家（之前那个「点了又被打回」就是这原因）。
   */
  async becomeOwner() {
    if (this.stopped) return;
    if (window.BARD_CLOUD) {
      if (await this.cloud?.isGM()) {
        this.role = "GM";
        this.token = "cloud-gm";
        this.emitStatus();
      } else {
        this.bus.post({ t: "error", error: "只有 Owlbear 房主才能控制云端歌单" });
      }
      return;
    }
    this.role = "GM";
    await this.ensureOwner();
    if (!this.token) {
      this.role = "PLAYER";
      this.emitStatus();
      return;
    }
    this.startGmLoops();
    this.connect();
    this.emitStatus();
    report("become-owner", { roomId: this.roomId, kind: this.kind });
  }

  /** 主动让出：先停掉心跳，否则会自动把控制权抢回来。 */
  async releaseOwnership() {
    if (window.BARD_CLOUD) {
      this.token = "";
      this.emitStatus();
      return;
    }
    const t = this.token;
    this.stopGmLoops();
    this.token = "";
    lsDel(tokenKey(this.roomId));
    if (t) {
      try {
        await apiPost(`/api/rooms/${encodeURIComponent(this.roomId)}/release`, {}, t);
      } catch {}
    }
    this.role = "PLAYER";
    this.connect();
    this.emitStatus();
    report("release-owner", { roomId: this.roomId, kind: this.kind });
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.stopGmLoops();
    clearTimeout(this.sseWatch);
    this.stopPolling();
    try {
      this.es?.close();
    } catch {}
    this.halt();
    this.bus.post({ t: "engine-stopped", kind: this.kind });
    this.bus.close();
  }

  // ---------- 主持权 ----------
  async ensureOwner() {
    if (window.BARD_CLOUD) {
      this.token = (await this.cloud?.isGM()) ? "cloud-gm" : "";
      this.emitStatus();
      return;
    }
    try {
      const name = await this.OBR.player.getName().catch(() => "GM");
      const res = await apiPost(`/api/rooms/${encodeURIComponent(this.roomId)}/claim`, {
        role: "GM",
        clientId: this.clientId,
        name,
        token: this.token,
      });
      if (res?.token) {
        this.token = res.token;
        this.claimError = "";
        lsSet(tokenKey(this.roomId), res.token);
        this.emitStatus();
        if (res.fresh) this.connect();
        report("claim-ok", { roomId: this.roomId, fresh: Boolean(res.fresh) });
      }
    } catch (err) {
      this.claimError = err.body?.owner ? `房间当前由「${err.body.owner.name}」控制` : err.message || "无法取得控制权";
      this.emitStatus();
      report("claim-fail", { roomId: this.roomId, error: this.claimError, status: err.status });
    }
  }

  async heartbeat() {
    if (!this.token) return;
    try {
      await apiPost(`/api/rooms/${encodeURIComponent(this.roomId)}/heartbeat`, {}, this.token);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        this.token = "";
        lsDel(tokenKey(this.roomId));
        await this.ensureOwner();
      }
    }
  }

  // ---------- 时钟 ----------
  async syncClock() {
    try {
      const t0 = Date.now();
      const data = await (await fetch(`${apiBase()}/api/health`, { cache: "no-store" })).json();
      this.skew = data.time - (t0 + Date.now()) / 2;
      if (!this.connected) {
        this.connected = true;
        this.emitStatus();
      }
    } catch {
      if (this.connected) {
        this.connected = false;
        this.emitStatus();
      }
    }
  }

  serverNow() {
    return Date.now() + this.skew;
  }

  // ---------- 同步流 ----------
  connect() {
    try {
      this.es?.close();
    } catch {}
    if (this.forcePoll) return this.startPolling();
    if (this.forceLong) return this.startLongPoll("forced");

    const qs = this.role === "GM" && this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    const es = new EventSource(`${apiBase()}/api/rooms/${encodeURIComponent(this.roomId)}/events${qs}`);
    this.es = es;
    this.gotSseData = false;
    // 看门狗放在建连之后就开始计时：有些代理连 onopen 都不及时给，
    // 不能把兜底挂在 onopen 里。
    clearTimeout(this.sseWatch);
    this.sseWatch = setTimeout(() => {
      if (!this.gotSseData) this.startLongPoll("sse-buffered");
    }, 2500);
    es.addEventListener("now", (ev) => {
      this.gotSseData = true;
      this.onNow(safeParse(ev.data));
    });
    es.addEventListener("state", (ev) => {
      const state = safeParse(ev.data);
      if (!state) return;
      this.state = state;
      this.bus.post({ t: "state", state });
    });
    es.onopen = () => {
      this.connected = true;
      this.emitStatus();
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        this.connected = false;
        this.emitStatus();
      }
    };
  }

  /** 轮询兜底：每秒拉一次「现在该播什么」，走到哪都通。 */
  startPolling(reason) {
    if (this.polling || this.stopped) return;
    this.polling = true;
    report("sync-fallback", { kind: this.kind, reason: reason || "forced" });

    const room = encodeURIComponent(this.roomId);
    const tick = async () => {
      if (this.stopped) return;
      try {
        const now = await (await fetch(`${apiBase()}/api/rooms/${room}/now`, { cache: "no-store" })).json();
        this.connected = true;
        this.onNow(now);
        if (this.role === "GM" && this.token) {
          const state = await apiGet(`/api/rooms/${room}/state`, this.token).catch(() => null);
          if (state) {
            this.state = state;
            this.bus.post({ t: "state", state });
          }
        }
      } catch {
        this.connected = false;
        this.emitStatus();
      }
    };
    tick();
    this.pollTimer = setInterval(tick, 400);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.polling = false;
    this.settleUntil = 0;
    this.longPolling = false;
  }

  /**
   * 长轮询：请求挂住等变化，服务端一有动作立刻回包，拿到就发下一个。
   * 相比定时轮询的优点：不依赖定时器（后台标签页会被浏览器节流到 1 秒甚至更久），
   * 延迟就是一次往返。
   */
  async startLongPoll(reason) {
    if (this.longPolling || this.stopped) return;
    this.stopPolling();
    this.longPolling = true;
    report("sync-longpoll", { kind: this.kind, reason: reason || "forced" });

    const room = encodeURIComponent(this.roomId);
    let since = this.now?.playback?.seq ?? 0;
    let errors = 0;
    while (!this.stopped && this.longPolling) {
      try {
        const qs = new URLSearchParams({ since: String(since), t: "25000" });
        if (this.role === "GM" && this.token) qs.set("token", this.token);
        const data = await (await fetch(`${apiBase()}/api/rooms/${room}/wait?${qs}`, { cache: "no-store" })).json();
        errors = 0;
        if (typeof data.seq === "number") since = data.seq;
        if (data.now) this.onNow(data.now);
        if (data.state) {
          this.state = data.state;
          this.bus.post({ t: "state", state: data.state });
        }
        if (!this.connected) {
          this.connected = true;
          this.emitStatus();
        }
      } catch {
        errors++;
        if (this.connected) {
          this.connected = false;
          this.emitStatus();
        }
        if (errors >= 3) {
          this.longPolling = false;
          return this.startPolling("longpoll-failed");
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  onNow(now) {
    if (!now || this.stopped) return;
    const previous = this.now?.playback;
    const previousTarget = this.target();
    const prevSeq = this.now?.playback?.seq;
    this.now = now;
    // seq 变了 = 有人真的点了播放/暂停/切歌/拖进度，这时不该被冷却挡住
    if (now.playback?.seq !== prevSeq) this.lastSeekAt = 0;
    this.applyPlayback(true);
    // Owlbear 的新 Metadata 有时仅仅改变音量或可见性。云版不能因为
    // 这些变更或正常的时钟漂移就重置音频位置；只在显式播放时间轴变化
    //（播放/暂停/拖进度/循环换轮）时执行一次校准。
    if (window.BARD_CLOUD &&
        shouldSnapOnCloudUpdate(previous, now.playback, previousTarget, this.target(),
          Number(now.track?.duration))) {
      this.snap();
    }
    this.bus.post({ t: "now", now });
  }

  // ---------- 播放 ----------
  bindAudio() {
    this.audio.addEventListener("loadedmetadata", () => {
      // 关键：这里要重新算一次目标位置。pendingSeek 是"设置 src 那一刻"算的，
      // 而通过慢链路拉元数据要 1~3 秒，那期间服务端时间轴已经往前走了；
      // 用旧值会让播放一开头就落后——要么跳一下，要么花很久慢慢追。
      const fresh = this.target();
      const seek = Number.isFinite(fresh) ? fresh : this.pendingSeek;
      this.pendingSeek = null;
      if (Number.isFinite(seek)) {
        try {
          this.audio.currentTime = window.BARD_CLOUD
            ? initialCloudSeek(seek, this.now?.track?.duration, this.now?.playback?.loop,
              this.now?.playback?.playing)
            : Math.max(0, seek);
        } catch {}
      }
      this.settleUntil = Date.now() + 5000; // 开头 5 秒先不纠偏，等缓冲稳住
      // 时长未知（预置曲目/直链）时由 GM 回填
      const known = Number(this.now?.track?.duration || 0);
      const real = this.audio.duration;
      const id = this.now?.track?.id;
      if (this.role === "GM" && this.token && known <= 0 && id && Number.isFinite(real) && real > 1) {
        if (this.reportedFor !== id) {
          this.reportedFor = id;
          this.command({ type: "track.update", trackId: id, patch: { duration: Math.round(real) } });
        }
      }
      this.emitStatus();
    });
    this.audio.addEventListener("ended", () => this.onEnded());
    this.audio.addEventListener("error", () => {
      report("audio-error", {
        kind: this.kind,
        code: this.audio.error?.code,
        src: String(this.audio.currentSrc || this.src).slice(0, 120),
      });
      this.emitStatus();
    });
    this.audio.addEventListener("playing", () => {
      // 只有真的出声了才会触发，用来区分「状态在走」和「确实在播」
      if (this.reportedPlaying !== this.src) {
        this.reportedPlaying = this.src;
        report("audio-playing", { kind: this.kind, time: Math.round(this.audio.currentTime) });
      }
      this.emitStatus();
    });
    this.audio.addEventListener("play", () => this.emitStatus());
    this.audio.addEventListener("pause", () => this.emitStatus());
    // 卡顿事件：网络抖动时浏览器会报 waiting/stalled。记下时间，纠偏时避开这段。
    this.audio.addEventListener("waiting", () => {
      this.lastWaitingAt = Date.now();
      this.buffering = true;
      this.emitStatus();
      if (!this.stallReported) {
        this.stallReported = true;
        report("audio-stall", {
          kind: this.kind,
          buffered: this.bufferedAhead(),
          time: Math.round(this.audio.currentTime),
          networkState: this.audio.networkState,
        });
      }
    });
    this.audio.addEventListener("seeking", () => {
      this.buffering = true;
      this.emitStatus();
    });
    this.audio.addEventListener("playing", () => {
      this.stallReported = false;
      this.buffering = false;
      this.emitStatus();
    });
    this.audio.addEventListener("seeked", () => {
      // seeked 已完成定位，即使浏览器没有再派发 playing 事件，
      // 后续也要恢复小幅纠偏，否则 buffering 标志会永久留在 true。
      this.buffering = false;
      this.emitStatus();
    });
  }

  /** 当前缓冲领先播放头多少秒。 */
  bufferedAhead() {
    const b = this.audio.buffered;
    if (!b || !b.length) return 0;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= this.audio.currentTime && this.audio.currentTime <= b.end(i)) {
        return Math.round((b.end(i) - this.audio.currentTime) * 10) / 10;
      }
    }
    return 0;
  }

  target() {
    const p = this.now?.playback;
    if (!p) return 0;
    return p.playing ? p.position + (this.serverNow() - p.anchor) / 1000 : p.position;
  }

  applyPlayback(sync) {
    const p = this.now?.playback;
    const track = this.now?.track;
    if (!p) return;
    if (!track?.src) return this.halt();

    // 单曲循环由各设备的音频解码器直接无缝循环，而不是每过十几秒都
    // 等 Owlbear Metadata 回来后停播再启动。GM 仍通过时钟更新房间 seq，
    // 而同曲的循环边界不会迫使其他客户端反复执行 play()。
    this.audio.loop = Boolean(window.BARD_CLOUD && p.loop === "track");

    if (window.BARD_CLOUD && track.src.startsWith("cloud:")) {
      // Blob URL 由每名玩家本地 OPFS/IndexedDB 生成。DO 不返回歌曲 URL，
      // 浏览器也不会尝试向 Worker 请求 /audio/...。
      if (this.src !== track.src) {
        this.src = track.src;
        this.shortFade = true;
        this.pendingSeek = this.target();
        if (this.cloudBlobUrl) URL.revokeObjectURL(this.cloudBlobUrl);
        this.cloudBlobUrl = null;
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
        getAudio(track.hash).then((file) => {
          if (this.stopped || this.src !== track.src) return;
          if (!file) {
            this.src = ""; // 缺文件先保持静音，待中继完成后重试
            return;
          }
          this.cloudBlobUrl = URL.createObjectURL(file);
          this.audio.src = this.cloudBlobUrl;
          this.resetRate();
          this.audio.load();
          this.applyVolume();
          if (this.now?.playback?.playing) this.play();
        }).catch((err) => {
          this.src = "";
          report("cloud-audio-error", { message: String(err) });
        });
        return;
      }
      this.applyVolume();
      if (p.playing) this.play();
      else this.pause();
      if (sync) this.correctDrift();
      return;
    }

    if (this.src !== track.src) {
      // 切歌不淡出：旧曲立刻被替换，多一段淡出只会让人觉得「点了没反应」。
      // 新曲用短淡入收一下开头，避免爆音。
      this.shortFade = true;
      this.src = track.src;
      this.pendingSeek = this.target();
      // 服务端给的是相对路径，用自己访问到的地址解析（避免拿到 localhost）
      this.audio.src = new URL(track.src, apiBase()).href;
      this.resetRate();
      this.audio.load();
    }
    this.applyVolume();
    if (p.playing) this.play();
    else this.pause();
    if (sync) this.correctDrift();
  }

  correctDrift() {
    if (window.BARD_CLOUD) {
      // 「同步」与「连续」必须同时成立。禁止每 3 秒硬跳/±6% 猛追，
      // 但不能因此任由不同设备的音频时钟永久漂移。
      //
      // 1. 小于 100ms 忽略，消除浏览器 tick / 浏览器音频设备抖动。
      // 2. 100ms~2.5s 用 ±1.5% 小幅度纠偏，不暂停音频、不重建缓冲。
      // 3. 真的长期偏离超过 2.5s 时，持续 6 秒后才允许一次校准 seek，
      //    两次硬跳至少间隔 20s，而不是 12 秒歌曲里连跳三四次。
      // 4. 单曲循环计算「圆环最短相位差」，在 12.4→0 秒边界绝不能
      //    把正常的循环识别成一个 12 秒的错位。
      const playback = this.now?.playback;
      if (!playback?.playing || this.audio.readyState < 1 || this.audio.paused ||
          this.audio.seeking || this.buffering ||
          Date.now() - (this.lastWaitingAt || 0) < 3000 ||
          Date.now() < (this.settleUntil || 0)) {
        return this.resetRate();
      }
      const duration = Number(this.now?.track?.duration);
      const looping = playback.loop === "track";
      const goal = initialCloudSeek(this.target(), duration, playback.loop, true);
      const drift = cloudPhaseDifference(this.audio.currentTime, goal, duration, looping);
      const gap = Math.abs(drift);
      if (gap < 0.1) {
        this.largeDriftSince = 0;
        return this.resetRate();
      }
      if (gap >= 2.5) {
        this.largeDriftSince ||= Date.now();
        if (Date.now() - this.largeDriftSince >= 6000 &&
            Date.now() - (this.lastSeekAt || 0) >= 20000) {
          try {
            this.audio.currentTime = goal;
            this.lastSeekAt = Date.now();
            this.settleUntil = Date.now() + 5000;
          } catch {}
          this.largeDriftSince = 0;
        }
        return this.resetRate();
      }
      this.largeDriftSince = 0;
      // preservesPitch 用于保证变速时人声的音高尽可能不改变；
      // 未支持的浏览器会忽略该属性，故将速度变化严格控制在 ±1.5%。
      if ("preservesPitch" in this.audio) this.audio.preservesPitch = true;
      const correction = Math.max(-0.015, Math.min(0.015, -drift * 0.045));
      const nextRate = Number((1 + correction).toFixed(3));
      if (Math.abs(this.audio.playbackRate - nextRate) >= 0.002) {
        this.audio.playbackRate = nextRate;
      }
      return;
    }
    if (!this.now?.playback?.playing || this.audio.readyState < 1) return this.resetRate();
    // 正在卡顿/刚卡完：这时候 seek 只会丢掉缓冲区，越纠越卡，先什么都别做
    if (Date.now() - (this.lastWaitingAt || 0) < 5000) return this.resetRate();
    // 刚开播/刚换曲/刚跳转后的稳流期：不纠偏，避免开头就跳
    if (Date.now() < (this.settleUntil || 0)) return this.resetRate();

    const target = this.target();
    if (!Number.isFinite(target)) return this.resetRate();
    const diff = this.audio.currentTime - target; // 正数 = 播快了，负数 = 落后
    const gap = Math.abs(diff);

    if (gap >= HARD_SEEK) {
      const now = Date.now();
      if (now - (this.lastSeekAt || 0) < SEEK_COOLDOWN) return this.resetRate();
      try {
        this.audio.currentTime = Math.max(0, target);
        this.lastSeekAt = now;
        this.settleUntil = now + 2000; // 跳完先稳一下，别立刻再判
      } catch {}
      return this.resetRate();
    }

    if (gap <= DEADBAND) return this.resetRate();

    // 中等偏差：用 ±6% 的速度慢慢追，不打断缓冲、听不出差别
    const rate = 1 - Math.max(-RATE_LIMIT, Math.min(RATE_LIMIT, diff * 0.5));
    this.audio.playbackRate = Number(rate.toFixed(3));
  }

  resetRate() {
    if (this.audio.playbackRate !== 1) {
      try {
        this.audio.playbackRate = 1;
      } catch {}
    }
  }

  play() {
    if (!this.audio.paused) return;
    const wasBlocked = this.blocked;
    this.audio
      .play()
      .then(() => {
        this.blocked = false;
        if (wasBlocked) this.emitStatus();
        // 切歌后短淡入（180ms），普通开播用 400ms；太长会让开头听起来"闷一下"
        this.fadeIn(this.shortFade ? 180 : 400);
        this.shortFade = false;
      })
      .catch((err) => {
        report("audio-blocked", { kind: this.kind, name: err?.name, message: String(err?.message || err).slice(0, 160) });
        if (err?.name === "NotAllowedError") {
          this.blocked = true;
          this.promptUnlock();
        }
        this.emitStatus();
      });
  }

  pause() {
    this.resetRate();
    if (!this.audio.paused) this.fadeOut(220, () => this.audio.pause());
  }

  halt() {
    this.resetRate();
    this.src = "";
    if (this.cloudBlobUrl) {
      URL.revokeObjectURL(this.cloudBlobUrl);
      this.cloudBlobUrl = null;
    }
    this.pendingSeek = null;
    try {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    } catch {}
  }

  onEnded() {
    if (this.role !== "GM" || !this.token) return;
    if (!window.BARD_CLOUD && Number(this.now?.track?.duration || 0) > 0) return; // 原版 Node 会自动切歌
    if (window.BARD_CLOUD) {
      const playback = this.now?.playback;
      // 同账号的桌面和手机都可能是 GM：自动切歌只允许最后一次
      // 发出播放指令的设备（clockId）执行，其余 GM 设备只负责收听。
      // 老版本房间缺少 clockId 时维持向后兼容。
      if (playback?.clockId && playback.clockId !== this.cloud?.deviceId) return;
      if (!playback?.playing || !playback?.trackId) return;
      if (this.lastEndedSeq === playback.seq) return;
      this.lastEndedSeq = playback.seq;
      // 同时携带发生结束时的 seq；即便 GM 另一窗口或用户先手动切歌，
      // 元数据提交前也会重新核对它，不能把下一首重复跳过。
      this.command({ type: "ended", expectedSeq: playback.seq });
      return;
    }
    this.command({ type: "ended" });
  }

  /** 淡入：从 0 升到 1（默认 400ms） */
  fadeIn(ms = 400) {
    this.stopFade();
    this.fade = 0;
    this.applyVolume();
    const steps = Math.max(1, Math.round(ms / 40));
    let i = 0;
    this.fadeTimer = setInterval(() => {
      i++;
      this.fade = Math.min(1, i / steps);
      this.applyVolume();
      if (i >= steps) this.stopFade();
    }, 40);
  }

  /** 淡出到 0 后执行回调（默认 250ms），用于暂停与切歌 */
  fadeOut(ms = 250, done) {
    this.stopFade();
    if (this.audio.paused) {
      this.fade = 1;
      return done && done();
    }
    const steps = Math.max(1, Math.round(ms / 40));
    let i = 0;
    this.fadeTimer = setInterval(() => {
      i++;
      this.fade = Math.max(0, 1 - i / steps);
      this.applyVolume();
      if (i >= steps) {
        this.stopFade();
        this.fade = 1;
        if (done) done();
      }
    }, 40);
  }

  stopFade() {
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  applyVolume() {
    const p = this.now?.playback;
    const master = p ? clamp(Number(p.volume ?? 1)) : 1;
    const v = clamp(master * this.localVolume * this.fade);
    this.audio.volume = v;
    this.audio.muted = v === 0;
  }

  setLocalVolume(v) {
    this.localVolume = clamp(v);
    lsSet("bard:vol", this.localVolume);
    this.applyVolume();
    this.emitStatus();
  }

  /** 用户点「开启声音」时调用：浏览器要求必须由用户手势触发发声。 */
  async unlock() {
    this.blocked = false;
    this.fade = 1;
    this.applyVolume();
    if (!this.now?.track?.src) {
      this.emitStatus();
      return false;
    }
    if (this.audio.readyState === 0) this.audio.load();
    try {
      await this.audio.play();
      this.blocked = false;
      this.fadeIn();
      this.emitStatus();
      return true;
    } catch (err) {
      this.blocked = err?.name === "NotAllowedError";
      this.emitStatus();
      return false;
    }
  }

  tick() {
    if (this.stopped) return;
    // 不能只依赖 HTMLAudioElement 的 ended 事件：后台 iframe 被浏览器禁止
    // 自动播放、系统挂起或设备没有声音输出时，音频可能根本没开始播放，
    // 但房间共享的播放时间锚点仍在推进，玩家会看到 2:57 / 0:20 一类越界。
    // 复用既有 500ms 本地 tick，以 GM 时钟到达曲长作为结束的第二信号，
    // 不增加任何 Owlbear/DO 的周期网络请求，也不让玩家擅自切歌。
    if (window.BARD_CLOUD && this.role === "GM" && this.token &&
        this.now?.playback?.playing && Number(this.now?.track?.duration) > 0 &&
        this.target() >= this.now.track.duration) this.onEnded();
    if (this.now?.playback?.playing) this.correctDrift();
    this.bus.post({ t: "tick", time: this.audio.currentTime || 0, playing: !this.audio.paused });
  }

  promptUnlock() {
    if (this.prompted) return;
    this.prompted = true;
    try {
      this.OBR?.notification?.show?.("音乐台需要点一下才能发声：打开 ♪ 面板，点「开启声音」");
    } catch {}
  }

  async command(body) {
    if (!this.token) return;
    try {
      await apiPost(`/api/rooms/${encodeURIComponent(this.roomId)}/command`, body, this.token);
    } catch (err) {
      this.bus.post({ t: "error", error: err.message || "指令失败" });
    }
  }

  emitStatus() {
    this.bus.post({
      t: "status",
      status: {
        kind: this.kind,
        role: this.role,
        connected: this.connected,
        blocked: this.blocked,
        buffering: Boolean(this.buffering),
        buffered: this.bufferedAhead(),
        drift: Math.round((this.audio.currentTime - (this.target() || 0)) * 10) / 10,
        rate: Number((this.audio.playbackRate || 1).toFixed(2)),
        hasToken: Boolean(this.token),
        claimError: this.claimError,
        volume: this.localVolume,
        error: this.audio.error ? `音频加载失败（${this.audio.error.code}）` : "",
      },
    });
  }

  onBus(msg) {
    if (!msg || this.stopped) return;
    switch (msg.t) {
      case "who":
        this.bus.post({ t: "hello", kind: this.kind, role: this.role });
        if (this.now) this.bus.post({ t: "now", now: this.now });
        if (this.state) this.bus.post({ t: "state", state: this.state });
        this.emitStatus();
        break;
      case "unlock":
        this.unlock();
        break;
      case "claim":
        this.becomeOwner();
        break;
      case "release":
        this.releaseOwnership();
        break;
      case "volume":
        this.setLocalVolume(msg.value);
        break;
      case "hello":
        // 后台优先：浮窗自愈的引擎听到后台上线就让位，避免双声道
        if (this.kind === "popover" && msg.kind === "background") this.stop();
        break;
      case "retry":
        this.connect();
        break;
      case "now":
        // 面板把命令响应里的最新状态直接塞过来，省掉一次往返
        if (msg.now) {
          const prevSeq = this.now?.playback?.seq;
          this.onNow(msg.now);
          if (!window.BARD_CLOUD && msg.now?.playback?.seq !== prevSeq) this.snap();
        }
        break;
      case "refresh":
        // 拖完进度条让引擎立刻拉一次，不等下一个轮询周期
        this.refreshNow();
        break;
    }
  }

  /** 立刻取一次当前状态（拖动/操作后用，避免等一个轮询周期）。 */
  async refreshNow() {
    if (window.BARD_CLOUD) {
      if (this.cloud?.getNow()) this.onNow(this.cloud.getNow());
      return;
    }
    try {
      const now = await (await fetch(`${apiBase()}/api/rooms/${encodeURIComponent(this.roomId)}/now`, { cache: "no-store" })).json();
      const prevSeq = this.now?.playback?.seq;
      this.onNow(now);
      if (now?.playback?.seq !== prevSeq) this.snap();
    } catch {}
  }

  /** 明确的状态变化（有人 seek/切歌）时立刻对齐，不走容差判断。 */
  snap() {
    if (this.audio.readyState < 1) return;
    const p = this.now?.playback;
    const duration = Number(this.now?.track?.duration);
    const t = window.BARD_CLOUD
      ? initialCloudSeek(this.target(), duration, p?.loop, p?.playing)
      : this.target();
    if (!Number.isFinite(t)) return;
    const drift = window.BARD_CLOUD
      ? cloudPhaseDifference(this.audio.currentTime, t, duration,
        p?.loop === "track" && p?.playing)
      : this.audio.currentTime - t;
    if (Math.abs(drift) > 0.2) {
      try {
        this.audio.currentTime = Math.max(0, t);
        this.lastSeekAt = Date.now();
      } catch {}
    }
  }
}
