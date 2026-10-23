/**
 * ipRegion.mjs — 论坛「IP 属地」服务端归属地解析
 *
 * 需求（2026-10-23 用户明确）：
 *   · 发帖/回复必须展示 IP 属地（用户不可关闭、不可自选）；
 *   · 中国大陆 → 展示省级 / 直辖市一级（河北、北京、广东…）；
 *   · 中国大陆之外 → 只展示国家 / 地区名称（美国、日本、中国香港…）；
 *   · 隐私红线：库中只存行政区标签 {region,country}，绝不存 IP 本身。
 *
 * 实现：
 *   · 主解析用离线库 ip2region（自带 IPv4+IPv6 数据文件，零外网依赖、零费用）；
 *   · 港澳台在库中是 country=中国 + province=香港/澳门/台湾省，映射成
 *     中国香港 / 中国澳门 / 中国台湾（合规写法）；
 *   · 解析结果按 IP 缓存（上限 2 万条），同一 IP 只查一次；
 *   · 客户端真实 IP：Fly 平台取 fly-client-ip 请求头（由 Fly 代理写入，
 *     客户端伪造会被覆盖），本地开发退回 x-forwarded-for / socket 地址。
 */

import _ip2region from 'ip2region';

/* 兼容该包 CJS/ESM 双重包装的导出形态 */
const IP2RegionCtor =
  _ip2region?.default?.default || _ip2region?.default || _ip2region;

let searcher = null;
function getSearcher() {
  if (!searcher) searcher = new IP2RegionCtor();
  return searcher;
}

/** 省级行政区后缀 → 简称（广东省→广东、北京市→北京、内蒙古自治区→内蒙古） */
function stripAdmin(s) {
  if (!s) return '';
  return String(s)
    .replace(/特别行政区$/, '')
    .replace(/(壮族|回族|维吾尔|哈萨克)?自治区$/, '')
    .replace(/省$/, '')
    .replace(/市$/, '')
    .trim();
}

/** 港澳台在 ip2region 中是 country=中国 + province=xxx，映射为合规地区名 */
const CN_SPECIAL_REGION = {
  香港: '中国香港',
  澳门: '中国澳门',
  台湾: '中国台湾',
  台湾省: '中国台湾',
};

/* 解析缓存（IP → location|null），封顶防止长期驻留内存膨胀 */
const CACHE_MAX = 20000;
const cache = new Map();

/**
 * 提取请求的真实客户端 IP。
 * 顺序：Fly 注入的 fly-client-ip → x-forwarded-for 首段 → socket 地址。
 */
export function clientIpOf(req) {
  const fly = req.headers && req.headers['fly-client-ip'];
  if (typeof fly === 'string' && fly.trim()) return fly.trim().split(',')[0].trim();
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ra.replace(/^::ffff:/, '');
}

/**
 * IP → IP 属地标签 {region, country} | null。
 *   中国大陆    → { region: '河北', country: '中国' }
 *   港澳台      → { region: null, country: '中国香港' | '中国澳门' | '中国台湾' }
 *   其他国家    → { region: null, country: '美国' | '日本' | … }
 *   解析失败    → null（前端不展示，绝不编造属地）
 */
export function regionFromIp(ip) {
  const key = String(ip || '').trim();
  if (!key || key === '::1' || key === '127.0.0.1') return null;
  if (cache.has(key)) return cache.get(key);

  let loc = null;
  try {
    const r = getSearcher().search(key);
    const country = String(r?.country || '').trim();
    const province = String(r?.province || '').trim();
    if (country === '中国') {
      if (CN_SPECIAL_REGION[province]) {
        loc = { region: null, country: CN_SPECIAL_REGION[province] };
      } else {
        const region = stripAdmin(province);
        loc = region
          ? { region, country: '中国' }
          : { region: null, country: '中国' };
      }
    } else if (country) {
      // 海外：只取国家名，不带一级行政区（用户明确要求）
      loc = { region: null, country };
    }
  } catch {
    loc = null; // 库中无该 IP / 格式异常 → 不编造
  }

  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, loc);
  return loc;
}
