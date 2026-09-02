/**
 * copilotPanel.js — 「改装工程师」侧边对话面板
 *
 * 职责编排：
 *   1. 收集输入（文本 or 语音转写）
 *   2. 附带当前车况快照调 /api/copilot
 *   3. 展示助手文字
 *   4. 执行工具调用 → 3D 场景实时变化 + 面板滑杆同步
 *   5. 语音播报（可在头部关闭）
 *
 * 设计约束：
 *   · 语音不是唯一入口——Safari 等浏览器识别不可用，必须保留文本输入
 *   · 工具执行结果对用户可见（回执气泡），让用户知道"它到底改了什么"
 *   · 快捷指令降低使用门槛，也顺带示范"该怎么跟它说话"
 */

import './copilot.css';
import { createTools, runToolCalls, specsSnapshot } from '../copilot/tools.js';
import { createRecognizer, speak, stopSpeaking, RECOGNITION_SUPPORTED, SYNTHESIS_SUPPORTED } from '../copilot/voice.js';

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

/** 快捷指令：降低使用门槛，也示范话术 */
const QUICK_PROMPTS = [
  '来个低趴姿态',
  '轮毂齐平翼子板',
  'HellaFlush 风格',
  '换 20 寸轮毂',
  '车漆改哑光黑',
  '看看现在的规格',
];

/**
 * 创建面板。
 *
 * @param {object} o
 * @param {object} o.app   main.js 的 app 实例
 * @param {object} o.panel panel.js 的面板实例（syncAll）
 * @returns {{root: HTMLElement, dispose: ()=>void}}
 */
export function createCopilotPanel({ app, panel }) {
  const tools = createTools(app, panel);

  const messages = [];        // 发给模型的对话历史
  let busy = false;           // 是否正在等待模型
  let speakerOn = SYNTHESIS_SUPPORTED;
  let recognizer = null;
  let interimText = '';       // 语音临时结果

  /* ---------------- 消息渲染 ---------------- */

  const logEl = el('div', { class: 'cop-log' });

  function scrollToBottom() {
    requestAnimationFrame(() => {
      logEl.scrollTop = logEl.scrollHeight;
    });
  }

  function bubble(role, text) {
    const b = el('div', { class: `cop-msg cop-msg--${role}` }, text);
    logEl.appendChild(b);
    scrollToBottom();
    return b;
  }

  /** 工具执行回执：让用户看见"它改了什么" */
  function receipt(results) {
    if (!results.length) return;
    const items = results.map((r) => {
      const icon = r.ok ? '已改' : '失败';
      return el(
        'li',
        { class: `cop-recv__item ${r.ok ? 'is-ok' : 'is-bad'}` },
        el('span', { class: 'cop-recv__tag' }, icon),
        el('span', { class: 'cop-recv__text' }, r.message || r.name)
      );
    });
    logEl.appendChild(
      el('div', { class: 'cop-msg cop-msg--tool' },
        el('div', { class: 'cop-recv__title' }, '改装动作'),
        el('ul', { class: 'cop-recv' }, ...items))
    );
    scrollToBottom();
  }

  function typing() {
    const b = el('div', { class: 'cop-msg cop-msg--assistant cop-typing' },
      el('span', { class: 'cop-dot' }), el('span', { class: 'cop-dot' }), el('span', { class: 'cop-dot' }));
    logEl.appendChild(b);
    scrollToBottom();
    return b;
  }

  /* ---------------- 核心流程 ---------------- */

  async function send(text) {
    const t = (text || '').trim();
    if (!t || busy) return;

    bubble('user', t);
    messages.push({ role: 'user', content: t });
    setBusy(true);

    const wait = typing();
    try {
      const res = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, specs: specsSnapshot(app) }),
      });
      const data = await res.json();
      wait.remove();

      if (!data.available) {
        const why = {
          'no-key': '还没配置大模型 key，助手暂时没法工作。',
          auth: '大模型 key 失效或没有权限。',
          error: `调用出错：${data.detail || '未知原因'}`,
        }[data.reason] || '助手暂时不可用。';
        bubble('assistant', why);
        return;
      }

      // 助手的文字解释
      const content = (data.content || '').trim();
      if (content) {
        bubble('assistant', content);
        messages.push({ role: 'assistant', content });
        if (speakerOn) speak(content);
      }

      // 执行工具调用
      const calls = data.toolCalls || [];
      if (calls.length) {
        const results = runToolCalls(tools, calls);
        receipt(results);
        // 工具结果回填给模型，让它知道执行是否成功（下一轮能据此调整）
        messages.push({
          role: 'assistant',
          content: `[工具执行结果] ${results.map((r) => `${r.name}: ${r.ok ? '成功' : '失败'} - ${r.message}`).join(' | ')}`,
        });
      }
    } catch (e) {
      wait.remove();
      bubble('assistant', `网络请求失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    micBtn.disabled = v || !RECOGNITION_SUPPORTED;
    root.classList.toggle('is-busy', v);
  }

  /* ---------------- 语音 ---------------- */

  function setupVoice() {
    if (!RECOGNITION_SUPPORTED) {
      micBtn.title = '当前浏览器不支持语音识别，请用文字输入';
      micBtn.classList.add('is-off');
      return;
    }
    recognizer = createRecognizer({
      onResult: (text, isFinal) => {
        if (isFinal) {
          interimText = '';
          input.value = text;
          input.classList.remove('is-interim');
          // 说完自动发送，符合"对话"直觉
          send(text);
        } else {
          interimText = text;
          input.value = text;
          input.classList.add('is-interim');
        }
      },
      onError: (err) => {
        micBtn.classList.remove('is-listening');
        bubble('assistant', err.message);
      },
      onEnd: () => {
        micBtn.classList.remove('is-listening');
      },
    });
  }

  function toggleMic() {
    if (!recognizer) return;
    if (micBtn.classList.contains('is-listening')) {
      recognizer.stop();
      micBtn.classList.remove('is-listening');
    } else {
      stopSpeaking();
      micBtn.classList.add('is-listening');
      recognizer.start();
    }
  }

  /* ---------------- DOM ---------------- */

  const input = el('input', {
    class: 'cop-input',
    type: 'text',
    placeholder: RECOGNITION_SUPPORTED ? '说点什么，或点麦克风…' : '描述你想要的改装效果…',
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = input.value;
        input.value = '';
        send(v);
      }
    },
  });

  const sendBtn = el('button', {
    class: 'cop-send',
    type: 'button',
    title: '发送',
    onClick: () => {
      const v = input.value;
      input.value = '';
      send(v);
    },
  }, '发送');

  const micBtn = el('button', {
    class: 'cop-mic',
    type: 'button',
    title: '点击说话',
    onClick: toggleMic,
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>',
  });

  const speakerBtn = el('button', {
    class: `cop-speaker ${speakerOn ? 'is-on' : 'is-off'}`,
    type: 'button',
    title: speakerOn ? '关闭语音播报' : '开启语音播报',
    onClick: () => {
      speakerOn = !speakerOn;
      if (!speakerOn) stopSpeaking();
      speakerBtn.classList.toggle('is-on', speakerOn);
      speakerBtn.classList.toggle('is-off', !speakerOn);
      speakerBtn.title = speakerOn ? '关闭语音播报' : '开启语音播报';
    },
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
  });

  const quickRow = el(
    'div',
    { class: 'cop-quick' },
    ...QUICK_PROMPTS.map((q) =>
      el('button', {
        class: 'cop-quick__btn',
        type: 'button',
        onClick: () => send(q),
      }, q)
    )
  );

  const root = el(
    'aside',
    { class: 'cop-panel' },
    el('div', { class: 'cop-head' },
      el('div', { class: 'cop-head__title' },
        el('span', { class: 'cop-head__dot' }),
        '改装工程师'),
      el('div', { class: 'cop-head__acts' }, speakerBtn)),
    logEl,
    quickRow,
    el('div', { class: 'cop-bar' }, input, micBtn, sendBtn)
  );

  // 开场白：告诉用户它能干什么
  bubble('assistant', '我在旁边看着呢。想改什么直接说——比如「轮毂换20寸，ET 25」「来个低趴姿态」「车漆改哑光黑」。说完我直接给你改上去。');

  setupVoice();
  setBusy(false);

  return {
    root,
    dispose() {
      stopSpeaking();
      recognizer?.abort?.();
    },
  };
}
