/**
 * 从浏览器私人音频缓存还原「可识别的媒体源」。
 *
 * 音频文件以 SHA-256 作为 OPFS 文件名保存，文件名没有 .mp3/.m4a 后缀；
 * 在部分 WebKit 中，OPFS 的 File.type 因此可能为空。若直接
 * URL.createObjectURL(file)，WebKit 就可能以
 * MEDIA_ERR_SRC_NOT_SUPPORTED(4) 拒绝加载，即使文件 SHA256 完全正确。
 *
 * 先检查文件头（magic bytes），然后选择原始 Metadata 的 MIME 兜底。
 * 不修改音频内容、不伪装不支持的音频编码，也不把 File 的内容再上传。
 * new Blob([file], {type}) 仅构造带媒体类型的 Blob，供 URL.createObjectURL。
 */
const supportedMimes = new Set([
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav",
  "audio/ogg", "audio/webm", "audio/flac", "audio/x-flac",
  "audio/aiff", "audio/x-aiff", "audio/x-m4a",
]);

export function sniffAudioMime(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (arr.length < 4) return null;
  const ascii = (from, length) => String.fromCharCode(...arr.slice(from, from + length));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  // ADTS AAC 与 MP3 都可能以 0xff 0xf? 开头；先匹配更具体的 ADTS，
  // 否则会把 AAC 误认成 MP3，在 iOS 上制造新的错误 4。
  if (arr[0] === 0xff && (arr[1] & 0xf6) === 0xf0) return "audio/aac";
  if (ascii(0, 3) === "ID3" ||
      (arr[0] === 0xff && (arr[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(4, 4) === "ftyp") return "audio/mp4";
  if (ascii(0, 4) === "FORM" &&
      (ascii(8, 4) === "AIFF" || ascii(8, 4) === "AIFC")) return "audio/aiff";
  if (arr[0] === 0x1a && arr[1] === 0x45 && arr[2] === 0xdf &&
      arr[3] === 0xa3) return "audio/webm";
  return null;
}

function cleanMime(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();
  if (mime === "audio/mp3" || mime === "audio/x-mp3") return "audio/mpeg";
  if (mime === "audio/x-wav" || mime === "audio/wave") return "audio/wav";
  if (mime === "audio/x-m4a") return "audio/mp4";
  return supportedMimes.has(mime) ? mime : null;
}

/**
 * @param {Blob|File} file 已按 SHA-256 校验并保存在 OPFS/IndexedDB 的文件
 * @param {string} declaredMime 房间元数据中的原始歌曲 MIME
 * @returns {Promise<{blob:Blob,mime:string,detectedMime:string|null,
 *    storedMime:string,declaredMime:string,codecSupported:string}>}
 */
export async function playableAudioSource(file, declaredMime = "") {
  if (!(file instanceof Blob)) throw new TypeError("缓存音频文件无效");
  const head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  const detectedMime = sniffAudioMime(head);
  const mime = detectedMime || cleanMime(file.type) ||
    cleanMime(declaredMime) || "application/octet-stream";
  // iOS 不能通过这个函数解决浏览器压根不支持的 Opus/FLAC/OGG 解码。
  // 诊断可以利用 canPlayType 提醒使用 MP3 或 M4A(AAC)。
  const probe = typeof Audio === "function" ? new Audio() : null;
  const codecSupported = probe?.canPlayType?.(mime) || "";
  return {
    blob: new Blob([file], { type: mime }),
    mime,
    detectedMime,
    storedMime: file.type || "",
    declaredMime: String(declaredMime || "").slice(0, 80),
    codecSupported,
  };
}
