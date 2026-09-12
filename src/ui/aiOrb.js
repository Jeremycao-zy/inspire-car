/**
 * aiOrb.js — 首页「发光点阵球」AI 对话入口
 *
 * 视觉：右下角悬浮的 Three.js 点阵球（Fibonacci 球面分布 + 加法混合 + 辉光贴图 +
 *       缓慢自转 + 轻微浮动 + CSS 呼吸光环），点击展开侧滑对话面板。
 * 对话：面板调用后端 POST /api/chat（OpenAI 兼容、流式 SSE），无 key 时有兜底文案。
 *
 * 性能：独占一个小的 WebGLRenderer；离开首页（garage 隐藏）时 pause() 停渲染、
 *       dispose() 释放上下文，避免和车库 hero 预览 / studio 视口叠加出移动端
 *       WebGL 上下文过多导致的闪回问题。
 */

import * as THREE from 'three';
import './aiOrb.css';

/** 生成柔和圆形辉光贴图（白色核心 → 青色 → 透明），给点阵球做发光感 */
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(180,246,255,0.95)');
  grd.addColorStop(1, 'rgba(0,229,255,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(32, 32, 32, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function mountAiOrb() {
  /* ---------- DOM ---------- */
  const wrap = document.createElement('div');
  wrap.className = 'ai-orb';
  const canvas = document.createElement('canvas');
  canvas.className = 'ai-orb__canvas';
  const label = document.createElement('div');
  label.className = 'ai-orb__label';
  label.textContent = 'AI';
  const hint = document.createElement('div');
  hint.className = 'ai-orb__hint';
  hint.textContent = '点我说话';
  wrap.append(canvas, label, hint);
  document.body.appendChild(wrap);

  /* ---------- Three.js 点阵球 ---------- */
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const SIZE = 132;
  renderer.setSize(SIZE, SIZE, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  camera.position.z = 2.25;

  const N = 720;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const col = new THREE.Color('#00e5ff');
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    positions[i * 3] = Math.cos(th) * r;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(th) * r;
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const tex = makeGlowTexture();
  const mat = new THREE.PointsMaterial({
    size: 0.1,
    map: tex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  let raf = 0;
  let running = true;
  let t = 0;
  /* 这个球是首页上第 3 个 WebGL 上下文（另两个是 hero 车模预览和卡片缩略图预览引擎）。
   * 它原先无条件跑满 60fps、且从不因页面不可见而停 —— 是移动端持续 GPU 负载的来源之一，
   * 叠加那些动辄 30~48MB 的车模，很容易把 Safari 顶到 jetsam（页面重载＝用户看到的"闪退"）。
   * 现在：①限帧 30fps（点阵旋转在这个速度下肉眼无差别，步进加倍以保持原转速）
   *      ②页面切到后台（document.hidden）时只驱动时间、不渲染 */
  const FRAME_MS = 1000 / 30;
  let last = 0;
  function frame() {
    if (!running) {
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (document.hidden) {
      last = now;
      return;
    }
    if (now - last < FRAME_MS) return;
    last = now;
    t += 0.01;
    points.rotation.y = t;
    points.rotation.x = Math.sin(t * 0.5) * 0.18;
    points.position.y = Math.sin(t * 1.4) * 0.04;
    renderer.render(scene, camera);
  }
  frame();

  /* ---------- 对话面板 ---------- */
  const panel = document.createElement('div');
  panel.className = 'ai-chat';
  panel.innerHTML = `
    <div class="ai-chat__head">
      <div class="ai-chat__title">AI 改装助手<small>轮毂 · 姿态 · 车漆建议</small></div>
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
      addBubble('ai', '你好，我是灵感改装 AI 助手。想换轮毂、调姿态还是改车漆？告诉我你的车型，我帮你出方案。');
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

  /** 朗读回复 */
  function speak(text) {
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

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  let listening = false;

  function stopListening() {
    listening = false;
    wrap.classList.remove('is-listening');
    try {
      recog?.stop();
    } catch {
      /* ignore */
    }
  }

  if (SR) {
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.interimResults = true;
    recog.continuous = false;
    recog.onstart = () => {
      listening = true;
      wrap.classList.add('is-listening');
      showCaption('正在聆听…', 0);
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
    recog.onerror = () => {
      stopListening();
      showCaption('没听清，再点一次试试。', 3000);
    };
    recog.onend = () => stopListening();
  }

  wrap.addEventListener('click', () => {
    // 正在听 → 再点一次结束
    if (listening) {
      stopListening();
      caption.classList.remove('show');
      return;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    wrap.classList.remove('is-speaking');
    if (!recog) {
      openPanel(); // 浏览器不支持语音识别 → 退回文字面板
      return;
    }
    try {
      recog.start();
    } catch {
      /* 已在运行 */
    }
  });
  closeBtn.addEventListener('click', closePanel);
  sendBtn.addEventListener('click', () => { const v = ta.value.trim(); if (v) send(v); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = ta.value.trim(); if (v) send(v); }
  });

  /* ---------- 生命周期 ---------- */
  function pause() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function resume() {
    if (!running) { running = true; frame(); }
  }
  function dispose() {
    pause();
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
    renderer.dispose();
    geo.dispose();
    mat.dispose();
    tex.dispose();
    wrap.remove();
    panel.remove();
  }

  return { el: wrap, pause, resume, dispose };
}

export { mountAiOrb };
