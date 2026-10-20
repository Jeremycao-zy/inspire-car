/**
 * photoGuide.js — 新建方案后的拍照引导界面
 *
 * 布局：单屏「取景框 + 角度队列」——左侧大取景框以示例图的蓝图化虚线轮廓为参照
 *       拍摄当前角度，右侧队列纵排 5 个角度缩略图；拍完一张即替换对应缩略图
 *       并自动切到下一个未拍摄角度（由原 5 张展开卡片融合而来）。
 *
 * 流程：用户按角度上传/拍摄 5 张照片 → 点击「开始建模」
 *       → 调用 generateModel 生成 3D 车模 → 成功后回调，携带 url + files。
 */

import { generateModel, GenerateError } from '../api/generate.js';
import logoWordmarkUrl from '../assets/logo-wordmark-white.png';
import logoGlyphUrl from '../assets/logo-glyph-white.png';
import { loading3D } from './loading3d.js';
import './photoGuide.css';

/** 建模等待时的改装知识小贴士（自动轮播 + 可手动点切下一条） */
const LOADING_TIPS = [
  { title: 'ET 值：轮毂偏距', text: '偏距越小轮毂越向外凸，改装时要同时考虑轮拱宽度与悬挂倾角。' },
  { title: '扁平比与路感', text: '胎壁越薄（如 35）路感越直接，但舒适性下降、鼓包风险也会增加。' },
  { title: '降低车身必做定位', text: '改变车高会连带改变倾角与束角，建议降低后做一次四轮定位。' },
  { title: '刹车的真相', text: '刹车线性更多来自刹车皮和盘片配方，而不是单纯看活塞数量。' },
  { title: '倾角 Camber', text: '适度的负倾角能提升弯道接地，但会加速轮胎内侧磨损。' },
  { title: '轮距加法兰', text: '法兰盘能扩轮距提升稳定性，但也会增加转向和悬挂负荷。' },
  { title: '车衣 vs 改色膜', text: 'TPU 车衣能自动修复划痕；PVC 改色膜颜色多但保护力较弱。' },
  { title: '进气温度', text: '每降低 10°C，空气密度提升约 3%，自然吸气也能获得更好响应。' },
  { title: '排气背压', text: '排气过通畅会损失低扭，街车建议保留适度回压更平顺。' },
  { title: '胎压要冷胎看', text: '行驶后胎压会升高 0.1-0.2 bar，补气和检查都以冷胎为准。' },
  { title: '簧下质量', text: '每减轻 1 kg 簧下质量，约等于减少 15 kg 簧上质量的效果。' },
  { title: '包围不是越夸张越好', text: '街车过于夸张的包围容易产生乱流，反而增加高速油耗与噪音。' },
];

function $(sel) {
  return document.querySelector(sel);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

/** 5 个拍摄角度定义：正面 → 侧前 → 正侧 → 正后 → 侧后 */
const ANGLES = [
  {
    id: 'front',
    title: '正面',
    desc: '站在车头正前方，保持车身左右对称，完整拍摄前脸、大灯与进气格栅。',
    img: '/guides/front.png',
  },
  {
    id: 'frontRight',
    title: '侧前',
    desc: '从车头右前方 45° 拍摄，同时露出车头与右侧车身，展现立体感。',
    img: '/guides/front-right.png',
  },
  {
    id: 'side',
    title: '正侧',
    desc: '在车身侧面水平拍摄，完整展示腰线、车门与侧裙。',
    img: '/guides/side.png',
  },
  {
    id: 'rear',
    title: '正后',
    desc: '站在车尾正后方，水平拍摄尾灯、后保险杠与整体车尾轮廓。',
    img: '/guides/rear.png',
  },
  {
    id: 'rearRight',
    title: '侧后',
    desc: '从车尾右后方 45° 拍摄，同时露出车尾与右侧车身。',
    img: '/guides/rear-right.png',
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
 * 生成缩略图 Blob（只用于预览）。
 *
 * ⚠️ 这是"拍照环节一切横屏就崩"的根因：
 * 手机相机原图动辄 1000~1200 万像素，浏览器解码一张要 ~48MB 内存，5 张就是 200MB+。
 * 原先直接 `thumb.src = URL.createObjectURL(file)` 拿原图当缩略图，
 * 而**横竖屏切换会让浏览器重新解码所有可见图片**，内存瞬间冲到峰值把标签页顶崩。
 *
 * 这里统一压到 maxSide 以内再显示，单张降到几十 KB，重解码的代价可以忽略。
 * 注意：只影响预览；上传建模仍然用原始 file，生成质量不受影响。
 */
async function makeThumbBlob(file, maxSide = 420) {
  try {
    if (!file || !file.type.startsWith('image/')) return null;
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return null;
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.(); // 立刻释放位图，不等 GC
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    c.width = 0; // 释放画布后备存储
    c.height = 0;
    return blob;
  } catch {
    return null;
  }
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
  // 每个角度一个 file input（挂在队列项里，由取景框的上传/重选按钮编程触发点击）
  const inputsById = {};
  // 取景框当前展示的角度（点击队列项切换）
  let currentAngleId = ANGLES[0].id;
  let generating = false;

  const draft = loadDraft();

  // 顶部
  const header = el(
    'header',
    { class: 'photo-guide__header' },
    el(
      'div',
      { class: 'photo-guide__brand' },
      el('img', { class: 'photo-guide__logo', src: logoWordmarkUrl, alt: 'INSPIRE CAR' }),
      '灵感改装 · 拍摄引导'
    ),
    el(
      'button',
      { class: 'photo-guide__back', onClick: handleCancel },
      el('span', {
        class: 'photo-guide__back-icon',
        html:
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
          '<polyline points="17 21 17 13 7 13 7 21"/>' +
          '<polyline points="7 3 7 8 15 8"/></svg>',
      }),
      '返回车库'
    )
  );

  // 标题
  const title = el('h1', { class: 'photo-guide__title' }, '拍出你的车，开始 3D 建模');
  const subtitle = el(
    'p',
    { class: 'photo-guide__subtitle' },
    '对照取景框内的虚线轮廓，按右侧队列逐个拍摄或上传照片。光线充足、镜头干净，模型会更准确。'
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

  // ---------- 取景框（主视觉：ghost 蓝图轮廓 + 取景辅助线 + 用户照片） ----------
  // 底层：当前角度示例图，蓝图化处理后作为「车辆方位虚线轮廓」参照
  const vfGhost = el('img', { class: 'photo-guide__ghost hidden', alt: '' });
  // 中层：纯 CSS 取景辅助线（虚线安全框 + 四角相机括号 + 中心十字准线）
  const vfGuides = el(
    'div',
    { class: 'photo-guide__guides', 'aria-hidden': 'true' },
    el('div', { class: 'photo-guide__guide-frame' }),
    el('div', { class: 'photo-guide__guide-corner photo-guide__guide-corner--tl' }),
    el('div', { class: 'photo-guide__guide-corner photo-guide__guide-corner--tr' }),
    el('div', { class: 'photo-guide__guide-corner photo-guide__guide-corner--bl' }),
    el('div', { class: 'photo-guide__guide-corner photo-guide__guide-corner--br' }),
    el('div', { class: 'photo-guide__guide-cross' })
  );
  // 顶层：用户照片（与队列缩略图共享同一 blob URL，不额外占内存）
  const vfThumb = el('img', {
    class: 'photo-guide__thumb photo-guide__viewfinder-thumb hidden',
    alt: '已拍摄照片',
  });
  // 未拍摄时挂在取景框底部居中的大上传触发按钮（点击 → 打开当前角度的 file input）
  const vfUpload = el(
    'button',
    {
      type: 'button',
      class: 'photo-guide__upload photo-guide__upload--hero',
      onClick: () => inputsById[currentAngleId]?.click(),
    },
    el('span', {
      class: 'photo-guide__upload-icon',
      html:
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
        '<circle cx="12" cy="13" r="4"/></svg>',
    }),
    '拍照或选相册'
  );
  const vf = el('div', { class: 'photo-guide__viewfinder' }, vfGhost, vfGuides, vfThumb, vfUpload);

  // 取景框下方（框外）：当前角度标题 + 说明 + 重选按钮
  const vfIndex = el('span', { class: 'photo-guide__angle-index' }, '1/5');
  const vfTitle = el('h3', { class: 'photo-guide__angle-title' }, ANGLES[0].title);
  const vfDesc = el('p', { class: 'photo-guide__angle-desc' }, ANGLES[0].desc);
  const vfRetake = el(
    'button',
    { type: 'button', class: 'photo-guide__retake hidden', onClick: handleRetake },
    '重新选择'
  );
  const vfMeta = el(
    'div',
    { class: 'photo-guide__viewfinder-meta' },
    el('div', { class: 'photo-guide__viewfinder-meta-head' }, vfIndex, vfTitle),
    vfDesc,
    vfRetake
  );
  const vfCol = el('div', { class: 'photo-guide__viewfinder-col' }, vf, vfMeta);

  // ---------- 右侧角度队列：5 个缩略项，点击切换取景框角度 ----------
  const strip = el('div', { class: 'photo-guide__strip' });
  ANGLES.forEach((angle, i) => {
    const item = renderStripItem(angle, i);
    cardsById[angle.id] = item;
    strip.appendChild(item);
  });

  // 单屏舞台：左取景框（flex:1）+ 右队列（固定宽，移动端改为横向滚动）
  const stage = el('div', { class: 'photo-guide__stage' }, vfCol, strip);

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

  // 进度/错误覆盖层（程序化 3D 组装动画 + 改装知识 + 进度条/小车 logo 引导）
  const progressMarker = el('img', { class: 'photo-guide__bar-marker', src: logoGlyphUrl, alt: '' });
  const progressFill = el('div', { class: 'photo-guide__bar-fill' }, progressMarker);
  const overlayIcon = el('div', { class: 'photo-guide__overlay-icon' });
  const overlayAnimationHost = el('div', {
    class: 'loading3d-host loading3d-host--compact',
    'aria-label': '车辆三维组装进度动画',
  });
  const overlaySpinner = el('div', { class: 'photo-guide__overlay-spinner', 'aria-hidden': true });
  overlayIcon.appendChild(overlayAnimationHost);
  overlayIcon.appendChild(overlaySpinner);
  // 过程标题/错误提示：平时隐藏，仅在错误时显示
  const overlayTitle = el('h3', { class: 'photo-guide__overlay-title is-hidden' }, '正在建模…');
  const overlayText = el('p', { class: 'photo-guide__overlay-text is-hidden' }, '正在压缩并上传照片，请稍候');
  const overlayTips = el('div', { class: 'photo-guide__overlay-tips' });
  const overlayCaption = el('p', { class: 'photo-guide__overlay-caption' }, '');
  const overlayActions = el('div', { class: 'photo-guide__overlay-actions' });
  const overlayBox = el(
    'div',
    { class: 'photo-guide__overlay-box' },
    overlayIcon,
    overlayTips,
    overlayTitle,
    overlayText,
    el('div', { class: 'photo-guide__bar' }, progressFill),
    overlayCaption,
    overlayActions
  );
  const overlay = el('div', { class: 'photo-guide__overlay hidden' }, overlayBox);

  const scroll = el(
    'div',
    { class: 'photo-guide__scroll' },
    el('div', { class: 'photo-guide__inner' }, title, subtitle, tips, stage)
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

  // 默认选中第一个未拍摄的角度（全部拍完则落在最后一个）
  const firstPending = ANGLES.find((a) => !filesById[a.id]);
  selectAngle(firstPending ? firstPending.id : ANGLES[ANGLES.length - 1].id);

  /**
   * 渲染右侧队列中的一个角度项：序号圆点 + 角度标题 + 缩略图（示例图/用户照片）+ ✓ 徽章。
   * 每项内置一个不可见的 file input，由取景框的上传按钮编程触发。
   */
  function renderStripItem(angle, index) {
    const input = el('input', {
      class: 'photo-guide__file-input',
      type: 'file',
      accept: 'image/*',
      tabindex: '-1',
      'aria-hidden': 'true',
      // 注意：不要加 capture 属性——capture 会强制直接开相机，
      // 把 iOS/Android 的「照片图库 / 选取文件」选项藏掉，导致手机上只能拍照、选不了相册。
      // 去掉后系统弹窗会同时提供「拍照 / 照片图库 / 选取文件」。
      onChange: (e) => {
        handleFileChange(angle.id, e.target.files?.[0]);
        // 清空 input：否则再次选择同一个文件时 value 不变、change 不再触发
        e.target.value = '';
      },
    });
    inputsById[angle.id] = input;

    // 示例图（未拍摄时显示）；用户照片就绪后由 thumb 覆盖
    const guide = el('img', { class: 'photo-guide__strip-img', src: angle.img, alt: '' });
    const thumb = el('img', {
      class: 'photo-guide__thumb photo-guide__strip-thumb hidden',
      alt: angle.title,
    });
    thumbsById[angle.id] = thumb;

    return el(
      'div',
      {
        // photo-guide__card 类名是 e2e 回归契约（'.photo-guide__card input[type=file]'
        // 用于定位 5 个角度输入），勿删；视觉样式全部由 photo-guide__strip-item 承担。
        class: 'photo-guide__strip-item photo-guide__card',
        'data-angle': angle.id,
        role: 'button',
        tabindex: '0',
        'aria-label': `拍摄角度 ${index + 1}：${angle.title}`,
        onClick: () => selectAngle(angle.id),
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectAngle(angle.id);
          }
        },
      },
      el(
        'div',
        { class: 'photo-guide__strip-head' },
        el('span', { class: 'photo-guide__strip-index' }, String(index + 1)),
        el('span', { class: 'photo-guide__strip-label' }, angle.title)
      ),
      el(
        'div',
        { class: 'photo-guide__strip-thumb-wrap' },
        guide,
        thumb,
        el('span', { class: 'photo-guide__strip-badge', 'aria-hidden': 'true' }, '✓')
      ),
      input
    );
  }

  /** 切换取景框当前展示的角度 */
  function selectAngle(id) {
    if (!ANGLES.some((a) => a.id === id)) return;
    currentAngleId = id;
    syncViewfinder();
  }

  /** 让取景框与 currentAngleId 的拍摄状态保持同步 */
  function syncViewfinder() {
    const index = ANGLES.findIndex((a) => a.id === currentAngleId);
    const angle = ANGLES[index] || ANGLES[0];
    const shot = !!filesById[angle.id];

    vfGhost.src = angle.img;
    // 已拍摄 → ghost 隐藏、辅助线淡出，用户照片铺满取景框
    vfGhost.classList.toggle('hidden', shot);
    vfGuides.classList.toggle('is-faded', shot);
    vfIndex.textContent = `${index + 1}/${ANGLES.length}`;
    vfTitle.textContent = angle.title;
    vfDesc.textContent = angle.desc;

    const stripThumb = thumbsById[angle.id];
    if (shot && stripThumb && stripThumb.src) {
      // 与队列缩略图共享同一 blob URL（压缩图仅几十 KB，不额外占内存）
      if (vfThumb.src !== stripThumb.src) vfThumb.src = stripThumb.src;
      vfThumb.classList.remove('hidden');
      vfUpload.classList.add('hidden');
      vfRetake.classList.remove('hidden');
    } else {
      vfThumb.src = '';
      vfThumb.classList.add('hidden');
      vfUpload.classList.remove('hidden');
      vfRetake.classList.add('hidden');
    }

    for (const a of ANGLES) {
      cardsById[a.id].classList.toggle('photo-guide__strip-item--active', a.id === angle.id);
    }
  }

  /** 重新选择当前角度的照片：清空旧图并重新打开文件选择 */
  function handleRetake() {
    const input = inputsById[currentAngleId];
    if (!input) return;
    input.value = '';
    handleFileChange(currentAngleId, null);
    input.click();
  }

  function handleFileChange(id, file) {
    const thumb = thumbsById[id];
    const card = cardsById[id];
    const has = file && file.type.startsWith('image/');

    if (has) {
      filesById[id] = file;
      if (thumb.src && thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
      // 先清空，别让上一张的解码位图继续占内存
      thumb.src = '';
      thumb.classList.remove('hidden');
      card.classList.add('photo-guide__strip-item--done');
      // 用压缩后的缩略图显示（原图解码会吃掉几十 MB，横竖屏切换重解码时直接崩）
      makeThumbBlob(file)
        .then((blob) => {
          if (filesById[id] !== file) return; // 期间又换图/清空了，丢弃这次结果
          if (!blob) {
            thumb.src = URL.createObjectURL(file); // 极端情况兜底
          } else {
            thumb.src = URL.createObjectURL(blob);
          }
          // 若当前角度就是它，取景框立即换上（与队列共享同一 URL）
          if (id === currentAngleId) syncViewfinder();
        })
        .catch(() => {});
    } else {
      filesById[id] = null;
      if (thumb.src && thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
      thumb.src = '';
      thumb.classList.add('hidden');
      card.classList.remove('photo-guide__strip-item--done');
    }

    // 取景框跟随当前角度刷新（ghost / 用户照片 / 辅助线 / 队列高亮）
    syncViewfinder();

    // 拍完一张 → 自动切到下一个未拍摄的角度，无需用户手点
    if (has) {
      const next = ANGLES.find((a) => !filesById[a.id]);
      if (next) selectAngle(next.id);
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

  // ---------- 建模等待期：改装知识轮播 + 科幻 3D 组装动画 ----------
  let tipIndex = 0;
  let tipTimer = null;

  function renderTip(i) {
    const tip = LOADING_TIPS[i % LOADING_TIPS.length];
    overlayTips.classList.add('fade');
    setTimeout(() => {
      overlayTips.innerHTML = `
        <div class="photo-guide__overlay-tip-label">改装小知识</div>
        <div class="photo-guide__overlay-tip-title">${escapeHtml(tip.title)}</div>
        <div class="photo-guide__overlay-tip-text">${escapeHtml(tip.text)}</div>
      `;
      overlayTips.classList.remove('fade');
    }, 220);
  }

  function nextTip() {
    tipIndex = (tipIndex + 1) % LOADING_TIPS.length;
    renderTip(tipIndex);
  }

  function startTips() {
    stopTips();
    tipIndex = Math.floor(Math.random() * LOADING_TIPS.length);
    renderTip(tipIndex);
    tipTimer = setInterval(nextTip, 6000);
  }

  function stopTips() {
    if (tipTimer) {
      clearInterval(tipTimer);
      tipTimer = null;
    }
  }

  async function handleStart() {
    if (generating) return;
    // 组装 files 时给每个 File 打上角度标签，供识别阶段挑最佳图（侧方/45° 优先）
    const files = ANGLES.map((a) => {
      const f = filesById[a.id];
      if (f) f.angleId = a.id;
      return f;
    }).filter(Boolean);
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
    const isDone = stage === 'done';
    // 完成时释放 WebGL 并切换为品牌 logo；处理中复用唯一的轻量 3D 组装场景。
    if (isDone) {
      loading3D.dispose(overlayAnimationHost);
      overlayIcon.innerHTML = `<img class="photo-guide__overlay-icon--done" src="${logoGlyphUrl}" alt="INSPIRE CAR">`;
      stopTips();
    } else {
      if (!overlayIcon.contains(overlayAnimationHost)) {
        overlayIcon.replaceChildren(overlayAnimationHost, overlaySpinner);
      }
      loading3D.mount(overlayAnimationHost, { compact: true, progress });
      loading3D.updateProgress(progress, overlayAnimationHost);
      if (!tipTimer) startTips();
    }
    // 简约版：不显示大标题/详细说明，进程信息以微文案形式挂在进度条下方
    overlayTitle.classList.add('is-hidden');
    overlayText.classList.add('is-hidden');
    overlayCaption.textContent = message || '处理中…';
    progressFill.style.width = `${Math.max(0, Math.min(100, (progress || 0) * 100))}%`;
    overlayActions.innerHTML = '';
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
    stopTips();
    loading3D.dispose(overlayAnimationHost);
    overlayIcon.replaceChildren(overlayAnimationHost, overlaySpinner);
    overlayTips.innerHTML = '';
    overlayCaption.textContent = '';
    overlayCaption.classList.remove('is-hidden');
    overlayTitle.classList.add('is-hidden');
    overlayText.classList.add('is-hidden');
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

    stopTips();
    loading3D.dispose(overlayAnimationHost);
    overlayTips.innerHTML = '';
    overlayIcon.textContent = '⚠️';
    overlayTitle.classList.remove('is-hidden');
    overlayText.classList.remove('is-hidden');
    overlayCaption.classList.add('is-hidden');
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
    // 复用已选照片时同样补角度标签（与 handleStart 一致）
    const files = ANGLES.map((a) => {
      const f = filesById[a.id];
      if (f) f.angleId = a.id;
      return f;
    }).filter(Boolean);
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
      stopTips();
      loading3D.dispose(overlayAnimationHost);
      // 清理 blob URL
      for (const thumb of Object.values(thumbsById)) {
        if (thumb.src && thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
      }
      root.innerHTML = '';
      root.classList.add('hidden');
    },
  };
}
