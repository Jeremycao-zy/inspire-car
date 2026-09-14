/**
 * server/wheels.mjs — 「轮毂仓库」服务端持久化
 *
 * 设计要点：
 *   · 生成的轮毂 GLB 已落在 .cache/models/（经 /api/asset/:name 下发），
 *     这里只维护「某个账户拥有哪些轮毂」的索引，不再复制大文件。
 *   · 索引归属由 userId 决定；userId 来自 JWT（server/auth.mjs 的 verifyToken）；
 *     未登录请求回退 'anon'，保证不登录也能用，登录后归属到账户（满足"他的账户持续拥有"）。
 *   · 每个轮毂记录 { id, url, name, thumb, createdAt, lastUsedAt }；url 指向 /api/asset/<name>。
 *   · 同一 url 不重复（换装任意车都复用同一条记录），删除只删索引不影响 GLB。
 *   · 实际存储交给 server/db.mjs（DATABASE_URL 存在 → PostgreSQL；
 *     否则 → .cache/wheels/<userId>.json 文件回退，仅本地开发用）。
 */

import { verifyToken } from './auth.mjs';
import * as db from './db.mjs';

/**
 * 获取某用户的轮毂列表。
 * @param {string} uid
 * @returns {Promise<Array<object>>}
 */
export function getWheels(uid) {
  return db.getWheels(uid);
}

/**
 * 添加一个轮毂到账户。同一 url 去重（移到最前）。
 * @returns {Promise<object|null>} 新增/已有的轮毂记录
 */
export function addWheel(uid, { url, name, thumb } = {}) {
  return db.addWheel(uid, { url, name, thumb });
}

/** 删除一个轮毂（只删索引，不影响 .cache/models 下的 GLB） */
export function removeWheel(uid, id) {
  return db.removeWheel(uid, id);
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
