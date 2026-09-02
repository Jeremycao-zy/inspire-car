/**
 * subscribe.js — 「订阅方案」弹窗
 *
 * 当前为纯前端展示：点击方案后提示"即将开通支付"。
 * 后续如需真实收款，可在此接入 Stripe / 微信支付等 SDK。
 */

import './subscribe.css';

const PLANS = [
  {
    id: 'free',
    name: '免费体验',
    desc: '先试用核心流程，零成本体验 3D 改装预览。',
    price: 0,
    unit: '¥',
    cycle: '/ 月',
    recommended: false,
    btn: '当前可用',
    variant: 'ghost',
    features: [
      '整车 3D 生成：1 次/月',
      '轮毂 3D 生成：1 次/月',
      '车型识别：1 次/月',
      'BANG 车身拆解：—',
      '保存方案：最多 1 个',
    ],
  },
  {
    id: 'hobby',
    name: '改装爱好者',
    desc: '适合个人玩家，每月足够完成 1–2 套完整改装方案。',
    price: 29,
    unit: '¥',
    cycle: '/ 月',
    recommended: true,
    btn: '选择此方案',
    variant: 'primary',
    features: [
      '整车 3D 生成：4 次/月',
      '轮毂 3D 生成：8 次/月',
      '车型识别：无限次',
      'BANG 车身拆解：1 次/月',
      '保存方案：最多 10 个',
    ],
  },
  {
    id: 'pro',
    name: '改装工作室',
    desc: '适合改装店、内容创作者或多车并行项目。',
    price: 79,
    unit: '¥',
    cycle: '/ 月',
    recommended: false,
    btn: '选择此方案',
    variant: 'primary',
    features: [
      '整车 3D 生成：12 次/月',
      '轮毂 3D 生成：25 次/月',
      '车型识别：无限次',
      'BANG 车身拆解：4 次/月',
      '保存方案：无限',
    ],
  },
];

const EXTRAS = [
  '额度用完后可购买加油包（¥9/3次、¥19/8次、¥39/20次）。',
  '未订阅时默认走 DEMO 模式，不消耗真实额度。',
  '价格按当前 Hyper3D/Rodin、混元 3D、通义千问 vision 及 Railway 托管成本测算，后续随调用量可能微调。',
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

  const cards = PLANS.map((plan) => {
    const priceDisplay =
      plan.price === 0
        ? [el('span', { class: 'num' }, '0'), el('span', { class: 'cycle' }, '免费')]
        : [
            el('span', { class: 'unit' }, plan.unit),
            el('span', { class: 'num' }, String(plan.price)),
            el('span', { class: 'cycle' }, plan.cycle),
          ];

    const featureItems = plan.features.map((text) =>
      el('li', { class: text.includes('—') ? 'disabled' : '' }, text)
    );

    return el(
      'div',
      { class: `pricing-card ${plan.recommended ? 'recommended' : ''}` },
      plan.recommended ? el('div', { class: 'pricing-card__badge' }, '推荐') : null,
      el('h3', { class: 'pricing-card__name' }, plan.name),
      el('p', { class: 'pricing-card__desc' }, plan.desc),
      el('div', { class: 'pricing-card__price' }, ...priceDisplay),
      el('ul', { class: 'pricing-card__features' }, ...featureItems),
      el(
        'button',
        {
          class: `pricing-card__btn ${plan.variant}`,
          type: 'button',
          onClick: () => handleSelect(plan),
        },
        plan.btn
      )
    );
  });

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
      el('h2', { class: 'pricing-head__title' }, '选择你的订阅方案'),
      el(
        'p',
        { class: 'pricing-head__sub' },
        '按当前 3D 生成、车型识别与云托管成本测算。订阅后解锁真实模型生成，未订阅仍可体验 DEMO 模式。'
      )
    ),
    closeBtn
  );

  const grid = el('div', { class: 'pricing-grid' }, ...cards);

  const foot = el(
    'div',
    { class: 'pricing-foot' },
    ...EXTRAS.map((text) => el('p', {}, `· ${text}`))
  );

  const modal = el('div', { class: 'pricing-modal' }, head, grid, foot);
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
  // 当前无真实支付，先给用户一个友好提示
  // 将来可在此跳转 Stripe Checkout / 微信支付收银台
  if (plan.id === 'free') {
    showToast('免费版已可用，上传照片即可开始体验。');
    return;
  }
  showToast(
    `你选择了「${plan.name}」。支付功能即将上线，我们会尽快开通。当前可先使用免费版体验完整流程。`
  );
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
