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

import { authFetch, isLoggedIn } from '../auth.js';
import { showAuthOverlay } from './auth.js';

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

/** 未登录则弹登录浮层，登录成功（或已登录）后执行 then */
function requireLogin(then) {
  if (isLoggedIn()) {
    then();
    return;
  }
  showAuthOverlay(() => then());
}

/* ----------------------------- 通用模态框 ----------------------------- */

function buildModal({ title, bodyNodes, footerNodes }) {
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
  const box = el('div', { class: 'cm-modal' }, ...children);
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
    const meta = el('div', { class: 'cm-topic__meta' });
    meta.appendChild(el('span', { class: `cm-tag cm-tag--${t.category}` }, forumCatLabel(t.category)));
    meta.appendChild(el('span', { class: 'cm-meta__author' }, `@${t.username || '匿名'}`));
    meta.appendChild(el('span', { class: 'cm-meta__time' }, relativeTime(t.createdAt)));
    meta.appendChild(el('span', { class: 'cm-meta__reply' }, `💬 ${t.replyCount || 0}`));
    card.appendChild(meta);
    card.addEventListener('click', () => openTopic(t.id));
    return card;
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
    const back = el('button', { class: 'cm-back', onclick: backToList }, '← 返回列表');
    const head = el(
      'div',
      { class: 'cm-detail__head' },
      el('div', { class: 'cm-detail__title' }, topic.title || '(无标题)'),
      el(
        'div',
        { class: 'cm-topic__meta' },
        el('span', { class: `cm-tag cm-tag--${topic.category}` }, forumCatLabel(topic.category)),
        el('span', { class: 'cm-meta__author' }, `@${topic.username || '匿名'}`),
        el('span', { class: 'cm-meta__time' }, relativeTime(topic.createdAt))
      )
    );
    const body = el('div', { class: 'cm-detail__body' }, topic.body || '');

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
        item.appendChild(
          el(
            'div',
            { class: 'cm-reply__meta' },
            el('span', { class: 'cm-meta__author' }, `@${r.username || '匿名'}`),
            el('span', { class: 'cm-meta__time' }, relativeTime(r.createdAt))
          )
        );
        item.appendChild(el('div', { class: 'cm-reply__body' }, r.body || ''));
        repliesBox.appendChild(item);
      }
    }

    /* 评论框 */
    const ta = el('textarea', {
      class: 'cm-textarea',
      placeholder: '写下你的评论…（登录后发表）',
      rows: '3',
    });
    const err = el('div', { class: 'cm-comment__err' });
    const sendBtn = el('button', { class: 'cm-btn-primary' }, '发表评论');
    sendBtn.addEventListener('click', () => submitReply(topic, ta, err));
    const commentBox = el('div', { class: 'cm-comment' }, ta, err, sendBtn);

    forumDetailEl.appendChild(
      el('div', { class: 'cm-detail__inner' }, back, head, body, repliesTitle, repliesBox, commentBox)
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
      const { ok, status, data } = await apiPost('/api/forum/topics', {
        title,
        body: bodyText,
        category: catSelect.value,
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
      bodyNodes: [titleInput, catSelect, bodyArea, errEl],
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
    const card = el('div', { class: 'cm-card cm-news' });
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
    return card;
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
