/**
 * legalModal.js — 用户协议 / 社区守则 展示弹窗
 *
 * 协议正文放在 docs/legal/*.md（Markdown 源），便于运营方直接编辑、
 * 也便于交给律师审阅修改——不必改动任何 JS。
 * 这里用 Vite 的 ?raw 导入原始文本，再用一个极简渲染器转成 HTML。
 *
 * 只支持协议里实际用到的那几种语法（标题、引用、有序/无序列表、粗体、
 * 水平线、代码块），不做通用 Markdown 解析——够用且没有 XSS 注入面
 * （内容来自本仓库文件，但仍做了 HTML 转义）。
 */

import './legal.css';
import agreementMd from '../../docs/legal/USER-AGREEMENT.md?raw';
import guidelinesMd from '../../docs/legal/COMMUNITY-GUIDELINES.md?raw';

/** HTML 转义，避免正文里的 < > & 破坏结构 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 行内样式：**加粗** */
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * 极简 Markdown → HTML。
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  // 逐行解析前先做一次预处理：把跨行的 **加粗** 折叠成一行。
  // 否则 "**这是一段\n很长的强调**" 会被拆成两行，两半各剩一个孤立的 **，
  // 最终以裸 `**` 的形式显示给用户（实测协议里有 9 处这类跨行加粗）。
  const normalized = String(md || '').replace(
    /\*\*([\s\S]+?)\*\*/g,
    (_m, inner) => `**${inner.replace(/\s*\n\s*/g, ' ')}**`
  );

  const lines = normalized.split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol' | null
  let inQuote = false;
  let inCode = false;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // 代码块（协议里用于占位符说明）
    if (line.startsWith('```')) {
      closeList();
      closeQuote();
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      continue;
    }

    // 水平线
    if (/^-{3,}$/.test(line.trim())) {
      closeList();
      closeQuote();
      out.push('<hr/>');
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      closeQuote();
      const lv = Math.min(h[1].length, 4);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }

    // 引用。注意要连"只有一个 > 的空行"也一起吃掉——否则引用块内部的空行
    // 会漏到下面的普通段落分支，渲染成一个孤零零的 "&gt;" 段落。
    if (line.startsWith('>')) {
      closeList();
      if (!inQuote) {
        out.push('<blockquote>');
        inQuote = true;
      }
      const text = line.slice(1).trim();
      if (text) out.push(`<p>${inline(text)}</p>`);
      continue;
    }
    closeQuote();

    // 列表
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();

    // 空行分段
    if (!line.trim()) continue;

    out.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  closeQuote();
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

export const LEGAL_DOCS = {
  agreement: { title: '用户协议', body: agreementMd },
  guidelines: { title: '社区内容守则', body: guidelinesMd },
};

let activeEl = null;

/**
 * 打开协议弹窗。
 * @param {'agreement'|'guidelines'} which
 */
export function openLegalModal(which = 'agreement') {
  closeLegalModal();
  const doc = LEGAL_DOCS[which];
  if (!doc) return;

  const body = document.createElement('div');
  body.className = 'legal-body';
  body.innerHTML = renderMarkdown(doc.body);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'legal-head__close';
  closeBtn.type = 'button';
  closeBtn.title = '关闭';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeLegalModal);

  const head = document.createElement('div');
  head.className = 'legal-head';
  const title = document.createElement('h2');
  title.className = 'legal-head__title';
  title.textContent = doc.title;
  head.append(title, closeBtn);

  const modal = document.createElement('div');
  modal.className = 'legal-modal';
  modal.append(head, body);

  const overlay = document.createElement('div');
  overlay.className = 'legal-overlay';
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeLegalModal();
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-open'));

  const onKey = (e) => {
    if (e.key === 'Escape') closeLegalModal();
  };
  document.addEventListener('keydown', onKey);
  overlay._onKey = onKey;

  // 打开时定位到顶部
  body.scrollTop = 0;
  activeEl = overlay;
}

export function closeLegalModal() {
  if (!activeEl) return;
  if (activeEl._onKey) document.removeEventListener('keydown', activeEl._onKey);
  activeEl.remove();
  activeEl = null;
}
