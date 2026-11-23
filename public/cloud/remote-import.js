/**
 * HTTPS 音频直链导入，仅在 GM 浏览器中执行。
 *
 * 跨域下载的前提是音源允许 CORS；不能通过 Cloudflare Worker 兜底抓取，
 * 也不会把 URL 中的授权参数、Cookie 或临时签名广播给房间成员。
 * 只有成功读完、确认不超过 64 MiB、验证音频文件头后，调用现有的
 * uploadTrack() 把 File 写入 OPFS，再通知 DO 有新的音频可供中继。
 */
import { MAX_AUDIO_SIZE } from "./wire.js";
import { sniffAudioMime } from "./audio-source.js";
const byExt={mp3:"audio/mpeg",m4a:"audio/mp4",mp4:"audio/mp4",aac:"audio/aac",
  ogg:"audio/ogg",oga:"audio/ogg",opus:"audio/ogg",wav:"audio/wav",
  flac:"audio/flac",webm:"audio/webm",m4s:"audio/mp4"};
const extOfMime=mime=>Object.keys(byExt).find(k=>byExt[k]===mime)||"mp3";
export function validateDirectUrl(input){
  let u;
  try{u=new URL(String(input||"").trim())}catch{throw new Error("请输入完整的 HTTPS 音频直链")}
  if(u.protocol!=="https:"||u.username||u.password)throw new Error("只支持无账号密码的 HTTPS 直链");
  const host=u.hostname.toLowerCase().replace(/\.$/,"");
  if(host==="localhost"||host.endsWith(".local")||host.endsWith(".internal")||
     host==="[::1]"||/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)||
     /^[0-9a-f:]+$/i.test(host))throw new Error("不能导入内网或 IP 地址");
  return u.href;
}
export function filenameOf(url,title="",mimeHint=""){
  const u=new URL(url);
  let fromPath="";
  try{fromPath=decodeURIComponent(u.pathname.split("/").pop()||"")}catch{}
  const ext=(/\.([a-z0-9]{2,5})$/i.exec(fromPath)?.[1]||"").toLowerCase();
  const mime=byExt[ext]||mimeHint.split(";")[0].toLowerCase().trim();
  // 网络音源有时会将 .mp3 扩展名对应的内容改为 MP4；
  // 如果检测到了与扩展名不一致的 MIME，以真实媒体类型选取扩展名。
  const extension=byExt[ext]&&(!mimeHint||byExt[ext]===mimeHint)?ext:extOfMime(mime);
  const name=String(title||fromPath.replace(/\.[^.]+$/,"")||"直链音频")
    .replace(/[\x00-\x1f\\/:*?"<>|]/g,"_").trim().slice(0,110)||"直链音频";
  return {name:name+"."+extension,mime:byExt[extension]||mime||"audio/mpeg"};
}
export async function responseToAudioFile(response,{url,title="",mimeHint="",onProgress}={}){
  if(!response.ok)throw new Error("音频下载 HTTP "+response.status);
  if(!response.body)throw new Error("链接没有返回音频内容");
  const contentType=(response.headers.get("Content-Type")||"").split(";")[0].toLowerCase();
  if(/^(text\/|application\/(?:json|xml))/.test(contentType))
    throw new Error("链接返回了网页/JSON，不是可下载的音频文件");
  const size=Number(response.headers.get("Content-Length")||0);
  if(size>MAX_AUDIO_SIZE)throw new Error("音频超过64MiB，不能加入房间");
  const chunks=[],reader=response.body.getReader();let count=0;
  const signature=new Uint8Array(24);
  let signatureLength=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      count+=value.byteLength;
      if(count>MAX_AUDIO_SIZE)throw new Error("音频超过64MiB，已停止下载");
      // 仅积攒前 24 字节作为媒体文件签名，避免为鉴别格式再复制整个音频。
      if(signatureLength<signature.length){
        const n=Math.min(value.byteLength,signature.length-signatureLength);
        signature.set(value.subarray(0,n),signatureLength);
        signatureLength+=n;
      }
      chunks.push(value);
      onProgress?.(size>0?Math.min(0.95,count/size):Math.min(0.9,count/MAX_AUDIO_SIZE));
    }
  }catch(e){await reader.cancel().catch(()=>{});throw e}
  if(!count)throw new Error("音频文件为空");
  // 不信任 URL 的文件扩展名和 HTTP Content-Type：很多错误页面会冒充 mp3，
  // 仅凭 HTTP 200 就加入歌单，会制造“添加成功但永远没声音”的假成功。
  const detected=sniffAudioMime(signature.subarray(0,signatureLength));
  if(!detected)throw new Error("文件头不是支持的音频格式，请确认这是 MP3、M4A、AAC、OGG、WAV、FLAC 或 WebM 音频直链");
  const outputMime=detected;
  const name=filenameOf(url,title,outputMime).name;
  return new File(chunks,name,{type:outputMime});
}
export async function downloadDirectAudio(input,{title="",onProgress}={}){
  const url=validateDirectUrl(input);
  let response;
  try{response=await fetch(url,{method:"GET",mode:"cors",credentials:"omit",cache:"no-store"})}
  catch(e){throw new Error("直链无法跨域读取（CORS）或网络失败；需音源允许浏览器直接下载："+e.message)}
  return responseToAudioFile(response,{url,title,onProgress});
}
