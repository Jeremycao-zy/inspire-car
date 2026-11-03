/**
 * subscribe.js — 「方案与价格」弹窗
 *
 * 售卖单位是「次」，不是 credit、不是余额。
 * 1 次 = 一套完整整车改装方案（3D 生成 + 车身拆解 + 实时调参）。
 *
 * 价格与 server/pay.mjs 的 PLANS 必须保持一致：
 *   single ¥29/1 次 · pack5 ¥99/5 次 · pack12 ¥199/12 次
 *   studio ¥399/月 20 次 · pro ¥999/月 60 次
 * 改价时两边一起改，否则收银台和这张卡片会对不上。
 */

import './subscribe.css';

const PLANS = [
  {
    id: 'free',
    name: '免费体验',
    desc: '先跑通一次完整流程，看看 3D 改装长什么样。',
    price: 0,
    unit: '¥',
    cycle: '免费',
    recommended: false,
    btn: '当前可用',
    variant: 'ghost',
    features: [
      '整车 3D 生成：1 次',
      '车型自动识别：可用',
      '车身拆解：不含',
      '导出：带水印',
      '保存方案：1 个',
    ],
  },
  {
    id: 'single',
    name: '单次体验',
    desc: '先改一台车看看效果，觉得值再买次数包。',
    price: 29,
    unit: '¥',
    cycle: '/ 次',
    recommended: false,
    btn: '购买 1 次',
    variant: 'primary',
    features: [
      '整车 3D 生成：1 次',
      '车身拆解（BANG）：含',
      '轮毂 / 包围 / 倾角实时调参',
      '无水印导出 GLB',
      '有效期：永久',
    ],
  },
  {
    id: 'pack5',
    name: '5 次包',
    desc: '单套 ¥19.8，适合反复对比几套改装方向。',
    price: 99,
    unit: '¥',
    cycle: '/ 5 次',
    recommended: true,
    btn: '购买 5 次',
    variant: 'primary',
    features: [
      '整车 3D 生成：5 次',
      '每套单价比单次省 ¥9.2',
      '车身拆解（BANG）：全含',
      '无水印导出 GLB',
      '有效期：永久',
    ],
  },
  {
    id: 'pack12',
    name: '12 次包',
    desc: '单套 ¥16.6，一次买够一个季度的用量。',
    price: 199,
    unit: '¥',
    cycle: '/ 12 次',
    recommended: false,
    btn: '购买 12 次',
    variant: 'primary',
    features: [
      '整车 3D 生成：12 次',
      '每套单价比单次省 ¥12.4',
      '车身拆解（BANG）：全含',
      '无水印导出 GLB',
      '有效期：永久',
    ],
  },
];

/** 面向改装店 / 工作室的方案，单独一栏，避免和 C 端次数包混在一起比价 */
const STUDIO_PLANS = [
  {
    id: 'studio',
    name: '工作室月卡',
    desc: '改装店日常给客户出效果图，30 天 20 套。',
    price: 399,
    unit: '¥',
    cycle: '/ 30 天',
    variant: 'primary',
    btn: '开通月卡',
    features: ['30 天内 20 次整车方案', '含车身拆解与调参', '无水印商用导出', '到期不结转'],
  },
  {
    id: 'pro',
    name: '专业版月卡',
    desc: '多车并行、内容量产，30 天 60 套。',
    price: 999,
    unit: '¥',
    cycle: '/ 30 天',
    variant: 'primary',
    btn: '开通月卡',
    features: ['30 天内 60 次整车方案', '含车身拆解与调参', '无水印商用导出', '到期不结转'],
  },
];

const EXTRAS = [
  '所有方案按「次」计：1 次 = 一套完整整车改装方案（3D 生成 + 车身拆解）。',
  '次数包永久有效，用不完不过期；月卡按 30 天计，到期剩余次数不结转。',
  '免费体验不含车身拆解，导出带水印，每个手机号限 1 次。',
];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false)
      node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

let activeModal = null;

export function openPricingModal() {
  if (activeModal) {
    activeModal.classList.add('active');
    document.body.style.overflow = 'hidden';
    return;
  }

  function planCard(plan) {
    const priceDisplay =
      plan.price === 0
        ? [el('span', { class: 'num' }, '0'), el('span', { class: 'cycle' }, '免费')]
        : [
            el('span', { class: 'unit' }, plan.unit),
            el('span', { class: 'num' }, String(plan.price)),
            el('span', { class: 'cycle' }, plan.cycle),
          ];

    const featureItems = plan.features.map((text) =>
      el('li', { class: text.includes('—') || text.includes('不含') ? 'disabled' : '' }, text)
    );

    return el(
      'div',
      { class: `pricing-card ${plan.recommended ? 'recommended' : ''}` },
      plan.recommended ? el('div', { class: 'pricing-card__badge' }, '最受欢迎') : null,
      el('h3', { class: 'pricing-card__name' }, plan.name),
      el('p', { class: 'pricing-card__desc' }, plan.desc),
      el('div', { class: 'pricing-card__price' }, ...priceDisplay),
      el('ul', { class: 'pricing-card__features' }, ...featureItems),
      el(
        'button',
        {
          class: `pricing-card__btn ${plan.variant || 'primary'}`,
          type: 'button',
          onClick: () => handleSelect(plan),
        },
        plan.btn || '选择此方案'
      )
    );
  }

  const cards = PLANS.map(planCard);

  const closeBtn = el(
    'button',
    { class: 'pricing-head__close', type: 'button', title: '关闭', onClick: closeModal },
    '×'
  );

  const head = el(
    'div',
    { class: 'pricing-head' },
    el(
      'div',
      { class: 'pricing-head__text' },
      el('h2', { class: 'pricing-head__title' }, '按次购买，永久有效'),
      el(
        'p',
        { class: 'pricing-head__sub' },
        '1 次 = 一套完整整车改装方案（3D 生成 + 车身拆解 + 实时调参）。次数包用不完不过期，不充值、不扣余额。'
      )
    ),
    closeBtn
  );

  const grid = el('div', { class: 'pricing-grid' }, ...cards);

  // 改装店 / 工作室单独一栏：他们靠这个赚钱，价格锚点与 C 端不同，不要混在一排比价
  const studioSection = el(
    'div',
    { class: 'pricing-studio' },
    el('h3', { class: 'pricing-head__title', style: 'margin:26px 0 6px;' }, '改装店 / 工作室'),
    el(
      'p',
      { class: 'pricing-head__sub', style: 'margin:0 0 14px;' },
      '按 30 天开通，含商用授权与无水印导出。按量买次数包同样可以，只是高频使用月卡更划算。'
    ),
    el('div', { class: 'pricing-grid' }, ...STUDIO_PLANS.map(planCard))
  );

  const foot = el(
    'div',
    { class: 'pricing-foot' },
    ...EXTRAS.map((text) => el('p', {}, `· ${text}`))
  );

  const modal = el('div', { class: 'pricing-modal' }, head, grid, studioSection, foot);
  const overlay = el('div', { class: 'pricing-overlay' }, modal);

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // ESC 关闭
  function onKey(e) {
    if (e.key === 'Escape') closeModal();
  }

  function closeModal() {
    overlay.classList.remove('active');
    document.body.style.overflow = '';
    setTimeout(() => {
      overlay.remove();
      activeModal = null;
    }, 260);
    document.removeEventListener('keydown', onKey);
  }

  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);

  // 强制重排以触发进入动画
  requestAnimationFrame(() => overlay.classList.add('active'));
  document.body.style.overflow = 'hidden';

  activeModal = overlay;
}

function handleSelect(plan) {
  if (plan.id === 'free') {
    showToast('免费版已可用，上传照片即可开始体验。');
    return;
  }
  // 真实收款：跳到收银页（微信内走 JSAPI，普通浏览器走支付宝）。
  // 未登录时收银页会提示先登录，不会产生脏单。
  location.href = `/pay.html?plan=${encodeURIComponent(plan.id)}`;
}

function showToast(message) {
  // 复用简单的全局 toast，没有则创建一个
  let toast = document.getElementById('gb-toast');
  if (!toast) {
    toast = el('div', {
      id: 'gb-toast',
      style:
        'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);' +
        'z-index:300;padding:12px 20px;border-radius:12px;background:#14233c;color:#fff;' +
        'font-size:13px;font-weight:600;box-shadow:0 12px 32px rgba(16,34,70,0.28);' +
        'opacity:0;visibility:hidden;transition:opacity .2s ease,transform .2s ease,visibility .2s ease;' +
        'max-width:min(520px,calc(100vw - 40px));text-align:center;line-height:1.5;',
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.visibility = 'visible';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.visibility = 'hidden';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 3600);
}
