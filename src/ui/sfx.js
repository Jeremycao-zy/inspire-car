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
 *
 * 音色基调：宇宙感 / 空灵感（新能源汽车低速提示音风格）。
 * - 统一走「正弦基频 + 轻微失谐泛音 shimmer + 高泛音」的空灵风铃，柔起音、长尾混响。
 * - 旋转 / 滑动摩擦用「带通滤波噪声 + 混响」的空灵气声，而非生硬白噪爆破。
 * - 共享一段合成脉冲响应的卷积混响（零素材），给所有声音一层纵深空间感。
 */

let ctx = null;
let master = null;
let reverb = null; // ConvolverNode（合成 IR）
let enabled = true;
let installed = false;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.2;
    master.connect(ctx.destination);
    buildReverb();
  }
  if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
  return ctx;
}

/** 合成指数衰减噪声脉冲响应 → 空灵大厅混响，零音频素材 */
function buildReverb() {
  const len = Math.floor(ctx.sampleRate * 2.6);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8);
    }
  }
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4800; // 略压高频，避免混响发刺
  const wet = ctx.createGain();
  wet.gain.value = 0.55; // 混响量
  conv.connect(lp);
  lp.connect(wet);
  wet.connect(master);
  reverb = conv;
}

/**
 * 空灵风铃音：正弦基频 + 失谐泛音(shimmer) + 高泛音(partial) + 长尾混响。
 * @param {object} o
 *  freq 基频 / type 波形 / dur 时长 / gain 主增益 / sweep 基频扫频
 *  delay 延迟（秒）/ shimmer 失谐泛音相对增益（0 关闭）/ partial 高泛音倍数（0 关闭）
 */
function chime({ freq = 720, type = 'sine', dur = 0.22, gain = 0.3, sweep = 0, delay = 0, shimmer = 0.18, partial = 0 }) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime + delay;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012); // 柔起音
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.connect(master);
  if (reverb) g.connect(reverb);

  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur);
  osc.connect(g);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);

  // 失谐泛音：±一个高八度上的轻微失谐，制造宇宙空灵的"晶亮"质感
  if (shimmer > 0) {
    const o2 = c.createOscillator();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(freq * 2.003, t0);
    if (sweep) o2.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 2.003 + sweep), t0 + dur);
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0.0001, t0);
    g2.gain.exponentialRampToValueAtTime(gain * shimmer, t0 + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.92);
    g2.connect(g);
    o2.connect(g2);
    o2.start(t0);
    o2.stop(t0 + dur + 0.05);
  }

  // 高泛音（如 +2 倍八度）：增加"叮"的空灵铃感
  if (partial > 0) {
    const o3 = c.createOscillator();
    o3.type = 'sine';
    o3.frequency.setValueAtTime(freq * partial, t0);
    const g3 = c.createGain();
    g3.gain.setValueAtTime(0.0001, t0);
    g3.gain.exponentialRampToValueAtTime(gain * 0.2, t0 + 0.02);
    g3.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.7);
    g3.connect(g);
    o3.connect(g3);
    o3.start(t0);
    o3.stop(t0 + dur + 0.05);
  }
}

/**
 * 空灵气声：带通滤波噪声 + 混响 + 长尾。用于旋转 / 滑动摩擦，替代生硬噪声爆破。
 */
function airy({ dur = 0.4, gain = 0.1, freq = 800, q = 0.8, sweep = 400 }) {
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
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  if (reverb) g.connect(reverb);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
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
  // —— 语义化音效（宇宙感 / 空灵）——
  tick() {
    // 水滴般的空灵小音：高频、快速收敛、带失谐微光
    chime({ freq: 1520, type: 'sine', dur: 0.14, gain: 0.14, sweep: -380, shimmer: 0.12 });
  },
  click() {
    // 新能源低速提示音：两声柔和下行的"叮—叮"双音风铃
    chime({ freq: 700, type: 'sine', dur: 0.2, gain: 0.26, shimmer: 0.2, partial: 2 });
    chime({ freq: 936, type: 'sine', dur: 0.26, gain: 0.26, shimmer: 0.2, partial: 2, delay: 0.07 });
  },
  card() {
    // 饱满的空灵和弦：基频 + 八度 + 五度泛音，长尾混响
    chime({ freq: 588, type: 'sine', dur: 0.36, gain: 0.28, shimmer: 0.18, partial: 2 });
    chime({ freq: 882, type: 'sine', dur: 0.3, gain: 0.15, shimmer: 0.16, delay: 0.02 });
    chime({ freq: 392, type: 'sine', dur: 0.42, gain: 0.12, shimmer: 0.1, delay: 0.0 });
  },
  toggleSfx() {
    // 开关：柔和上行双音
    chime({ freq: 560, type: 'sine', dur: 0.16, gain: 0.22, shimmer: 0.15 });
    chime({ freq: 748, type: 'sine', dur: 0.22, gain: 0.22, shimmer: 0.15, delay: 0.06 });
  },
  whoosh() {
    // 空灵气旋：带通噪声 + 混响，柔和弥散而非生硬爆破
    airy({ dur: 0.5, gain: 0.1, freq: 760, sweep: 520 });
  },
  rotate() {
    // 拖拽旋转：高频空灵气声，轻而通透
    airy({ dur: 0.22, gain: 0.07, freq: 1340, sweep: 360 });
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

  // 1) 滑块：滑动改变数据 → 细微空灵 tick
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

  // 3) 车身旋转：在主 3D 画布（#main-viewer-canvas）上拖拽 → 空灵气声
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
