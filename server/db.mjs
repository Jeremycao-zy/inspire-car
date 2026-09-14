/**
 * server/db.mjs — 用户与轮毂数据的持久化层
 *
 * 双模式（调用方 auth.mjs / wheels.mjs 无需感知当前是哪种）：
 *
 *   · SQL 模式（生产 / 有 DATABASE_URL）：
 *      使用 PostgreSQL（pg）。启动自动建表（users / wheels / plans / models / otp + 唯一/普通索引），
 *      账号、「我的轮毂」索引、整车方案与生成的 GLB 字节真正持久化，Railway 重新部署后数据不丢。
 *      仅当 DATABASE_URL 存在时才动态 import('pg')，所以本地没装 pg 也不会报错。
 *      密码字段 salt/pw 允许为空——手机号验证码登录的用户没有密码。
 *
 *   · JSON 模式（本地开发 / 无数据库）：
 *      回退到 .cache 下的文件存储，行为与历史一致，便于零依赖跑通。
 *      注意：Railway 容器文件系统是临时的，JSON 模式仅适合本地；生产必须配 DATABASE_URL。
 *
 * 设计约束：
 *   · 密码只以 scrypt 哈希（salt+pw）落库，绝不明文。
 *   · 用户名 / 邮箱唯一性按 lower() 比较，大小写不敏感。
 *   · 所有对外函数都是 async，方便未来无缝切换到其它 SQL 实现。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 当前模式：'sql' | 'json' */
export let dbMode = 'json';
/** PostgreSQL 连接池（仅 SQL 模式非空） */
let pool = null;

/* ------------------------- 连接与建表 ------------------------- */

/**
 * 初始化数据库。
 * @returns {Promise<{mode:string, note?:string}>}
 */
export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    dbMode = 'json';
    ensureJsonDirs();
    return {
      mode: 'json',
      note: 'DATABASE_URL 未设置，使用本地 JSON 文件存储（仅开发可用，Railway 上数据不持久）',
    };
  }
  const pgMod = await import('pg');
  const Pool = pgMod.Pool || (pgMod.default && pgMod.default.Pool);
  if (!Pool) throw new Error('pg 模块未导出 Pool，请确认已 npm install pg');
  // Railway / 多数云 Postgres 连接串带 sslmode=require；统一关闭证书校验（连接已加密）。
  const ssl = /sslmode=require|ssl=true|sslmode=no-verify/i.test(url) || url.startsWith('postgres://')
    ? { rejectUnauthorized: false }
    : false;
  pool = new Pool({ connectionString: url, ssl, max: 10 });
  await pool.query('SELECT 1'); // 探活
  await migrate();
  dbMode = 'sql';
  return { mode: 'sql' };
}

/** 关闭连接池（进程退出时用） */
export async function closeDb() {
  if (pool) {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    pool = null;
  }
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      email      TEXT,
      phone      TEXT,
      salt       TEXT,
      pw         TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username))'
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email)) WHERE email IS NOT NULL'
  );
  // 兼容已上线的旧 users 表：旧表 salt/pw 是 NOT NULL 且可能没有 phone 列。
  // ALTER 用 IF EXISTS / DROP NOT NULL（幂等），重复部署不会报错。
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT');
  await pool.query('ALTER TABLE users ALTER COLUMN salt DROP NOT NULL');
  await pool.query('ALTER TABLE users ALTER COLUMN pw DROP NOT NULL');
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS users_phone_lower ON users (lower(phone)) WHERE phone IS NOT NULL'
  );

  // 手机号验证码登录：每个手机号同时只保留一条有效验证码（发送新码即作废旧码）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp (
      phone      TEXT NOT NULL,
      code       TEXT NOT NULL,
      purpose    TEXT NOT NULL DEFAULT 'login',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS otp_phone ON otp (phone)'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wheels (
      id          TEXT PRIMARY KEY,
      owner       TEXT NOT NULL,
      url         TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '我的轮毂',
      thumb       TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS wheels_owner ON wheels (owner)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS models (
      name TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id          TEXT NOT NULL,
      owner       TEXT NOT NULL,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner, id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS plans_owner ON plans (owner)');
}

/* ------------------------- JSON 回退存储 ------------------------- */

const USERS_DIR = path.join(ROOT, '.cache', 'users');
const WHEELS_DIR = path.join(ROOT, '.cache', 'wheels');
const MODELS_DIR = path.join(ROOT, '.cache', 'models');
const PLANS_DIR = path.join(ROOT, '.cache', 'plans');
const OT_DIR = path.join(ROOT, '.cache', 'otp');
const USERS_FILE = path.join(USERS_DIR, 'users.json');

function ensureJsonDirs() {
  try {
    fs.mkdirSync(USERS_DIR, { recursive: true });
    fs.mkdirSync(WHEELS_DIR, { recursive: true });
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    fs.mkdirSync(PLANS_DIR, { recursive: true });
    fs.mkdirSync(OT_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function readUsersJson() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeUsersJson(list) {
  fs.mkdirSync(USERS_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}
function wheelFileFor(uid) {
  return path.join(WHEELS_DIR, `${uid}.json`);
}
function readWheelsJson(uid) {
  try {
    const list = JSON.parse(fs.readFileSync(wheelFileFor(uid), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeWheelsJson(uid, list) {
  fs.mkdirSync(WHEELS_DIR, { recursive: true });
  const MAX = 60; // 单用户最多保留 60 条，超出丢弃最旧
  if (list.length > MAX) list.length = MAX;
  fs.writeFileSync(wheelFileFor(uid), JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** 把 SQL 行的 timestamptz 统一转成 ISO 字符串（前端与历史 JSON 行为一致） */
function iso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

/* ------------------------- 用户 ------------------------- */

export async function userExistsByUsername(username) {
  const lower = String(username || '').toLowerCase();
  if (!lower) return false;
  if (dbMode === 'sql') {
    const r = await pool.query('SELECT 1 FROM users WHERE lower(username)=$1', [lower]);
    return r.rowCount > 0;
  }
  return readUsersJson().some((u) => u.username.toLowerCase() === lower);
}

export async function userExistsByEmail(email) {
  const lower = String(email || '').toLowerCase();
  if (!lower) return false;
  if (dbMode === 'sql') {
    const r = await pool.query('SELECT 1 FROM users WHERE lower(email)=$1', [lower]);
    return r.rowCount > 0;
  }
  return readUsersJson().some((u) => u.email && u.email.toLowerCase() === lower);
}

export async function userExistsByPhone(phone) {
  const lower = String(phone || '').toLowerCase();
  if (!lower) return false;
  if (dbMode === 'sql') {
    const r = await pool.query('SELECT 1 FROM users WHERE lower(phone)=$1', [lower]);
    return r.rowCount > 0;
  }
  return readUsersJson().some((u) => u.phone && u.phone.toLowerCase() === lower);
}

/**
 * 写入新用户（调用方已保证用户名/邮箱/手机号不冲突）。
 * 密码类字段 salt/pw 允许为 null（手机号验证码登录的用户无密码）。
 * @param {{id,username,email?,phone?,salt?,pw?}} record
 */
export async function createUser(record) {
  if (dbMode === 'sql') {
    await pool.query(
      'INSERT INTO users (id, username, email, phone, salt, pw) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        record.id,
        record.username,
        record.email || null,
        record.phone || null,
        record.salt ?? null,
        record.pw ?? null,
      ]
    );
    return;
  }
  const users = readUsersJson();
  users.push({
    id: record.id,
    username: record.username,
    email: record.email || null,
    phone: record.phone || null,
    salt: record.salt ?? null,
    pw: record.pw ?? null,
    createdAt: new Date().toISOString(),
  });
  writeUsersJson(users);
}

/**
 * 按登录名（用户名或邮箱，大小写不敏感）查用户，返回含 salt/pw 的完整记录或 null。
 */
export async function findUserByLogin(login) {
  const lower = String(login || '').toLowerCase();
  if (!lower) return null;
  if (dbMode === 'sql') {
    const r = await pool.query(
      `SELECT id, username, email, phone, salt, pw, created_at
         FROM users WHERE lower(username)=$1 OR lower(email)=$1 OR lower(phone)=$1
         LIMIT 1`,
      [lower]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      phone: row.phone,
      salt: row.salt,
      pw: row.pw,
      createdAt: iso(row.created_at),
    };
  }
  const users = readUsersJson();
  return (
    users.find(
      (u) =>
        u.username.toLowerCase() === lower ||
        (u.email && u.email.toLowerCase() === lower) ||
        (u.phone && u.phone.toLowerCase() === lower)
    ) || null
  );
}

/** 按手机号查完整记录（含 salt/pw，供验证码登录回查） */
export async function findUserByPhone(phone) {
  const lower = String(phone || '').toLowerCase();
  if (!lower) return null;
  if (dbMode === 'sql') {
    const r = await pool.query(
      `SELECT id, username, email, phone, salt, pw, created_at
         FROM users WHERE lower(phone)=$1 LIMIT 1`,
      [lower]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      phone: row.phone,
      salt: row.salt,
      pw: row.pw,
      createdAt: iso(row.created_at),
    };
  }
  const users = readUsersJson();
  return users.find((u) => u.phone && u.phone.toLowerCase() === lower) || null;
}

/** 按 id 查公开用户对象（不含 salt/pw） */
export async function findUserById(id) {
  if (dbMode === 'sql') {
    const r = await pool.query(
      'SELECT id, username, email, phone, created_at FROM users WHERE id=$1',
      [id]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      phone: row.phone,
      createdAt: iso(row.created_at),
    };
  }
  const u = readUsersJson().find((x) => x.id === id);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email || null,
    phone: u.phone || null,
    createdAt: u.createdAt,
  };
}

/* ------------------------- 验证码（OTP） ------------------------- */

/**
 * 写入（并作废旧的）某手机号的验证码。每个手机号同时只保留一条有效记录。
 * @param {string} phone
 * @param {string} code   明文 6 位验证码
 * @param {number} ttlMs  有效期（毫秒）
 */
export async function saveOtp(phone, code, ttlMs) {
  const lower = String(phone || '').toLowerCase();
  if (!lower) return;
  if (dbMode === 'sql') {
    await pool.query('DELETE FROM otp WHERE lower(phone)=$1', [lower]);
    await pool.query(
      'INSERT INTO otp (phone, code, expires_at, created_at) VALUES ($1,$2,now()+$3::int*interval \'1 ms\',$4)',
      [lower, code, ttlMs, new Date().toISOString()]
    );
    return;
  }
  // JSON 回退：存到 .cache/otp/<phone>.json
  const file = path.join(OT_DIR, `${lower}.json`);
  fs.mkdirSync(OT_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ phone: lower, code, expiresAt: Date.now() + ttlMs, createdAt: Date.now() }),
    { mode: 0o600 }
  );
}

/**
 * 取某手机号当前有效的验证码记录（不含已删除的）。
 * @returns {Promise<{code:string, expiresAt:number, createdAt:number}|null>}
 */
export async function getLatestOtp(phone) {
  const lower = String(phone || '').toLowerCase();
  if (!lower) return null;
  if (dbMode === 'sql') {
    const r = await pool.query(
      `SELECT code, expires_at, created_at FROM otp WHERE lower(phone)=$1 ORDER BY created_at DESC LIMIT 1`,
      [lower]
    );
    const row = r.rows[0];
    if (!row) return null;
    return { code: row.code, expiresAt: new Date(row.expires_at).getTime(), createdAt: new Date(row.created_at).getTime() };
  }
  try {
    const o = JSON.parse(fs.readFileSync(path.join(OT_DIR, `${lower}.json`), 'utf8'));
    return { code: o.code, expiresAt: o.expiresAt, createdAt: o.createdAt };
  } catch {
    return null;
  }
}

/** 作废某手机号的验证码（登录/注册成功后调用，一次性使用） */
export async function deleteOtp(phone) {
  const lower = String(phone || '').toLowerCase();
  if (!lower) return;
  if (dbMode === 'sql') {
    await pool.query('DELETE FROM otp WHERE lower(phone)=$1', [lower]);
    return;
  }
  try {
    fs.unlinkSync(path.join(OT_DIR, `${lower}.json`));
  } catch {
    /* ignore */
  }
}

/* ------------------------- 轮毂 ------------------------- */

/** 取某用户的轮毂列表（按最近使用倒序） */
export async function getWheels(uid) {
  if (dbMode === 'sql') {
    const r = await pool.query(
      `SELECT id, url, name, thumb, created_at, last_used_at
         FROM wheels WHERE owner=$1 ORDER BY last_used_at DESC`,
      [uid]
    );
    return r.rows.map((w) => ({
      id: w.id,
      url: w.url,
      name: w.name,
      thumb: w.thumb,
      createdAt: iso(w.created_at),
      lastUsedAt: iso(w.last_used_at),
    }));
  }
  return readWheelsJson(uid);
}

/**
 * 添加一个轮毂到账户。同一 url 去重（刷新名字/缩略图并提到最前）。
 * @returns {object|null} 新增/已有的轮毂记录
 */
export async function addWheel(uid, { url, name, thumb } = {}) {
  if (!uid || !url) return null;
  if (dbMode === 'sql') {
    const existing = await pool.query(
      'SELECT id, name, thumb FROM wheels WHERE owner=$1 AND url=$2',
      [uid, url]
    );
    if (existing.rowCount > 0) {
      const w = existing.rows[0];
      await pool.query(
        `UPDATE wheels
            SET name = COALESCE(NULLIF($2, ''), name),
                thumb = COALESCE(NULLIF($3, ''), thumb),
                last_used_at = now()
          WHERE id=$1`,
        [w.id, name || null, thumb || null]
      );
      const upd = await pool.query(
        'SELECT id, url, name, thumb, created_at, last_used_at FROM wheels WHERE id=$1',
        [w.id]
      );
      const row = upd.rows[0];
      return {
        id: row.id, url: row.url, name: row.name, thumb: row.thumb,
        createdAt: iso(row.created_at), lastUsedAt: iso(row.last_used_at),
      };
    }
    const id = 'wh-' + crypto.randomBytes(6).toString('hex');
    const r = await pool.query(
      `INSERT INTO wheels (id, owner, url, name, thumb)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, url, name, thumb, created_at, last_used_at`,
      [id, uid, url, name || '我的轮毂', thumb || '']
    );
    const row = r.rows[0];
    return {
      id: row.id, url: row.url, name: row.name, thumb: row.thumb,
      createdAt: iso(row.created_at), lastUsedAt: iso(row.last_used_at),
    };
  }
  // JSON 回退（保持原有逻辑）
  const list = readWheelsJson(uid);
  const idx = list.findIndex((w) => w.url === url);
  if (idx >= 0) {
    const w = list[idx];
    if (name) w.name = name;
    if (thumb) w.thumb = thumb;
    w.lastUsedAt = new Date().toISOString();
    list.splice(idx, 1);
    list.unshift(w);
    writeWheelsJson(uid, list);
    return w;
  }
  const w = {
    id: 'wh-' + crypto.randomBytes(6).toString('hex'),
    url,
    name: name || '我的轮毂',
    thumb: thumb || '',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  list.unshift(w);
  writeWheelsJson(uid, list);
  return w;
}

/** 删除一个轮毂，返回删除后的列表 */
export async function removeWheel(uid, id) {
  if (!uid || !id) return [];
  if (dbMode === 'sql') {
    await pool.query('DELETE FROM wheels WHERE owner=$1 AND id=$2', [uid, id]);
    return getWheels(uid);
  }
  const list = readWheelsJson(uid).filter((w) => w.id !== id);
  writeWheelsJson(uid, list);
  return list;
}

/* ------------------------- 模型文件（GLB） ------------------------- */

/**
 * 把生成的 GLB 字节持久化到数据库。
 *   · SQL 模式：真正落库（INSERT ... ON CONFLICT DO UPDATE 幂等），
 *     这样 Railway 重新部署把 .cache 清空后，本地缺失的模型能从 DB 取回。
 *   · JSON 模式：no-op——本地 .cache/models 已经是真源，无需重复存。
 *
 * @param {string} name   文件名（含 .glb），作为主键
 * @param {Buffer} buffer GLB 二进制
 */
export async function saveModel(name, buffer) {
  if (dbMode !== 'sql') return;
  if (!name || !Buffer.isBuffer(buffer) || buffer.length < 12) return;
  await pool.query(
    `INSERT INTO models (name, data, created_at) VALUES ($1,$2,now())
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
    [String(name), buffer]
  );
}

/**
 * 从数据库取回 GLB 字节（仅 SQL 模式有意义；JSON 模式返回 null）。
 * @param {string} name
 * @returns {Promise<{data:Buffer, createdAt:string}|null>}
 */
export async function getModel(name) {
  if (dbMode !== 'sql') return null;
  if (!name) return null;
  const r = await pool.query('SELECT data, created_at FROM models WHERE name=$1', [String(name)]);
  const row = r.rows[0];
  if (!row) return null;
  return { data: row.data, createdAt: iso(row.created_at) };
}

/** 模型是否已存库（仅 SQL 模式） */
export async function modelExists(name) {
  if (dbMode !== 'sql') return false;
  if (!name) return false;
  const r = await pool.query('SELECT 1 FROM models WHERE name=$1', [String(name)]);
  return r.rowCount > 0;
}

/* ------------------------- 整车方案（按账号） ------------------------- */

function planFileFor(uid) {
  return path.join(PLANS_DIR, `${uid}.json`);
}
function readPlansJson(uid) {
  try {
    const list = JSON.parse(fs.readFileSync(planFileFor(uid), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writePlansJson(uid, list) {
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.writeFileSync(planFileFor(uid), JSON.stringify(list, null, 2), { mode: 0o600 });
}

/**
 * 取某账号的全部整车方案（按最近更新倒序）。
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
export async function getPlans(uid) {
  if (dbMode !== 'sql' || !uid) return readPlansJson(uid);
  const r = await pool.query(
    'SELECT data, updated_at FROM plans WHERE owner=$1 ORDER BY updated_at DESC',
    [uid]
  );
  return r.rows.map((row) => row.data);
}

/**
 * 写入/更新一个整车方案（按 owner+id 幂等 upsert）。
 * SQL 模式整份存 JSONB；JSON 模式回退到本地文件。
 * @param {string} uid
 * @param {object} plan 含 id 的方案对象
 * @returns {Promise<object|null>}
 */
export async function upsertPlan(uid, plan) {
  if (!uid || !plan || !plan.id) return null;
  if (dbMode === 'sql') {
    await pool.query(
      `INSERT INTO plans (id, owner, data, updated_at, created_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (owner, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [String(plan.id), uid, plan]
    );
    return plan;
  }
  const list = readPlansJson(uid);
  const idx = list.findIndex((p) => p.id === plan.id);
  if (idx >= 0) list[idx] = plan;
  else list.unshift(plan);
  writePlansJson(uid, list);
  return plan;
}

/** 删除一个方案，返回删除后列表 */
export async function deletePlan(uid, id) {
  if (!uid || !id) return [];
  if (dbMode === 'sql') {
    await pool.query('DELETE FROM plans WHERE owner=$1 AND id=$2', [uid, String(id)]);
    return getPlans(uid);
  }
  const list = readPlansJson(uid).filter((p) => p.id !== id);
  writePlansJson(uid, list);
  return list;
}
