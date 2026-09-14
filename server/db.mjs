/**
 * server/db.mjs — 用户与轮毂数据的持久化层
 *
 * 双模式（调用方 auth.mjs / wheels.mjs 无需感知当前是哪种）：
 *
 *   · SQL 模式（生产 / 有 DATABASE_URL）：
 *      使用 PostgreSQL（pg）。启动自动建表（users / wheels + 唯一/普通索引），
 *      账号与「我的轮毂」索引真正持久化，Railway 重新部署后数据不丢。
 *      仅当 DATABASE_URL 存在时才动态 import('pg')，所以本地没装 pg 也不会报错。
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
      salt       TEXT NOT NULL,
      pw         TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username))'
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email)) WHERE email IS NOT NULL'
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
}

/* ------------------------- JSON 回退存储 ------------------------- */

const USERS_DIR = path.join(ROOT, '.cache', 'users');
const WHEELS_DIR = path.join(ROOT, '.cache', 'wheels');
const MODELS_DIR = path.join(ROOT, '.cache', 'models');
const USERS_FILE = path.join(USERS_DIR, 'users.json');

function ensureJsonDirs() {
  try {
    fs.mkdirSync(USERS_DIR, { recursive: true });
    fs.mkdirSync(WHEELS_DIR, { recursive: true });
    fs.mkdirSync(MODELS_DIR, { recursive: true });
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

/**
 * 写入新用户（调用方已保证用户名/邮箱不冲突、密码已哈希）。
 * @param {{id,username,email,salt,pw}} record
 */
export async function createUser(record) {
  if (dbMode === 'sql') {
    await pool.query(
      'INSERT INTO users (id, username, email, salt, pw) VALUES ($1,$2,$3,$4,$5)',
      [record.id, record.username, record.email || null, record.salt, record.pw]
    );
    return;
  }
  const users = readUsersJson();
  users.push({
    id: record.id,
    username: record.username,
    email: record.email || null,
    salt: record.salt,
    pw: record.pw,
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
      `SELECT id, username, email, salt, pw, created_at
         FROM users WHERE lower(username)=$1 OR lower(email)=$1
         LIMIT 1`,
      [lower]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      salt: row.salt,
      pw: row.pw,
      createdAt: iso(row.created_at),
    };
  }
  const users = readUsersJson();
  return (
    users.find(
      (u) => u.username.toLowerCase() === lower || (u.email && u.email.toLowerCase() === lower)
    ) || null
  );
}

/** 按 id 查公开用户对象（不含 salt/pw） */
export async function findUserById(id) {
  if (dbMode === 'sql') {
    const r = await pool.query(
      'SELECT id, username, email, created_at FROM users WHERE id=$1',
      [id]
    );
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.id, username: row.username, email: row.email, createdAt: iso(row.created_at) };
  }
  const u = readUsersJson().find((x) => x.id === id);
  if (!u) return null;
  return { id: u.id, username: u.username, email: u.email || null, createdAt: u.createdAt };
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
