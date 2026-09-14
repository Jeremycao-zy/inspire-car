/**
 * server/wheels.mjs — 「轮毂仓库」服务端持久化
 *
 * 设计要点：
 *   · 生成的轮毂 GLB 已落在 .cache/models/（经 /api/asset/:name 下发），
 *     这里只维护「某个账户拥有哪些轮毂」的索引，不再复制大文件。
 *   · 索引按用户分文件：.cache/wheels/<userId>.json（数组）。
 *     userId 来自 JWT（server/auth.mjs 的 verifyToken）；未登录请求回退 'anon'，
 *     保证不登录也能用，登录后归属到账户（满足"他的账户持续拥有"）。
 *   · 每个轮毂记录 { id, url, name, thumb, createdAt }；url 指向 /api/asset/<name>。
 *   · 同一 url 不重复（换装任意车都复用同一条记录），删除只删索引不影响 GLB。
 *
 * 与 recognition / specs 一样，纯 Node 内置模块，零三方依赖。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyToken } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, '.cache', 'wheels');

function fileForUser(uid) {
  return path.join(DIR, `${uid}.json`);
}

export function getWheels(uid) {
  try {
    const list = JSON.parse(fs.readFileSync(fileForUser(uid), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function setWheels(uid, list) {
  fs.mkdirSync(DIR, { recursive: true });
  // 上限保护：单用户最多保留 60 条，超出丢弃最旧
  const MAX = 60;
  if (list.length > MAX) list.length = MAX;
  fs.writeFileSync(fileForUser(uid), JSON.stringify(list, null, 2), { mode: 0o600 });
}

/**
 * 添加一个轮毂到账户。同一 url 去重（移到最前）。
 * @returns {object|null} 新增/已有的轮毂记录
 */
export function addWheel(uid, { url, name, thumb } = {}) {
  if (!uid || !url) return null;
  const list = getWheels(uid);
  const idx = list.findIndex((w) => w.url === url);
  if (idx >= 0) {
    // 已有：把名字/缩略图刷新到最新，并提到最前
    const w = list[idx];
    if (name) w.name = name;
    if (thumb) w.thumb = thumb;
    w.lastUsedAt = new Date().toISOString();
    list.splice(idx, 1);
    list.unshift(w);
    setWheels(uid, list);
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
  setWheels(uid, list);
  return w;
}

/** 删除一个轮毂（只删索引，不影响 .cache/models 下的 GLB） */
export function removeWheel(uid, id) {
  if (!uid || !id) return [];
  const list = getWheels(uid).filter((w) => w.id !== id);
  setWheels(uid, list);
  return list;
}

/**
 * 从请求解析归属用户：Authorization: Bearer <jwt> → verifyToken → uid。
 * 无 token / 非法 → 'anon'（共享全局库）。
 */
export function resolveWheelOwner(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (m) {
    try {
      const p = verifyToken(m[1]);
      if (p && p.uid) return p.uid;
    } catch {
      /* 落到 anon */
    }
  }
  return 'anon';
}
