/**
 * wechatMini.mjs — 微信小程序登录（jscode2session）
 *
 * 只负责「平台侧」的事：把小程序端 wx.login() 拿到的 code 换成 openid / unionid。
 * 真正的「找/建账号 + 签发本站 JWT」交给 server/auth.mjs 的 loginOrRegisterByOAuth，
 * 与网站扫码登录、Apple 登录共用同一套账号体系与 JWT 逻辑。
 *
 * 环境变量（不配置时接口会优雅返回「未配置」错误，绝不会让进程崩溃）：
 *   WECHAT_MINI_APPID    —— 微信公众平台「小程序」的 AppID
 *   WECHAT_MINI_SECRET   —— 对应的 AppSecret
 *
 * 失败处理原则（本项目红线：外部依赖挂了不能把整个服务打死）：
 *   · 配置缺失 / 微信返回 errcode / 网络异常 都通过 throw 带 code 的 Error 暴露，
 *     由调用方（server/index.mjs 的路由 handler）捕获后以清晰 message 返回，绝不 500 无信息。
 *   · 本模块不创建 http server、不依赖任何三方包，只用 Node 内置 https。
 */

import https from 'node:https';

/* 读环境变量（空串也当作未配置） */
function env(...keys) {
  for (const k of keys) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

/** 小程序登录是否已配置好（决定接口可用 or 提示「未配置」） */
export function miniConfigured() {
  return Boolean(env('WECHAT_MINI_APPID') && env('WECHAT_MINI_SECRET'));
}

/* ------------------------- HTTP helper ------------------------- */

function getJson(url, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('微信返回非 JSON：' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求微信超时')));
  });
}

/**
 * 用小程序 code 换 openid/unionid/session_key。
 * @param {string} code 来自 wx.login() 的临时登录凭证
 * @returns {Promise<{openid:string, unionid?:string, sessionKey:string}>}
 * @throws {Error} 带 .code 字段：not_configured | wechat_upstream_error | wechat_errcode | wechat_no_openid
 */
export async function exchangeMiniCode(code) {
  if (!miniConfigured()) {
    const e = new Error(
      '小程序登录尚未配置：需在微信公众平台获取小程序 AppID/AppSecret，并设置环境变量 WECHAT_MINI_APPID / WECHAT_MINI_SECRET'
    );
    e.code = 'not_configured';
    throw e;
  }

  const appid = env('WECHAT_MINI_APPID');
  const secret = env('WECHAT_MINI_SECRET');
  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;

  let r;
  try {
    r = await getJson(url);
  } catch (e) {
    const err = new Error('调用微信 jscode2session 失败：' + (e?.message || e));
    err.code = 'wechat_upstream_error';
    throw err;
  }

  if (r.errcode) {
    // 常见：40029 无效 code；45011 频率限制；40125 等
    const err = new Error(`微信登录失败（${r.errcode}）：${r.errmsg || '未知错误'}`);
    err.code = 'wechat_errcode';
    throw err;
  }
  if (!r.openid) {
    const err = new Error('微信未返回 openid');
    err.code = 'wechat_no_openid';
    throw err;
  }

  return {
    openid: r.openid,
    unionid: r.unionid || undefined, // 已绑定开放平台才有
    sessionKey: r.session_key || '',
  };
}
