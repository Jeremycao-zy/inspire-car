/**
 * auth.js (UI) — 登录 / 注册浮层
 *
 * 与 auth.js（状态管理）配合：本模块只负责渲染浮层、收集输入、调用 register/login，
 * 成功后通过回调通知上层（main.js）刷新门禁；失败在浮层内就地提示。
 *
 * 设计：单例浮层，首次需要时挂载到 body，重复调用只切换模式而不重建。
 */

import './auth.css';
import { register, login } from '../auth.js';
import logoMarkUrl from '../assets/logo-mark-nobg.png';

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

  const errorBox = el('p', { class: 'auth-error', style: 'display:none' });
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
    emailField,
    nameField,
    pwdField,
    errorBox,
    submit,
    switchText
  );

  const card = el(
    'div',
    { class: 'auth-card' },
    brand,
    heading,
    hint,
    form
  );
  layer = el('div', { class: 'auth-layer' }, card);
  document.body.appendChild(layer);

  // 内部状态：mode = 'login' | 'register'
  layer._mode = 'login';
  layer._refs = { heading, hint, emailField, nameField, pwdField, errorBox, submit, switchText };

  setMode('login');
  return layer;
}

function setMode(mode) {
  const L = layer;
  L._mode = mode;
  const { heading, hint, emailField, nameField, pwdField, errorBox, submit, switchText } = L._refs;
  errorBox.style.display = 'none';
  const email = emailField.querySelector('input');
  const name = nameField.querySelector('input');
  const pwd = pwdField.querySelector('input');

  if (mode === 'register') {
    heading.textContent = '注册账号';
    hint.textContent = '创建用户名与密码，保存你自己的改装方案';
    emailField.style.display = '';
    name.setAttribute('autocomplete', 'username');
    name.setAttribute('placeholder', '用户名（2–24 位）');
    pwd.setAttribute('autocomplete', 'new-password');
    pwd.setAttribute('placeholder', '设置密码（至少 6 位）');
    submit.textContent = '注册并登录';
    switchText.innerHTML = '';
    switchText.appendChild(document.createTextNode('已有账号？'));
    switchText.appendChild(
      el('button', { type: 'button', onClick: () => setMode('login') }, '去登录')
    );
    email.focus();
  } else {
    heading.textContent = '登录';
    hint.textContent = '登录后即可查看你的改装方案';
    emailField.style.display = 'none';
    name.setAttribute('autocomplete', 'username');
    name.setAttribute('placeholder', '用户名 / 邮箱');
    pwd.setAttribute('autocomplete', 'current-password');
    pwd.setAttribute('placeholder', '密码');
    submit.textContent = '登录';
    switchText.innerHTML = '';
    switchText.appendChild(document.createTextNode('还没有账号？'));
    switchText.appendChild(
      el('button', { type: 'button', onClick: () => setMode('register') }, '去注册')
    );
    name.focus();
  }
}

function showError(msg) {
  const { errorBox } = layer._refs;
  errorBox.textContent = msg;
  errorBox.style.display = '';
}

async function submitForm() {
  const { emailField, nameField, pwdField, submit } = layer._refs;
  const email = emailField.querySelector('input').value.trim();
  const loginVal = nameField.querySelector('input').value.trim();
  const password = pwdField.querySelector('input').value;
  const mode = layer._mode;

  if (mode === 'register') {
    if (!loginVal) return showError('请填写用户名');
    if (!password) return showError('请填写密码');
  } else {
    if (!loginVal) return showError('请填写账号');
    if (!password) return showError('请填写密码');
  }

  submit.disabled = true;
  submit.textContent = mode === 'register' ? '注册中…' : '登录中…';
  try {
    let user;
    if (mode === 'register') {
      user = await register({ username: loginVal, email, password });
    } else {
      user = await login({ login: loginVal, password });
    }
    hide();
    onDone?.(user);
  } catch (e) {
    showError(e.message || '操作失败，请重试');
  } finally {
    submit.disabled = false;
    submit.textContent = mode === 'register' ? '注册并登录' : '登录';
  }
}

/** 显示登录浮层；onSuccess 在登录/注册成功后回调（拿到 user） */
export function showAuthOverlay(callback) {
  onDone = callback;
  const L = buildLayer();
  L.style.display = 'flex';
  // 重新聚焦第一个输入框
  setTimeout(() => {
    const first =
      L._mode === 'register'
        ? L._refs.emailField.querySelector('input')
        : L._refs.nameField.querySelector('input');
    first?.focus();
  }, 30);
}

/** 隐藏浮层 */
export function hide() {
  if (layer) layer.style.display = 'none';
}
