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
import mascotIdleUrl from '../assets/mascot-idle.png';
import mascotIdleWebpUrl from '../assets/mascot-idle.webp';
import mascotActiveUrl from '../assets/mascot-active.png';
import mascotActiveWebpUrl from '../assets/mascot-active.webp';

/** 助手名字 */
export const ASSISTANT_NAME = '小灵';

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
  // 朗读音色：默认 Cherry（百炼 qwen-tts 真人音色），可在面板里切换并持久化
  let currentVoice = 'Cherry';
  const panel = document.createElement('div');
  panel.className = 'ai-chat';
  panel.innerHTML = `
    <div class="ai-chat__head">
      <div class="ai-chat__title">小灵 · 改装助手<small>轮毂 · 姿态 · 车漆建议</small></div>
      <label class="ai-chat__voice" title="选择 AI 朗读音色（百炼真人语音）">
        <span>音色</span>
        <select class="ai-chat__voice-sel">
          <option value="Cherry">Cherry · 甜美</option>
          <option value="Serena">Serena · 温柔知性</option>
          <option value="Ethan">Ethan · 沉稳男声</option>
          <option value="Chelsie">Chelsie · 明亮亲切</option>
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

  /** 调用 /api/chat；支持 SSE 流式与 JSON 兜底 */
  async function send(text) {
    addBubble('user', text);
    history.push({ role: 'user', content: text });
    ta.value = '';
    const aiBubble = addBubble('ai', '', true);
    sendBtn.disabled = true;

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-12), stream: true }),
      });
      const ct = resp.headers.get('content-type') || '';
      let acc = '';
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
              if (j.error) { acc += `\n[错误] ${j.error}`; }
              const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
              if (delta) { acc += delta; aiBubble.textContent = acc; list.scrollTop = list.scrollHeight; }
            } catch { /* 忽略不完整 chunk */ }
          }
        }
      } else {
        const j = await resp.json().catch(() => ({}));
        acc = j.reply || '（没有收到回复）';
      }
      aiBubble.classList.remove('thinking');
      aiBubble.textContent = acc || '（没有收到回复）';
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

  /** 向 /api/chat 取一次回复（语音链路用，不依赖面板） */
  async function ask(text) {
    history.push({ role: 'user', content: text });
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-12), stream: false }),
    });
    const data = await resp.json().catch(() => ({}));
    const reply = (data && data.reply) || '抱歉，我这边没接上，能再说一次吗？';
    history.push({ role: 'assistant', content: reply });
    return reply;
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
  // 解码并播放 TTS 音频；成功返回 true，失败（解码异常 / 无上下文）返回 false
  async function playTts(ab) {
    const ctx = getCtx();
    if (!ctx || !ab || ab.byteLength < 1000) return false;
    try {
      const buf = await ctx.decodeAudioData(ab);
      stopAudio();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => wrap.classList.remove('is-speaking');
      src.start(0);
      currentSource = src;
      return true;
    } catch (e) {
      console.warn('[aiOrb] 解码/播放 TTS 失败', e);
      return false;
    }
  }

  /** 浏览器内置语音（兜底） */
  function speakFallback(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.02;
      const clear = () => wrap.classList.remove('is-speaking');
      u.onend = clear;
      u.onerror = clear;
      wrap.classList.add('is-speaking');
      window.speechSynthesis.speak(u);
    } catch {
      wrap.classList.remove('is-speaking');
    }
  }

  /** 朗读回复：优先服务端真人音色 */
  async function speak(text) {
    if (!text) return;
    wrap.classList.add('is-speaking');
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: currentVoice }),
      });
      if (r.ok) {
        const ab = await r.arrayBuffer();
        if (ab && ab.byteLength > 1000) {
          const played = await playTts(ab);
          if (played) return; // 真人语音已成功播放，结束
        }
      }
      throw new Error('tts unavailable');
    } catch (err) {
      // 服务端音色不可用 → 退回系统语音，保证一定有声音（不再静默切换，给出提示便于排查）
      console.warn('[aiOrb] TTS 真人语音失败，退回系统语音：', err);
      showCaption('真人语音暂不可用，已切换系统语音', 2600);
      wrap.classList.remove('is-speaking');
      speakFallback(text);
    }
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  let listening = false;

  /* wanting = 用户还处在"想说话"的状态。识别引擎常会因为静音/网络自行 end，
     只要用户没主动结束就自动重启，避免"说了一半就断开"（对话时灵时不灵的主因）。 */
  let wanting = false;
  let restartTimer = 0;
  let netErrCount = 0; // 连续网络失败次数（超过阈值退回文字面板）

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
      if (!text) return;
      showCaption(`你说：${text}\n思考中…`, 0);
      try {
        const reply = await ask(text);
        showCaption(reply, 7000);
        speak(reply);
      } catch {
        showCaption('网络好像不太稳，稍后再试一次。', 4000);
      }
    };
  }

  wrap.addEventListener('click', () => {
    unlockAudio(); // 首次点击预热音频播放权限
    // 正在听 → 再点一次结束
    if (wanting || listening) {
      stopListening();
      caption.classList.remove('show');
      return;
    }
    stopAudio();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    wrap.classList.remove('is-speaking');
    if (!recog) {
      openPanel(); // 浏览器不支持语音识别 → 退回文字面板
      return;
    }
    wanting = true;
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
  }
  function resume() {
    wrap.classList.remove('is-paused', 'is-hidden');
  }
  function dispose() {
    pause();
    wanting = false;
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

  return { el: wrap, pause, resume, dispose };
}

export { mountAiOrb };
