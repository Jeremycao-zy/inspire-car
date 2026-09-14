/**
 * server/auth.mjs — 无依赖用户认证模块
 *
 * 设计要点（与整个项目「纯 Node 内置、零三方依赖」约定一致）：
 *
 *   · 密码哈希：crypto.scrypt（CPU 密集型、抗 GPU 暴力破解），每用户随机 16B salt。
 *   · 令牌：无状态 JWT。header.payload 用 base64url 编码，再用 HMAC-SHA256 签名，
 *           secret 取自环境变量 AUTH_SECRET，缺失时回退到 .cache/users/.secret（首次启动生成）。
 *           ⚠️ 生产环境（Railway）必须把 AUTH_SECRET 设为固定值（控制台 Variables），
 *              否则每次重新部署会重新生成密钥，导致所有已登录用户被踢下线。
 *   · 用户存储：交给 server/db.mjs（DATABASE_URL 存在 → PostgreSQL；
 *              否则 → .cache/users/users.json 文件回退，仅本地开发用）。
 *   · 纯函数导出，server/index.mjs 仅做路由与请求体解析。
 *
 * 不引入 refresh token / 邮件验证 / 限额，v1 只解决「注册 + 登录 + 身份校验」。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import * as sms from './sms.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.cache', 'users');
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

/* ------------------------- 校验规则 ------------------------- */

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function isValidUsername(name) {
  return /^[a-zA-Z0-9_一-龥]{2,24}$/.test(name);
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
/** 大陆手机号：1 开头、第二位 3-9、共 11 位 */
function normalizePhone(phone) {
  const p = String(phone || '').trim().replace(/[\s-]/g, '');
  return /^1[3-9]\d{9}$/.test(p) ? p : null;
}
function isValidPhone(phone) {
  return normalizePhone(phone) !== null;
}

/* ------------------------- 注册 / 登录 ------------------------- */

/**
 * 注册新用户（统一入口：账号可以是手机号，也可以是个性化用户名）。
 *   · 账号为手机号：必须先用短信验证码校验所有权（手机号注册逻辑），
 *     校验通过后才用「手机号 + 密码」建立账户（避免别人用你的手机号注册）。
 *   · 账号为用户名：常规用户名 + 密码（+ 可选邮箱）注册。
 * @param {{account:string, password:string, email?:string, code?:string}} input
 *   account 为手机号时需额外提供 code（短信验证码）。
 * @returns {Promise<{ok:true, user, token} | {ok:false, error:string, code:string}>}
 */
export async function registerUser(input) {
  const account = String(input?.account ?? input?.username ?? '').trim();
  const email = normalizeEmail(input?.email);
  const password = String(input?.password || '');
  const code = String(input?.code || '').trim();

  if (!account) return { ok: false, error: '请填写账号', code: 'bad_account' };
  if (password.length < 6) return { ok: false, error: '密码至少 6 位', code: 'bad_password' };

  const phone = normalizePhone(account);
  let username;
  let phoneVal = null;

  if (phone) {
    // 手机号注册：必须短信验证码校验所有权
    if (!code) return { ok: false, error: '请先获取并填写短信验证码', code: 'need_code' };
    const rec = await db.getLatestOtp(phone);
    if (!rec) return { ok: false, error: '请先获取验证码', code: 'no_code' };
    if (Date.now() > rec.expiresAt) {
      await db.deleteOtp(phone);
      return { ok: false, error: '验证码已过期，请重新获取', code: 'expired' };
    }
    if (rec.code !== code) return { ok: false, error: '验证码错误', code: 'invalid' };
    await db.deleteOtp(phone); // 一次性使用

    if (await db.userExistsByPhone(phone)) {
      return { ok: false, error: '该手机号已注册', code: 'phone_taken' };
    }
    phoneVal = phone;
    username = 'm' + phone.slice(-8);
    let n = 0;
    while (await db.userExistsByUsername(username)) username = 'm' + phone.slice(-8) + ++n;
  } else {
    username = account;
    if (!isValidUsername(username)) {
      return { ok: false, error: '用户名需 2–24 位（字母/数字/下划线/中文）', code: 'bad_username' };
    }
    if (email && !isValidEmail(email)) {
      return { ok: false, error: '邮箱格式不正确', code: 'bad_email' };
    }
    if (await db.userExistsByUsername(username)) {
      return { ok: false, error: '该用户名已被注册', code: 'username_taken' };
    }
    if (email && (await db.userExistsByEmail(email))) {
      return { ok: false, error: '该邮箱已被注册', code: 'email_taken' };
    }
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    // 手机号注册暂不绑定邮箱（邮箱为用户名账户的选填项，避免唯一索引冲突）
    email: phoneVal ? null : email || null,
    phone: phoneVal,
    salt,
    pw: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
  await db.createUser(user);

  return { ok: true, user: publicUser(user), token: signToken(user) };
}

/**
 * 校验登录凭据（login 可为用户名或邮箱）。
 * @returns {Promise<{ok:true, user, token} | {ok:false, error:string, code:string}>}
 */
export async function verifyCredentials(input) {
  const login = String(input?.login || '').trim().toLowerCase();
  const password = String(input?.password || '');
  if (!login || !password) {
    return { ok: false, error: '请输入账号和密码', code: 'missing' };
  }
  const user = await db.findUserByLogin(login);
  // 统一错误，避免泄露账号是否存在
  if (!user || !verifyPassword(password, user.salt, user.pw)) {
    return { ok: false, error: '账号或密码错误', code: 'invalid' };
  }
  return { ok: true, user: publicUser(user), token: signToken(user) };
}

/* ------------------------- 手机号验证码登录 ------------------------- */

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000); // 默认 5 分钟
const OTP_COOLDOWN_MS = Number(process.env.OTP_COOLDOWN_MS || 60 * 1000); // 重发冷却 60s

/**
 * 发送手机号验证码。
 * @param {{phone:string}} input
 * @returns {Promise<{ok:boolean, dev?:boolean, code?:string, error?:string, code?:string}>}
 */
export async function sendPhoneCode(input) {
  const phone = normalizePhone(input?.phone);
  if (!phone) return { ok: false, error: '请输入正确的手机号', code: 'bad_phone' };

  // 重发冷却：避免刷短信
  const recent = await db.getLatestOtp(phone);
  if (recent && recent.createdAt && Date.now() - recent.createdAt < OTP_COOLDOWN_MS) {
    return { ok: false, error: '验证码发送过于频繁，请稍后再试', code: 'too_frequent' };
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.saveOtp(phone, code, OTP_TTL_MS);
  const sent = await sms.sendSmsCode(phone, code);
  if (!sent.ok) return { ok: false, error: sent.error || '短信发送失败', code: 'sms_failed' };
  // dev 模式下把验证码透传给前端便于本地测试；生产模式不返回 code。
  return { ok: true, dev: sent.dev, code: sent.dev ? code : undefined };
}

/**
 * 校验验证码并登录 / 注册（手机号不存在则自动注册）。
 * @param {{phone:string, code:string}} input
 * @returns {Promise<{ok:boolean, user?, token?, error?:string, code?:string}>}
 */
export async function loginOrRegisterByPhone(input) {
  const phone = normalizePhone(input?.phone);
  const code = String(input?.code || '').trim();
  if (!phone) return { ok: false, error: '请输入手机号', code: 'bad_phone' };
  if (!/^\d{6}$/.test(code)) return { ok: false, error: '请输入 6 位验证码', code: 'bad_code' };

  const rec = await db.getLatestOtp(phone);
  if (!rec) return { ok: false, error: '请先获取验证码', code: 'no_code' };
  if (Date.now() > rec.expiresAt) {
    await db.deleteOtp(phone);
    return { ok: false, error: '验证码已过期，请重新获取', code: 'expired' };
  }
  if (rec.code !== code) return { ok: false, error: '验证码错误', code: 'invalid' };

  // 一次性使用：校验通过立即作废
  await db.deleteOtp(phone);

  let user = await db.findUserByPhone(phone);
  if (!user) {
    // 自动注册：用户名取手机号后 8 位，冲突则追加随机后缀
    let username = 'm' + phone.slice(-8);
    let n = 0;
    while (await db.userExistsByUsername(username)) {
      username = 'm' + phone.slice(-8) + (++n);
    }
    user = {
      id: crypto.randomBytes(8).toString('hex'),
      username,
      email: null,
      phone,
      salt: null,
      pw: null,
      createdAt: new Date().toISOString(),
    };
    await db.createUser(user);
  }
  return { ok: true, user: publicUser(user), token: signToken(user) };
}

/** 去掉密码字段，返回安全用户对象 */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email || null,
    phone: u.phone || null,
    createdAt: u.createdAt,
  };
}

/** 按 id 取公开用户对象（token 校验后回查用） */
export async function getUserById(id) {
  return db.findUserById(id);
}

/** 在服务启动时确保密钥可用（避免首次注册时才抢建；DB 连接由 db.initDb 负责） */
export function initAuth() {
  try {
    getSecret(); // 预热密钥
  } catch {
    /* ignore */
  }
}
