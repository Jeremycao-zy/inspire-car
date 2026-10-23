/**
 * moderation.mjs — 论坛发帖 / 回复 内容审核（违禁词拦截）
 *
 * 合规依据：
 *   国家互联网信息办公室《网络信息内容生态治理规定》（第 5 号，2020-03-01 施行）
 *     · 第六条  网络信息内容生产者不得制作、复制、发布 11 类违法信息
 *               （危害国家安全、色情、赌博、暴力凶杀恐怖、侮辱诽谤他人…）；
 *     · 第七条  应当防范和抵制 9 类不良信息（性暗示、低俗、地域歧视、煽动歧视…）；
 *     · 第九条 / 第十条  平台须建立「跟帖评论审核」等制度，发现违法信息须立即处置并报告。
 *   本模块即在「跟帖评论」入口做服务端前置拦截：命中违禁词则拒绝发布（400）。
 *
 * 实现：
 *   · 归一化：小写 + 去除空白与常见分隔 / 混淆字符，挫败「傻*逼」「沙_逼」「沙 逼」等基础规避；
 *   · 匹配：Trie（DFA）子串扫描，命中即记录；
 *   · 词库：内置基础词库（覆盖 规定 第六 / 七条 主要类别），并可在
 *          server/data/banned-words.txt 增量扩充（每行一词，# 开头为注释，
 *          支持 "类别:词" 形式，部署后无需改代码即可更新）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 内置基础词库（curated）。
 * 类别对齐《网络信息内容生态治理规定》第六 / 七条：
 *   curse   辱骂 / 脏话
 *   gamble  赌博
 *   drug    毒品
 *   porn    色情违法活动
 *   violence 暴恐
 *   polity  涉政违法活动（危害国家安全类，仅列明显违法表述）
 *   fraud   诈骗 / 广告引流
 * 注意：刻意排除日常高频但不违规的单字 / 词（如「日」「垃圾」「废物」「USB」），
 *       以控制误杀；如需更严格可经由 banned-words.txt 扩充。
 */
const BUILTIN_WORDS = [
  // ---- curse 辱骂 / 脏话 ----
  '傻逼', '傻b', '傻B', '沙比', '沙逼', '沙雕', '煞笔', '煞逼', '啥比', '脑残', '白痴', '弱智',
  '狗东西', '狗杂种', '王八蛋', '王八羔子', '混蛋', '浑蛋', '贱人', '婊子', '贱货', '骚货',
  '操你', '草你', '日你', '操你妈', '草你妈', '日你妈', '操他', '草他',
  '妈的', '他妈的', '你妈的', '我妈的', '去死', '该死', '找死', '畜生', '禽兽', '杂种', '野种',
  '混账', '滚蛋', '滚开', '放屁', '傻叉', '二逼', '二货', '装逼', '装b', '装B',
  'tmd', 'TMD', 'nmd', 'NMD', 'wcnm', 'WCNM', 'wqnmlgb',

  // ---- gamble 赌博 ----
  '赌博', '赌钱', '博彩', '赌场', '赌球', '赌马', '百家乐', '时时彩', '六合彩', '私彩', '外围赌',
  '网络赌博', '网上赌博', '老虎机', '赌盘', '赌注', '赌博平台', '博彩平台', '私彩平台', '网上赌',

  // ---- drug 毒品 ----
  '毒品', '吸毒', '贩毒', '制毒', '冰毒', '海洛因', '可卡因', '大麻', '摇头丸', '麻古', 'k粉', 'K粉',
  '鸦片', '罂粟', '毒品交易', '吸毒品', '贩毒品',

  // ---- porn 色情违法活动 ----
  '卖淫', '嫖娼', '招嫖', '裸聊', '色情交易', '涉黄', '黄赌毒', '成人网站', '黄色网站', '色情网站',
  '色情服务', '约炮', '一夜情',

  // ---- violence 暴恐 ----
  '恐怖组织', '恐怖袭击', '爆炸物', '制造炸弹', '枪支弹药', '制爆', '暴恐', '炸弹',

  // ---- polity 涉政违法（明显危害国家安全表述，最小化以控误杀） ----
  '分裂国家', '颠覆国家', '颠覆国家政权', '叛乱', '民族仇恨',

  // ---- fraud 诈骗 / 广告引流 ----
  '代开发票', '刷单', '兼职刷单', '贷款诈骗', '充值返利', '赌博平台', '色情平台',
  '微信号', '加我微信', '威信', 'vx号', '加vx', '免费领', '扫码领', '博彩平台',
];

/** 归一化：小写、去空白与常见分隔 / 混淆字符 */
function normalize(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\s*_~·\-.,，、!！@#$%^&+=\/|;:；：'"`()（）[\]【】<>《》?？]+/g, '');
}

/** 构建 Trie（DFA） */
function buildTrie(words) {
  const root = Object.create(null);
  for (const w of words) {
    const n = normalize(w);
    if (!n) continue;
    let node = root;
    for (const ch of n) {
      if (!node[ch]) node[ch] = Object.create(null);
      node = node[ch];
    }
    node.$ = true; // 词尾标记
  }
  return root;
}

/** 在文本中扫描命中的违禁词（归一化后子串匹配），返回去重数组 */
function scan(text, root) {
  const s = normalize(text);
  const found = [];
  for (let i = 0; i < s.length; i++) {
    let node = root;
    let matchEnd = -1;
    let j = i;
    while (j < s.length) {
      node = node[s[j]];
      if (!node) break;
      if (node.$) matchEnd = j;
      j++;
    }
    if (matchEnd >= 0) {
      const w = s.slice(i, matchEnd + 1);
      if (!found.includes(w)) found.push(w);
      i = matchEnd; // 从匹配末尾继续，避免遗漏后续词
    }
  }
  return found;
}

let _root = null;
function getRoot() {
  if (_root) return _root;
  const words = [...BUILTIN_WORDS];
  const file = path.join(__dirname, 'data', 'banned-words.txt');
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const word = t.includes(':') ? t.split(':', 2)[1].trim() : t; // 支持 "类别:词"
        if (word) words.push(word);
      }
    }
  } catch {
    /* 外部词库加载失败不阻断内置词库 */
  }
  _root = buildTrie(words);
  return _root;
}

/** 返回命中的违禁词数组（空数组表示无违禁词） */
export function findBanned(text) {
  if (!text) return [];
  return scan(text, getRoot());
}

/** 审核入口：{ ok, words } */
export function moderate(text) {
  const words = findBanned(text);
  return { ok: words.length === 0, words };
}

export { BUILTIN_WORDS };
export default { moderate, findBanned, BUILTIN_WORDS };
