/**
 * auth.js (UI) — 登录 / 注册浮层
 *
 * 与 auth.js（状态管理）配合：本模块只负责渲染浮层、收集输入、调用 register/login/phoneLogin，
 * 成功后通过回调通知上层（main.js）刷新门禁；失败在浮层内就地提示。
 *
 * 登录方式（顶部 Tab 切换）：
 *   · 账号密码：用户名/邮箱 + 密码，含注册（含协议勾选）。
 *   · 手机号：  手机号 + 短信验证码，验证码登录/注册二合一（手机号不存在自动注册）。
 *
 * 设计：单例浮层，首次需要时挂载到 body，重复调用只切换模式而不重建。
 */

import './auth.css';
import { register, login, sendPhoneCode, phoneLogin } from '../auth.js';
import logoMarkUrl from '../assets/logo-mark-neon.png';
import { openLegalModal } from './legalModal.js';

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

let layer = null;
let onDone = null;

function buildLayer() {
  if (layer) return layer;

  const logo = el('img', { class: 'auth-card__logo', src: logoMarkUrl, alt: 'INSPIRE CAR' });
  const brandText = el(
    'div',
    { class: 'auth-card__brand-text' },
    el('h1', { class: 'auth-card__title' }, '灵感改装'),
    el('p', { class: 'auth-card__sub' }, 'INSPIRE CAR')
  );
  const brand = el('div', { class: 'auth-card__brand' }, logo, brandText);

  const heading = el('h2', { class: 'auth-card__heading' }, '登录');
  const hint = el('p', { class: 'auth-card__hint' }, '登录后即可查看你的改装方案');

  /* ---- 登录方式 Tab ---- */
  const tabPwd = el('button', { type: 'button', class: 'auth-tab', 'data-tab': 'password' }, '账号密码');
  const tabPhone = el('button', { type: 'button', class: 'auth-tab', 'data-tab': 'phone' }, '手机号');
  const tabRow = el('div', { class: 'auth-tabs' }, tabPwd, tabPhone);
  tabPwd.addEventListener('click', () => setTab('password'));
  tabPhone.addEventListener('click', () => setTab('phone'));

  /* ---- 账号密码区 ---- */
  const emailField = el(
    'div',
    { class: 'auth-field' },
    el('input', {
      class: 'auth-field__input',
      type: 'email',
      placeholder: '邮箱（注册时填写，可选）',
      autocomplete: 'email',
      'data-role': 'email',
    })
  );
  const nameField = el(
    'div',
    { class: 'auth-field' },
    el('input', {
      class: 'auth-field__input',
      type: 'text',
      placeholder: '用户名 / 邮箱',
      autocomplete: 'username',
      'data-role': 'login',
    })
  );
  const pwdField = el(
    'div',
    { class: 'auth-field' },
    el('input', {
      class: 'auth-field__input',
      type: 'password',
      placeholder: '密码（至少 6 位）',
      autocomplete: 'current-password',
      'data-role': 'password',
    })
  );
  const passwordFields = el('div', { class: 'auth-pwd-fields' }, emailField, nameField, pwdField);

  /* ---- 手机号区 ---- */
  const phoneField = el(
    'div',
    { class: 'auth-field' },
    el('input', {
      class: 'auth-field__input',
      type: 'tel',
      inputmode: 'numeric',
      maxlength: '11',
      placeholder: '手机号',
      autocomplete: 'tel',
      'data-role': 'phone',
    })
  );
  const codeField = el('input', {
    class: 'auth-field__input',
    type: 'text',
    inputmode: 'numeric',
    maxlength: '6',
    placeholder: '验证码（6 位）',
    autocomplete: 'one-time-code',
    'data-role': 'code',
  });
  const codeBtn = el('button', { type: 'button', class: 'auth-code-btn' }, '获取验证码');
  const codeRow = el('div', { class: 'auth-code-row' }, codeField, codeBtn);
  const phoneFields = el('div', { class: 'auth-phone-fields' }, phoneField, codeRow);
  codeBtn.addEventListener('click', () => void onSendCode());

  // 协议同意勾选（注册 / 手机号登录都需显式勾选——法律上的"明示同意"要件）
  const agreeBox = el(
    'label',
    { class: 'auth-agree', 'data-role': 'agree-box' },
    el('input', { type: 'checkbox', 'data-role': 'agree' }),
    el(
      'span',
      { class: 'auth-agree__text' },
      '我已阅读并同意',
      el('button', {
        type: 'button',
        class: 'auth-link',
        onClick: (e) => {
          e.preventDefault();
          openLegalModal('agreement');
        },
      }, '《用户协议》'),
      '和',
      el('button', {
        type: 'button',
        class: 'auth-link',
        onClick: (e) => {
          e.preventDefault();
          openLegalModal('guidelines');
        },
      }, '《社区内容守则》')
    )
  );

  const errorBox = el('p', { class: 'auth-error', style: 'display:none' });
  const infoBox = el('p', { class: 'auth-info', style: 'display:none' });
  const submit = el('button', { class: 'auth-submit', type: 'submit' }, '登录');
  const switchText = el('p', { class: 'auth-switch' });

  const form = el(
    'form',
    {
      class: 'auth-card__form',
      onSubmit: (e) => {
        e.preventDefault();
        void submitForm();
      },
    },
    passwordFields,
    phoneFields,
    agreeBox,
    errorBox,
    infoBox,
    submit,
    switchText
  );

  const card = el('div', { class: 'auth-card' }, brand, heading, hint, tabRow, form);
  layer = el('div', { class: 'auth-layer' }, card);
  document.body.appendChild(layer);

  // 内部状态
  layer._tab = 'password';
  layer._mode = 'login';
  layer._refs = {
    heading, hint, tabRow, tabPwd, tabPhone,
    emailField, nameField, pwdField, passwordFields,
    phoneField, codeField, codeBtn, phoneFields,
    agreeBox, errorBox, infoBox, submit, switchText,
  };

  render();
  return layer;
}

/* 单一渲染入口：根据 _tab / _mode 决定可见性与文案 */
function render() {
  const L = layer;
  const { heading, hint, tabPwd, tabPhone, emailField, nameField, pwdField, passwordFields,
    phoneField, codeBtn, phoneFields, agreeBox, errorBox, infoBox, submit, switchText } = L._refs;

  errorBox.style.display = 'none';
  infoBox.style.display = 'none';

  tabPwd.classList.toggle('is-active', L._tab === 'password');
  tabPhone.classList.toggle('is-active', L._tab === 'phone');
  const agreed = agreeBox.querySelector('input').checked;

  if (L._tab === 'phone') {
    passwordFields.style.display = 'none';
    phoneFields.style.display = '';
    switchText.style.display = 'none';
    agreeBox.style.display = '';
    heading.textContent = '手机号快捷登录';
    hint.textContent = '输入手机号获取验证码，一键登录或注册';
    submit.textContent = '登录 / 注册';
    // 切到手机号后重置验证码按钮文案（若不在倒计时中）
    if (!codeBtn._timer) codeBtn.textContent = '获取验证码';
    return;
  }

  // 账号密码 tab
  phoneFields.style.display = 'none';
  passwordFields.style.display = '';
  switchText.style.display = '';
  const mode = L._mode;
  agreeBox.style.display = mode === 'register' ? '' : 'none';

  if (mode === 'register') {
    heading.textContent = '注册账号';
    hint.textContent = '创建用户名与密码，保存你自己的改装方案';
    emailField.style.display = '';
    nameField.querySelector('input').setAttribute('autocomplete', 'username');
    nameField.querySelector('input').setAttribute('placeholder', '用户名（2–24 位）');
    pwdField.querySelector('input').setAttribute('autocomplete', 'new-password');
    pwdField.querySelector('input').setAttribute('placeholder', '设置密码（至少 6 位）');
    submit.textContent = '注册并登录';
    switchText.innerHTML = '';
    switchText.appendChild(document.createTextNode('已有账号？'));
    switchText.appendChild(el('button', { type: 'button', onClick: () => setMode('login') }, '去登录'));
    emailField.querySelector('input').focus();
  } else {
    heading.textContent = '登录';
    hint.textContent = '登录后即可查看你的改装方案';
    emailField.style.display = 'none';
    nameField.querySelector('input').setAttribute('autocomplete', 'username');
    nameField.querySelector('input').setAttribute('placeholder', '用户名 / 邮箱');
    pwdField.querySelector('input').setAttribute('autocomplete', 'current-password');
    pwdField.querySelector('input').setAttribute('placeholder', '密码');
    submit.textContent = '登录';
    switchText.innerHTML = '';
    switchText.appendChild(document.createTextNode('还没有账号？'));
    switchText.appendChild(el('button', { type: 'button', onClick: () => setMode('register') }, '去注册'));
    nameField.querySelector('input').focus();
  }
}

function setTab(tab) {
  if (layer._tab === tab) return;
  layer._tab = tab;
  render();
}
function setMode(mode) {
  layer._mode = mode;
  render();
}

function showError(msg) {
  const { errorBox, infoBox } = layer._refs;
  infoBox.style.display = 'none';
  errorBox.textContent = msg;
  errorBox.style.display = '';
}
function showInfo(msg, isDev = false) {
  const { errorBox, infoBox } = layer._refs;
  errorBox.style.display = 'none';
  infoBox.textContent = msg;
  infoBox.className = isDev ? 'auth-info auth-info--dev' : 'auth-info';
  infoBox.style.display = '';
}

/* 获取验证码 + 60s 倒计时 */
async function onSendCode() {
  const { phoneField, agreeBox, codeBtn, errorBox, infoBox } = layer._refs;
  const phone = phoneField.querySelector('input').value.trim();
  if (!agreeBox.querySelector('input').checked) {
    return showError('请先阅读并勾选同意《用户协议》和《社区内容守则》');
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return showError('请输入正确的手机号');
  }
  codeBtn.disabled = true;
  errorBox.style.display = 'none';
  infoBox.style.display = 'none';
  try {
    const r = await sendPhoneCode(phone);
    if (r.dev && r.code) {
      showInfo(`测试验证码：${r.code}（开发模式，生产环境由短信下发）`, true);
    } else {
      showInfo('验证码已发送，请查收短信');
    }
    startCountdown(codeBtn, 60);
  } catch (e) {
    showError(e.message || '发送失败，请重试');
    codeBtn.disabled = false;
  }
}

function startCountdown(btn, secs) {
  if (btn._timer) clearInterval(btn._timer);
  let left = secs;
  btn.textContent = `${left}s 后重发`;
  btn.disabled = true;
  btn._timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(btn._timer);
      btn._timer = null;
      btn.textContent = '获取验证码';
      btn.disabled = false;
    } else {
      btn.textContent = `${left}s 后重发`;
    }
  }, 1000);
}

async function submitForm() {
  const { emailField, nameField, pwdField, phoneField, codeField, agreeBox, submit } = layer._refs;
  const agreed = agreeBox.querySelector('input').checked;

  submit.disabled = true;
  try {
    let user;
    if (layer._tab === 'phone') {
      if (!agreed) return showError('请先阅读并勾选同意《用户协议》和《社区内容守则》');
      const phone = phoneField.querySelector('input').value.trim();
      const code = codeField.querySelector('input').value.trim();
      if (!/^1[3-9]\d{9}$/.test(phone)) return showError('请输入正确的手机号');
      if (!/^\d{6}$/.test(code)) return showError('请输入 6 位验证码');
      submit.textContent = '登录中…';
      user = await phoneLogin({ phone, code });
    } else if (layer._mode === 'register') {
      const email = emailField.querySelector('input').value.trim();
      const loginVal = nameField.querySelector('input').value.trim();
      const password = pwdField.querySelector('input').value;
      if (!loginVal) return showError('请填写用户名');
      if (!password) return showError('请填写密码');
      if (!agreed) return showError('请先阅读并勾选同意《用户协议》和《社区内容守则》');
      submit.textContent = '注册中…';
      user = await register({ username: loginVal, email, password });
    } else {
      const loginVal = nameField.querySelector('input').value.trim();
      const password = pwdField.querySelector('input').value;
      if (!loginVal) return showError('请填写账号');
      if (!password) return showError('请填写密码');
      submit.textContent = '登录中…';
      user = await login({ login: loginVal, password });
    }
    hide();
    onDone?.(user);
  } catch (e) {
    showError(e.message || '操作失败，请重试');
  } finally {
    submit.disabled = false;
    submit.textContent = layer._tab === 'phone' ? '登录 / 注册'
      : (layer._mode === 'register' ? '注册并登录' : '登录');
  }
}

/** 显示登录浮层；onSuccess 在登录/注册成功后回调（拿到 user） */
export function showAuthOverlay(callback) {
  onDone = callback;
  const L = buildLayer();
  L.style.display = 'flex';
  // 重新聚焦第一个输入框（按当前 tab）
  setTimeout(() => {
    const first =
      L._tab === 'phone'
        ? L._refs.phoneField.querySelector('input')
        : L._refs.nameField.querySelector('input');
    first?.focus();
  }, 30);
}

/** 隐藏浮层 */
export function hide() {
  if (layer) layer.style.display = 'none';
}
