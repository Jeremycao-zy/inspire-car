/**
 * auth.js — 前端登录态管理（无三方依赖，纯 fetch + localStorage）
 *
 * 职责：
 *   · 保存 / 读取 / 清除登录令牌（Bearer）
 *   · 暴露 authFetch：自动带 Authorization，401 时清登录态并触发登出事件
 *   · 封装 register / login / logout / fetchMe
 *   · 通过 window 事件 'auth:change' 通知 UI 登录态变化
 *
 * 与后端 server/auth.mjs 配套：令牌为 HMAC 签名的无状态 JWT。
 */

const TOKEN_KEY = 'inspire-auth-token';
const USER_KEY = 'inspire-auth-user';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function writeToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
function readUser() {
  try {
    const s = localStorage.getItem(USER_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function writeUser(u) {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

function emitChange() {
  window.dispatchEvent(new CustomEvent('auth:change', { detail: { user: currentUser() } }));
}

/** 当前登录用户（公开字段），未登录返回 null */
export function currentUser() {
  return readUser();
}

/** 是否已登录（仅看本地是否有 token + user，真实校验走 fetchMe） */
export function isLoggedIn() {
  return !!readToken() && !!readUser();
}

/** 带鉴权的 fetch：自动附带 Authorization，401 时清态并广播 */
export async function authFetch(url, options = {}) {
  const token = readToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    // 令牌失效：清态并通知（通常因过期或被服务端拒绝）
    writeToken('');
    writeUser(null);
    emitChange();
  }
  return res;
}

/** 注册并自动登录 */
export async function register({ username, email, password }) {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: email || undefined, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || '注册失败');
    e.code = data.code;
    throw e;
  }
  writeToken(data.token);
  writeUser(data.user);
  emitChange();
  return data.user;
}

/** 登录 */
export async function login({ login, password }) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || '登录失败');
    e.code = data.code;
    throw e;
  }
  writeToken(data.token);
  writeUser(data.user);
  emitChange();
  return data.user;
}

/** 登出（清本地态 + 通知服务端作废令牌） */
export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* 忽略网络错误，本地清态即可 */
  }
  writeToken('');
  writeUser(null);
  emitChange();
}

/** 用本地 token 向服务端校验身份；无效则清态，返回 user 或 null */
export async function fetchMe() {
  const token = readToken();
  if (!token) {
    writeUser(null);
    return null;
  }
  try {
    const res = await fetch('/api/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      writeToken('');
      writeUser(null);
      emitChange();
      return null;
    }
    const data = await res.json();
    writeUser(data.user);
    return data.user;
  } catch {
    // 网络异常：保留本地态，等下次再校验
    return readUser();
  }
}
