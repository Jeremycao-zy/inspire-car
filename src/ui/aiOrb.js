/**
 * aiOrb.js — 首页「小灵」AI 人偶（语音助手入口）
 *
 * 视觉：右下角悬浮的可爱人偶（品牌定制角色：靛蓝云朵头 + 深色面罩 + 胸口 `>_` 终端）。
 *       两张立绘切换：待机（闭眼月牙）/ 说话·聆听（睁眼发光）。
 *       纯 CSS 动画（浮动 + 呼吸 + 说话时轻弹），不再占用 WebGL 上下文 ——
 *       此前这里是第 3 个 WebGL 上下文（另两个是 hero 车模预览与卡片缩略图），
 *       在 iOS Safari 上是 jetsam 闪退的元凶之一。换成 <img> 后该压力直接消失。
 * 对话：面板调用后端 POST /api/chat（OpenAI 兼容、流式 SSE），无 key 时有兜底文案。
 * 语音：点击人偶直接开始识别（连续续听），回复走 /api/tts 真人音色，失败退回系统语音。
 */

import './aiOrb.css';
import { isLoggedIn } from '../auth.js';
import mascotIdleUrl from '../assets/mascot-idle.png';
import mascotIdleWebpUrl from '../assets/mascot-idle.webp';
import mascotActiveUrl from '../assets/mascot-active.png';
import mascotActiveWebpUrl from '../assets/mascot-active.webp';

/** 助手名字 */
export const ASSISTANT_NAME = '小灵';

/* 本次页面会话是否已打过招呼（模块级：首页重复 mount 不重复播） */
let greeted = false;

function mountAiOrb() {
  /* ---------- DOM ---------- */
  const wrap = document.createElement('div');
  wrap.className = 'ai-orb';
  wrap.setAttribute('role', 'button');
  wrap.setAttribute('aria-label', `${ASSISTANT_NAME} · AI 改装助手（点击语音对话）`);

  // 两张立绘：待机（闭眼月牙）/ 活跃（睁眼发光，说话·聆听时切换）
  // 用 <picture> 走 webp（15KB）优先、png（90KB）兜底
  const makeMascot = (cls, pngUrl, webpUrl, alt) => {
    const pic = document.createElement('picture');
    pic.className = `ai-orb__mascot ${cls}`;
    const src = document.createElement('source');
    src.srcset = webpUrl;
    src.type = 'image/webp';
    const img = document.createElement('img');
    img.src = pngUrl;
    img.alt = alt;
    img.draggable = false;
    img.decoding = 'async';
    pic.append(src, img);
    return pic;
  };
  const mascotIdle = makeMascot('ai-orb__mascot--idle', mascotIdleUrl, mascotIdleWebpUrl, ASSISTANT_NAME);
  const mascotActive = makeMascot('ai-orb__mascot--active', mascotActiveUrl, mascotActiveWebpUrl, '');
  mascotActive.setAttribute('aria-hidden', 'true');

  const label = document.createElement('div');
  label.className = 'ai-orb__label';
  label.textContent = ASSISTANT_NAME;

  const hint = document.createElement('div');
  hint.className = 'ai-orb__hint';
  hint.textContent = '点我说话';

  wrap.append(mascotIdle, mascotActive, label, hint);
  document.body.appendChild(wrap);

  /* ---------- 对话面板 ---------- */
  // 朗读音色：默认 Kai「凯」男声·沉稳清爽（qwen3-tts-flash），面板可切换并持久化。
  // 一次性迁移（版本标记）：老默认（无 / Cherry / Nini / Andre / Vincent）→ Kai；用户显式选过的其他音色保留。
  let currentVoice = localStorage.getItem('aiOrbVoice');
  if (localStorage.getItem('aiOrbVoiceMigrated') !== '3') {
    if (!currentVoice || ['Cherry', 'Nini', 'Andre', 'Vincent'].includes(currentVoice)) {
      currentVoice = 'Kai';
      try {
        localStorage.setItem('aiOrbVoice', 'Kai');
      } catch {
        /* ignore */
      }
    }
    try {
      localStorage.setItem('aiOrbVoiceMigrated', '3');
    } catch {
      /* ignore */
    }
  }
  if (!currentVoice) currentVoice = 'Kai';
  const panel = document.createElement('div');
  panel.className = 'ai-chat';
  panel.innerHTML = `
    <div class="ai-chat__head">
      <div class="ai-chat__title">小灵 · 改装助手<small>轮毂 · 姿态 · 车漆建议</small></div>
      <label class="ai-chat__voice" title="选择 AI 朗读音色（百炼真人语音）">
        <span>音色</span>
        <select class="ai-chat__voice-sel">
          <option value="Kai">Kai · 沉稳清爽</option>
          <option value="Ethan">Ethan · 阳光温暖</option>
          <option value="Andre">Andre · 磁性沉稳</option>
          <option value="Vincent">Vincent · 低沉烟嗓</option>
          <option value="Nini">Nini · 甜美自然</option>
          <option value="Momo">Momo · 撒娇可爱</option>
          <option value="Cherry">Cherry · 阳光亲切</option>
          <option value="Serena">Serena · 温柔知性</option>
          <option value="Chelsie">Chelsie · 二次元灵动</option>
        </select>
      </label>
      <button class="ai-chat__close" aria-label="关闭">×</button>
    </div>
    <div class="ai-chat__list"></div>
    <div class="ai-chat__input">
      <textarea placeholder="问问轮毂 / 姿态 / 车漆…" rows="1"></textarea>
      <button class="ai-chat__send">发送</button>
    </div>`;
  document.body.appendChild(panel);
  const list = panel.querySelector('.ai-chat__list');
  const ta = panel.querySelector('textarea');
  const sendBtn = panel.querySelector('.ai-chat__send');
  const closeBtn = panel.querySelector('.ai-chat__close');
  const voiceSel = panel.querySelector('.ai-chat__voice-sel');
  currentVoice = localStorage.getItem('aiOrbVoice') || 'Cherry';
  voiceSel.value = currentVoice;
  voiceSel.addEventListener('change', () => {
    currentVoice = voiceSel.value;
    try { localStorage.setItem('aiOrbVoice', currentVoice); } catch { /* ignore */ }
  });

  const history = [];
  function addBubble(role, text, thinking = false) {
    const b = document.createElement('div');
    b.className = `ai-bubble ${role}${thinking ? ' thinking' : ''}`;
    b.textContent = text || '';
    list.appendChild(b);
    list.scrollTop = list.scrollHeight;
    return b;
  }

  /** 调用 /api/chat；支持 SSE 流式与 JSON 兜底。句子一旦生成立即送 TTS 排队，首句抢先发声 */
  async function send(text) {
    addBubble('user', text);
    history.push({ role: 'user', content: text });
    ta.value = '';
    const aiBubble = addBubble('ai', '', true);
    sendBtn.disabled = true;

    let acc = '';
    let pending = ''; // 未成句缓冲
    let spoken = false;
    const emitSentences = (force) => {
      for (;;) {
        const m = pending.match(/^([\s\S]*?[。！？；!?;\n])([\s\S]*)$/);
        if (m) {
          const s = m[1].trim();
          if (s) {
            speakPush(s);
            spoken = true;
          }
          pending = m[2];
          continue;
        }
        if (force && pending.trim()) {
          speakPush(pending.trim());
          spoken = true;
          pending = '';
        }
        break;
      }
    };

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-12), stream: true }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('text/event-stream') && resp.body) {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const s = line.trim();
            if (!s || !s.startsWith('data:')) continue;
            const data = s.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              if (j.error) {
                acc += `\n[错误] ${j.error}`;
              }
              const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
              if (delta) {
                acc += delta;
                pending += delta;
                aiBubble.textContent = acc;
                list.scrollTop = list.scrollHeight;
                emitSentences(false); // 完整句子立刻送 TTS
              }
            } catch {
              /* 忽略不完整 chunk */
            }
          }
        }
      } else {
        const j = await resp.json().catch(() => ({}));
        acc = j.reply || '（没有收到回复）';
        pending = acc;
      }
      aiBubble.classList.remove('thinking');
      aiBubble.textContent = acc || '（没有收到回复）';
      emitSentences(true); // 尾巴整句送出
      if (!spoken && acc && !acc.startsWith('[错误]')) speak(acc); // 没切出句子就整段播
      if (acc && !acc.startsWith('[错误]')) history.push({ role: 'assistant', content: acc });
    } catch (e) {
      aiBubble.classList.remove('thinking');
      aiBubble.textContent = `对话失败：${e.message}`;
    } finally {
      sendBtn.disabled = false;
    }
  }

  function openPanel() {
    panel.classList.add('open');
    if (!list.children.length) {
      addBubble('ai', `你好，我是${ASSISTANT_NAME}，灵感改装的 AI 助手。想换轮毂、调姿态还是改车漆？告诉我你的车型，我帮你出方案。`);
    }
    setTimeout(() => ta.focus(), 280);
  }
  function closePanel() {
    panel.classList.remove('open');
  }

  /* ---------- 语音交互：点一下球体直接开始听，不弹面板 ---------- */
  const caption = document.createElement('div');
  caption.className = 'ai-orb__caption';
  document.body.appendChild(caption);
  let captionTimer = 0;
  function showCaption(text, autoHideMs = 4000) {
    caption.textContent = text;
    caption.classList.add('show');
    clearTimeout(captionTimer);
    if (autoHideMs) {
      captionTimer = setTimeout(() => caption.classList.remove('show'), autoHideMs);
    }
  }

  /** 向 /api/chat 流式取回复（语音链路用，不依赖面板）。
   *  每出现一个完整句子立即回调 onSentence（送 TTS 排队，首句抢先发声）；
   *  onDelta(全文累积) 用于实时字幕。 */
  async function askStream(text, onDelta, onSentence) {
    history.push({ role: 'user', content: text });
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-12), stream: true }),
    });
    const ct = resp.headers.get('content-type') || '';
    let acc = '';
    let pending = ''; // 未成句缓冲
    const pump = (force) => {
      for (;;) {
        const m = pending.match(/^([\s\S]*?[。！？；!?;\n])([\s\S]*)$/);
        if (m) {
          const s = m[1].trim();
          if (s) onSentence(s);
          pending = m[2];
          continue;
        }
        if (force && pending.trim()) {
          onSentence(pending.trim());
          pending = '';
        }
        break;
      }
    };
    if (ct.includes('text/event-stream') && resp.body) {
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s || !s.startsWith('data:')) continue;
          const data = s.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
            if (delta) {
              acc += delta;
              pending += delta;
              if (onDelta) onDelta(acc);
              pump(false); // 完整句子立刻送 TTS
            }
          } catch {
            /* 忽略不完整 chunk */
          }
        }
      }
    } else {
      const j = await resp.json().catch(() => ({}));
      acc = j.reply || '';
      pending = acc;
      if (onDelta) onDelta(acc);
    }
    pump(true); // 尾巴整句送出
    if (acc && !acc.startsWith('[错误]')) history.push({ role: 'assistant', content: acc });
    return acc;
  }

  /* 服务端音色（百炼 qwen-tts）：系统默认中文音色机械感重、各平台还不一致，
     优先用服务端合成；失败或无 key 时自动退回浏览器 speechSynthesis。 */
  // Web Audio 播放：用 AudioContext 解码 WAV 后用 AudioBufferSourceNode 播放。
  // 关键优势：只要在用户手势里 resume 过 AudioContext，异步（fetch 回来后）播放
  // 就不再受 <audio> 元素的自动播放策略约束——这才是之前「退回系统语音」的根因
  // （<audio>.play() 在 iOS Safari / 部分浏览器即便预热过也仍可能被拦截）。
  let audioCtx = null;
  let currentSource = null;
  function getCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  // 在用户手势里解锁音频上下文（点击 AI 球 / 发送按钮 / 回车都会调用）
  function unlockAudio() {
    getCtx();
  }
  function stopAudio() {
    try {
      if (currentSource) {
        currentSource.onended = null;
        currentSource.stop();
        currentSource.disconnect();
      }
    } catch {
      /* ignore */
    }
    currentSource = null;
  }
  // 解码并播放 TTS 音频；成功返回 true，失败（解码异常 / 无上下文）返回 false。
  // onEnd 在音频自然播放结束时触发（连续对话模式靠它接续聆听）。
  async function playTts(ab, onEnd, epoch) {
    const ctx = getCtx();
    if (!ctx || !ab || ab.byteLength < 1000) return false;
    try {
      const buf = await ctx.decodeAudioData(ab);
      if (epoch !== undefined && epoch !== audioEpoch) return false; // 已被用户打断，丢弃
      stopAudio();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1.2; // 播放加速约 20%，对话更利落
      src.connect(ctx.destination);
      src.onended = () => {
        wrap.classList.remove('is-speaking');
        if (onEnd) onEnd();
      };
      src.start(0);
      currentSource = src;
      return true;
    } catch (e) {
      console.warn('[aiOrb] 解码/播放 TTS 失败', e);
      return false;
    }
  }

  /** 浏览器内置语音（兜底） */
  function speakFallback(text, onEnd) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.15; // 稍快，与真人音色听感接近
      const clear = () => {
        wrap.classList.remove('is-speaking');
        if (onEnd) onEnd();
      };
      u.onend = clear;
      u.onerror = clear;
      wrap.classList.add('is-speaking');
      window.speechSynthesis.speak(u);
    } catch {
      wrap.classList.remove('is-speaking');
    }
  }

  // 朗读前清洗：TTS 会把 Markdown 符号 / 表情 / 装饰字符读出来，很难听
  function sanitizeForSpeech(t) {
    return String(t || '')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
      .replace(/[*#`>_~～]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- TTS 句子队列 ----------
   * 流式回复每产生一个完整句子就立刻送 TTS 排队播放：首句抢先发声，
   * 不用等整段回复生成完，大幅缩短「回应间隔」。队列顺序播放、互不取消。 */
  const speechQ = { items: [], playing: false, drain: null };
  function speakPush(text) {
    if (!text) return;
    speechQ.items.push(text);
    if (!speechQ.playing) speakNext();
  }
  function speakNext() {
    const item = speechQ.items.shift();
    if (!item) {
      speechQ.playing = false;
      const cb = speechQ.drain;
      speechQ.drain = null;
      if (cb) cb();
      return;
    }
    speechQ.playing = true;
    speak(item, speakNext, true); // queued：顺序播放，不互相顶号
  }
  function speakClear() {
    speechQ.items = [];
  }
  /** 队列排空后执行回调（连续对话靠它接续聆听） */
  function onSpeechDrain(cb) {
    if (!speechQ.playing && !speechQ.items.length) cb();
    else speechQ.drain = cb;
  }

  /** 朗读一段文本：优先服务端真人音色。
   *  onEnd = 播放自然结束回调；queued = 队列模式（顺序播放，不顶号）。 */
  let speakSeq = 0; // 连续整段发言时只播最新一条，避免新旧语音交叠
  let audioEpoch = 0; // 用户手动打断时 +1，作废所有在途音频
  async function speak(text, onEnd, queued = false) {
    const clean = sanitizeForSpeech(text);
    if (!clean) {
      if (onEnd) onEnd();
      return;
    }
    if (!queued) speakClear(); // 整段发言顶掉排队中的句子
    const seq = ++speakSeq;
    const epoch = audioEpoch;
    const stale = () => !queued && seq !== speakSeq;
    wrap.classList.add('is-speaking');
    const endOnce = () => {
      if (!stale() && onEnd) onEnd();
    };
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean.slice(0, 500), voice: currentVoice }),
      });
      if (r.ok) {
        const ab = await r.arrayBuffer();
        if (ab && ab.byteLength > 1000) {
          if (stale() || epoch !== audioEpoch) {
            endOnce();
            return;
          }
          const played = await playTts(ab, endOnce, epoch);
          if (played) return; // 真人语音已成功播放，结束
        }
      }
      throw new Error('tts unavailable');
    } catch (err) {
      if (stale() || epoch !== audioEpoch) {
        endOnce();
        return;
      }
      // 服务端音色不可用 → 退回系统语音，保证一定有声音（不再静默切换，给出提示便于排查）
      console.warn('[aiOrb] TTS 真人语音失败，退回系统语音：', err);
      showCaption('真人语音暂不可用，已切换系统语音', 2600);
      wrap.classList.remove('is-speaking');
      speakFallback(clean, endOnce);
    }
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  let listening = false;

  /* wanting = 用户还处在"想说话"的状态。识别引擎常会因为静音/网络自行 end，
     只要用户没主动结束就自动重启，避免"说了一半就断开"（对话时灵时不灵的主因）。
     converseMode = 连续对话模式：进入后每轮回复播完自动接着听，不用反复点小球；
     用户再点一次小球即退出。 */
  let wanting = false;
  let converseMode = false;
  let restartTimer = 0;
  let netErrCount = 0; // 连续网络失败次数（超过阈值退回文字面板）

  /** 回复播完后自动接续聆听（连续对话） */
  function autoListen() {
    if (!converseMode || !recog) return;
    showCaption('我在听，继续说…', 0);
    wanting = true;
    try {
      recog.start();
    } catch {
      restartListening(400); // 引擎正忙，稍后自动重试
    }
  }

  function stopListening() {
    wanting = false;
    listening = false;
    clearTimeout(restartTimer);
    restartTimer = 0;
    wrap.classList.remove('is-listening');
    try {
      recog?.stop();
    } catch {
      /* ignore */
    }
  }

  function restartListening(delay = 350) {
    if (!wanting || !recog) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!wanting) return;
      try {
        recog.start();
      } catch {
        // 已在运行等状态：稍后再试
        restartListening(600);
      }
    }, delay);
  }

  if (SR) {
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.interimResults = true;
    recog.continuous = false;
    recog.onstart = () => {
      listening = true;
      wrap.classList.add('is-listening');
    };
    recog.onend = () => {
      listening = false;
      // 用户没喊停 → 自动续听
      if (wanting) restartListening();
      else wrap.classList.remove('is-listening');
    };
    recog.onerror = (ev) => {
      const code = ev?.error || '';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        // 麦克风权限被拒：给明确指引，并退回文字面板（否则用户会卡在"聆听中"进退两难）
        wanting = false;
        listening = false;
        wrap.classList.remove('is-listening');
        showCaption('麦克风被禁用，已切换文字对话；可在浏览器地址栏允许麦克风权限。', 5000);
        openPanel();
        return;
      }
      if (code === 'no-speech') {
        restartListening(200); // 只是没听到声音，继续听
        return;
      }
      if (code === 'network') {
        showCaption('网络不稳定，正在重试聆听…', 2500);
        netErrCount += 1;
        if (netErrCount >= 3) {
          // 连续网络失败：放弃语音，直接给文字面板，避免无限重试
          wanting = false;
          listening = false;
          wrap.classList.remove('is-listening');
          showCaption('语音识别连不上，已切换文字对话。', 4000);
          openPanel();
          return;
        }
        restartListening(800);
        return;
      }
      restartListening(600);
    };
    recog.onresult = async (ev) => {
      const text = Array.from(ev.results)
        .map((r) => r[0].transcript)
        .join('')
        .trim();
      if (!ev.results[0].isFinal) {
        if (text) showCaption(text, 0); // 实时字幕
        return;
      }
      stopListening();
      netErrCount = 0;
      if (!text) {
        if (converseMode) autoListen();
        return;
      }
      showCaption('思考中…', 0);
      try {
        let spoken = false;
        const reply = await askStream(
          text,
          (full) => showCaption(full, 0), // 实时字幕：边生成边显示
          (sentence) => {
            spoken = true;
            speakPush(sentence); // 出一句、播一句，首句抢先发声
          }
        );
        if (!spoken && reply) speakPush(reply);
        onSpeechDrain(() => {
          if (converseMode) autoListen(); // 全部播完再接续聆听
        });
      } catch {
        showCaption('网络好像不太稳，稍后再试一次。', 4000);
        if (converseMode) autoListen();
      }
    };
  }

  wrap.addEventListener('click', () => {
    unlockAudio(); // 首次点击预热音频播放权限
    // 正在听 → 再点一次结束（退出连续对话）
    if (wanting || listening) {
      stopListening();
      converseMode = false;
      speakClear(); // 丢掉排队中还没播的句子
      audioEpoch++; // 作废在途音频（打断当前朗读）
      caption.classList.remove('show');
      return;
    }
    stopAudio();
    speakClear();
    audioEpoch++;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    wrap.classList.remove('is-speaking');
    if (!recog) {
      openPanel(); // 浏览器不支持语音识别 → 退回文字面板
      return;
    }
    wanting = true;
    converseMode = true; // 进入连续对话：回复播完自动继续听
    netErrCount = 0;
    showCaption('正在聆听…', 0);
    try {
      recog.start();
    } catch {
      restartListening(400); // 引擎正忙，稍后自动重试
    }
  });
  closeBtn.addEventListener('click', closePanel);
  sendBtn.addEventListener('click', () => { unlockAudio(); const v = ta.value.trim(); if (v) send(v); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); unlockAudio(); const v = ta.value.trim(); if (v) send(v); }
  });

  /* ---------- 生命周期 ---------- */
  // 人偶是纯 CSS 动画：离开首页（进 TUNING STUDIO / 页面进后台）时淡出并冻结动画，
  // 回到首页再淡入。旧实现是 WebGL 球"原地冻住"，看着像渲染卡死。
  function pause() {
    wrap.classList.add('is-paused', 'is-hidden');
    converseMode = false; // 离开首页：退出连续对话、停止聆听
    speakClear();
    audioEpoch++;
    stopListening();
  }
  function resume() {
    wrap.classList.remove('is-paused', 'is-hidden');
  }
  function dispose() {
    pause();
    wanting = false;
    if (greetingCleanup) greetingCleanup(); // 拆掉进门引导的手势监听
    clearTimeout(restartTimer);
    stopAudio();
    try {
      recog?.abort?.();
    } catch {
      /* ignore */
    }
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
    clearTimeout(captionTimer);
    caption.remove();
    wrap.remove();
    panel.remove();
  }

  /* ---------- 进门引导语：进主页主动打招呼，引导登录注册 / 开始改装 ---------- */
  let greetingCleanup = null;
  let greetingAudio = null; // 预取的引导语音频：手势一来立刻播，不用等合成

  function greetingText() {
    return isLoggedIn()
      ? '你好，我是小灵！告诉我你的车型和想法，咱们开始改装吧。想换轮毂、调姿态还是改车漆，直接跟我说。'
      : '你好，我是小灵，你的改装助手！第一次来的话，先点右上角登录或注册一下，之后告诉我你的车型和想法，我帮你定制轮毂、姿态或者车漆方案。';
  }

  // 进页面就并行预取引导语音频（fetch 不受自动播放策略限制，只有播放需要手势）
  function prefetchGreeting() {
    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: greetingText().slice(0, 500), voice: currentVoice }),
    })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => {
        if (ab && ab.byteLength > 1000) greetingAudio = ab;
      })
      .catch(() => {
        /* 预取失败无所谓：手势后走常规合成 */
      });
  }

  function playGreeting() {
    if (greeted) return;
    greeted = true;
    if (greetingCleanup) greetingCleanup();
    const text = greetingText();
    showCaption(text, 0); // 先上字幕，音频就绪前也有反馈
    const onEnd = () => showCaption(isLoggedIn() ? '点我，随时跟我聊改装' : '点我随时说话，或先点右上角登录', 6000);
    if (greetingAudio) {
      wrap.classList.add('is-speaking');
      Promise.resolve(playTts(greetingAudio, onEnd, audioEpoch)).then((ok) => {
        if (!ok) speak(text, onEnd); // 预取音频解码失败 → 退回常规合成
      });
      return;
    }
    speak(text, onEnd);
  }

  function scheduleGreeting() {
    if (greeted) return;
    prefetchGreeting(); // 立刻并行预取，覆盖 900ms 等待 + 合成耗时
    setTimeout(() => {
      if (greeted) return;
      const ctx = getCtx();
      if (ctx && ctx.state === 'running') {
        playGreeting(); // 之前已有点击手势、音频已解锁 → 直接说
        return;
      }
      // 浏览器自动播放策略：必须等用户首次手势才能出声。
      // 先用人偶弹跳 + 字幕吸引注意，任意点击/按键即解锁并播放引导语。
      wrap.classList.add('is-greeting');
      showCaption('你好呀，点一下页面，听我打招呼', 0);
      const onGesture = (ev) => {
        const t = ev && ev.target;
        if (t && t.closest && t.closest('.ai-orb')) {
          greeted = true; // 用户直接点了小球：跳过引导语，进入正常对话
          greetingCleanup();
          return;
        }
        unlockAudio();
        playGreeting();
      };
      greetingCleanup = () => {
        window.removeEventListener('pointerdown', onGesture);
        window.removeEventListener('keydown', onGesture);
        wrap.classList.remove('is-greeting');
      };
      window.addEventListener('pointerdown', onGesture);
      window.addEventListener('keydown', onGesture);
    }, 900);
  }
  scheduleGreeting();

  return { el: wrap, pause, resume, dispose };
}

export { mountAiOrb };
