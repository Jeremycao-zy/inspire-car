/**
 * community.js — 「社区」模块前端（论坛 + 资讯自动更新）
 *
 * 设计要点：
 *   · 纯原生 ESM + DOM，无框架，复用项目既有的 authFetch / showAuthOverlay。
 *   · 拆成两个平级视图：createForum（论坛）与 createNews（资讯），
 *     分别挂到车库顶层导航的「论坛」「资讯」分页里，不再有内部 subtab 切换条。
 *   · 论坛：列表 → 详情（主题 + 回复 + 评论框）；未登录发帖/评论引导登录。
 *     首次 activate 拉取一次即可（发帖/回复后主动重载），不做轮询。
 *   · 资讯：三个筛选 chip（资讯/赛事/活动）；activate 时拉取并每 30s 轮询刷新，
 *     deactivate 时 clearInterval，按发布时间倒序，显示「最近更新 HH:MM」。
 *   · 所有用户生成内容一律用 textContent 渲染，杜绝 XSS。
 *
 * 接入方式：garage.js 的顶层分页导航在首次切到对应页时惰性调用
 * createForum({ mount }) / createNews({ mount })，并用返回的
 * { activate, deactivate } 在切页 / 离开车库时启停（含轮询生命周期）。
 */

import { authFetch, isLoggedIn, currentUser } from '../auth.js';
import { showAuthOverlay } from './auth.js';
import { shrinkImage } from '../api/generate.js';

/* ----------------------------- DOM 小工具 ----------------------------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'value' && 'value' in node) node.value = v;
    else if (k === 'checked' && 'checked' in node) node.checked = !!v;
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

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setLoading(node, on) {
  node.classList.toggle('cm-loading', !!on);
}

/* ----------------------------- 文案 / 时间 ----------------------------- */

const FORUM_CATS = [
  ['', '全部'],
  ['chat', '改装交流'],
  ['help', '求助'],
  ['show', '展示'],
];
const NEWS_CATS = [
  ['', '全部'],
  ['news', '改装资讯'],
  ['race', '赛事'],
  ['event', '活动'],
];
const FORUM_CAT_LABEL = { chat: '改装交流', help: '求助', show: '展示' };
const NEWS_CAT_LABEL = { news: '改装资讯', race: '赛事', event: '活动' };

function forumCatLabel(c) {
  return FORUM_CAT_LABEL[c] || '改装交流';
}
function newsCatLabel(c) {
  return NEWS_CAT_LABEL[c] || '改装资讯';
}

/* ----------------------------- 定位隐私：仅保留省级 / 国级 ----------------------------- */

/**
 * 去掉行政区划后缀，得到简称：河北省→河北、北京市→北京、广西壮族自治区→广西、香港特别行政区→香港。
 */
function stripAdmin(s) {
  if (!s) return '';
  return String(s)
    .replace(/特别行政区$/, '')
    .replace(/(壮族|回族|维吾尔|哈萨克)?自治区$/, '')
    .replace(/省$/, '')
    .replace(/市$/, '')
    .trim();
}

/** 中国省级行政区粗粒度包围盒（离线、零外泄、零依赖），用于逆地理的兜底。 */
const CN_DIVISIONS = [
  // 直辖市 / 特别行政区（小盒，先判，避免被周边省份误吞）
  { n: '北京', a: 39.4, b: 41.1, c: 115.4, d: 117.5 },
  { n: '天津', a: 38.5, b: 40.3, c: 116.6, d: 118.4 },
  { n: '上海', a: 30.4, b: 32.2, c: 120.5, d: 122.5 },
  { n: '重庆', a: 28.5, b: 32.2, c: 105.0, d: 110.5 },
  { n: '香港', a: 22.1, b: 22.6, c: 113.8, d: 114.5 },
  { n: '澳门', a: 21.9, b: 22.3, c: 113.3, d: 113.7 },
  // 省份 / 自治区 / 台湾（顺序无所谓，盒子互不重叠）
  { n: '河北', a: 36.0, b: 42.6, c: 113.1, d: 120.0 },
  { n: '山西', a: 34.3, b: 40.7, c: 110.1, d: 114.6 },
  { n: '辽宁', a: 38.7, b: 43.3, c: 118.8, d: 125.2 },
  { n: '吉林', a: 40.8, b: 46.3, c: 121.5, d: 131.3 },
  { n: '黑龙江', a: 43.2, b: 53.3, c: 121.1, d: 135.1 },
  { n: '江苏', a: 30.5, b: 35.2, c: 116.5, d: 121.9 },
  { n: '浙江', a: 27.0, b: 31.2, c: 118.0, d: 123.1 },
  { n: '安徽', a: 29.5, b: 34.5, c: 114.8, d: 120.0 },
  { n: '福建', a: 23.3, b: 28.4, c: 116.3, d: 120.9 },
  { n: '江西', a: 24.3, b: 30.1, c: 113.3, d: 118.5 },
  { n: '山东', a: 34.4, b: 38.4, c: 114.2, d: 122.7 },
  { n: '河南', a: 31.4, b: 36.4, c: 110.2, d: 116.6 },
  { n: '湖北', a: 29.0, b: 33.3, c: 108.3, d: 116.2 },
  { n: '湖南', a: 24.6, b: 30.1, c: 108.6, d: 114.3 },
  { n: '广东', a: 20.1, b: 25.5, c: 109.6, d: 117.3 },
  { n: '广西', a: 20.8, b: 26.4, c: 104.4, d: 112.1 },
  { n: '海南', a: 3.5, b: 20.1, c: 108.5, d: 111.9 },
  { n: '四川', a: 26.0, b: 34.3, c: 97.3, d: 108.6 },
  { n: '贵州', a: 24.4, b: 29.2, c: 103.5, d: 109.7 },
  { n: '云南', a: 21.1, b: 29.3, c: 97.3, d: 106.3 },
  { n: '陕西', a: 31.7, b: 39.6, c: 105.3, d: 111.3 },
  { n: '甘肃', a: 32.4, b: 42.8, c: 92.2, d: 108.8 },
  { n: '青海', a: 31.2, b: 39.3, c: 89.3, d: 103.2 },
  { n: '台湾', a: 21.9, b: 25.3, c: 119.5, d: 122.1 },
  { n: '内蒙古', a: 37.2, b: 53.4, c: 97.0, d: 126.1 },
  { n: '宁夏', a: 34.5, b: 39.4, c: 104.1, d: 107.7 },
  { n: '新疆', a: 34.2, b: 49.2, c: 73.3, d: 96.4 },
  { n: '西藏', a: 26.8, b: 36.5, c: 78.1, d: 99.2 },
];

/** 离线粗粒度定位：经纬度 → 省级简称；不在任何盒内（海外）→ null。 */
function coarseRegion(lat, lng) {
  for (const dv of CN_DIVISIONS) {
    if (lat >= dv.a && lat <= dv.b && lng >= dv.c && lng <= dv.d) return dv.n;
  }
  return null;
}

/**
 * 逆地理编码：经纬度 → { region, country }。
 * 优先用在线服务精确拿到省/国；失败（断网 / 被墙）回退到本地包围盒（仍为省级，零外泄）。
 * 关键隐私原则：服务器只收到「河北」「中国」这类行政区标签，绝不收到精确坐标。
 */
async function reverseGeocode(lat, lng) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=zh`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (r.ok) {
      const d = await r.json().catch(() => null);
      if (d) {
        const country = d.countryName || '';
        const sub = d.principalSubdivision || '';
        if (/中国|china/i.test(country)) {
          return { region: stripAdmin(sub) || '中国', country: '中国' };
        }
        if (country) return { region: null, country: stripAdmin(country) };
      }
    }
  } catch {
    /* 落到本地回退 */
  }
  const region = coarseRegion(lat, lng);
  if (region) return { region, country: '中国' };
  return { region: null, country: '海外' };
}

/** 把存储的定位（{region,country}）渲染成展示文案；旧数据只有经纬度则不展示（保护隐私）。 */
function locationLabel(loc) {
  if (!loc || typeof loc !== 'object') return '';
  if (loc.region) return '📍 ' + loc.region;
  if (loc.country) return '🌐 ' + loc.country;
  return '';
}

/* ----------------------------- 删除帖子 / 回复（通用请求与确认） ----------------------------- */

async function apiDelete(url) {
  const res = await authFetch(url, { method: 'DELETE' });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

/** 通用确认弹窗，返回用户是否确认 */
function confirmDelete(message) {
  return new Promise((resolve) => {
    const close = (val) => { overlay.remove(); resolve(val); };
    const yes = el('button', { class: 'cm-btn-danger', onclick: () => close(true) }, '删除');
    const no = el('button', { class: 'cm-btn-ghost', onclick: () => close(false) }, '取消');
    const overlay = buildModal({
      title: '确认删除',
      bodyNodes: [el('p', { class: 'cm-modal__msg' }, message)],
      footerNodes: [no, yes],
    });
  });
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const t = new Date(isoStr).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatHM(isoStr) {
  const d = new Date(isoStr || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ----------------------------- API 封装 ----------------------------- */

async function apiGet(url) {
  const res = await authFetch(url);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}

async function apiPost(url, body) {
  const res = await authFetch(url, { method: 'POST', body: JSON.stringify(body) });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}

/** 上传论坛媒体（图片/视频）-> {ok, status, data:{url, kind}} */
async function apiUploadForumMedia(dataUrl, ext) {
  const res = await authFetch('/api/forum/media', { method: 'POST', body: JSON.stringify({ dataUrl, ext }) });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}

/** 读文件为 dataURL */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/** 取文件扩展名（归一 jpeg->jpg） */
function mediaExtOf(name, type, fallback) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  if (type && type.indexOf('/') >= 0) {
    const e = type.split('/')[1].replace('jpeg', 'jpg');
    if (e) return e;
  }
  return fallback;
}

/** 预处理待上传媒体：图片压缩（长边<=1600 JPEG），视频原样读 dataURL */
async function prepareMediaFile(file) {
  const isVideo = String(file.type || '').indexOf('video/') === 0;
  if (isVideo) {
    return { dataUrl: await readFileAsDataURL(file), type: 'video', ext: mediaExtOf(file.name, file.type, 'mp4') };
  }
  const dataUrl = await shrinkImage(file, 1600, 0.82);
  return { dataUrl, type: 'image', ext: mediaExtOf(file.name, file.type, 'jpg') };
}

/** 未登录则弹登录浮层，登录成功（或已登录）后执行 then */
function requireLogin(then) {
  if (isLoggedIn()) {
    then();
    return;
  }
  showAuthOverlay(() => then());
}

/* ----------------------------- 通用模态框 ----------------------------- */

function buildModal({ title, bodyNodes, footerNodes, cls }) {
  const overlay = el('div', { class: 'cm-modal-overlay' });
  const children = [
    el(
      'div',
      { class: 'cm-modal__head' },
      el('span', { class: 'cm-modal__title' }, title),
      el('button', { class: 'cm-modal__close', onclick: () => overlay.remove() }, '×')
    ),
    el('div', { class: 'cm-modal__body' }, ...bodyNodes),
  ];
  if (footerNodes && footerNodes.length) {
    children.push(el('div', { class: 'cm-modal__foot' }, ...footerNodes));
  }
  const box = el('div', { class: 'cm-modal' + (cls ? ' ' + cls : '') }, ...children);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  return overlay;
}

/* ----------------------------- 主入口 ----------------------------- */

/**
 * 构建社区子视图（论坛 或 资讯）并挂到 mount 容器。
 *
 * 两个视图共用同一份实现：view === 'forum' 时只建论坛区（无资讯区、无 subtab），
 * view === 'news' 时只建资讯区（含分类 chip、列表、「最近更新 HH:MM」戳）。
 *
 * @param {{mount: HTMLElement, view: 'forum'|'news'}} opts
 * @returns {{root: HTMLElement, activate: Function, deactivate: Function}}
 */
function createCommunityView({ mount, view } = {}) {
  const isForum = view === 'forum';
  let currentForumCat = '';
  let currentNewsCat = '';
  let newsTimer = null;
  let lastUpdated = null;
  let forumLoaded = false; // 论坛只首次进入时拉一次，切回来不重复请求

  /* ---- 论坛区（仅 forum 视图构建） ---- */
  let forumChips = null;
  let forumListEl = null;
  let forumDetailEl = null;
  let forumSection = null;

  if (isForum) {
    const postBtn = el('button', { class: 'cm-btn-primary', onclick: openPostModal }, '发帖');
    forumChips = el('div', { class: 'cm-chips' });
    forumListEl = el('div', { class: 'cm-list' });
    forumDetailEl = el('div', { class: 'cm-detail cm-hidden' });
    forumSection = el(
      'div',
      { class: 'cm-section' },
      el(
        'div',
        { class: 'cm-toolbar' },
        el('div', { class: 'cm-toolbar__title' }, '论坛'),
        postBtn
      ),
      forumChips,
      forumListEl,
      forumDetailEl
    );
  }

  /* ---- 资讯区（仅 news 视图构建） ---- */
  let newsStamp = null;
  let newsChips = null;
  let newsListEl = null;
  let newsSection = null;

  if (!isForum) {
    newsStamp = el('span', { class: 'cm-news__stamp' }, '');
    newsChips = el('div', { class: 'cm-chips' });
    newsListEl = el('div', { class: 'cm-list' });
    newsSection = el(
      'div',
      { class: 'cm-section' },
      el(
        'div',
        { class: 'cm-toolbar' },
        el('div', { class: 'cm-toolbar__title' }, '资讯'),
        el('div', { class: 'cm-news__updated' }, '最近更新 ', newsStamp)
      ),
      newsChips,
      newsListEl
    );
  }

  const root = el('div', { class: 'community' }, isForum ? forumSection : newsSection);
  mount.appendChild(root);

  /* ---- 筛选 chip 渲染 ---- */
  function renderForumChips() {
    clear(forumChips);
    for (const [val, label] of FORUM_CATS) {
      const chip = el(
        'button',
        {
          class: `cm-chip${currentForumCat === val ? ' active' : ''}`,
          onclick: () => {
            currentForumCat = val;
            renderForumChips();
            loadForum();
          },
        },
        label
      );
      forumChips.appendChild(chip);
    }
  }
  function renderNewsChips() {
    clear(newsChips);
    for (const [val, label] of NEWS_CATS) {
      const chip = el(
        'button',
        {
          class: `cm-chip${currentNewsCat === val ? ' active' : ''}`,
          onclick: () => {
            currentNewsCat = val;
            renderNewsChips();
            loadNews();
          },
        },
        label
      );
      newsChips.appendChild(chip);
    }
  }
  if (isForum) renderForumChips();
  else renderNewsChips();

  /* ---- 论坛：列表 ---- */
  async function loadForum() {
    clear(forumListEl);
    setLoading(forumListEl, true);
    const { ok, data } = await apiGet(
      `/api/forum/topics?category=${encodeURIComponent(currentForumCat)}&page=1`
    );
    setLoading(forumListEl, false);
    if (!ok) {
      forumListEl.appendChild(el('div', { class: 'cm-empty' }, '加载失败，请稍后重试'));
      return;
    }
    const topics = data.topics || [];
    if (!topics.length) {
      forumListEl.appendChild(el('div', { class: 'cm-empty' }, '还没有帖子，来发第一帖吧'));
      return;
    }
    for (const t of topics) forumListEl.appendChild(renderTopicCard(t));
  }

  function renderTopicCard(t) {
    const card = el('div', { class: 'cm-card cm-topic' });
    card.appendChild(el('div', { class: 'cm-topic__title' }, t.title || '(无标题)'));
    const media = Array.isArray(t.media) ? t.media : [];
    if (media.length) {
      const strip = el('div', { class: 'cm-topic__media' });
      media.slice(0, 3).forEach((m) => {
        strip.appendChild(
          m.type === 'video'
            ? el('video', { class: 'cm-topic__media-thumb', src: m.url, muted: true, playsinline: '' })
            : el('img', { class: 'cm-topic__media-thumb', src: m.url, alt: '', loading: 'lazy' })
        );
      });
      if (media.length > 3) strip.appendChild(el('div', { class: 'cm-topic__media-more' }, `+${media.length - 3}`));
      card.appendChild(strip);
    }
    const meta = el('div', { class: 'cm-topic__meta' });
    meta.appendChild(el('span', { class: `cm-tag cm-tag--${t.category}` }, forumCatLabel(t.category)));
    meta.appendChild(el('span', { class: 'cm-meta__author' }, `@${t.username || '匿名'}`));
    meta.appendChild(el('span', { class: 'cm-meta__time' }, relativeTime(t.createdAt)));
    const locText = locationLabel(t.location);
    if (locText) meta.appendChild(el('span', { class: 'cm-meta__loc' }, locText));
    meta.appendChild(el('span', { class: 'cm-meta__reply' }, `💬 ${t.replyCount || 0}`));
    const me = currentUser();
    if (me && String(me.id) === String(t.uid)) {
      meta.appendChild(
        el(
          'button',
          {
            class: 'cm-meta__del',
            type: 'button',
            title: '删除我的帖子',
            onclick: (e) => {
              e.stopPropagation();
              deleteOwnTopic(t.id, false);
            },
          },
          '删除'
        )
      );
    }
    card.appendChild(meta);
    card.addEventListener('click', () => openTopic(t.id));
    return card;
  }

  /* ---- 论坛：删除自己的帖子 / 回复 ---- */
  async function deleteOwnTopic(id, fromDetail) {
    const confirmed = await confirmDelete(
      '确定删除这篇帖子吗？删除后不可恢复，帖子下的所有回复也会一并删除。'
    );
    if (!confirmed) return;
    const { status, data } = await apiDelete(`/api/forum/topics/${encodeURIComponent(id)}`);
    if (status === 401) {
      showAuthOverlay(() => deleteOwnTopic(id, fromDetail));
      return;
    }
    if (!status || status >= 400) {
      alert(data?.error || '删除失败');
      return;
    }
    if (fromDetail) backToList();
    loadForum();
  }

  async function deleteOwnReply(id, topicId) {
    const confirmed = await confirmDelete('确定删除这条回复吗？删除后不可恢复。');
    if (!confirmed) return;
    const { status, data } = await apiDelete(`/api/forum/replies/${encodeURIComponent(id)}`);
    if (status === 401) {
      showAuthOverlay(() => deleteOwnReply(id, topicId));
      return;
    }
    if (!status || status >= 400) {
      alert(data?.error || '删除失败');
      return;
    }
    openTopic(topicId); // 重新拉取详情，显示更新后的回复列表
  }

  /* ---- 论坛：详情 ---- */
  async function openTopic(id) {
    forumListEl.classList.add('cm-hidden');
    forumDetailEl.classList.remove('cm-hidden');
    clear(forumDetailEl);
    setLoading(forumDetailEl, true);
    const { ok, data } = await apiGet(`/api/forum/topics/${encodeURIComponent(id)}`);
    setLoading(forumDetailEl, false);
    if (!ok || !data.topic) {
      forumDetailEl.appendChild(el('div', { class: 'cm-empty' }, data.error || '主题不存在'));
      return;
    }
    renderTopicDetail(data.topic);
  }

  function backToList() {
    forumDetailEl.classList.add('cm-hidden');
    forumListEl.classList.remove('cm-hidden');
  }

  function renderTopicDetail(topic) {
    const me = currentUser();
    const back = el('button', { class: 'cm-back', onclick: backToList }, '← 返回列表');
    const headChildren = [
      el('div', { class: 'cm-detail__title' }, topic.title || '(无标题)'),
      el(
        'div',
        { class: 'cm-topic__meta' },
        el('span', { class: `cm-tag cm-tag--${topic.category}` }, forumCatLabel(topic.category)),
        el('span', { class: 'cm-meta__author' }, `@${topic.username || '匿名'}`),
        el('span', { class: 'cm-meta__time' }, relativeTime(topic.createdAt))
      ),
    ];
    if (me && String(me.id) === String(topic.uid)) {
      headChildren.push(
        el(
          'button',
          {
            class: 'cm-detail__del',
            type: 'button',
            title: '删除我的帖子',
            onclick: () => deleteOwnTopic(topic.id, true),
          },
          '删除帖子'
        )
      );
    }
    const head = el('div', { class: 'cm-detail__head' }, ...headChildren);
    const body = el('div', { class: 'cm-detail__body' }, topic.body || '');

    /* 定位信息（仅省级 / 国级，保护隐私：服务器从不收到精确坐标） */
    let locBox = null;
    const locText = locationLabel(topic.location);
    if (locText) {
      locBox = el('div', { class: 'cm-detail__loc' }, locText);
    }
    /* 媒体九宫格：图片 + 视频（video 带控件，移动端可播放） */
    let mediaBox = null;
    const media = Array.isArray(topic.media) ? topic.media : [];
    if (media.length) {
      const grid = el('div', { class: 'cm-detail__media' });
      media.forEach((m) => {
        grid.appendChild(
          m.type === 'video'
            ? el('video', { class: 'cm-detail__video', src: m.url, controls: true, playsinline: '' })
            : el('img', { class: 'cm-detail__img', src: m.url, alt: '', loading: 'lazy' })
        );
      });
      mediaBox = grid;
    }

    const repliesTitle = el(
      'div',
      { class: 'cm-replies__title' },
      `回复（${topic.replies ? topic.replies.length : 0}）`
    );
    const repliesBox = el('div', { class: 'cm-replies' });
    const replies = topic.replies || [];
    if (!replies.length) {
      repliesBox.appendChild(el('div', { class: 'cm-empty cm-empty--sm' }, '还没有回复，来抢沙发'));
    } else {
      for (const r of replies) {
        const item = el('div', { class: 'cm-reply' });
        const metaChildren = [
          el('span', { class: 'cm-meta__author' }, `@${r.username || '匿名'}`),
          el('span', { class: 'cm-meta__time' }, relativeTime(r.createdAt)),
        ];
        if (me && String(me.id) === String(r.uid)) {
          metaChildren.push(
            el(
              'button',
              {
                class: 'cm-meta__del',
                type: 'button',
                title: '删除我的回复',
                onclick: (e) => {
                  e.stopPropagation();
                  deleteOwnReply(r.id, topic.id);
                },
              },
              '删除'
            )
          );
        }
        item.appendChild(el('div', { class: 'cm-reply__meta' }, ...metaChildren));
        item.appendChild(el('div', { class: 'cm-reply__body' }, r.body || ''));
        repliesBox.appendChild(item);
      }
    }

    /* 评论框 */
    const ta = el('textarea', {
      class: 'cm-textarea',
      placeholder: isLoggedIn() ? '写下你的评论…' : '写下你的评论…（登录后发表）',
      rows: '3',
    });
    const err = el('div', { class: 'cm-comment__err' });
    const sendBtn = el('button', { class: 'cm-btn-primary' }, '发表评论');
    sendBtn.addEventListener('click', () => submitReply(topic, ta, err));
    const commentBox = el('div', { class: 'cm-comment' }, ta, err, sendBtn);

    forumDetailEl.appendChild(
      el('div', { class: 'cm-detail__inner' }, back, head, locBox, mediaBox, body, repliesTitle, repliesBox, commentBox)
    );
  }

  async function submitReply(topic, ta, err) {
    const text = ta.value.trim();
    err.textContent = '';
    if (!text) {
      err.textContent = '评论内容不能为空';
      return;
    }
    requireLogin(async () => {
      err.textContent = '发送中…';
      const { ok, status, data } = await apiPost('/api/forum/replies', {
        topicId: topic.id,
        body: text,
      });
      if (status === 401) {
        err.textContent = '';
        showAuthOverlay(() => submitReply(topic, ta, err));
        return;
      }
      if (!ok) {
        err.textContent = data.error || '评论失败';
        return;
      }
      ta.value = '';
      err.textContent = '';
      openTopic(topic.id); // 重新拉取，显示新回复
    });
  }

  /* ---- 论坛：发帖弹窗 ---- */
  function openPostModal() {
    requireLogin(buildPostModal);
  }

  function buildPostModal() {
    const titleInput = el('input', {
      class: 'cm-input',
      type: 'text',
      placeholder: '标题（必填，最多 80 字）',
      maxlength: '80',
    });
    const catSelect = el(
      'select',
      { class: 'cm-select' },
      ...FORUM_CATS.filter(([v]) => v).map(([v, l]) => el('option', { value: v }, l))
    );
    catSelect.value = 'chat';
    const bodyArea = el('textarea', {
      class: 'cm-textarea',
      placeholder: '说点什么…（必填）',
      rows: '6',
    });

    /* 媒体（图片/视频）：移动端点击唤起相册/相机 */
    const picked = []; // { dataUrl, type, ext }
    const fileInput = el('input', { type: 'file', accept: 'image/*,video/*', multiple: true, style: 'display:none' });
    const previewBox = el('div', { class: 'cm-media-preview' });
    const addMediaBtn = el('button', { class: 'cm-media-add', type: 'button', onclick: () => fileInput.click() }, '📷 添加图片 / 视频');
    const mediaBox = el('div', { class: 'cm-media' }, addMediaBtn, previewBox, fileInput);
    function renderPreviews() {
      clear(previewBox);
      picked.forEach((m, i) => {
        const thumb = m.type === 'video'
          ? el('video', { class: 'cm-media__thumb', src: m.dataUrl, muted: true, playsinline: '' })
          : el('img', { class: 'cm-media__thumb', src: m.dataUrl, alt: '' });
        const rm = el('button', { class: 'cm-media__rm', type: 'button', title: '移除', onclick: () => { picked.splice(i, 1); renderPreviews(); } }, '×');
        previewBox.appendChild(el('div', { class: 'cm-media__item' }, thumb, rm));
      });
    }
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      for (const f of files) {
        if (picked.length >= 9) break;
        try {
          const prep = await prepareMediaFile(f);
          picked.push({ dataUrl: prep.dataUrl, type: prep.type, ext: prep.ext });
        } catch {
          /* 跳过读取失败的文件 */
        }
      }
      fileInput.value = '';
      renderPreviews();
    });

    /* 定位：触发位置权限 */
    let loc = null;
    const locBtn = el('button', { class: 'cm-loc-btn', type: 'button' }, '📍 添加位置');
    const locText = el('span', { class: 'cm-loc-text' }, '');
    function renderLoc() {
      locText.textContent = '';
      if (loc) {
        const label = loc.region ? `📍 ${loc.region}` : (loc.country ? `🌐 ${loc.country}` : '已定位');
        locText.textContent = `已定位：${label}`;
        locBtn.textContent = '移除位置';
      } else {
        locBtn.textContent = '📍 添加位置';
      }
    }
    locBtn.addEventListener('click', () => {
      if (loc) {
        loc = null;
        renderLoc();
        return;
      }
      if (!navigator.geolocation) {
        locText.textContent = '当前设备不支持定位';
        return;
      }
      locBtn.textContent = '定位中…';
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          // 隐私原则：仅把经纬度本地逆地理成「省 / 国」标签，绝不上传精确坐标
          locBtn.textContent = '解析位置…';
          try {
            loc = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
          } catch {
            loc = { region: null, country: '海外' };
          }
          renderLoc();
        },
        (err) => {
          locText.textContent = '定位失败：' + (err && err.message ? err.message : '已拒绝或不可用');
          locBtn.textContent = '📍 重试定位';
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
    const locBox = el('div', { class: 'cm-loc' }, locBtn, locText);

    const errEl = el('div', { class: 'cm-modal__err' });
    const submit = el('button', { class: 'cm-btn-primary' }, '发布');

    submit.addEventListener('click', async () => {
      const title = titleInput.value.trim();
      const bodyText = bodyArea.value.trim();
      if (!title || !bodyText) {
        errEl.textContent = '标题和正文都不能为空';
        return;
      }
      submit.disabled = true;
      submit.textContent = '发布中…';
      errEl.textContent = '';
      /* 先逐张上传媒体，拿到站内 URL */
      const media = [];
      for (let i = 0; i < picked.length; i++) {
        errEl.textContent = `上传媒体 ${i + 1}/${picked.length}…`;
        const up = await apiUploadForumMedia(picked[i].dataUrl, picked[i].ext);
        if (!up.ok) {
          errEl.textContent = up.data?.error || '媒体上传失败';
          submit.disabled = false;
          submit.textContent = '发布';
          return;
        }
        media.push({ type: up.data?.kind || picked[i].type, url: up.data?.url });
      }
      const { ok, status, data } = await apiPost('/api/forum/topics', {
        title,
        body: bodyText,
        category: catSelect.value,
        media,
        location: loc || undefined,
      });
      if (status === 401) {
        overlay.remove();
        showAuthOverlay(() => buildPostModal());
        return;
      }
      if (!ok) {
        errEl.textContent = data.error || '发布失败';
        submit.disabled = false;
        submit.textContent = '发布';
        return;
      }
      overlay.remove();
      currentForumCat = '';
      renderForumChips();
      forumListEl.classList.remove('cm-hidden');
      forumDetailEl.classList.add('cm-hidden');
      loadForum();
    });

    const overlay = buildModal({
      title: '发帖',
      bodyNodes: [titleInput, catSelect, bodyArea, mediaBox, locBox, errEl],
      footerNodes: [
        el('button', { class: 'cm-btn-ghost', onclick: () => overlay.remove() }, '取消'),
        submit,
      ],
    });
    setTimeout(() => titleInput.focus(), 30);
  }

  /* ---- 资讯：列表 + 轮询 ---- */
  function updateNewsStamp() {
    newsStamp.textContent = lastUpdated ? formatHM(lastUpdated) : '—';
  }

  async function loadNews() {
    const { ok, data } = await apiGet(
      `/api/news?category=${encodeURIComponent(currentNewsCat)}`
    );
    lastUpdated = Date.now();
    updateNewsStamp();
    clear(newsListEl);
    if (!ok) {
      newsListEl.appendChild(el('div', { class: 'cm-empty' }, '加载失败'));
      return;
    }
    const items = data.news || [];
    if (!items.length) {
      newsListEl.appendChild(el('div', { class: 'cm-empty' }, '暂无资讯'));
      return;
    }
    for (const n of items) newsListEl.appendChild(renderNewsCard(n));
  }

  function renderNewsCard(n) {
    const card = el('div', { class: 'cm-card cm-news', tabindex: '0', role: 'button', title: '点击查看资讯详情' });
    if (n.cover) {
      card.appendChild(
        el('img', { class: 'cm-news__cover', src: n.cover, alt: n.title || '', loading: 'lazy' })
      );
    }
    card.appendChild(el('div', { class: `cm-news__cat cm-news__cat--${n.category}` }, newsCatLabel(n.category)));
    card.appendChild(el('div', { class: 'cm-news__title' }, n.title || ''));
    if (n.summary) card.appendChild(el('div', { class: 'cm-news__summary' }, n.summary));
    const meta = el('div', { class: 'cm-news__meta' });
    meta.appendChild(el('span', {}, n.source || ''));
    meta.appendChild(el('span', {}, relativeTime(n.publishedAt)));
    card.appendChild(meta);
    card.appendChild(el('div', { class: 'cm-news__more' }, '阅读全文 →'));
    const open = () => openNewsDetail(n);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    return card;
  }

  const NEWS_LINK_MARK = '—— 原文：';

  /** 点开资讯详情：完整正文 + 封面图 + 图集 + 视频 + 阅读原文 */
  function openNewsDetail(n) {
    const rawBody = String(n.body || '');
    let articleBody = rawBody;
    let origLink = '';
    const idx = rawBody.indexOf(NEWS_LINK_MARK);
    if (idx >= 0) {
      articleBody = rawBody.slice(0, idx).trim();
      origLink = rawBody.slice(idx + NEWS_LINK_MARK.length).trim().split(/\s+/)[0] || '';
    }
    const paras = articleBody.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

    const media = Array.isArray(n.media) ? n.media : [];
    const cover = n.cover || '';
    const galleryImgs = media
      .filter((m) => m && m.type === 'image' && m.url && m.url !== cover)
      .map((m) => m.url);
    const videos = media.filter((m) => m && m.type === 'video');

    const bodyNodes = [];
    const meta = el('div', { class: 'cm-news-detail__meta' });
    meta.appendChild(el('span', { class: `cm-news__cat cm-news__cat--${n.category}` }, newsCatLabel(n.category)));
    meta.appendChild(el('span', {}, n.source || ''));
    meta.appendChild(el('span', {}, relativeTime(n.publishedAt)));
    bodyNodes.push(meta);

    if (cover) {
      bodyNodes.push(el('img', { class: 'cm-news-detail__cover', src: cover, alt: n.title || '', loading: 'lazy' }));
    }
    for (const p of paras) bodyNodes.push(el('p', { class: 'cm-news-detail__p' }, p));
    if (!paras.length) {
      bodyNodes.push(el('p', { class: 'cm-news-detail__p' }, n.summary || '（暂无正文）'));
    }
    if (galleryImgs.length) {
      const gal = el('div', { class: 'cm-news-detail__gallery' });
      for (const u of galleryImgs) {
        gal.appendChild(el('img', { class: 'cm-news-detail__img', src: u, alt: '', loading: 'lazy' }));
      }
      bodyNodes.push(gal);
    }
    for (const v of videos) {
      if (v.youtubeId) {
        bodyNodes.push(
          el('iframe', {
            class: 'cm-news-detail__video',
            src: v.url,
            title: '视频',
            loading: 'lazy',
            allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
            allowfullscreen: true,
            frameborder: '0',
          })
        );
        bodyNodes.push(
          el('a', { class: 'cm-news-detail__videolink', href: `https://www.youtube.com/watch?v=${v.youtubeId}`, target: '_blank', rel: 'noopener' }, '▶ 在 YouTube 观看')
        );
      } else if (v.url) {
        bodyNodes.push(el('video', { class: 'cm-news-detail__video', src: v.url, controls: true, preload: 'none' }));
      }
    }

    const footerNodes = [];
    if (origLink) {
      footerNodes.push(
        el('a', { class: 'cm-news-detail__readmore', href: origLink, target: '_blank', rel: 'noopener' }, '阅读原文 ↗')
      );
    }
    const overlay = buildModal({
      title: n.title || '资讯详情',
      bodyNodes,
      footerNodes,
      cls: 'cm-news-detail',
    });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  }

  function startNewsPolling() {
    stopNewsPolling();
    loadNews();
    newsTimer = setInterval(loadNews, 30000);
  }
  function stopNewsPolling() {
    if (newsTimer) {
      clearInterval(newsTimer);
      newsTimer = null;
    }
  }

  /* ---- 生命周期（由车库分页导航 setPage / hide / pause 调用） ---- */
  function activate() {
    if (isForum) {
      // 首次进来拉一次就够；发帖/回复会主动重载，不做轮询
      if (!forumLoaded) {
        forumLoaded = true;
        loadForum();
      }
      return;
    }
    startNewsPolling();
  }

  function deactivate() {
    // 论坛无定时器，空实现保留语义；资讯必须停轮询
    stopNewsPolling();
  }

  return { root, activate, deactivate };
}

/**
 * 论坛视图（车库顶层「论坛」分页）。
 * @param {{mount: HTMLElement}} opts
 * @returns {{activate: Function, deactivate: Function}}
 */
export function createForum({ mount } = {}) {
  return createCommunityView({ mount, view: 'forum' });
}

/**
 * 资讯视图（车库顶层「资讯」分页，含分类 chip 与 30s 轮询）。
 * @param {{mount: HTMLElement}} opts
 * @returns {{activate: Function, deactivate: Function}}
 */
export function createNews({ mount } = {}) {
  return createCommunityView({ mount, view: 'news' });
}
