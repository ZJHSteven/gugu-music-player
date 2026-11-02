// 日志：同时打到控制台和 data/server.log。
// 公开给别人的时候，出问题让对方把 server.log 发过来就能定位，不用猜。
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024; // 超过 5MB 就滚成 .old，不会无限长

let stream = null;
let written = 0;
let filePath = "";

export function initLog(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    filePath = path.join(dataDir, "server.log");
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_BYTES) {
      fs.renameSync(filePath, path.join(dataDir, "server.old.log"));
    }
    stream = fs.createWriteStream(filePath, { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
  } catch {
    stream = null;
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(line) {
  if (!stream) return;
  try {
    stream.write(line + "\n");
    written += line.length;
    if (written > MAX_BYTES) {
      written = 0;
      stream.end();
      try {
        fs.renameSync(filePath, path.join(path.dirname(filePath), "server.old.log"));
      } catch {}
      stream = fs.createWriteStream(filePath, { flags: "a" });
    }
  } catch {
    stream = null;
  }
}

export function log(...args) {
  const text = args.map((a) => (typeof a === "string" ? a : safe(a))).join(" ");
  console.log(text);
  // 控制台输出本身已经带时间戳的行就不重复加
  write(/^\d\d:\d\d:\d\d /.test(text) ? text : `${stamp()}  ${text}`);
}

export function logError(...args) {
  const text = args.map((a) => (typeof a === "string" ? a : safe(a))).join(" ");
  console.error(...args);
  write(`${stamp()}  [错误] ${text}`);
}

function safe(v) {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

/** 只写文件、不打控制台（请求日志用：终端保持干净，排查时看 server.log）。 */
export function logQuiet(...args) {
  const text = args.map((a) => (typeof a === "string" ? a : safe(a))).join(" ");
  write(/^\d\d:\d\d:\d\d /.test(text) ? text : `${stamp()}  ${text}`);
}