/**
 * photoGuide.js — 新建方案后的拍照引导界面
 *
 * 流程：展示 5 个拍摄角度 → 用户上传/拍摄 5 张照片 → 点击「开始建模」
 *       → 调用 generateModel 生成 3D 车模 → 成功后回调，携带 url + files。
 */

import { generateModel, GenerateError } from '../api/generate.js';
import logoMarkUrl from '../assets/logo-mark-neon.png';
import './photoGuide.css';

function $(sel) {
  return document.querySelector(sel);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'value' && 'value' in node) node.value = v;
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

/** 5 个拍摄角度定义 */
const ANGLES = [
  {
    id: 'front',
    title: '正前方',
    desc: '站在车头正前方，保持车身左右对称，能完整看到前脸和大灯。',
    img: '/guides/front.png',
  },
  {
    id: 'rear',
    title: '正后方',
    desc: '站在车尾正后方，水平拍摄尾灯、后保险杠和整体车尾轮廓。',
    img: '/guides/rear.png',
  },
  {
    id: 'side',
    title: '正侧方',
    desc: '在车身侧面水平拍摄，完整展示腰线、车门和侧裙。',
    img: '/guides/side.png',
  },
  {
    id: 'frontRight',
    title: '车头右前方',
    desc: '从右前方 45° 拍摄，同时露出车头和右侧车身，展现立体感。',
    img: '/guides/front-right.png',
  },
  {
    id: 'rearLeft',
    title: '车尾左后方',
    desc: '从左后方 45° 拍摄，同时露出车尾和左侧车身。',
    img: '/guides/rear-left.png',
  },
];

const STORAGE_KEY = 'photo-guide-draft';

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDraft(filesById) {
  try {
    const payload = {};
    for (const [id, file] of Object.entries(filesById)) {
      if (file) payload[id] = { name: file.name, size: file.size, lastModified: file.lastModified };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

function clearDraft() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/**
 * @param {Object} opts
 * @param {(result: {url:string, mode:string, files:File[]}) => void} opts.onModeled
 * @param {() => void} [opts.onCancel]
 * @param {string} [opts.mount] 挂载目标选择器，默认 #photo-guide
 */
export function mountPhotoGuide({ onModeled, onCancel, mount } = {}) {
  const root = $(mount || '#photo-guide');
  if (!root) {
    console.error('[photoGuide] mount target not found');
    return null;
  }
  root.classList.remove('hidden');

  // 状态：每个角度对应一个 File
  const filesById = {};
  const thumbsById = {};
  const cardsById = {};
  let generating = false;

  const draft = loadDraft();

  // 顶部
  const header = el(
    'header',
    { class: 'photo-guide__header' },
    el(
      'div',
      { class: 'photo-guide__brand' },
      el('img', { class: 'photo-guide__logo', src: logoMarkUrl, alt: 'INSPIRE CAR' }),
      '灵感改装 · 拍摄引导'
    ),
    el(
      'button',
      { class: 'photo-guide__back', onClick: handleCancel },
      '← 返回车库'
    )
  );

  // 标题
  const title = el('h1', { class: 'photo-guide__title' }, '拍出你的车，开始 3D 建模');
  const subtitle = el(
    'p',
    { class: 'photo-guide__subtitle' },
    '请按下方 5 个角度依次拍摄或上传照片。光线充足、镜头干净，模型会更准确。'
  );

  // 提示卡片
  const tips = el(
    'div',
    { class: 'photo-guide__tips' },
    el(
      'div',
      { class: 'photo-guide__tip' },
      el('div', { class: 'photo-guide__tip-icon' }, '☀️'),
      el(
        'div',
        { class: 'photo-guide__tip-content' },
        el('div', { class: 'photo-guide__tip-title' }, '白天拍摄'),
        el('p', { class: 'photo-guide__tip-text' }, '自然光下车身纹理更清晰，避免夜景或过暗环境。')
      )
    ),
    el(
      'div',
      { class: 'photo-guide__tip' },
      el('div', { class: 'photo-guide__tip-icon' }, '🧽'),
      el(
        'div',
        { class: 'photo-guide__tip-content' },
        el('div', { class: 'photo-guide__tip-title' }, '擦净摄像头'),
        el('p', { class: 'photo-guide__tip-text' }, '油污、指纹会让模型边缘模糊，拍前请擦拭镜头。')
      )
    ),
    el(
      'div',
      { class: 'photo-guide__tip' },
      el('div', { class: 'photo-guide__tip-icon' }, '🚙'),
      el(
        'div',
        { class: 'photo-guide__tip-content' },
        el('div', { class: 'photo-guide__tip-title' }, '完整入镜'),
        el('p', { class: 'photo-guide__tip-text' }, '每张照片都要让整车的四个角都在画面内。')
      )
    )
  );

  // 角度网格
  const grid = el('div', { class: 'photo-guide__grid' });
  for (const angle of ANGLES) {
    const card = renderAngleCard(angle);
    cardsById[angle.id] = card;
    grid.appendChild(card);
  }

  // 底部建模栏
  const counter = el('span', { class: 'photo-guide__counter' }, '已拍摄 0/5 张');
  const startBtn = el(
    'button',
    { class: 'photo-guide__start', onClick: handleStart, disabled: true },
    '开始建模'
  );
  const footer = el(
    'footer',
    { class: 'photo-guide__footer' },
    el(
      'div',
      { class: 'photo-guide__footer-inner' },
      counter,
      startBtn
    )
  );

  // 进度/错误覆盖层
  const progressFill = el('div', { class: 'photo-guide__bar-fill' });
  const overlayIcon = el('div', { class: 'photo-guide__overlay-icon' }, '⏳');
  const overlayTitle = el('h3', { class: 'photo-guide__overlay-title' }, '正在建模…');
  const overlayText = el('p', { class: 'photo-guide__overlay-text' }, '正在压缩并上传照片，请稍候');
  const overlayActions = el('div', { class: 'photo-guide__overlay-actions' });
  const overlayBox = el(
    'div',
    { class: 'photo-guide__overlay-box' },
    overlayIcon,
    overlayTitle,
    overlayText,
    el('div', { class: 'photo-guide__bar' }, progressFill),
    overlayActions
  );
  const overlay = el('div', { class: 'photo-guide__overlay hidden' }, overlayBox);

  const scroll = el(
    'div',
    { class: 'photo-guide__scroll' },
    el('div', { class: 'photo-guide__inner' }, title, subtitle, tips, grid)
  );

  root.innerHTML = '';
  root.appendChild(header);
  root.appendChild(scroll);
  root.appendChild(footer);
  root.appendChild(overlay);

  updateCounter();

  // 尝试从草稿恢复：只有元数据，无法恢复 File 对象；让用户重新选更快。
  if (draft) {
    // 仅保留视觉提示：如果有 draft，提示用户重新上传
    // 实际上不做恢复，避免 stale 状态
  }

  function renderAngleCard(angle) {
    const img = el('img', { class: 'photo-guide__card-img', src: angle.img, alt: angle.title });

    const input = el('input', {
      type: 'file',
      accept: 'image/*',
      capture: 'environment',
      onChange: (e) => handleFileChange(angle.id, e.target.files?.[0]),
    });

    const uploadZone = el(
      'label',
      { class: 'photo-guide__upload' },
      '📷 拍照 / 上传',
      input
    );

    const thumb = el('img', { class: 'photo-guide__thumb hidden' });
    thumbsById[angle.id] = thumb;

    const retakeBtn = el(
      'button',
      {
        class: 'photo-guide__retake hidden',
        onClick: () => {
          input.value = '';
          handleFileChange(angle.id, null);
          input.click();
        },
      },
      '重新拍摄'
    );

    return el(
      'div',
      { class: 'photo-guide__card', 'data-angle': angle.id },
      el('div', { class: 'photo-guide__card-badge' }, '✓'),
      img,
      el(
        'div',
        { class: 'photo-guide__card-body' },
        el('h3', { class: 'photo-guide__card-title' }, angle.title),
        el('p', { class: 'photo-guide__card-desc' }, angle.desc),
        uploadZone,
        thumb,
        retakeBtn
      )
    );
  }

  function handleFileChange(id, file) {
    const thumb = thumbsById[id];
    const card = cardsById[id];
    const retake = card.querySelector('.photo-guide__retake');
    const uploadZone = card.querySelector('.photo-guide__upload');

    if (file && file.type.startsWith('image/')) {
      filesById[id] = file;
      if (thumb.src && thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
      thumb.src = URL.createObjectURL(file);
      thumb.classList.remove('hidden');
      uploadZone.classList.add('hidden');
      retake.classList.remove('hidden');
      card.classList.add('photo-guide__card--done');
    } else {
      filesById[id] = null;
      if (thumb.src && thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
      thumb.src = '';
      thumb.classList.add('hidden');
      uploadZone.classList.remove('hidden');
      retake.classList.add('hidden');
      card.classList.remove('photo-guide__card--done');
    }
    saveDraft(filesById);
    updateCounter();
  }

  function updateCounter() {
    const count = Object.values(filesById).filter(Boolean).length;
    counter.innerHTML = `已拍摄 <strong>${count}/5</strong> 张`;
    startBtn.disabled = count < 5 || generating;
    startBtn.textContent = generating ? '建模中…' : '开始建模';
  }

  async function handleStart() {
    if (generating) return;
    const files = ANGLES.map((a) => filesById[a.id]).filter(Boolean);
    if (files.length < 5) return;

    generating = true;
    updateCounter();
    showOverlay('prepare', 0.02, '正在压缩照片…');

    try {
      const result = await generateModel({
        kind: 'car',
        files,
        title: '我的车',
        onProgress: (s) => {
          showOverlay(s.stage, Math.min(0.98, s.progress || 0.02), s.message);
        },
      });

      clearDraft();
      showOverlay('done', 1, '建模完成，正在进入工作室…');
      setTimeout(() => {
        hideOverlay();
        if (typeof onModeled === 'function') {
          onModeled({ url: result.url, mode: result.mode || 'live', files });
        }
      }, 600);
    } catch (err) {
      generating = false;
      updateCounter();
      showError(err);
    }
  }

  function showOverlay(stage, progress, message) {
    overlay.classList.remove('hidden');
    overlayIcon.textContent = stage === 'done' ? '✨' : '⏳';
    overlayTitle.textContent = stage === 'done' ? '建模完成' : '正在建模…';
    overlayText.textContent = message || '处理中…';
    progressFill.style.width = `${Math.max(0, Math.min(100, (progress || 0) * 100))}%`;
    overlayActions.innerHTML = '';
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  function showError(err) {
    const isGen = err instanceof GenerateError;
    const reason = isGen ? err.reason : 'fail';
    const detail = err?.message || '生成失败，请检查网络后重试。';

    let title = '建模失败';
    let hint = detail;
    if (reason === 'quota') {
      title = '今日额度已用完';
      hint = '明天再试，或返回车库使用演示模型。';
    } else if (reason === 'auth') {
      title = '凭证已失效';
      hint = '请在右上角重新登录/换票后再试。';
    } else if (reason === 'timeout') {
      title = '生成仍在云端进行';
      hint = '可点击重试继续等待，不重复扣额度。';
    }

    overlayIcon.textContent = '⚠️';
    overlayTitle.textContent = title;
    overlayText.textContent = hint;
    progressFill.style.width = '0%';
    overlayActions.innerHTML = '';

    const retryBtn = el(
      'button',
      {
        class: 'photo-guide__overlay-btn primary',
        onClick: () => {
          if (reason === 'timeout' && isGen && err.jobId) {
            handleResume(err.jobId);
          } else {
            handleStart();
          }
        },
      },
      reason === 'timeout' ? '继续等待' : '重试'
    );
    const cancelBtn = el(
      'button',
      { class: 'photo-guide__overlay-btn', onClick: hideOverlay },
      '返回'
    );
    overlayActions.appendChild(retryBtn);
    overlayActions.appendChild(cancelBtn);
  }

  async function handleResume(jobId) {
    const files = ANGLES.map((a) => filesById[a.id]).filter(Boolean);
    generating = true;
    updateCounter();
    showOverlay('prepare', 0.1, '正在续等云端任务…');

    try {
      const result = await generateModel({
        kind: 'car',
        files,
        resumeJobId: jobId,
        onProgress: (s) => showOverlay(s.stage, Math.min(0.98, s.progress || 0.02), s.message),
      });
      clearDraft();
      showOverlay('done', 1, '建模完成，正在进入工作室…');
      setTimeout(() => {
        hideOverlay();
        if (typeof onModeled === 'function') {
          onModeled({ url: result.url, mode: result.mode || 'live', files });
        }
      }, 600);
    } catch (err) {
      generating = false;
      updateCounter();
      showError(err);
    }
  }

  function handleCancel() {
    if (generating) return;
    root.classList.add('hidden');
    if (typeof onCancel === 'function') onCancel();
  }

  return {
    root,
    destroy() {
      // 清理 blob URL
      for (const thumb of Object.values(thumbsById)) {
        if (thumb.src && thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
      }
      root.innerHTML = '';
      root.classList.add('hidden');
    },
  };
}
