/**
 * sfx.js — 全站轻量操作音效（纯 Web Audio 合成，零音频素材 / 零外部依赖 / 零自动播放限制）
 *
 * 设计要点：
 * - 所有音色用振荡器 / 噪声实时合成，体积小、可离线、不拖慢首屏。
 * - AudioContext 在首个用户手势（pointerdown / keydown）时才创建并 resume，
 *   彻底规避浏览器自动播放策略（这是之前真人语音被静默退回系统音的同一类坑）。
 * - 在 document 层用事件委托统一接入，动态生成的卡片 / 滑块也能自动带音效。
 * - 提供语义化音效：tick（滑块微调）/ click（按钮）/ card（卡片选择）/
 *   whoosh（车身旋转）/ toggle（开关切换）。
 */

let ctx = null;
let master = null;
let enabled = true;
let installed = false;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
  return ctx;
}

/** 单个振荡器音：可带频率扫频（sweep>0 升、<0 降） */
function tone({ freq = 1000, type = 'sine', dur = 0.05, gain = 0.5, sweep = 0, delay = 0 }) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

/** 带通滤波的短噪声 burst，适合「旋转 / 滑动」这类摩擦/气流感音效 */
function noiseBurst({ dur = 0.16, gain = 0.14, freq = 700, q = 0.7, sweep = 0 }) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(freq, t0);
  if (sweep) bp.frequency.exponentialRampToValueAtTime(Math.max(80, freq + sweep), t0 + dur);
  bp.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
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
  // —— 语义化音效 ——
  tick() {
    tone({ freq: 2100, type: 'square', dur: 0.018, gain: 0.16 });
  },
  click() {
    tone({ freq: 880, type: 'triangle', dur: 0.055, gain: 0.4 });
  },
  card() {
    tone({ freq: 620, type: 'sine', dur: 0.1, gain: 0.5, sweep: 360 });
  },
  toggleSfx() {
    tone({ freq: 520, type: 'sine', dur: 0.08, gain: 0.38, sweep: 240 });
  },
  whoosh() {
    noiseBurst({ dur: 0.18, gain: 0.13, freq: 620, sweep: 520 });
  },
  rotate() {
    noiseBurst({ dur: 0.07, gain: 0.1, freq: 900, sweep: 300 });
  },
};

/** 在 document 层用事件委托统一接入全站操作音效（幂等，可重复调用） */
export function installGlobalSfx() {
  if (installed) return;
  installed = true;
  sfx.init();

  const throttle = (ms, fn) => {
    let last = 0;
    return () => {
      const n = Date.now();
      if (n - last >= ms) {
        last = n;
        fn();
      }
    };
  };
  const tickT = throttle(60, () => sfx.tick());
  const rotT = throttle(110, () => sfx.rotate());

  // 1) 滑块：滑动改变数据 → 细微 tick
  document.addEventListener(
    'input',
    (e) => {
      const el = e.target;
      if (el && el.matches && el.matches('input[type="range"]')) tickT();
    },
    true
  );

  // 2) 卡片点击 / 按钮点击 → card / click
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#ai-orb') || t.closest('.ai-chat')) return; // AI 球自带语音，避免叠加
      if (t.closest('input')) return; // 滑块交给 tick，避免双响
      if (t.closest('.garage-card, .plan-card, [data-card]')) {
        sfx.card();
        return;
      }
      if (t.closest('button, .toggle, [role="button"], .tab')) sfx.click();
    },
    true
  );

  // 3) 车身旋转：在主 3D 画布（#main-viewer-canvas）上拖拽 → rotate
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!(e.buttons & 1)) return; // 仅左键拖拽
      const t = e.target;
      if (t && t.id === 'main-viewer-canvas') rotT();
    },
    true
  );

  // 4) 开关 / 下拉切换 → toggle
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (el && el.matches && el.matches('input[type="checkbox"], input[type="radio"], select')) {
        sfx.toggleSfx();
      }
    },
    true
  );

  mountMuteButton();
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
    color: '#9af7ff',
    background: 'rgba(10,14,18,0.72)',
    border: '1px solid rgba(120,230,255,0.45)',
    borderRadius: '999px',
    boxShadow: '0 0 12px rgba(80,220,255,0.35)',
    cursor: 'pointer',
    backdropFilter: 'blur(6px)',
    userSelect: 'none',
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = sfx.toggle();
    btn.textContent = on ? '音效 开' : '音效 关';
    btn.style.color = on ? '#9af7ff' : '#ff9aa6';
    btn.style.borderColor = on ? 'rgba(120,230,255,0.45)' : 'rgba(255,150,160,0.5)';
  });
  document.body.appendChild(btn);
}
