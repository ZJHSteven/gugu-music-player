import test from "node:test";
import assert from "node:assert/strict";
import { playableAudioSource, sniffAudioMime } from "../../public/cloud/audio-source.js";

test("OPFS 使用无扩展名hash后遗失MIME，必须重新生成带 audio/mpeg 的Blob", async () => {
  const original = new Blob([new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x00,
  ])]); // 模拟无后缀OPFS File.type=''
  const fixed = await playableAudioSource(original, "audio/mpeg");
  assert.equal(fixed.storedMime, "");
  assert.equal(fixed.detectedMime, "audio/mpeg");
  assert.equal(fixed.blob.type, "audio/mpeg");
  assert.deepEqual(new Uint8Array(await fixed.blob.arrayBuffer()),
    new Uint8Array(await original.arrayBuffer()));
});

test("保留原有M4A、WAV、FLAC、Ogg格式而不擅自转码", async () => {
  const m4a = new Uint8Array(24);
  m4a.set([0x66, 0x74, 0x79, 0x70], 4);
  assert.equal(sniffAudioMime(m4a), "audio/mp4");
  assert.equal(sniffAudioMime(new TextEncoder().encode("OggS.....")), "audio/ogg");
  assert.equal(sniffAudioMime(new TextEncoder().encode("fLaC.....")), "audio/flac");
  const ogg = await playableAudioSource(new Blob([new TextEncoder().encode("OggS....")]),
    "audio/mpeg");
  assert.equal(ogg.blob.type, "audio/ogg", "文件实际格式优先于不可信MIME声明");
  const unknown = await playableAudioSource(new Blob(["\0\0\0\0"]),
    "audio/x-m4a");
  assert.equal(unknown.blob.type, "audio/mp4");
});

test("ADTS AAC 头不能错误判为 MP3", async () => {
  const aac = new Uint8Array([
    0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0, 0, 0, 0, 0,
  ]);
  assert.equal(sniffAudioMime(aac), "audio/aac");
  assert.equal((await playableAudioSource(new Blob([aac]), "audio/mpeg")).mime,
    "audio/aac");
});
