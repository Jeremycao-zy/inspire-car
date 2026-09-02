/**
 * voice.js — 浏览器原生语音能力封装（Web Speech API）
 *
 * 两个能力：
 *   · 听：SpeechRecognition   语音 → 文字
 *   · 说：speechSynthesis    文字 → 语音
 *
 * 为什么用浏览器原生而不是后端 Whisper/TTS：
 *   · 零成本、零后端负担、无网络往返延迟
 *   · 改装场景多为短句指令（"轮毂换20寸""再低一点"），识别率足够
 * 代价：Safari 支持不完整（iOS 上 recognition 需用户手势且可用性有限），
 *       所以 UI 必须保留文本输入作为兜底，绝不能只依赖语音。
 *
 * 兼容性：Chrome/Edge 完整支持；Firefox 需开 media.webspeech.recognition；
 *          Safari 从 14.1 起支持 speechSynthesis，recognition 支持较晚且不稳定。
 */

const SpeechRecognition = typeof window !== 'undefined'
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : null;

export const RECOGNITION_SUPPORTED = !!SpeechRecognition;
export const SYNTHESIS_SUPPORTED = typeof window !== 'undefined' && 'speechSynthesis' in window;

/* ------------------------- 语音识别（听） ------------------------- */

/**
 * 创建识别器。
 *
 * @param {object} o
 * @param {(text:string, isFinal:boolean)=>void} o.onResult 识别回调（isFinal=false 为临时结果）
 * @param {(err:{code:string, message:string})=>void} [o.onError]
 * @param {()=>void} [o.onEnd]  无论成功失败都会触发
 * @param {string} [o.lang='zh-CN']
 * @returns {{start:()=>void, stop:()=>void, abort:()=>void, isListening:()=>boolean}|null}
 */
export function createRecognizer({ onResult, onError, onEnd, lang = 'zh-CN' } = {}) {
  if (!RECOGNITION_SUPPORTED) return null;

  const rec = new SpeechRecognition();
  rec.lang = lang;
  rec.continuous = false;      // 说完一句自动停，符合"按住说话"的直觉
  rec.interimResults = true;   // 实时回传临时结果，UI 能显示"正在识别…"
  rec.maxAlternatives = 1;

  let listening = false;
  let stoppedByUser = false;

  rec.onstart = () => {
    listening = true;
  };

  rec.onresult = (evt) => {
    let interim = '';
    let final = '';
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const r = evt.results[i];
      const text = r[0]?.transcript || '';
      if (r.isFinal) final += text;
      else interim += text;
    }
    if (final) onResult?.(final.trim(), true);
    else if (interim) onResult?.(interim.trim(), false);
  };

  rec.onerror = (evt) => {
    // aborted 通常是用户主动 stop()，不算真错误，静默处理
    if (evt.error === 'aborted') return;
    const MESSAGES = {
      'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏允许后重试',
      'service-not-allowed': '语音服务不可用，请检查系统麦克风设置',
      'no-speech': '没听清，再说一次',
      network: '网络异常，语音识别失败',
      'audio-capture': '找不到麦克风设备',
    };
    onError?.({
      code: evt.error,
      message: MESSAGES[evt.error] || `语音识别出错（${evt.error}）`,
    });
  };

  rec.onend = () => {
    listening = false;
    onEnd?.();
  };

  return {
    start() {
      if (listening) return;
      stoppedByUser = false;
      try {
        rec.start();
      } catch {
        /* 已在监听时 start 会抛 InvalidStateError，忽略 */
      }
    },
    stop() {
      stoppedByUser = true;
      try {
        rec.stop();
      } catch {
        /* 忽略 */
      }
    },
    abort() {
      stoppedByUser = true;
      try {
        rec.abort();
      } catch {
        /* 忽略 */
      }
    },
    isListening: () => listening,
  };
}

/* ------------------------- 语音合成（说） ------------------------- */

let preferredVoice = null;

/** 挑一个中文音色（优先本地、优先普通话） */
function pickChineseVoice() {
  if (!SYNTHESIS_SUPPORTED) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;

  const isZh = (v) => /zh|cmn|Chinese|普通话|中文/i.test(`${v.lang} ${v.name}`);
  const zh = voices.filter(isZh);
  if (!zh.length) return null;

  // 优先本地音色（不依赖网络、延迟低）
  const local = zh.find((v) => v.localService);
  // 再优先大陆普通话，避免 picked 到粤语/台湾腔
  const mainland = zh.find((v) => /zh[-_]CN|cmn[-_]Hans/i.test(v.lang));
  return local || mainland || zh[0];
}

/** 部分浏览器 getVoices() 首次返回空数组，需监听 voiceschanged */
if (SYNTHESIS_SUPPORTED) {
  const load = () => {
    preferredVoice = pickChineseVoice();
  };
  load();
  window.speechSynthesis.addEventListener?.('voiceschanged', load);
}

/**
 * 朗读一段文本。
 * 自动剔除 markdown 符号与工具回执里的技术参数，让播报更像人说话。
 *
 * @param {string} text
 * @param {object} [o] { rate=1.05, pitch=1, volume=1, onstart, onend }
 */
export function speak(text, { rate = 1.05, pitch = 1, volume = 1, onstart, onend } = {}) {
  if (!SYNTHESIS_SUPPORTED || !text) {
    onend?.();
    return;
  }
  // 先停掉上一句，避免连续指令时语音排队堆积
  window.speechSynthesis.cancel();

  const clean = String(text)
    .replace(/```[\s\S]*?```/g, '')      // 代码块
    .replace(/[*_`#]/g, '')              // markdown 标记
    .replace(/https?:\/\/\S+/g, '')      // 链接
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!clean) {
    onend?.();
    return;
  }

  const u = new SpeechSynthesisUtterance(clean);
  if (!preferredVoice) preferredVoice = pickChineseVoice();
  if (preferredVoice) u.voice = preferredVoice;
  u.lang = preferredVoice?.lang || 'zh-CN';
  u.rate = rate;
  u.pitch = pitch;
  u.volume = volume;
  u.onstart = () => onstart?.();
  u.onend = () => onend?.();
  u.onerror = () => onend?.();

  window.speechSynthesis.speak(u);
}

/** 停止朗读 */
export function stopSpeaking() {
  if (SYNTHESIS_SUPPORTED) window.speechSynthesis.cancel();
}

/** 是否正在朗读 */
export function isSpeaking() {
  return SYNTHESIS_SUPPORTED ? window.speechSynthesis.speaking : false;
}
