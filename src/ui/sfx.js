/**
 * sfx.js — 全站操作音效（纯 Web Audio 合成，零音频素材 / 零外部依赖 / 零自动播放限制）
 *
 * 音色基调（2026-10-15 重做）：**机械赛博** —— 金属敲击 / 液压传动 / 伺服电机。
 * 替代了原先的"空灵风铃"（正弦基频 + 失谐泛音 + 长尾混响）。
 *
 * 为什么换风格：
 *   原音色是柔和空灵的（新能源低速提示音那类），但产品是**改装工位**，
 *   交互反馈应该像操作机械开关/液压机构，而不是风铃。空灵音在滑杆连续
 *   触发时还会显得尖亮刺耳，与"工位"氛围不符。
 *
 * 合成手法（全部实时合成，零素材）：
 *   - 金属敲击 metalHit()：两个失谐正弦 + 高 Q 带通"共鸣体" + 极快衰减包络。
 *     金属的"叮"来自高 Q 谐振腔，而不是泛音叠加。
 *   - 液压/伺服 servo()：方波+锯齿的频率扫掠 + 带通噪声，跟随"棘轮咔哒"调制。
 *   - 机械开关 clack()：短噪声脉冲过带通 + 低频"体腔"砰声。
 *   - 能量/充能 chargeUp()：上行扫频 + 逐渐加密的脉冲序列（生成中）。
 *   - 警报 alarm()：两声硬方波脉冲（失败），有压迫感但不刺耳。
 *
 * 自动播放策略：AudioContext 在首个用户手势（pointerdown/keydown）时才创建并 resume，
 * 彻底规避浏览器拦截（与之前 TTS 被静默退回系统音是同一类坑）。
 */

let ctx = null;
let master = null;
let busSfx = null; // 音效总线（干声为主，少量混响）
let busRoom = null; // 房间混响总线
let enabled = true;
let installed = false;
let lastTickAt = 0; // 滑杆音节流（自己控，比 throttle 闭包更可测）
let reverbNode = null; // 合成混响卷积器（buildReverb 内赋值）

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.2; // 总音量（用户选了"只调平衡"，不改这个基数）
    master.connect(ctx.destination);

    // 干声总线：机械音以干声为主，混响过多会变成空灵风铃（那就白改了）
    busSfx = ctx.createGain();
    busSfx.gain.value = 0.86;
    busSfx.connect(master);

    // 房间混响总线：只给少量空间感（合成 IR，非长尾）
    busRoom = ctx.createGain();
    busRoom.gain.value = 0.16;
    busRoom.connect(master);
    buildReverb();
  }
  if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
  return ctx;
}

/** 合成短促的金属车间混响（0.9s，衰减快，不做空灵大厅） */
function buildReverb() {
  const len = Math.floor(ctx.sampleRate * 0.9);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      // 指数衰减 + 早期反射稀疏化 → 更像硬地面车间，不像教堂
      const t = i / len;
      const env = Math.pow(1 - t, 4.2);
      const early = i < len * 0.06 && i % 3 === 0 ? 1.6 : 1;
      d[i] = (Math.random() * 2 - 1) * env * early;
    }
  }
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3200; // 压高频，保持"闷"而非"叮"
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 180;
  conv.connect(hp);
  hp.connect(lp);
  lp.connect(busRoom);
  reverbNode = conv; // 必须在这里赋值：调用方（metalHit/clack）读的是模块级变量
  return conv;
}

/**
 * 金属敲击：金属的"叮"来自高 Q 谐振，不是泛音堆叠。
 * @param {object} o
 *  freq 基频（金属板固有频率）/ dur 时长 / gain 增益
 *  noise 噪声打击占比（0=纯音，越大越"砸"）/ detune 失谐（Hz，两个振子错开产生金属感）
 *  sweep 频率下滑（松手后音高下沉）/ bright 共振亮度（带通中心倍率）
 */
function metalHit({ freq = 420, dur = 0.16, gain = 0.3, noise = 0.25, detune = 9, sweep = -60, bright = 1 } = {}) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime;

  // —— 噪声打击层：起音的"砸" ——
  if (noise > 0) {
    const len = Math.max(1, Math.floor(c.sampleRate * 0.035));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq * 3.2 * bright;
    bp.Q.value = 1.1;
    const ng = c.createGain();
    ng.gain.setValueAtTime(gain * noise, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.035);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(busSfx);
    src.start(t0);
    src.stop(t0 + 0.05);
  }

  // —— 共鸣体：两枚失谐振子过同一个高 Q 带通 = 金属"叮"——
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(freq * bright, t0);
  bp.frequency.exponentialRampToValueAtTime(Math.max(60, freq * bright + sweep), t0 + dur);
  bp.Q.value = 9; // 高 Q = 金属共鸣腔
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004); // 极快起音（机械瞬态）
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  bp.connect(g);
  g.connect(busSfx);
  if (reverbNode) g.connect(reverbNode);

  for (const f of [freq, freq + detune]) {
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(f, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(50, f + sweep), t0 + dur);
    const og = c.createGain();
    og.gain.value = 0.5; // 两振子平权
    o.connect(og);
    og.connect(bp);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
}

/**
 * 伺服/液压：频率扫掠的锯齿 + 带通棘轮噪声（有"咔哒咔哒"的机械爬行感）。
 * @param {object} o
 *  from/to 起止频率（Hz，to>from 即上行=松手/to<from 下行=落位）
 *  dur 时长 / gain 增益 / steps 棘轮咔哒数（0=连续无咔哒）
 */
function servo({ from = 180, to = 460, dur = 0.3, gain = 0.2, steps = 5 } = {}) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime;

  // 主体：扫频锯齿
  const o = c.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(from, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1400, t0);
  lp.frequency.exponentialRampToValueAtTime(2600, t0 + dur);
  lp.Q.value = 3;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.setValueAtTime(gain, t0 + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(lp);
  lp.connect(g);
  g.connect(busSfx);
  o.start(t0);
  o.stop(t0 + dur + 0.03);

  // 棘轮：steps 个短噪声咔哒（机械爬行的节奏感）
  if (steps > 0) {
    for (let i = 0; i < steps; i++) {
      const tt = t0 + (dur * 0.82 * (i + 1)) / steps;
      const len = Math.floor(c.sampleRate * 0.012);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let k = 0; k < len; k++) d[k] = (Math.random() * 2 - 1) * Math.pow(1 - k / len, 2);
      const s = c.createBufferSource();
      s.buffer = buf;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 2.2;
      const ng = c.createGain();
      ng.gain.value = gain * 0.32;
      s.connect(bp);
      bp.connect(ng);
      ng.connect(busSfx);
      s.start(tt);
      s.stop(tt + 0.02);
    }
  }
}

/** 液压"砰"：低频体腔 + 短促泄压（用于落位/确认这类"实"的动作） */
function clack({ freq = 150, dur = 0.2, gain = 0.34, release = 0.05 } = {}) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime;
  // 体腔砰
  const o = c.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(freq, t0);
  o.frequency.exponentialRampToValueAtTime(freq * 0.55, t0 + dur); // 下滑 = 落位感
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(busSfx);
  if (reverbNode) g.connect(reverbNode);
  o.start(t0);
  o.stop(t0 + dur + 0.03);

  // 泄压嘶声
  const len = Math.floor(c.sampleRate * release);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
  const s = c.createBufferSource();
  s.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3200;
  bp.Q.value = 1.4;
  const ng = c.createGain();
  ng.gain.setValueAtTime(gain * 0.4, t0);
  ng.gain.exponentialRampToValueAtTime(0.0001, t0 + release);
  s.connect(bp);
  bp.connect(ng);
  ng.connect(busSfx);
  s.start(t0);
  s.stop(t0 + release + 0.02);
}

/** 能量充能：上行扫频 + 逐渐加密脉冲（生成中循环调用） */
function chargeUp({ base = 200, dur = 0.5, gain = 0.16 } = {}) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime;
  const o = c.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(base, t0);
  o.frequency.exponentialRampToValueAtTime(base * 2.6, t0 + dur);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(base * 3, t0);
  bp.frequency.exponentialRampToValueAtTime(base * 7, t0 + dur);
  bp.Q.value = 5;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(bp);
  bp.connect(g);
  g.connect(busSfx);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

/** 完成确认：两声上行金属锤（成功落定） */
function success() {
  metalHit({ freq: 520, dur: 0.13, gain: 0.3, noise: 0.2, bright: 1.15 });
  metalHit({ freq: 784, dur: 0.24, gain: 0.32, noise: 0.12, detune: 12, bright: 1.2, sweep: -30 });
  clack({ freq: 120, dur: 0.26, gain: 0.22 });
}

/** 失败警报：两声硬脉冲（方波 + 噪声），有压迫感但已避开高频刺耳区 */
function alarm() {
  for (const [f, t] of [[320, 0], [232, 0.13]]) {
    const c = ensureCtx();
    if (!c || !enabled) return;
    const t0 = c.currentTime + t;
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100; // 压高频，避免刺耳
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.24, t0 + 0.008);
    g.gain.setValueAtTime(0.24, t0 + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
    o.connect(lp);
    lp.connect(g);
    g.connect(busSfx);
    o.start(t0);
    o.stop(t0 + 0.17);
  }
}

export const sfx = {
  /** 在首个用户手势时解锁音频上下文 */
  init() {
    const unlock = () => ensureCtx();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
  },
  setEnabled(v) {
    enabled = !!v;
    if (enabled) ensureCtx();
  },
  isEnabled() {
    return enabled;
  },
  toggle() {
    this.setEnabled(!enabled);
    return enabled;
  },

  /* ============ 语义化音效（机械赛博） ============ */

  /** 滑杆微调：低频棘轮咔哒。原 tick 是 1520Hz 高频，连续拖动极刺耳，
   *  现在降到 ~560Hz 并靠伺服爬行的"咔哒"表达档位感。 */
  tick() {
    const now = Date.now();
    if (now - lastTickAt < 55) return; // 内置节流（比闭包 throttle 更可控）
    lastTickAt = now;
    servo({ from: 620, to: 500, dur: 0.06, gain: 0.09, steps: 0 });
  },

  /** 按钮按下：硬质机械按键（清脆的"嗒"） */
  click() {
    metalHit({ freq: 640, dur: 0.075, gain: 0.22, noise: 0.3, detune: 14, bright: 1.3 });
  },

  /** 卡片选择：两声液压落位（比 click 更"重"，表示切换到一张大卡片） */
  card() {
    servo({ from: 200, to: 520, dur: 0.18, gain: 0.16, steps: 4 });
    metalHit({ freq: 460, dur: 0.16, gain: 0.22, noise: 0.16, bright: 1.05, sweep: -70 });
  },

  /** 开关打开：伺服上行 + 轻金属确认 */
  toggleOn() {
    servo({ from: 240, to: 600, dur: 0.2, gain: 0.16, steps: 5 });
    metalHit({ freq: 700, dur: 0.1, gain: 0.16, noise: 0.1, bright: 1.2 });
  },

  /** 开关关闭：伺服下行（与打开形成方向对比，语义不再混淆） */
  toggleOff() {
    servo({ from: 560, to: 210, dur: 0.2, gain: 0.15, steps: 4 });
    clack({ freq: 130, dur: 0.14, gain: 0.18 });
  },

  /** 下拉选值/分段切换：短促棘轮（与开关的连续伺服区分） */
  select() {
    servo({ from: 420, to: 700, dur: 0.07, gain: 0.13, steps: 3 });
  },

  /** 展开/弹出：液压抬升（上行的空间感） */
  open() {
    servo({ from: 300, to: 820, dur: 0.26, gain: 0.15, steps: 6 });
  },

  /** 收起/关闭：液压落下（下行 + 落位砰，与 open 形成对比） */
  close() {
    servo({ from: 780, to: 260, dur: 0.22, gain: 0.14, steps: 4 });
    clack({ freq: 140, dur: 0.2, gain: 0.26 });
  },

  /** 车身旋转摩擦：低频空气声（原 1340Hz 气声太亮），带阻尼感 */
  rotate() {
    const c = ensureCtx();
    if (!c || !enabled) return;
    const now = Date.now();
    if (now - lastTickAt < 110) return;
    lastTickAt = now;
    const t0 = c.currentTime;
    const len = Math.max(1, Math.floor(c.sampleRate * 0.2));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1);
    const s = c.createBufferSource();
    s.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(520, t0);
    bp.frequency.exponentialRampToValueAtTime(760, t0 + 0.2);
    bp.Q.value = 1.3; // 低 Q = 宽而闷，像气流而非尖啸
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    s.connect(bp);
    bp.connect(g);
    g.connect(busSfx);
    s.start(t0);
    s.stop(t0 + 0.22);
  },

  /* ============ 状态反馈（原来完全缺失） ============ */

  /** 生成开始：充能启动 */
  generating() {
    chargeUp({ base: 180, dur: 0.7, gain: 0.15 });
  },
  /** 生成成功：两声金属锤 + 落位 */
  success,
  /** 生成失败：双脉冲警报 */
  fail: alarm,
  /** 校验不通过（规格不真实/数据不足）：单声闷响，不是致命警报 */
  warn() {
    metalHit({ freq: 260, dur: 0.14, gain: 0.2, noise: 0.28, bright: 0.7, sweep: -40 });
  },
  /** 打开全屏/弹层（显式函数体：open/close 是属性名，别名导出时 this 会丢失） */
  open() {
    open();
  },
  /** 关闭弹层 */
  close() {
    close();
  },
  /** 兼容旧调用名 */
  toggleSfx() {
    this.toggleOn();
  },
  whoosh() {
    servo({ from: 160, to: 700, dur: 0.42, gain: 0.12, steps: 8 });
  },
};

/** 在 document 层用事件委托统一接入全站操作音效（幂等，可重复调用） */
export function installGlobalSfx() {
  if (installed) return;
  installed = true;
  sfx.init();

  const rotT = throttleMs(110, () => sfx.rotate());

  // 1) 滑块：滑动改变数据 → 低频棘轮 tick
  document.addEventListener(
    'input',
    (e) => {
      const el = e.target;
      if (el && el.matches && el.matches('input[type="range"]')) sfx.tick();
    },
    true
  );

  // 2) 卡片 / 按钮点击
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#ai-orb') || t.closest('.ai-chat')) return; // AI 球自带语音，避免叠加
      if (t.closest('input')) return; // 滑块交给 tick
      if (t.closest('.garage-card, .plan-card, [data-card]')) {
        sfx.card();
        return;
      }
      // 关闭类按钮优先（✕ / 关闭 / 取消）：用"落下"音，与"抬起"区分
      if (t.closest('[aria-label*="关闭"], .wg-close, .wheel-guide__close, .wheel-guide__footer-close, [data-act="close"]')) {
        sfx.close();
        return;
      }
      if (t.closest('button, .toggle, [role="button"], .tab, .chip, .spec-chip, .seg button')) sfx.click();
    },
    true
  );

  // 3) 车身旋转：主画布左键拖拽 → 低频气流
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!(e.buttons & 1)) return;
      const t = e.target;
      if (t && t.id === 'main-viewer-canvas') rotT();
    },
    true
  );

  // 4) 开关 / 单选 → 开=上行、关=下行（语义终于分开了）
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!el || !el.matches) return;
      if (el.matches('input[type="checkbox"], input[type="radio"]')) {
        sfx[el.checked ? 'toggleOn' : 'toggleOff']();
        return;
      }
      // 下拉 / 分段选择：短棘轮（与开关的连续伺服区分）
      if (el.matches('select')) sfx.select();
    },
    true
  );

  mountMuteButton();
}

function throttleMs(ms, fn) {
  let last = 0;
  return () => {
    const n = Date.now();
    if (n - last >= ms) {
      last = n;
      fn();
    }
  };
}

/** 右下角悬浮「音效开关」按钮（内联样式，不依赖额外 CSS） */
function mountMuteButton() {
  if (document.getElementById('sfx-mute-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'sfx-mute-btn';
  btn.type = 'button';
  btn.textContent = '音效 开';
  Object.assign(btn.style, {
    position: 'fixed',
    right: '14px',
    bottom: '14px',
    zIndex: '9999',
    padding: '6px 12px',
    fontSize: '12px',
    fontFamily: 'inherit',
    letterSpacing: '0.04em',
    color: '#c8b6ff',
    background: 'rgba(10,10,18,0.76)',
    border: '1px solid rgba(160,140,255,0.5)',
    borderRadius: '999px',
    boxShadow: '0 0 12px rgba(120,100,255,0.35)',
    cursor: 'pointer',
    backdropFilter: 'blur(6px)',
    userSelect: 'none',
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = sfx.toggle();
    btn.textContent = on ? '音效 开' : '音效 关';
    btn.style.color = on ? '#c8b6ff' : '#ff9aa6';
    btn.style.borderColor = on ? 'rgba(160,140,255,0.5)' : 'rgba(255,150,160,0.5)';
  });
  document.body.appendChild(btn);
}
