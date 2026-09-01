/**
 * server/auth.mjs — 无依赖用户认证模块
 *
 * 设计要点（与整个项目「纯 Node 内置、零三方依赖」约定一致）：
 *
 *   · 密码哈希：crypto.scrypt（CPU 密集型、抗 GPU 暴力破解），每用户随机 16B salt。
 *   · 令牌：无状态 JWT。header.payload 用 base64url 编码，再用 HMAC-SHA256 签名，
 *           secret 取自环境变量 AUTH_SECRET，缺失时回退到 .cache/users/.secret（首次启动生成）。
 *   · 用户存储：.cache/users/users.json（数组，按用户名/邮箱唯一索引）。
 *   · 纯函数导出，server/index.mjs 仅做路由与请求体解析。
 *
 * 不引入 refresh token / 邮件验证 / 限额，v1 只解决「注册 + 登录 + 身份校验」。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.cache', 'users');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');

const SCRYPT_KEYLEN = 64;
const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS || 1000 * 60 * 60 * 24 * 7); // 默认 7 天

/* ------------------------- 令牌密钥 ------------------------- */

function ensureSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    /* 首次：生成并落盘（.cache 已被 gitignore，不会提交） */
    const s = crypto.randomBytes(48).toString('hex');
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    } catch {
      /* 写失败就退回内存密钥（重启即失效，仅开发可用） */
      return s;
    }
    return s;
  }
}

function getSecret() {
  return process.env.AUTH_SECRET || ensureSecret();
}

/* ------------------------- JWT（无状态，HMAC 签名） ------------------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function fromB64urlJson(str) {
  return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
}

/** 签发令牌：payload 不含敏感字段，只放 uid / name / 过期时间 */
export function signToken(user) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Date.now();
  const payload = {
    uid: user.id,
    name: user.username,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + TOKEN_TTL_MS) / 1000),
  };
  const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** 校验令牌：签名无效 / 过期 → 返回 null；否则返回 payload */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(`${h}.${p}`).digest('base64url');
  // 定长时间比较，防时序攻击
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = fromB64urlJson(p);
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------- 密码哈希 ------------------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

function verifyPassword(password, salt, expectedHex) {
  const got = hashPassword(password, salt);
  const a = Buffer.from(got);
  const b = Buffer.from(expectedHex);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------- 用户存储 ------------------------- */

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeUsers(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** 去掉密码字段，返回安全用户对象 */
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, email: u.email || null, createdAt: u.createdAt };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function isValidUsername(name) {
  return /^[a-zA-Z0-9_一-龥]{2,24}$/.test(name);
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * 注册新用户。
 * @param {{username:string, email?:string, password:string}} input
 * @returns {{ok:true, user, token} | {ok:false, error:string, code:string}}
 */
export function registerUser(input) {
  const username = String(input?.username || '').trim();
  const email = normalizeEmail(input?.email);
  const password = String(input?.password || '');

  if (!isValidUsername(username)) {
    return { ok: false, error: '用户名需 2–24 位（字母/数字/下划线/中文）', code: 'bad_username' };
  }
  if (email && !isValidEmail(email)) {
    return { ok: false, error: '邮箱格式不正确', code: 'bad_email' };
  }
  if (password.length < 6) {
    return { ok: false, error: '密码至少 6 位', code: 'bad_password' };
  }

  const users = readUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return { ok: false, error: '该用户名已被注册', code: 'username_taken' };
  }
  if (email && users.some((u) => u.email && u.email === email)) {
    return { ok: false, error: '该邮箱已被注册', code: 'email_taken' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    email: email || null,
    salt,
    pw: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);

  return { ok: true, user: publicUser(user), token: signToken(user) };
}

/**
 * 校验登录凭据（login 可为用户名或邮箱）。
 * @returns {{ok:true, user, token} | {ok:false, error:string, code:string}}
 */
export function verifyCredentials(input) {
  const login = String(input?.login || '').trim().toLowerCase();
  const password = String(input?.password || '');
  if (!login || !password) {
    return { ok: false, error: '请输入账号和密码', code: 'missing' };
  }
  const users = readUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === login || (u.email && u.email === login)
  );
  // 统一错误，避免泄露账号是否存在
  if (!user || !verifyPassword(password, user.salt, user.pw)) {
    return { ok: false, error: '账号或密码错误', code: 'invalid' };
  }
  return { ok: true, user: publicUser(user), token: signToken(user) };
}

/** 按 id 取公开用户对象（token 校验后回查用） */
export function getUserById(id) {
  const users = readUsers();
  return publicUser(users.find((u) => u.id === id));
}

/** 在服务启动时确保数据目录存在（避免首次注册时才抢建） */
export function initAuth() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    getSecret(); // 预热密钥
  } catch {
    /* ignore */
  }
}
