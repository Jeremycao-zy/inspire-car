/**
 * compliance.js — 改装合规校验与提示卡
 *
 * 总纲：真实装车才是最终目的。
 * 本模块帮助用户在真实动手前，验证方案"能装 / 合规 / 安全"，并把法定红线和
 * 自查清单直接推到工作台与方案卡片上（比纯条款更易被看到）。
 *
 * 数据驱动：改装类别的合法/非法清单集中在 MOD_COMPLIANCE；车身套件字段接入
 * params 后，analyzePlanCompliance 会自动识别并打 ⛔ 角标，无需改调用方。
 */

import './compliance.css';
import { openLegalModal } from './legalModal.js';

// 改装类别合规表（依据《机动车登记规定》公安部 164 号令，详见用户协议第七章）
export const MOD_COMPLIANCE = {
  // ❌ 非法改装：无登记通道，查到罚≤500 + 责令恢复 + 年检不过 + 保险可拒赔
  illegal: [
    { key: 'spoiler', label: '尾翼 / 扰流' },
    { key: 'frontLip', label: '前唇 / 包围' },
    { key: 'sideSkirt', label: '侧裙' },
    { key: 'widebody', label: '宽体' },
    { key: 'diffuser', label: '扩散器' },
  ],
  // ✅ 合法（可备案 / 免登记）
  legal: [
    { key: 'wheel-same', label: '同尺寸轮毂更换（样式可变，直径/宽度不变）' },
    { key: 'grille', label: '中网' },
    { key: 'bumper', label: '保险杠（不改变主体结构）' },
    { key: 'roof-rack', label: '行李架（≤300mm，需备案）' },
    { key: 'step', label: '出入口踏步件（≤50mm，免登记）' },
    { key: 'wrap', label: '改色膜 / 贴纸（≤30% 覆盖，需备案）' },
  ],
};

// 车身套件字段（未来 params 接入后自动识别为非法改装）
const BODY_KIT_FIELDS = ['frontLip', 'spoiler', 'sideSkirt', 'widebody', 'diffuser', 'lip', 'kit'];

const LEVEL_META = {
  ok: { cls: 'ok', icon: '✅', label: '可装' },
  caution: { cls: 'caution', icon: '⚠️', label: '需谨慎' },
  illegal: { cls: 'illegal', icon: '⛔', label: '不可上路' },
};

/**
 * 分析方案合规等级。
 * @param {object} plan 方案对象（含 params）
 * @param {{stockRimInch?:number}} [ctx] 出厂轮毂直径（用于判定是否改尺寸）
 * @returns {{level:string, illegal:boolean, points:Array}}
 */
export function analyzePlanCompliance(plan, ctx = {}) {
  const points = [];
  let level = 'ok';
  const p = plan?.params || {};
  const front = p.front || p;
  const rear = p.rear || p;

  // 1) 车身套件 → 非法改装
  const kitHits = BODY_KIT_FIELDS.filter((f) => {
    const v = p[f];
    return v !== undefined && v !== null && v !== 0 && v !== '' && v !== false;
  });
  if (kitHits.length) {
    level = 'illegal';
    const labels = kitHits
      .map((k) => MOD_COMPLIANCE.illegal.find((m) => m.key === k)?.label || k)
      .join('、');
    points.push({ status: 'bad', text: `检测到车身套件（${labels}）：属非法改装，无登记通道，不可上路行驶。` });
  }

  // 2) 轮毂尺寸
  const stockRim = ctx?.stockRimInch;
  const fRim = front.rimInch;
  const rRim = rear.rimInch;
  if (fRim || rRim) {
    const changed =
      (stockRim != null && fRim && fRim !== stockRim) ||
      (stockRim != null && rRim && rRim !== stockRim);
    if (changed) {
      if (level === 'ok') level = 'caution';
      points.push({
        status: 'warn',
        text: `轮毂直径与出厂不同（当前 ${fRim || rRim} 寸），需办理备案 / 验车后方可上路。`,
      });
    } else if (stockRim != null) {
      points.push({ status: 'ok', text: '轮毂为同尺寸更换（样式可变），属合法范围。' });
    } else {
      points.push({ status: 'ok', text: '轮毂改装：同尺寸更换合法；改变直径 / 宽度需办理备案 / 验车。' });
    }
  }

  // 3) 极端倾角（非法定非法，但影响安全/磨损）
  const camber = front.camber;
  if (camber != null && camber <= -3) {
    points.push({
      status: 'warn',
      text: `前轮倾角 ${camber}° 偏大（HellaFlush 风格），会加剧轮胎偏磨、影响湿地抓地，真实装车请谨慎。`,
    });
  }

  if (!points.length) {
    points.push({ status: 'ok', text: '当前方案未检测到明显合规风险项，仍以实物测量与当地车管所认定为准。' });
  }

  return { level, illegal: level === 'illegal', points };
}

/** 生成方案卡片角标 DOM（✅/⚠️/⛔） */
export function complianceBadge(plan, ctx) {
  const { level } = analyzePlanCompliance(plan, ctx);
  const m = LEVEL_META[level];
  const span = document.createElement('span');
  span.className = `compliance-badge compliance-badge--${m.cls}`;
  span.textContent = `${m.icon} ${m.label}`;
  span.title = '合规参考：详见《用户协议》第七章与社区守则附录A';
  return span;
}

let lastShownPlanId = null;

/**
 * 在工作台打开方案时，展示一次合规提示卡（可关闭，同方案不重复弹）。
 * @param {object} plan
 * @param {{stockRimInch?:number}} [ctx]
 */
export function showComplianceCard(plan, ctx = {}) {
  if (!plan) return;
  if (plan.id && plan.id === lastShownPlanId) return;
  lastShownPlanId = plan.id || null;

  const { level, points } = analyzePlanCompliance(plan, ctx);
  const m = LEVEL_META[level];

  const overlay = document.createElement('div');
  overlay.className = 'compliance-overlay';

  const card = document.createElement('div');
  card.className = `compliance-card compliance-card--${m.cls}`;

  const head = document.createElement('div');
  head.className = 'compliance-card__head';
  head.innerHTML = `<span class="compliance-card__badge">${m.icon} ${m.label}</span>
    <span class="compliance-card__title">真实装车合规参考</span>`;

  const close = document.createElement('button');
  close.className = 'compliance-card__close';
  close.type = 'button';
  close.textContent = '✕';
  close.addEventListener('click', () => overlay.remove());
  head.appendChild(close);

  const body = document.createElement('div');
  body.className = 'compliance-card__body';

  const list = document.createElement('ul');
  list.className = 'compliance-card__points';
  for (const pt of points) {
    const li = document.createElement('li');
    li.className = `compliance-point compliance-point--${pt.status}`;
    li.textContent = pt.text;
    list.appendChild(li);
  }
  body.appendChild(list);

  // 法定红线速览
  const ref = document.createElement('div');
  ref.className = 'compliance-card__ref';
  ref.innerHTML = `
    <div class="compliance-ref__col">
      <div class="compliance-ref__h compliance-ref__h--bad">⛔ 非法改装（无登记通道）</div>
      <div>${MOD_COMPLIANCE.illegal.map((x) => x.label).join('、')}</div>
    </div>
    <div class="compliance-ref__col">
      <div class="compliance-ref__h compliance-ref__h--ok">✅ 合法（可备案/免登记）</div>
      <div>${MOD_COMPLIANCE.legal.map((x) => x.label).join('、')}</div>
    </div>`;
  body.appendChild(ref);

  const foot = document.createElement('div');
  foot.className = 'compliance-card__foot';
  const link = document.createElement('a');
  link.className = 'compliance-card__link';
  link.href = '#';
  link.textContent = '查看《用户协议》第七章 · 改装合规与真实装车';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    openLegalModal?.('agreement');
  });
  const ok = document.createElement('button');
  ok.className = 'compliance-card__ok';
  ok.type = 'button';
  ok.textContent = '我知道了';
  ok.addEventListener('click', () => overlay.remove());
  foot.append(link, ok);

  card.append(head, body, foot);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-open'));
}
