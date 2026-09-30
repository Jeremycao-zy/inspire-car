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
    try {
      await seedNewsIfEmpty();
    } catch (e) {
      console.warn('[db] 资讯种子数据写入失败（可忽略）：', e?.message || e);
    }
    return {
      mode: 'json',
      note: 'DATABASE_URL 未设置，使用本地 JSON 文件存储（仅开发可用，Railway 上数据不持久）',
    };
  }
  // 有 DATABASE_URL：优先走 PostgreSQL；但连接失败必须**优雅回退**到 JSON 模式，
  // 绝不能让 DB 抖动把整个服务打挂 —— 否则 Railway 会崩溃重启循环 → 公网持久 502。
  try {
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
    // 卷模式：启动即迁移（库里 GLB 大对象 → .cache 持久卷），失败不阻塞启动
    if (MODEL_VOLUME) {
      try {
        await hydrateModelsToVolume();
      } catch (e) {
        console.warn('[db] 卷模式迁移失败（不影响启动，下次重试）：', e?.message || e);
      }
    }
    dbMode = 'sql';
    try {
      await seedNewsIfEmpty();
    } catch (e) {
      console.warn('[db] 资讯种子数据写入失败（可忽略）：', e?.message || e);
    }
    return { mode: 'sql' };
  } catch (err) {
    // 连接失败：清空池、回退 JSON 模式，服务照常启动（数据落容器本地，不持久，但站点不挂）
    pool = null;
    dbMode = 'json';
    ensureJsonDirs();
    console.warn(
      '\n  ⚠️  PostgreSQL 连接失败，已回退到本地 JSON 文件存储（服务继续运行，但数据不持久）：\n' +
      '      ' + (err && err.message ? err.message : String(err)) + '\n'
    );
    return { mode: 'json', note: 'DATABASE_URL 存在但连接失败，已回退 JSON 模式' };
  }
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
  // 卷模式（MODEL_VOLUME=1）下 DB 只存元数据，data 允许为 NULL（幂等，重复部署不报错）
  await pool.query('ALTER TABLE models ALTER COLUMN data DROP NOT NULL');

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

  // 社区模块：论坛主题 / 论坛回复 / 资讯（自动更新内容）
  // category 约定：
  //   forum_topics.category ∈ { chat(改装交流), help(求助), show(展示) }
  //   news.category          ∈ { news(改装资讯), race(赛事), event(活动) }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forum_topics (
      id          SERIAL PRIMARY KEY,
      uid         TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'chat',
      reply_count INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS forum_topics_created ON forum_topics (created_at DESC)'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forum_replies (
      id          SERIAL PRIMARY KEY,
      topic_id    INT NOT NULL,
      uid         TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS forum_replies_topic ON forum_replies (topic_id)'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news (
      id           SERIAL PRIMARY KEY,
      title        TEXT NOT NULL,
      summary      TEXT NOT NULL DEFAULT '',
      body         TEXT NOT NULL DEFAULT '',
      category     TEXT NOT NULL DEFAULT 'news',
      cover        TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS news_published ON news (published_at DESC)'
  );
}

/* ------------------------- JSON 回退存储 ------------------------- */

const USERS_DIR = path.join(ROOT, '.cache', 'users');
const WHEELS_DIR = path.join(ROOT, '.cache', 'wheels');
const MODELS_DIR = path.join(ROOT, '.cache', 'models');
const PLANS_DIR = path.join(ROOT, '.cache', 'plans');
const OT_DIR = path.join(ROOT, '.cache', 'otp');
const FORUM_DIR = path.join(ROOT, '.cache', 'forum');
const NEWS_DIR = path.join(ROOT, '.cache', 'news');
const USERS_FILE = path.join(USERS_DIR, 'users.json');
const FORUM_TOPICS_FILE = path.join(FORUM_DIR, 'topics.json');
const FORUM_REPLIES_FILE = path.join(FORUM_DIR, 'replies.json');
const NEWS_FILE = path.join(NEWS_DIR, 'news.json');

function ensureJsonDirs() {
  try {
    fs.mkdirSync(USERS_DIR, { recursive: true });
    fs.mkdirSync(WHEELS_DIR, { recursive: true });
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    fs.mkdirSync(PLANS_DIR, { recursive: true });
    fs.mkdirSync(OT_DIR, { recursive: true });
    fs.mkdirSync(FORUM_DIR, { recursive: true });
    fs.mkdirSync(NEWS_DIR, { recursive: true });
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

/** SQL 库里 GLB 缓存的最大保留条数（整车 + BANG 部件都算，1 辆车约 6 条）。
 *  只进不出的落库曾把 Railway Postgres 磁盘写满（No space left on device）。
 *  注意：被任一方案引用的模型（见 pruneModels 的 protect 子查询）永不在此额度内被清，
 *  所以"保存过的车"不会因为生成了几台新车就消失——这是防丢失的主防线。 */
const MODEL_DB_RETENTION = Math.max(4, parseInt(process.env.MODEL_DB_RETENTION || '24', 10) || 24);
/** 小体积索引文件，永不清理 */
const MODEL_DB_KEEP_FOREVER = '__bang-index.json';
/** 卷模式（MODEL_VOLUME=1）：GLB 文件以 .cache 持久卷为真源，DB 只存元数据（data=NULL）。
 *  免费层 Postgres 卷仅 500MB，而单个 GLB 12–44MB，把大对象塞库里必然写满磁盘 → 连接失败 → 502。
 *  开启前需给应用服务挂载持久卷到 /app/.cache（Railway 控制台 Settings → Volumes）。 */
const MODEL_VOLUME = process.env.MODEL_VOLUME === '1';
/** 字节预算（非卷模式的兜底防线）：models 表总字节数超过此值时，从最旧的非保护记录开始删。
 *  现有"条数 LRU"在「方案引用的模型永不驱逐」下会无上限增长，字节预算补上这个洞。 */
const MODEL_DB_MAX_BYTES =
  Math.max(64, parseInt(process.env.MODEL_DB_MAX_MB || '400', 10) || 400) * 1024 * 1024;

/**
 * 从方案对象里取出它引用的 GLB 文件名（basename，兼容 '/api/asset/xxx.glb' 与 'xxx.glb'）。
 * 方案可能用 model / bodyUrl / bodyModelUrl 任一字段指向整车 GLB。
 * @returns {string|null}
 */
function modelNameOfPlan(plan) {
  const ref = plan && (plan.model || plan.bodyUrl || plan.bodyModelUrl);
  if (!ref || typeof ref !== 'string') return null;
  const base = ref.split('/').pop();
  return base && base.toLowerCase().endsWith('.glb') ? base : null;
}

/**
 * 只保留最近 keep 条模型缓存（按 created_at），删除更旧的，防止 Postgres 磁盘被 GLB 写满。
 * 删掉的只是「重新部署后回源用的缓存」——最旧的方案本来也得重新生成才有部件。
 *
 * 关键保护：任一方案（plans 表 data->model/bodyUrl/bodyModelUrl）引用的模型**永不在此额度内被清**，
 * 这样用户"保存过的车"不会因为之后又生成几台新车而被 LRU 挤掉导致打开时 404「模型丢失」。
 * @returns {Promise<number>} 删除的条数
 */
/** 删除卷上的模型文件（卷模式用）；索引等非 GLB 文件不动 */
function unlinkModelFile(name) {
  try {
    const safe = path.basename(String(name));
    if (!safe || safe === MODEL_DB_KEEP_FOREVER) return;
    if (safe.toLowerCase().endsWith('.glb')) fs.unlinkSync(path.join(MODELS_DIR, safe));
  } catch {
    /* 文件可能已不存在，忽略 */
  }
}

export async function pruneModels(keep = MODEL_DB_RETENTION) {
  if (dbMode !== 'sql') return 0;
  // —— 1) 条数 LRU：只保留最近 keep 条非保护记录（原有逻辑）——
  const r = await pool.query(
    `DELETE FROM models
      WHERE name <> $2
        AND name NOT IN (
          SELECT name FROM models WHERE name <> $2
          ORDER BY created_at DESC LIMIT $1
        )
        AND name NOT IN (
          SELECT DISTINCT substring(
            COALESCE(data->>'model', data->>'bodyUrl', data->>'bodyModelUrl') FROM '[^/]+$'
          ) AS nm
          FROM plans
          WHERE (data->>'model' IS NOT NULL OR data->>'bodyUrl' IS NOT NULL OR data->>'bodyModelUrl' IS NOT NULL)
            AND substring(COALESCE(data->>'model', data->>'bodyUrl', data->>'bodyModelUrl') FROM '[^/]+$') LIKE '%.glb'
        )
      RETURNING name`,
    [keep, MODEL_DB_KEEP_FOREVER]
  );
  let n = r.rowCount || 0;
  if (MODEL_VOLUME) for (const row of r.rows) unlinkModelFile(row.name);
  // —— 2) 字节预算兜底：条数 LRU 挡不住「方案引用的模型永不驱逐」的无上限增长，
  //      500MB 小卷会被写满 → PG 拒连 → 502。超预算时从最旧的非保护记录开始删。——
  try {
    const agg = await pool.query(
      'SELECT coalesce(sum(octet_length(data)),0)::bigint AS b FROM models'
    );
    let total = Number(agg.rows[0].b);
    if (total > MODEL_DB_MAX_BYTES) {
      const old = await pool.query(
        `SELECT name, octet_length(data) AS bytes FROM models
          WHERE name <> $1
            AND name NOT IN (
              SELECT DISTINCT substring(
                COALESCE(data->>'model', data->>'bodyUrl', data->>'bodyModelUrl') FROM '[^/]+$'
              ) AS nm
              FROM plans
              WHERE (data->>'model' IS NOT NULL OR data->>'bodyUrl' IS NOT NULL OR data->>'bodyModelUrl' IS NOT NULL)
                AND substring(COALESCE(data->>'model', data->>'bodyUrl', data->>'bodyModelUrl') FROM '[^/]+$') LIKE '%.glb'
            )
          ORDER BY created_at ASC`,
        [MODEL_DB_KEEP_FOREVER]
      );
      for (const row of old.rows) {
        if (total <= MODEL_DB_MAX_BYTES) break;
        const d = await pool.query('DELETE FROM models WHERE name=$1 RETURNING name', [row.name]);
        if (d.rowCount > 0) {
          total -= Number(row.bytes) || 0;
          n++;
          if (MODEL_VOLUME) unlinkModelFile(row.name);
        }
      }
      console.log(
        `[db] models 总量超出字节预算（${Math.round(MODEL_DB_MAX_BYTES / 1048576)}MB），已清理最旧记录，现删 ${n} 条`
      );
    }
  } catch (e) {
    console.warn('[db] 字节预算清理失败（不影响主流程）：', e?.message || e);
  }
  return n;
}

/**
 * 把生成的 GLB 字节持久化到数据库。
 *   · SQL 模式：真正落库（INSERT ... ON CONFLICT DO UPDATE 幂等），
 *     这样 Railway 重新部署把 .cache 清空后，本地缺失的模型能从 DB 取回。
 *   · JSON 模式：no-op——本地 .cache/models 已经是真源，无需重复存。
 *
 * 韧性约定（重要）：落库只是「回源缓存」，写库失败绝不能让一次已经成功的生成被判失败——
 * 磁盘满时先 pruneModels 腾空间重试一次，仍失败则告警跳过。
 *
 * @param {string} name   文件名（含 .glb），作为主键
 * @param {Buffer} buffer GLB 二进制
 */
export async function saveModel(name, buffer) {
  if (dbMode !== 'sql') return;
  if (!name || !Buffer.isBuffer(buffer) || buffer.length < 12) return;
  // 卷模式：文件已由调用方写入 .cache 持久卷（真源），DB 只登记元数据，不再吃 GLB 大对象。
  // 这样免费层 500MB 的 Postgres 卷永远不会被车模写满。
  if (MODEL_VOLUME) {
    try {
      await pool.query(
        `INSERT INTO models (name, data, created_at) VALUES ($1, NULL, now())
         ON CONFLICT (name) DO UPDATE SET created_at = now()`,
        [String(name)]
      );
    } catch {
      /* 元数据登记失败不影响生成结果 */
    }
    return;
  }
  const q = `INSERT INTO models (name, data, created_at) VALUES ($1,$2,now())
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, created_at = now()`;
  try {
    await pool.query(q, [String(name), buffer]);
  } catch {
    try {
      await pruneModels(); // 大概率是磁盘满：清最旧的缓存腾出空间再试一次
      await pool.query(q, [String(name), buffer]);
    } catch (e2) {
      console.warn('[db] 模型落库失败（已跳过，不影响生成结果）：', e2?.message || e2);
      return;
    }
  }
  try {
    const pruned = await pruneModels();
    if (pruned > 0) console.log(`[db] 模型缓存超出保留额度（${MODEL_DB_RETENTION}），已清理 ${pruned} 条最旧记录`);
  } catch {}
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

/**
 * 卷模式一次性迁移：把库里的 GLB 大对象搬到 .cache 持久卷，然后清空表内大对象。
 * 用 TRUNCATE+重插元数据而不是逐行置 NULL——PG 的 DELETE/UPDATE 不归还磁盘空间，
 * VACUUM FULL 又需要约等于表大小的临时空间（99% 满的盘上必然失败），
 * 只有 TRUNCATE 能瞬时把空间还给文件系统。
 * 安全阀：只有「所有行都成功落盘」才执行 TRUNCATE；任何写盘失败都保留库内原数据并告警，
 * 下次启动自动重试（幂等：卷上已存在的文件直接跳过）。
 * @returns {Promise<{skipped?:boolean, rows?:number, written?:number, existing?:number, failed?:number, truncated?:boolean}>}
 */
export async function hydrateModelsToVolume() {
  if (dbMode !== 'sql' || !MODEL_VOLUME) return { skipped: true };
  const r = await pool.query(
    'SELECT name, data FROM models WHERE data IS NOT NULL ORDER BY created_at ASC'
  );
  if (r.rowCount === 0) return { rows: 0, written: 0, existing: 0, truncated: false };
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  let written = 0;
  let existing = 0;
  let failed = 0;
  for (const row of r.rows) {
    const safe = path.basename(String(row.name));
    const file = path.join(MODELS_DIR, safe);
    try {
      if (fs.existsSync(file)) {
        existing++;
      } else {
        fs.writeFileSync(file, row.data);
        written++;
      }
    } catch (e) {
      failed++;
      console.warn('[db] 模型迁移写盘失败（保留库内数据，下次启动重试）：', safe, e?.message || e);
    }
  }
  if (failed > 0) {
    return { rows: r.rowCount, written, existing, failed, truncated: false };
  }
  // 单条 simple query 内多语句 = 同一隐式事务；TRUNCATE 瞬时归还磁盘空间
  await pool.query(`
    CREATE TEMP TABLE _model_meta ON COMMIT DROP AS
      SELECT name, created_at FROM models;
    TRUNCATE models;
    INSERT INTO models (name, data, created_at)
      SELECT name, NULL, created_at FROM _model_meta;
  `);
  console.log(
    `[db] 卷模式迁移完成：${written} 个模型写入持久卷，${existing} 个已存在；models 表大对象已清空，Postgres 磁盘空间已释放`
  );
  return { rows: r.rowCount, written, existing, truncated: true };
}

/**
 * 只读诊断（排查"模型丢失"用）：返回 models 表概况、指定模型是否存在、
 * 最近若干条记录，以及指定方案是否仍存在并引用了哪个模型名。
 * 仅 SQL 模式有意义；JSON 模式返回 { mode:'json' }。
 * @param {string} [modelName]  要查是否存在的 GLB 文件名
 * @param {string} [planId]      要查的方案 id（跨用户按主键查）
 */
export async function diagAsset(modelName, planId) {
  if (dbMode !== 'sql') return { mode: 'json' };
  const out = { mode: 'sql', retention: MODEL_DB_RETENTION };
  const agg = await pool.query(
    'SELECT count(*)::int AS c, coalesce(sum(octet_length(data)),0)::bigint AS b FROM models'
  );
  out.modelCount = Number(agg.rows[0].c);
  out.totalBytes = Number(agg.rows[0].b);
  if (modelName) {
    const m = await pool.query(
      'SELECT name, created_at, octet_length(data) AS bytes FROM models WHERE name=$1',
      [String(modelName)]
    );
    out.target = m.rows[0]
      ? { name: m.rows[0].name, createdAt: iso(m.rows[0].created_at), bytes: Number(m.rows[0].bytes) }
      : null;
  }
  const recent = await pool.query(
    'SELECT name, created_at, octet_length(data) AS bytes FROM models WHERE name <> $1 ORDER BY created_at DESC LIMIT 15',
    [MODEL_DB_KEEP_FOREVER]
  );
  out.recent = recent.rows.map((r) => ({
    name: r.name,
    createdAt: iso(r.created_at),
    bytes: Number(r.bytes),
  }));
  if (planId) {
    const p = await pool.query('SELECT owner, data FROM plans WHERE id=$1', [String(planId)]);
    const row = p.rows[0];
    out.plan = row
      ? {
          owner: row.owner,
          model:
            (row.data && (row.data.model || row.data.bodyUrl || row.data.bodyModelUrl)) || null,
        }
      : null;
  }
  return out;
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
    // 方案引用的整车 GLB：把它的 created_at 刷到最新，既让它留在 LRU 窗口内，
    // 也确保 pruneModels 的 protect 子查询覆盖它——双保险防「保存的车消失」。
    const mname = modelNameOfPlan(plan);
    if (mname) {
      try {
        await pool.query(
          `UPDATE models SET created_at = now() WHERE name = $1`,
          [mname]
        );
      } catch {
        /* 模型可能尚未落库（生成失败），忽略即可 */
      }
    }
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

/* ------------------------- 社区：论坛 + 资讯 ------------------------- */

/* ---- JSON 回退读写（与 plans 等保持同一风格） ---- */

function readForumTopicsJson() {
  try {
    const list = JSON.parse(fs.readFileSync(FORUM_TOPICS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeForumTopicsJson(list) {
  fs.mkdirSync(FORUM_DIR, { recursive: true });
  fs.writeFileSync(FORUM_TOPICS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}
function readForumRepliesJson() {
  try {
    const list = JSON.parse(fs.readFileSync(FORUM_REPLIES_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeForumRepliesJson(list) {
  fs.mkdirSync(FORUM_DIR, { recursive: true });
  fs.writeFileSync(FORUM_REPLIES_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}
function readNewsJson() {
  try {
    const list = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeNewsJson(list) {
  fs.mkdirSync(NEWS_DIR, { recursive: true });
  fs.writeFileSync(NEWS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** 给一条主题补上作者用户名（JSON 模式靠 findUserById，SQL 模式靠 JOIN） */
function withTopicAuthor(t) {
  return { ...t, username: t.username || '匿名' };
}

/** 论坛主题分类白名单：改装交流 / 求助 / 展示（与前端 FORUM_CATS 一致） */
const FORUM_TOPIC_CATS = ['chat', 'help', 'show'];

/**
 * 论坛主题列表（按 created_at DESC），附带作者用户名。
 * @param {{category?:string, page?:number, pageSize?:number}} opts
 * @returns {Promise<{total:number, page:number, pageSize:number, topics:object[]}>}
 */
export async function listTopics({ category, page = 1, pageSize = 20 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  if (dbMode === 'sql') {
    const where = category ? 'WHERE t.category=$1' : '';
    const params = category ? [String(category)] : [];
    const countR = await pool.query(
      `SELECT COUNT(*)::int AS c FROM forum_topics t ${where}`,
      params
    );
    const total = countR.rows[0].c;
    const offset = (safePage - 1) * safeSize;
    const rows = await pool.query(
      `SELECT t.id, t.uid, t.title, t.body, t.category, t.reply_count, t.created_at, u.username
       FROM forum_topics t LEFT JOIN users u ON u.id = t.uid
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeSize, offset]
    );
    const topics = rows.rows.map((r) => ({
      id: Number(r.id),
      uid: r.uid,
      username: r.username || '匿名',
      title: r.title,
      body: r.body,
      category: r.category,
      replyCount: Number(r.reply_count || 0),
      createdAt: iso(r.created_at),
    }));
    return { total, page: safePage, pageSize: safeSize, topics };
  }
  // JSON 模式
  const all = readForumTopicsJson();
  const filtered = category ? all.filter((t) => t.category === category) : all;
  const sorted = filtered
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const total = sorted.length;
  const start = (safePage - 1) * safeSize;
  const topics = await Promise.all(
    sorted.slice(start, start + safeSize).map(async (t) => {
      const user = await findUserById(t.uid);
      return { ...t, username: user?.username || '匿名' };
    })
  );
  return { total, page: safePage, pageSize: safeSize, topics };
}

/**
 * 创建论坛主题。
 * @param {{uid:string, title:string, body:string, category?:string}} record
 * @returns {Promise<object>} 新建的主题（含 id / username / createdAt）
 */
export async function createTopic({ uid, title, body, category = 'chat' } = {}) {
  uid = String(uid || '');
  title = String(title || '').trim();
  body = String(body || '').trim();
  category = String(category || 'chat');
  // 白名单校验：仅允许 改装交流(chat) / 求助(help) / 展示(show)，
  // 与前端 FORUM_CATS、forumCatLabel 保持一致；越界值直接 400，不落库。
  if (!FORUM_TOPIC_CATS.includes(category)) throw new Error('非法的帖子分类');
  if (!uid) throw new Error('未登录');
  if (!title) throw new Error('标题不能为空');
  if (!body) throw new Error('正文不能为空');
  if (dbMode === 'sql') {
    const r = await pool.query(
      `INSERT INTO forum_topics (uid, title, body, category)
       VALUES ($1, $2, $3, $4)
       RETURNING id, uid, title, body, category, reply_count, created_at`,
      [uid, title, body, category]
    );
    const row = r.rows[0];
    const user = await findUserById(uid);
    return {
      id: Number(row.id),
      uid: row.uid,
      username: user?.username || '匿名',
      title: row.title,
      body: row.body,
      category: row.category,
      replyCount: Number(row.reply_count || 0),
      createdAt: iso(row.created_at),
    };
  }
  const topics = readForumTopicsJson();
  const id = topics.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;
  const topic = {
    id,
    uid,
    title,
    body,
    category,
    replyCount: 0,
    createdAt: new Date().toISOString(),
  };
  topics.unshift(topic);
  writeForumTopicsJson(topics);
  const user = await findUserById(uid);
  return { ...topic, username: user?.username || '匿名' };
}

/**
 * 取单个主题详情 + 其下所有回复（按 created_at ASC）。
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
export async function getTopic(id) {
  id = Number(id);
  if (!id) return null;
  if (dbMode === 'sql') {
    const tr = await pool.query(
      `SELECT t.id, t.uid, t.title, t.body, t.category, t.reply_count, t.created_at, u.username
       FROM forum_topics t LEFT JOIN users u ON u.id = t.uid
       WHERE t.id=$1`,
      [id]
    );
    const trow = tr.rows[0];
    if (!trow) return null;
    const rr = await pool.query(
      `SELECT r.id, r.topic_id, r.uid, r.body, r.created_at, u.username
       FROM forum_replies r LEFT JOIN users u ON u.id = r.uid
       WHERE r.topic_id=$1 ORDER BY r.created_at ASC`,
      [id]
    );
    const replies = rr.rows.map((r) => ({
      id: Number(r.id),
      topicId: Number(r.topic_id),
      uid: r.uid,
      username: r.username || '匿名',
      body: r.body,
      createdAt: iso(r.created_at),
    }));
    return {
      id: Number(trow.id),
      uid: trow.uid,
      username: trow.username || '匿名',
      title: trow.title,
      body: trow.body,
      category: trow.category,
      replyCount: Number(trow.reply_count || 0),
      createdAt: iso(trow.created_at),
      replies,
    };
  }
  const topics = readForumTopicsJson();
  const raw = topics.find((t) => Number(t.id) === id);
  if (!raw) return null;
  const user = await findUserById(raw.uid);
  const repliesRaw = readForumRepliesJson()
    .filter((r) => Number(r.topicId) === id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const replies = await Promise.all(
    repliesRaw.map(async (r) => {
      const ru = await findUserById(r.uid);
      return {
        id: r.id,
        topicId: r.topicId,
        uid: r.uid,
        username: ru?.username || '匿名',
        body: r.body,
        createdAt: r.createdAt,
      };
    })
  );
  return {
    id: raw.id,
    uid: raw.uid,
    username: user?.username || '匿名',
    title: raw.title,
    body: raw.body,
    category: raw.category,
    replyCount: raw.replyCount || 0,
    createdAt: raw.createdAt,
    replies,
  };
}

/**
 * 创建一条回复，并让主题的 reply_count +1。
 * @param {{uid:string, topicId:number|string, body:string}} record
 * @returns {Promise<object>} 新建的回复
 */
export async function createReply({ uid, topicId, body } = {}) {
  uid = String(uid || '');
  topicId = Number(topicId);
  body = String(body || '').trim();
  if (!uid) throw new Error('未登录');
  if (!topicId) throw new Error('主题不存在');
  if (!body) throw new Error('评论内容不能为空');
  if (dbMode === 'sql') {
    const chk = await pool.query('SELECT 1 FROM forum_topics WHERE id=$1', [topicId]);
    if (chk.rowCount === 0) throw new Error('主题不存在');
    const r = await pool.query(
      `INSERT INTO forum_replies (topic_id, uid, body)
       VALUES ($1, $2, $3)
       RETURNING id, topic_id, uid, body, created_at`,
      [topicId, uid, body]
    );
    await pool.query('UPDATE forum_topics SET reply_count = reply_count + 1 WHERE id=$1', [
      topicId,
    ]);
    const row = r.rows[0];
    const user = await findUserById(uid);
    return {
      id: Number(row.id),
      topicId: Number(row.topic_id),
      uid: row.uid,
      username: user?.username || '匿名',
      body: row.body,
      createdAt: iso(row.created_at),
    };
  }
  const topics = readForumTopicsJson();
  const topic = topics.find((t) => Number(t.id) === topicId);
  if (!topic) throw new Error('主题不存在');
  const replies = readForumRepliesJson();
  const id = replies.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  const reply = {
    id,
    topicId,
    uid,
    body,
    createdAt: new Date().toISOString(),
  };
  replies.unshift(reply);
  writeForumRepliesJson(replies);
  topic.replyCount = (topic.replyCount || 0) + 1;
  writeForumTopicsJson(topics);
  const user = await findUserById(uid);
  return { ...reply, username: user?.username || '匿名' };
}

/**
 * 资讯列表（按 published_at DESC）。
 * @param {{category?:string}} opts
 * @returns {Promise<object[]>}
 */
export async function listNews({ category } = {}) {
  if (dbMode === 'sql') {
    const where = category ? 'WHERE category=$1' : '';
    const params = category ? [String(category)] : [];
    const r = await pool.query(
      `SELECT id, title, summary, body, category, cover, source, published_at
       FROM news ${where} ORDER BY published_at DESC`,
      params
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      title: row.title,
      summary: row.summary,
      body: row.body,
      category: row.category,
      cover: row.cover || '',
      source: row.source || '',
      publishedAt: iso(row.published_at),
    }));
  }
  const all = readNewsJson();
  const filtered = category ? all.filter((n) => n.category === category) : all;
  return filtered
    .slice()
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

/**
 * 创建一条资讯（后台发布用，管理员鉴权在路由层做）。
 * @param {object} record { title, summary?, body?, category?, cover?, source?, publishedAt? }
 * @returns {Promise<object>} 新建的资讯
 */
export async function createNews(record = {}) {
  const title = String(record.title || '').trim();
  const summary = String(record.summary || '').trim();
  const body = String(record.body || '').trim();
  const category = String(record.category || 'news');
  const cover = String(record.cover || '');
  const source = String(record.source || '灵感改装编辑部');
  if (!title) throw new Error('标题不能为空');
  const publishedAt = record.publishedAt
    ? new Date(record.publishedAt).toISOString()
    : new Date().toISOString();
  if (dbMode === 'sql') {
    const r = await pool.query(
      `INSERT INTO news (title, summary, body, category, cover, source, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title, summary, body, category, cover, source, published_at`,
      [title, summary, body, category, cover, source, publishedAt]
    );
    const row = r.rows[0];
    return {
      id: Number(row.id),
      title: row.title,
      summary: row.summary,
      body: row.body,
      category: row.category,
      cover: row.cover || '',
      source: row.source || '',
      publishedAt: iso(row.published_at),
    };
  }
  const news = readNewsJson();
  const id = news.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0) + 1;
  const item = { id, title, summary, body, category, cover, source, publishedAt };
  news.unshift(item);
  writeNewsJson(news);
  return item;
}

/** 构建 5 条示例资讯（2 改装资讯 / 2 赛事 / 1 活动），时间错开最近几天 */
function buildNewsSeed() {
  const now = Date.now();
  const H = 3600 * 1000;
  const D = 24 * H;
  return [
    {
      title: '宽体套件怎么选？碳纤维与玻璃钢的取舍',
      summary:
        '从重量、成本、修复难度三方面对比两类宽体材质，帮你按预算与用途做决定。',
      body:
        '碳纤维宽体轻、强度高、质感好，但价格昂贵且碰撞后几乎无法无损修复；玻璃钢（FRP）便宜、可局部修补，但偏重、韧性一般。日常街道走 Glass Fiber 足够，赛道取向再上碳纤。',
      category: 'news',
      source: '灵感改装编辑部',
      cover: '',
      publishedAt: new Date(now - 6 * H).toISOString(),
    },
    {
      title: '避震改装入门：绞牙与气动怎么选',
      summary: '想降低车身又不想每天“搓底盘”？一文讲清绞牙与气动的适用场景。',
      body:
        '绞牙避震可调高度与阻尼，支撑性好、适合下场；气动（Air Suspension）按按钮升降，姿态玩家最爱，但成本高、维护多。先想清楚用途再掏钱。',
      category: 'news',
      source: '灵感改装编辑部',
      cover: '',
      publishedAt: new Date(now - 1.5 * D).toISOString(),
    },
    {
      title: '2026 场地赛首站落幕，本土车队表现亮眼',
      summary: '新赛季开门红：本土私人车队包揽小组前二，圈速较去年提升明显。',
      body:
        '周末的场地赛首站中，多支本土私人车队凭借自研 ECU 调校与轻量化方案杀入前列。下一站移师南方赛道，期待更多国产改装件登场。',
      category: 'race',
      source: '赛道前线',
      cover: '',
      publishedAt: new Date(now - 2.5 * D).toISOString(),
    },
    {
      title: '漂移锦标赛新赛季规则解读',
      summary: '判罚尺度收紧、双人追走权重上调，车手与技师都得重新适应。',
      body:
        '新赛季漂移锦标赛对“单走失误”扣分更狠，双人追走环节占比提升到 60%。这意味着容错率更低，对车辆一致性与车手心理都是新考验。',
      category: 'race',
      source: '赛道前线',
      cover: '',
      publishedAt: new Date(now - 3.5 * D).toISOString(),
    },
    {
      title: '城市改装文化节下周开幕，免费进场',
      summary: '为期三天的线下改装盛会，云集宽体、低趴、JDM 与电动改装阵营。',
      body:
        '下周起连续三天，城市滨江广场将举办改装文化节，设置静态展示、DIY 工坊与夜场灯光秀。入场免费，现场还有资深技师答疑，欢迎带上你的爱车。',
      category: 'event',
      source: '灵感改装编辑部',
      cover: '',
      publishedAt: new Date(now - 4.5 * D).toISOString(),
    },
  ];
}

/**
 * 若资讯表为空，幂等插入示例数据（开发期零数据也能跑通）。
 * SQL 与 JSON 两种模式都会处理；已存在数据则跳过。
 */
export async function seedNewsIfEmpty() {
  if (dbMode === 'sql') {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM news');
    if (r.rows[0].c > 0) return;
    for (const n of buildNewsSeed()) {
      await pool.query(
        `INSERT INTO news (title, summary, body, category, cover, source, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [n.title, n.summary, n.body, n.category, n.cover || '', n.source, n.publishedAt]
      );
    }
    return;
  }
  const news = readNewsJson();
  if (news.length > 0) return;
  const seeded = buildNewsSeed().map((n, i) => ({ id: i + 1, ...n }));
  writeNewsJson(seeded);
}
