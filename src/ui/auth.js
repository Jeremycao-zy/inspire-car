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

/* ---- 第三方登录（微信 / 苹果）图标 ---- */
/* 微信官方风格双气泡 logo（取自 simple-icons，单色路径 fill=currentColor） */
const WECHAT_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>';
const APPLE_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>';

/** 发起第三方登录：先问后端要授权跳转 URL，未配置则就地提示 */
async function startOAuth(provider) {
  try {
    const res = await fetch(`/api/auth/oauth/${provider}/start`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      showError(data.error || '该登录方式暂未开放');
      return;
    }
    window.location.href = data.url; // 跳去微信扫码 / Apple 授权
  } catch {
    showError('网络异常，请稍后再试');
  }
}

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

  /* ---- 其他登录方式：微信 / 苹果（图标入口） ---- */
  const wechatBtn = el(
    'button',
    { type: 'button', class: 'auth-oauth-btn auth-oauth-btn--wechat', 'aria-label': '微信登录', html: WECHAT_SVG }
  );
  wechatBtn.addEventListener('click', () => void startOAuth('wechat'));
  const appleBtn = el(
    'button',
    { type: 'button', class: 'auth-oauth-btn auth-oauth-btn--apple', 'aria-label': '苹果登录', html: APPLE_SVG }
  );
  appleBtn.addEventListener('click', () => void startOAuth('apple'));
  const oauthSection = el(
    'div',
    { class: 'auth-oauth' },
    el('div', { class: 'auth-oauth__divider' }, el('span', {}, '其他登录方式')),
    el('div', { class: 'auth-oauth__row' }, wechatBtn, appleBtn)
  );

  const card = el('div', { class: 'auth-card' }, brand, heading, hint, form, oauthSection);
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
        const code = codeField.value.trim();
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
