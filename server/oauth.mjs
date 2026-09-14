/**
 * oauth.mjs — 第三方 OAuth 登录（微信扫码 / 苹果 Sign in with Apple）
 *
 * 只负责「平台侧」的活：拼授权跳转 URL、用 code 换平台身份、校验 Apple id_token。
 * 真正的「找/建账号 + 签发本站 JWT」在 server/auth.mjs 的 loginOrRegisterByOAuth。
 *
 * 环境变量（不配置则对应入口提示「未配置」，绝不影响账号密码/手机号登录）：
 *   微信：WECHAT_APPID、WECHAT_SECRET（或 WECHAT_APPSECRET）
 *         —— 微信开放平台「网站应用」，回调域填本站域名
 *   苹果：APPLE_CLIENT_ID（即 Services ID，形如 com.xxx.web）
 *         —— Apple Developer「Sign in with Apple」，Return URLs 填
 *            https://<域名>/api/auth/oauth/apple/callback
 *   可选：PUBLIC_BASE_URL（最终回跳前端用的完整源，默认取请求源）
 *
 * 说明：
 *   · 微信网页登录用 snsapi_login（扫码），code → access_token → openid/unionid。
 *   · 苹果登录 response_mode=form_post，回调直接带 id_token（RS256），
 *     用 Apple 官方 JWKS 验签 + 校验 iss/aud/exp，即可拿到稳定 sub，无需私钥/client_secret。
 */

import crypto from 'node:crypto';
import https from 'node:https';

function env(...keys) {
  for (const k of keys) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

/** 该 provider 是否已配置好（决定入口可用 or 提示「未配置」） */
export function providerConfigured(provider) {
  if (provider === 'wechat') return Boolean(env('WECHAT_APPID') && env('WECHAT_SECRET', 'WECHAT_APPSECRET'));
  if (provider === 'apple') return Boolean(env('APPLE_CLIENT_ID', 'APPLE_SERVICES_ID'));
  return false;
}

/* ------------------------- HTTP helpers ------------------------- */

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
          reject(new Error('第三方返回非 JSON：' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求第三方超时')));
  });
}

/* ------------------------- state（CSRF 防跨站） ------------------------- */

const STATE_TTL_MS = 10 * 60 * 1000;
const stateStore = new Map(); // state -> { provider, createdAt }

export function createState(provider) {
  const now = Date.now();
  for (const [k, v] of stateStore) if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, { provider, createdAt: now });
  return state;
}

export function consumeState(state, provider) {
  const v = stateStore.get(state);
  stateStore.delete(state);
  if (!v || v.provider !== provider) return null;
  if (Date.now() - v.createdAt > STATE_TTL_MS) return null;
  return v;
}

/* ------------------------- 授权跳转 URL ------------------------- */

export function buildAuthorizeUrl(provider, { redirectUri, state }) {
  if (provider === 'wechat') {
    const q = new URLSearchParams({
      appid: env('WECHAT_APPID'),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'snsapi_login',
      state,
    });
    return `https://open.weixin.qq.com/connect/qrconnect?${q}#wechat_redirect`;
  }
  if (provider === 'apple') {
    const q = new URLSearchParams({
      client_id: env('APPLE_CLIENT_ID', 'APPLE_SERVICES_ID'),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'name email',
      response_mode: 'form_post',
      state,
    });
    return `https://appleid.apple.com/auth/authorize?${q}`;
  }
  throw new Error('未知的登录渠道：' + provider);
}

/* ------------------------- 微信：code → openid ------------------------- */

export async function exchangeWechat(code) {
  const appid = env('WECHAT_APPID');
  const secret = env('WECHAT_SECRET', 'WECHAT_APPSECRET');
  const tok = await getJson(
    `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(appid)}` +
      `&secret=${encodeURIComponent(secret)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`
  );
  if (tok.errcode) throw new Error(`微信授权失败：${tok.errmsg || tok.errcode}`);
  const id = tok.unionid || tok.openid;
  if (!id) throw new Error('微信未返回 openid');
  let nickname = '';
  try {
    const ui = await getJson(
      `https://api.weixin.qq.com/sns/userinfo?access_token=${encodeURIComponent(tok.access_token)}` +
        `&openid=${encodeURIComponent(tok.openid)}&lang=zh_CN`
    );
    if (ui && ui.nickname) nickname = String(ui.nickname);
  } catch {
    /* 昵称拿不到不影响登录 */
  }
  return { id, nickname };
}

/* ------------------------- 苹果：校验 id_token ------------------------- */

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

let appleJwks = { at: 0, keys: null };
async function applePublicKey(kid) {
  if (!appleJwks.keys || Date.now() - appleJwks.at > 3600e3) {
    appleJwks.keys = (await getJson('https://appleid.apple.com/auth/keys')).keys || [];
    appleJwks.at = Date.now();
  }
  const jwk = appleJwks.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error('未找到匹配的 Apple 公钥');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * 校验 Apple 回调里的 id_token（RS256）。
 * @returns {Promise<{id:string, email:string}>}  id = 稳定 sub
 */
export async function verifyAppleIdToken(idToken) {
  const clientId = env('APPLE_CLIENT_ID', 'APPLE_SERVICES_ID');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Apple id_token 格式错误');
  const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  const key = await applePublicKey(header.kid);
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]),
    key,
    b64urlDecode(parts[2])
  );
  if (!ok) throw new Error('Apple id_token 签名校验失败');
  if (payload.iss !== 'https://appleid.apple.com') throw new Error('id_token iss 校验失败');
  if (payload.aud !== clientId) throw new Error('id_token aud 校验失败（Services ID 不匹配）');
  if (Date.now() / 1000 > Number(payload.exp || 0)) throw new Error('id_token 已过期');
  if (!payload.sub) throw new Error('Apple 未返回用户标识 sub');
  return { id: String(payload.sub), email: String(payload.email || '') };
}
