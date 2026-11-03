/**
 * wheels.js — 「轮毂仓库」前端 API 客户端
 *
 * 与后端 server/wheels.mjs 配套：账户持久化的轮毂索引（GLB 本身在 /api/asset/:name）。
 * 用 authFetch 自动带登录态；未登录请求归属到服务端 'anon' 共享库。
 */

import { authFetch } from '../auth.js';

/** 取当前账户的轮毂列表（新→旧） */
export async function listWheels() {
  try {
    const r = await authFetch('/api/wheels', { method: 'GET' });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j?.wheels) ? j.wheels : [];
  } catch {
    return [];
  }
}

/** 把一个生成好的轮毂登记进仓库（去重） */
export async function addWheel({ url, name = '', thumb = '' } = {}) {
  if (!url) return null;
  try {
    const r = await authFetch('/api/wheels', {
      method: 'POST',
      body: JSON.stringify({ url, name, thumb }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.wheel || null;
  } catch {
    return null;
  }
}

/** 从仓库删除一个轮毂（仅删索引） */
export async function removeWheel(id) {
  if (!id) return;
  try {
    await authFetch(`/api/wheels/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    /* ignore */
  }
}
