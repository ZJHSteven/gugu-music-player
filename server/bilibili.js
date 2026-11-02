// B 站音轨解析：视频链接 -> 可直接播放的音频流地址。
//
// playurl 现在要 WBI 签名（否则 -403）：
//   view 拿 cid -> nav 拿 wbi_img 算 mixinKey -> playurl(wbi) 拿 dash.audio
// 音轨 URL 绑 referer 且带 deadline，必须由本服务代理转发。
import { createHash } from "node:crypto";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
export const BILI_HEADERS = {
  "User-Agent": UA,
  Referer: "https://www.bilibili.com",
  Origin: "https://www.bilibili.com",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

let wbi = { key: "", at: 0 };
const md5 = (s) => createHash("md5").update(s).digest("hex");

async function mixinKey() {
  if (wbi.key && Date.now() - wbi.at < 20 * 60 * 1000) return wbi.key;
  const data = await (await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: BILI_HEADERS })).json();
  const base = (u) => (String(u || "").split("/").pop() || "").split(".")[0];
  const raw = base(data?.data?.wbi_img?.img_url) + base(data?.data?.wbi_img?.sub_url);
  if (raw.length < 64) throw new Error("拿不到 B 站 WBI 密钥");
  const key = TAB.map((n) => raw[n]).join("").slice(0, 32);
  wbi = { key, at: Date.now() };
  return key;
}

function sign(params, key) {
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const q = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${q}&w_rid=${md5(q + key)}`;
}

/** 解析各种 B 站链接 / BV 号 / 短链。 */
export function parseInput(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  let m = /^(BV[0-9A-Za-z]{10})$/.exec(text);
  if (m) return { bvid: m[1], page: 1 };

  let url;
  try {
    url = new URL(text, "https://www.bilibili.com");
  } catch {
    return null;
  }
  if (!/bilibili\.com$|b23\.tv$/i.test(url.hostname)) return null;
  const page = Math.max(1, parseInt(url.searchParams.get("p") || "1", 10) || 1);
  m = /\/video\/(BV[0-9A-Za-z]{10})/i.exec(url.pathname);
  if (m) return { bvid: m[1], page };
  m = /\/video\/av(\d+)/i.exec(url.pathname);
  if (m) return { aid: Number(m[1]), page };
  const short = /\/([0-9A-Za-z]{4,})$/.exec(url.pathname);
  if (/b23\.tv$/i.test(url.hostname) && short) return { short: short[1], page };
  return null;
}

async function audioUrlOf({ bvid, cid }) {
  const key = await mixinKey();
  const query = sign({ bvid, cid, fnval: 16, fnver: 0, fourk: 1, platform: "pc", otype: "json", qn: 0 }, key);
  const data = await (await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, { headers: BILI_HEADERS })).json();
  if (data.code !== 0) throw Object.assign(new Error(`B 站接口：${data.message || data.code}`), { statusCode: 502 });

  const audios = (data.data?.dash?.audio || []).filter((a) => a.baseUrl);
  const best = audios.sort(
    (a, b) => (/mp4a/.test(b.codecs) ? 1 : 0) - (/mp4a/.test(a.codecs) ? 1 : 0) || b.bandwidth - a.bandwidth
  )[0];
  if (best) return { url: best.baseUrl, mime: "audio/mp4" };
  const durl = data.data?.durl?.[0];
  if (durl?.url) return { url: durl.url, mime: "audio/mp4" };
  return null;
}

const expiryOf = (url) => {
  try {
    const deadline = Number(new URL(url).searchParams.get("deadline"));
    if (deadline) return deadline * 1000;
  } catch {}
  return Date.now() + 90 * 60 * 1000;
};

/** 解析视频，返回可入库的曲目。 */
export async function resolveBilibili(input) {
  let info = parseInput(input);
  if (!info) throw Object.assign(new Error("不是有效的 B 站视频链接"), { statusCode: 400 });
  if (info.short) {
    const res = await fetch(`https://b23.tv/${info.short}`, { headers: BILI_HEADERS, redirect: "manual" });
    const parsed = parseInput(res.headers.get("location") || "");
    if (!parsed) throw Object.assign(new Error("短链接解析失败"), { statusCode: 400 });
    info = parsed;
  }

  const view = await (
    await fetch(`https://api.bilibili.com/x/web-interface/view?${info.bvid ? `bvid=${info.bvid}` : `aid=${info.aid}`}`, {
      headers: BILI_HEADERS,
    })
  ).json();
  if (view.code !== 0 || !view.data) throw Object.assign(new Error(`B 站接口：${view.message || view.code}`), { statusCode: 502 });

  const v = view.data;
  const page = Math.min(Math.max(info.page, 1), v.pages?.length || 1);
  const pageInfo = v.pages?.[page - 1];
  const cid = pageInfo?.cid || v.cid;
  const audio = await audioUrlOf({ bvid: v.bvid, cid });
  if (!audio) throw Object.assign(new Error("这个视频没有可用音轨（可能是付费/大会员限定）"), { statusCode: 502 });

  return {
    kind: "bilibili",
    title: page > 1 ? `${v.title} - P${page} ${pageInfo?.part || ""}`.trim() : v.title,
    artist: v.owner?.name || "bilibili",
    cover: v.pic ? v.pic.replace(/^http:/, "https:") : "",
    duration: Number(pageInfo?.duration || v.duration || 0),
    bvid: v.bvid,
    cid,
    srcUrl: audio.url,
    mime: audio.mime,
    expiresAt: expiryOf(audio.url),
  };
}

/** 直链过期后重新解析。 */
export async function refreshBilibili(track) {
  if (!track?.bvid || !track?.cid) throw new Error("曲目缺少 bvid/cid");
  const audio = await audioUrlOf({ bvid: track.bvid, cid: track.cid });
  if (!audio) throw new Error("音轨已失效");
  return { srcUrl: audio.url, mime: audio.mime, expiresAt: expiryOf(audio.url) };
}
