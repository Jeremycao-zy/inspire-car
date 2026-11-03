/**
 * cost.mjs — 生成成本账本
 *
 * 目的：把"估算成本"换成"实测成本"。
 *
 * Hyper3D 的提交接口会返回本次任务实际扣除的 credit 数（consumed），
 * 这个字段以前被丢掉了。现在每次提交都落一行 JSONL，攒够样本就能反推
 * 真实的单次成本，而不是靠官方价目表猜。
 *
 * 落盘：.cache/cost-ledger.jsonl（纯追加，不参与任何业务逻辑，删了不影响运行）
 *
 * 环境变量：
 *   CREDIT_PRICE_CNY=4.15   1 credit 的人民币成本（默认按 Business 套餐折算）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.cache');
const LEDGER = path.join(DIR, 'cost-ledger.jsonl');

/** 1 credit 折合人民币；改套餐时同步改这个值或设环境变量 */
export function creditPriceCny() {
  const v = Number(process.env.CREDIT_PRICE_CNY);
  return Number.isFinite(v) && v > 0 ? v : 4.15;
}

/**
 * 记一笔。
 * @param {object} o
 * @param {string} o.route   rodin | bang | wheel | vision
 * @param {string} o.kind    car | wheel
 * @param {number|null} o.consumed 接口返回的实际 credit（拿不到就 null，仅计数）
 * @param {string} [o.tier]  精度档位
 * @param {object} [o.meta]  其它想留痕的字段
 */
export function record({ route, kind, consumed = null, tier = '', meta = {} }) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    route,
    kind,
    tier,
    // consumed 是官方返回的真值；它比任何价目表都可靠
    credits: Number.isFinite(Number(consumed)) ? Number(consumed) : null,
    ...meta,
  });
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(LEDGER, line + '\n');
  } catch (e) {
    // 记账失败绝不影响生成
    console.warn('[cost] 账本写入失败：', e.message);
  }
}

/** 读全部记录（坏行跳过） */
export function readLedger() {
  try {
    return fs
      .readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 汇总最近 N 天。
 * @returns {{days:number, jobs:number, credits:number, known:number, cny:number, perCar:number|null, byRoute:object}}
 */
export function summarize({ days = 30 } = {}) {
  const since = Date.now() - days * 86400_000;
  const rows = readLedger().filter((r) => new Date(r.ts).getTime() >= since);
  const price = creditPriceCny();

  let credits = 0;
  let withCredits = 0;
  const byRoute = {};

  for (const r of rows) {
    const k = r.route || 'unknown';
    byRoute[k] = byRoute[k] || { count: 0, credits: 0 };
    byRoute[k].count += 1;
    if (typeof r.credits === 'number') {
      credits += r.credits;
      withCredits += 1;
      byRoute[k].credits += r.credits;
    }
  }

  // 单台整车的真实成本 = 整车相关的所有 credit（rodin + bang）÷ 整车生成台数
  // 分母只数 rodin 的 car 记录，否则 bang 那笔会把分母放大成两倍
  const carCredits = rows
    .filter((r) => r.kind === 'car')
    .reduce((s, r) => s + (typeof r.credits === 'number' ? r.credits : 0), 0);
  const carUnits = rows.filter((r) => r.kind === 'car' && r.route === 'rodin').length;

  return {
    days,
    jobs: rows.length,
    credits: Number(credits.toFixed(2)),
    known: withCredits,
    cny: Number((credits * price).toFixed(2)),
    perCar: carUnits > 0 ? Number((carCredits / carUnits).toFixed(2)) : null,
    byRoute,
  };
}
