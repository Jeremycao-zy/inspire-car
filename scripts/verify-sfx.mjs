/**
 * verify-sfx.mjs — 音效系统的静态一致性校验（不开浏览器）
 *
 * 音效是纯合成函数，没有可断言的数值输出，所以这里校验的是
 * **接口完整性与映射正确性** —— 这恰恰是最容易在重构中悄悄坏掉的部分
 * （2026-10-15 重做音色时：旧 chime/airy 已删，若有调用点残留会直接运行时报错）。
 *
 * 用法：node scripts/verify-sfx.mjs
 */
import { readFileSync } from 'node:fs';

const sfxSrc = readFileSync(new URL('../src/ui/sfx.js', import.meta.url), 'utf8');
const panelSrc = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

let fail = 0;
let pass = 0;
const ok = (m) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };

console.log('=== 1. 对外 API 完整（调用方依赖这些名字）===');
// 外部可能调用到的音效名
const PUBLIC_API = [
  'init', 'setEnabled', 'isEnabled', 'toggle',
  'tick', 'click', 'card', 'rotate',
  'toggleOn', 'toggleOff', 'select', 'open', 'close',
  'generating', 'success', 'fail', 'warn', 'whoosh', 'toggleSfx',
];
for (const name of PUBLIC_API) {
  const re = new RegExp(`(^|[\\s{])${name}\\s*[:(]`, 'm');
  sfxSrc.split('\n').some((l) => re.test(l) && !l.trim().startsWith('//'))
    ? ok(`${name}()`)
    : bad(`缺少对外方法 ${name}`);
}

console.log('\n=== 2. 旧的空灵音实现已彻底移除 ===');
for (const [name, pat] of [
  ['chime()', /function chime/],
  ['airy()', /function airy/],
  ['1520Hz 尖亮 tick', /freq:\s*1520/],
  ['失谐泛音 shimmer', /shimmer/],
]) {
  pat.test(sfxSrc) ? bad(`${name} 仍存在`) : ok(`${name} 已移除`);
}

console.log('\n=== 3. 机械赛博合成手法就位 ===');
for (const [name, pat] of [
  ['metalHit（金属敲击：高Q带通共鸣）', /function metalHit/],
  ['servo（伺服/液压扫频 + 棘轮）', /function servo/],
  ['clack（液压落位砰）', /function clack/],
  ['chargeUp（充能）', /function chargeUp/],
  ['alarm（失败警报）', /function alarm/],
  ['高Q金属共鸣 bp.Q.value = 9', /bp\.Q\.value = 9/],
  ['干声总线为主（混响 0.16）', /busRoom\.gain\.value = 0\.16/],
]) {
  pat.test(sfxSrc) ? ok(name) : bad(`${name} 缺失`);
}

console.log('\n=== 4. reverbNode 初始化顺序正确（曾有 TDZ/未定义 bug）===');
const declLine = sfxSrc.split('\n').findIndex((l) => /^let reverbNode = null;/.test(l.trim()));
const buildStart = sfxSrc.indexOf('function buildReverb');
const assignInBuild = sfxSrc.indexOf('reverbNode = conv;');
if (declLine >= 0 && buildStart >= 0 && assignInBuild >= 0 && declLine < buildStart) {
  ok(`reverbNode 声明在 buildReverb 之前（第 ${declLine + 1} 行），并在函数内赋值`);
} else {
  bad(`reverbNode 声明/赋值顺序错位（声明行 ${declLine + 1}，函数起点 ${buildStart}，赋值 ${assignInBuild}）`);
}

console.log('\n=== 5. 方向语义已区分（开/关、展开/收起 不能同音）===');
const pairs = [
  ['toggleOn', 'toggleOff', '开关'],
  ['open', 'close', '展开/收起'],
];
for (const [a, b, label] of pairs) {
  const hasA = new RegExp(`\\b${a}\\b`).test(sfxSrc);
  const hasB = new RegExp(`\\b${b}\\b`).test(sfxSrc);
  hasA && hasB ? ok(`${label}：${a} / ${b} 各自独立`) : bad(`${label} 缺少 ${!hasA ? a : b}`);
}
// tick 应下扫（档位下行）而不是高频上行
const tickBody = sfxSrc.slice(sfxSrc.indexOf('  tick()'), sfxSrc.indexOf('  click()'));
/from:\s*(\d+),\s*to:\s*(\d+)/.test(tickBody) && (() => {
  const m = tickBody.match(/from:\s*(\d+),\s*to:\s*(\d+)/);
  return Number(m[2]) < Number(m[1]); // to < from = 下扫
})() ? ok('tick 走低频下扫（避免原 1520Hz 刺耳高音）') : bad('tick 频率设置可疑');

console.log('\n=== 6. 状态音已接到真实流程（不能只定义不调用）===');
panelSrc.includes("import { sfx } from './sfx.js'")
  ? ok('panel.js 已 import sfx')
  : bad('panel.js 未 import sfx（success/fail/warn 会是空调用）');
const setStatusBlock = panelSrc.slice(panelSrc.indexOf('setStatus(text, tone'));
if (/tone === 'ok'[\s\S]{0,200}sfx\.success\(\)/.test(setStatusBlock)) ok("setStatus: tone 'ok' → sfx.success()");
else bad("setStatus 未映射 ok → success");
if (/tone === 'err'[\s\S]{0,260}sfx\.fail\(\)/.test(setStatusBlock)) ok("setStatus: tone 'err' → sfx.fail()");
else bad("setStatus 未映射 err → fail");
if (/tone === 'warn'[\s\S]{0,320}sfx\.warn\(\)/.test(setStatusBlock)) ok("setStatus: tone 'warn' → sfx.warn()");
else bad("setStatus 未映射 warn → warn");

console.log('\n=== 7. 全站无残留的旧 API 调用 ===');
const allSrc = [panelSrc, mainSrc, sfxSrc];
for (const old of ['sfx.chime(', 'sfx.airy(', 'sfx.toggleSfx()']) {
  const hit = allSrc.some((s) => s.includes(old));
  // toggleSfx 是保留的兼容别名，单独处理
  if (old === 'sfx.toggleSfx()') {
    hit ? ok('toggleSfx 仅作为兼容别名存在（未被删除）') : ok('toggleSfx 无外部调用（别名闲置但安全）');
  } else {
    hit ? bad(`仍有调用：${old}`) : ok(`无残留调用：${old}`);
  }
}

console.log('\n=== 7.5 this 绑定护栏（曾踩：open/close 别名导出报 Illegal invocation）===');
// open/close 既是模块级函数名又是对象属性名，写成 `open,` 简短属性时
// 调用 sfx.open() 里若用到 this.xxx，this 会丢失 → 运行时 Illegal invocation。
// 静态难测（只有真跑才炸），故此处断言它们必须是显式方法体。
for (const name of ['open', 'close']) {
  const hasExplicit = new RegExp(`\n  ${name}\\(\\) \\{`).test(sfxSrc);
  hasExplicit
    ? ok(`${name} 是显式方法体（this 绑定安全）`)
    : bad(`${name} 是简短属性写法，调用时 this 会丢失 → Illegal invocation`);
}

console.log('\n=== 8. 事件委托覆盖新的交互元素 ===');
for (const [name, pat] of [
  ['关闭类按钮走 close()（.wg-close 等）', /wg-close/],
  ['规格选择器 chip 有点击音', /spec-chip/],
  ['select 下拉走 select()', /matches\('select'\)/],
  ['checkbox 区分开/关', /toggleOn/],
]) {
  pat.test(sfxSrc) ? ok(name) : bad(`${name} 缺失`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
