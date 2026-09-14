/**
 * auth.js (UI) — 登录 / 注册浮层（单窗口统一入口）
 *
 * 与 auth.js（状态管理）配合：本模块只负责渲染浮层、收集输入、调用 login/register，
 * 成功后通过回调通知上层（main.js）刷新门禁；失败在浮层内就地提示。
 *
 * 统一入口（无 Tab、无两个窗口）：
 *   · 字段：账号 + 密码（+ 注册时可选邮箱）。
 *   · 账号可以是手机号，也可以是个性化用户名。
 *   · 登录：账号 + 密码（手机号账户、用户名账户都走密码）。
 *   · 注册：账号 + 密码；当账号是手机号时，额外出现「获取验证码」做短信所有权校验
 *     （手机号注册逻辑），通过后才用「手机号 + 密码」建立账户；用户名则直接注册。
 *
 * 设计：单例浮层，首次需要时挂载到 body，重复调用只切换模式而不重建。
 */

import './auth.css';
import { register, login, sendPhoneCode } from '../auth.js';
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

  /* ---- 账号（手机号或用户名） ---- */
  const accountField = el(
    'div',
    { class: 'auth-field' },
    el('input', {
      class: 'auth-field__input',
      type: 'text',
      placeholder: '手机号 / 用户名',
      autocomplete: 'username',
      'data-role': 'account',
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

  const emailField = el(
    'div',
    { class: 'auth-field' },
    el('input', {
      class: 'auth-field__input',
      type: 'email',
      placeholder: '邮箱（选填）',
      autocomplete: 'email',
      'data-role': 'email',
    })
  );

  /* ---- 手机号注册时的短信验证码行 ---- */
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
  codeBtn.addEventListener('click', () => void onSendCode());

  // 协议同意勾选（注册需显式勾选——法律上的"明示同意"要件）
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
    accountField,
    pwdField,
    emailField,
    codeRow,
    agreeBox,
    errorBox,
    infoBox,
    submit,
    switchText
  );

  const card = el('div', { class: 'auth-card' }, brand, heading, hint, form);
  layer = el('div', { class: 'auth-layer' }, card);
  document.body.appendChild(layer);

  // 账号框输入时实时判断是否为手机号，决定是否显示验证码行
  accountField.querySelector('input').addEventListener('input', () => updatePhoneFields());

  layer._mode = 'login';
  layer._refs = {
    heading, hint, accountField, pwdField, emailField, codeField, codeBtn, codeRow,
    agreeBox, errorBox, infoBox, submit, switchText,
  };

  render();
  return layer;
}

/** 当前账号框内容是否像手机号 */
function accountIsPhone() {
  const v = layer._refs.accountField.querySelector('input').value.trim();
  return /^1[3-9]\d{9}$/.test(v);
}

/* 单一渲染入口：按 _mode 决定可见性与文案 */
function render() {
  const L = layer;
  const { heading, hint, accountField, pwdField, emailField, codeField, codeBtn, codeRow,
    agreeBox, errorBox, infoBox, submit, switchText } = L._refs;

  errorBox.style.display = 'none';
  infoBox.style.display = 'none';

  const mode = L._mode;
  if (mode === 'register') {
    heading.textContent = '注册账号';
    hint.textContent = '手机号或用户名均可，设置密码保存你的改装方案';
    emailField.style.display = '';
    accountField.querySelector('input').setAttribute('placeholder', '手机号 / 用户名');
    pwdField.querySelector('input').setAttribute('autocomplete', 'new-password');
    pwdField.querySelector('input').setAttribute('placeholder', '设置密码（至少 6 位）');
    agreeBox.style.display = '';
    submit.textContent = '注册并登录';
    switchText.innerHTML = '';
    switchText.appendChild(document.createTextNode('已有账号？'));
    switchText.appendChild(el('button', { type: 'button', onClick: () => setMode('login') }, '去登录'));
    accountField.querySelector('input').focus();
  } else {
    heading.textContent = '登录';
    hint.textContent = '登录后即可查看你的改装方案';
    emailField.style.display = 'none';
    accountField.querySelector('input').setAttribute('placeholder', '手机号 / 用户名');
    pwdField.querySelector('input').setAttribute('autocomplete', 'current-password');
    pwdField.querySelector('input').setAttribute('placeholder', '密码');
    agreeBox.style.display = 'none';
    submit.textContent = '登录';
    switchText.innerHTML = '';
    switchText.appendChild(document.createTextNode('还没有账号？'));
    switchText.appendChild(el('button', { type: 'button', onClick: () => setMode('register') }, '去注册'));
    accountField.querySelector('input').focus();
  }
  updatePhoneFields();
}

/** 注册模式 + 账号是手机号时显示验证码行 */
function updatePhoneFields() {
  const L = layer;
  const { codeRow, codeBtn } = L._refs;
  const show = L._mode === 'register' && accountIsPhone();
  codeRow.style.display = show ? '' : 'none';
  if (show && !codeBtn._timer) codeBtn.textContent = '获取验证码';
}

function setMode(mode) {
  if (layer._mode === mode) return;
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

/* 获取验证码 + 60s 倒计时（仅手机号注册） */
async function onSendCode() {
  const { accountField, agreeBox, codeBtn } = layer._refs;
  const phone = accountField.querySelector('input').value.trim();
  if (!agreeBox.querySelector('input').checked) {
    return showError('请先阅读并勾选同意《用户协议》和《社区内容守则》');
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return showError('请输入正确的手机号');
  }
  codeBtn.disabled = true;
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
  const { accountField, pwdField, emailField, codeField, agreeBox, submit } = layer._refs;
  const account = accountField.querySelector('input').value.trim();
  const password = pwdField.querySelector('input').value;
  const agreed = agreeBox.querySelector('input').checked;

  submit.disabled = true;
  try {
    let user;
    if (layer._mode === 'register') {
      if (!account) return showError('请填写账号');
      if (!password) return showError('请填写密码');
      if (!agreed) return showError('请先阅读并勾选同意《用户协议》和《社区内容守则》');
      if (accountIsPhone()) {
        const code = codeField.querySelector('input').value.trim();
        if (!/^\d{6}$/.test(code)) return showError('请输入 6 位短信验证码');
        submit.textContent = '注册中…';
        user = await register({ account, password, code });
      } else {
        const email = emailField.querySelector('input').value.trim();
        submit.textContent = '注册中…';
        user = await register({ account, password, email });
      }
    } else {
      if (!account) return showError('请填写账号');
      if (!password) return showError('请填写密码');
      submit.textContent = '登录中…';
      user = await login({ login: account, password });
    }
    hide();
    onDone?.(user);
  } catch (e) {
    showError(e.message || '操作失败，请重试');
  } finally {
    submit.disabled = false;
    submit.textContent = layer._mode === 'register' ? '注册并登录' : '登录';
  }
}

/** 显示登录浮层；onSuccess 在登录/注册成功后回调（拿到 user） */
export function showAuthOverlay(callback) {
  onDone = callback;
  const L = buildLayer();
  L.style.display = 'flex';
  setTimeout(() => L._refs.accountField.querySelector('input').focus(), 30);
}

/** 隐藏浮层 */
export function hide() {
  if (layer) layer.style.display = 'none';
}
