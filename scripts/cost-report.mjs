#!/usr/bin/env node
/**
 * cost-report.mjs — 生成成本实测报表
 *
 * 用法：
 *   node scripts/cost-report.mjs          # 看最近 30 天
 *   node scripts/cost-report.mjs 7        # 看最近 7 天
 *   CREDIT_PRICE_CNY=10.8 node scripts/cost-report.mjs   # 按直充价折算
 *
 * 数据来源：.cache/cost-ledger.jsonl（server/cost.mjs 写入）
 */

import { summarize, readLedger, creditPriceCny } from '../server/cost.mjs';

const days = Number(process.argv[2]) || 30;
const s = summarize({ days });
const price = creditPriceCny();

const line = (t) => console.log(t);
line('');
line(`生成成本账本 · 最近 ${days} 天`);
line('─'.repeat(52));

if (s.jobs === 0) {
  line('还没有记录。跑一次真实生成，这里就会有数据。');
  line('');
  process.exit(0);
}

line(`任务笔数        ${s.jobs}（其中带真实 credit 的 ${s.known} 笔）`);
line(`credit 总消耗   ${s.credits}`);
line(`折算成本        ¥${s.cny}（按 ¥${price}/credit）`);
if (s.perCar !== null) {
  line(`单台整车        ${s.perCar} credit ≈ ¥${(s.perCar * price).toFixed(2)}`);
}
line('');
line('分环节：');
for (const [k, v] of Object.entries(s.byRoute)) {
  const cny = (v.credits * price).toFixed(2);
  line(`  ${k.padEnd(10)} ${String(v.count).padStart(4)} 次   ${String(v.credits).padStart(8)} credit   ¥${cny}`);
}

line('');
line('最近 5 笔：');
for (const r of readLedger().slice(-5)) {
  line(`  ${r.ts}  ${String(r.route).padEnd(7)} ${String(r.kind || '').padEnd(5)} ${r.credits ?? '-'} credit`);
}

line('');
line('─'.repeat(52));
line('校准口径：单台整车成本 = rodin + bang 两笔之和 ÷ 整车台数。');
line('若实测 > ¥7，C 端定价整体上浮；若 < ¥4，可放 ¥19 引流款。');
line('');
