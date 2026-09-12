/**
 * voice.mjs — 语音合成（TTS）
 *
 * 为什么不用浏览器的 speechSynthesis：
 *   系统默认中文音色机械感强、各平台音色还不一致（用户明确反馈"太难听"）。
 *   这里改走阿里云百炼 DashScope 的 qwen-tts（神经网络真人音色），
 *   **复用 vision.mjs 已有的 key 解析**（getVisionKey），不需要新增任何密钥。
 *
 * 服务端合成后把音频代理回前端，避免直连 OSS 的跨域/签名过期问题。
 */

import { getVisionKey } from './vision.mjs';

const TTS_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/** qwen-tts 官方音色（可按需扩展） */
export const VOICES = [
  'Cherry', // 女声 · 甜美自然（默认）
  'Serena', // 女声 · 温柔知性
  'Ethan', // 男声 · 沉稳
  'Chelsie', // 女声 · 明亮亲切
  'Dylan', // 男声 · 年轻活力（北京腔）
  'Jada', // 女声 · 干练
  'Sunny', // 女声 · 活泼
];
const DEFAULT_VOICE = process.env.TTS_VOICE || 'Cherry';

/** 取 DashScope（百炼）key；只有 qwen 通道的 key 才适用于 TTS */
function dashKey() {
  const v = getVisionKey();
  if (v && v.name === 'qwen' && v.key) return v.key;
  return null;
}

/** TTS 是否可用（无 key 时前端会退回浏览器语音） */
export function ttsAvailable() {
  return !!dashKey();
}

/**
 * 文本 → 语音
 * @param {string} text
 * @param {string} [voice] 音色名，取值见 VOICES
 * @returns {Promise<{audio: Buffer, mime: string, voice: string, model: string}|null>}
 *          不可用或失败返回 null（调用方应退回浏览器 speechSynthesis）
 */
export async function synthesize(text, voice) {
  const key = dashKey();
  const clean = String(text || '').trim();
  if (!key || !clean) return null;

  const v = VOICES.includes(voice) ? voice : DEFAULT_VOICE;
  // qwen-tts 对单次文本长度有限制，超长截断，避免整句失败
  const body = {
    model: 'qwen-tts',
    input: { text: clean.slice(0, 500), voice: v },
  };

  try {
    const r = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.warn('[tts] 合成请求失败', r.status, (await r.text().catch(() => '')).slice(0, 200));
      return null;
    }
    const j = await r.json().catch(() => null);
    const url = j?.output?.audio?.url;
    if (!url) return null;

    const a = await fetch(url);
    if (!a.ok) return null;
    const buf = Buffer.from(await a.arrayBuffer());
    if (!buf.length) return null;
    return { audio: buf, mime: 'audio/wav', voice: v, model: 'qwen-tts' };
  } catch (e) {
    console.warn('[tts] 合成异常', e?.message || e);
    return null;
  }
}

/**
 * 处理 POST /api/tts
 * 入参：{ text, voice? }
 * 出参：成功 → audio/wav 二进制；失败 → 501（前端据此退回浏览器语音）
 */
export async function handleTts(req, res) {
  let body = null;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  const text = String(body?.text || '').trim();
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '缺少文本' }));
    return;
  }
  if (!ttsAvailable()) {
    res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'no-tts-key' }));
    return;
  }
  const out = await synthesize(text, body?.voice);
  if (!out) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'tts-failed' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': out.mime,
    'Content-Length': out.audio.length,
    'Cache-Control': 'no-store',
  });
  res.end(out.audio);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1 << 20) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
