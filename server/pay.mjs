/**
 * server/pay.mjs — 收款通道（微信支付 V3 + 支付宝手机网站支付）
 *
 * 设计原则（与项目其它模块保持一致）：
 *   · 零三方依赖：只用 node:https + node:crypto，不引 wechatpay-node-v3 / alipay-sdk。
 *   · 外部依赖挂了不能打死进程：所有失败都 throw 带 code 的 Error，由路由层转成清晰 message。
 *   · 金额一律以「分」为整数单位，杜绝浮点误差。
 *   · 未配置凭证时 configured() 返回 false，接口优雅提示「未配置」，不影响站点运行。
 *
 * 微信支付（V3 / JSAPI，用于公众号内 H5）：
 *   下单  POST /v3/pay/transactions/jsapi
 *   回调  验签用「微信支付公钥」模式（推荐，免下载平台证书）
 *         头部 Wechatpay-Signature/Timestamp/Nonce/Serial
 *         报文 resource 用 AES-256-GCM(APIv3 密钥) 解密
 *
 * 支付宝（手机网站支付 alipay.trade.wap.pay）：
 *   下单  拼接 gateway 跳转 URL（GET）
 *   回调  x-www-form-urlencoded，剔除 sign/sign_type 后按 key 升序拼串做 RSA2 验签
 *
 * 环境变量见项目根 .env.example 的「支付」段。
 */

import https from 'node:https';
import crypto from 'node:crypto';

/* ------------------------- 通用 ------------------------- */

function env(...keys) {
  for (const k of keys) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * 归一化 PEM：环境变量里常被压成单行，换行写成字面量 \n。
 * Railway / 容器面板粘贴多行文本时几乎必然发生，这里统一还原。
 */
function pem(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (s.indexOf('\\n') === -1) return s;
  return s.replace(/\\n/g, '\n');
}

/** 带超时的 JSON 请求（仅 POST，够用） */
function httpsJson(method, urlStr, bodyStr, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || 443,
        headers,
        timeout,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = null;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed ?? {});
          } else {
            const e = new Error(
              `HTTP ${res.statusCode}：${(parsed && (parsed.message || parsed.error_description)) || data.slice(0, 300)}`
            );
            e.code = 'upstream_http_error';
            e.status = res.statusCode;
            e.detail = parsed || data.slice(0, 500);
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求上游超时')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/* ------------------------- 套餐 ------------------------- */

/**
 * 套餐配置。改价格 / 加套餐只动这里，前端通过 GET /api/pay/plans 拿到同一份数据。
 * id 与 src/ui/subscribe.js 的方案 id 保持一致，改价务必两边同步。
 * type: 'quota' 按次购买（永久） | 'subscription' 按天开通（带次数上限）
 */
/**
 * 对外只卖「次」，不卖 credit。
 *
 * 计价锚点 = 一次完整整车方案（含 Rodin 生成 + BANG 车身拆解），
 * 内部成本 ≈ ¥5.3／次（详见 COST_PRICING 文档）。定价下限 = 3 × 成本。
 *
 * 定价原则（别改坏）：
 *   1. 任何一个套餐的单次价格不得低于 ¥15，否则毛利不足以覆盖重试与退款；
 *   2. 不做「不限次」，订阅也必须带次数上限（subscription 的 quota 有值才会被扣减）；
 *   3. 单价必须随购买量递减：¥29 → ¥19.8 → ¥16.6。
 */
export const PLANS = {
  single: {
    id: 'single',
    name: '单次体验',
    desc: '1 次完整改装方案，含车身拆解与实时调参',
    priceFen: 2900, // ¥29 / 次（单次毛利 82%）
    type: 'quota',
    quota: 1,
    days: 0,
  },
  pack5: {
    id: 'pack5',
    name: '5 次包',
    desc: '5 次完整方案，单套 ¥19.8，永久有效',
    priceFen: 9900, // ¥99 / 5 次（毛利 73%）
    type: 'quota',
    quota: 5,
    days: 0,
  },
  pack12: {
    id: 'pack12',
    name: '12 次包',
    desc: '12 次完整方案，单套 ¥16.6，永久有效',
    priceFen: 19900, // ¥199 / 12 次（毛利 68%）
    type: 'quota',
    quota: 12,
    days: 0,
  },
  studio: {
    id: 'studio',
    name: '工作室月卡',
    desc: '30 天 20 次方案，适合改装店日常出效果图',
    priceFen: 39900, // ¥399 / 30 天 20 次（毛利 73%）
    type: 'subscription',
    quota: 20,
    days: 30,
  },
  pro: {
    id: 'pro',
    name: '专业版月卡',
    desc: '30 天 60 次方案，适合多车并行与内容量产',
    priceFen: 99900, // ¥999 / 30 天 60 次（毛利 68%）
    type: 'subscription',
    quota: 60,
    days: 30,
  },
};

/** 取套餐；不存在返回 null */
export function getPlan(id) {
  return Object.prototype.hasOwnProperty.call(PLANS, id) ? PLANS[id] : null;
}

/** 对外暴露的套餐列表（不含内部字段，价格同时给分和元，方便前端展示） */
export function listPlans() {
  return Object.values(PLANS).map((p) => ({
    id: p.id,
    name: p.name,
    desc: p.desc,
    priceFen: p.priceFen,
    priceYuan: (p.priceFen / 100).toFixed(2),
    type: p.type,
    quota: p.quota,
    days: p.days,
  }));
}

/* ======================================================================
 *  微信支付 V3
 * ==================================================================== */

const WX_API = 'https://api.mch.weixin.qq.com';

function wxCfg() {
  return {
    appid: env('WXPAY_APPID', 'WECHAT_MINI_APPID'),
    mchid: env('WXPAY_MCHID'),
    serialNo: env('WXPAY_SERIAL_NO'),
    privateKey: pem(env('WXPAY_PRIVATE_KEY')),
    apiv3Key: env('WXPAY_APIV3_KEY'),
    publicKey: pem(env('WXPAY_PUBLIC_KEY')), // 微信支付公钥（PEM）
    publicKeyId: env('WXPAY_PUBLIC_KEY_ID'), // 形如 PUB_KEY_ID_xxx
    notifyUrl: env('WXPAY_NOTIFY_URL'),
  };
}

/** 微信支付是否已配置齐全 */
export function wxConfigured() {
  const c = wxCfg();
  return Boolean(c.appid && c.mchid && c.serialNo && c.privateKey && c.apiv3Key && c.notifyUrl);
}

/** 支付宝是否已配置齐全 */
export function aliConfigured() {
  return Boolean(env('ALIPAY_APP_ID') && env('ALIPAY_PRIVATE_KEY') && env('ALIPAY_PUBLIC_KEY'));
}

/** 当前已启用的通道，供 /api/health 与前端展示 */
export function channels() {
  return { wx: wxConfigured(), ali: aliConfigured() };
}

/** 商户私钥 RSA-SHA256 签名（base64） */
function wxSign(message) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message, 'utf8');
  sign.end();
  return sign.sign(wxCfg().privateKey, 'base64');
}

/** 拼微信 V3 请求的 Authorization 头 */
function wxAuthHeader(method, urlPath, bodyStr) {
  const c = wxCfg();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
  const signature = wxSign(message);
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchid}",` +
    `nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${c.serialNo}",signature="${signature}"`
  );
}

/**
 * JSAPI 统一下单，返回可直接给前端 WeixinJSBridge 的参数。
 * @param {{outTradeNo:string, amountFen:number, subject:string, openid:string}} p
 */
export async function createWxJsapiOrder({ outTradeNo, amountFen, subject, openid }) {
  if (!wxConfigured()) {
    const e = new Error(
      '微信支付未配置：请设置 WXPAY_APPID / WXPAY_MCHID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY / WXPAY_APIV3_KEY / WXPAY_NOTIFY_URL'
    );
    e.code = 'not_configured';
    throw e;
  }
  if (!openid) {
    const e = new Error('缺少 openid：微信内支付需要先通过公众号网页授权获取 openid');
    e.code = 'missing_openid';
    throw e;
  }
  const c = wxCfg();
  const urlPath = '/v3/pay/transactions/jsapi';
  const payload = {
    appid: c.appid,
    mchid: c.mchid,
    description: subject.slice(0, 120),
    out_trade_no: outTradeNo,
    notify_url: c.notifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
    payer: { openid },
  };
  const bodyStr = JSON.stringify(payload);
  const r = await httpsJson('POST', WX_API + urlPath, bodyStr, {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: wxAuthHeader('POST', urlPath, bodyStr),
    'User-Agent': 'inspire-car/1.0',
  });

  if (!r || !r.prepay_id) {
    const e = new Error('微信下单未返回 prepay_id：' + JSON.stringify(r || {}).slice(0, 300));
    e.code = 'wx_no_prepay';
    throw e;
  }

  // 前端调起参数：paySign 是对 appId\ntimeStamp\nnonceStr\npackage\n 再做一次 RSA 签名
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const pkg = `prepay_id=${r.prepay_id}`;
  const paySign = wxSign(`${c.appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`);

  return {
    appId: c.appid,
    timeStamp,
    nonceStr,
    package: pkg,
    signType: 'RSA',
    paySign,
    prepayId: r.prepay_id,
  };
}

/**
 * 校验微信回调签名。
 * @param {object} headers  原始请求头（小写键）
 * @param {string} rawBody  原始报文（必须是未经解析的字符串）
 * @returns {boolean}
 */
export function verifyWxNotifySignature(headers, rawBody) {
  const c = wxCfg();
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  const serial = headers['wechatpay-serial'];
  if (!timestamp || !nonce || !signature) return false;

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`, 'utf8');

  // 优先用「微信支付公钥」模式；serial 命中公钥 ID 时直接验
  if (c.publicKey) {
    try {
      if (verifier.verify(c.publicKey, signature, 'base64')) return true;
    } catch {
      /* 落到平台证书分支 */
    }
  }
  // 兼容平台证书模式：WXPAY_PLATFORM_CERTS 传 JSON，形如 {"序列号":"-----BEGIN CERTIFICATE-----..."}
  const certsRaw = env('WXPAY_PLATFORM_CERTS');
  if (certsRaw && serial) {
    try {
      const map = JSON.parse(certsRaw);
      const cert = pem(map[serial]);
      if (cert) {
        const v2 = crypto.createVerify('RSA-SHA256');
        v2.update(`${timestamp}\n${nonce}\n${rawBody}\n`, 'utf8');
        return v2.verify(cert, signature, 'base64');
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * 解密回调里的 resource（AEAD_AES_256_GCM）。
 * 注意：密文 base64 解码后，末尾 16 字节是 authTag，前面才是正文。
 * @param {{ciphertext:string, nonce:string, associated_data?:string}} resource
 * @returns {object} 明文 JSON
 */
export function decryptWxResource(resource) {
  const key = Buffer.from(wxCfg().apiv3Key, 'utf8');
  const buf = Buffer.from(resource.ciphertext, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) {
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  }
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

/**
 * 公众号网页授权换 openid（snsapi_base，静默授权，不弹窗）。
 * @param {string} code 微信回调带回的 code
 * @returns {Promise<{openid:string, accessToken?:string}>}
 */
export async function exchangeWechatOauthCode(code) {
  const appid = env('WXPAY_APPID', 'WECHAT_MINI_APPID');
  const secret = env('WXPAY_APPSECRET');
  if (!appid || !secret) {
    const e = new Error('公众号网页授权未配置：请设置 WXPAY_APPID 与 WXPAY_APPSECRET');
    e.code = 'not_configured';
    throw e;
  }
  const url =
    `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const r = await httpsJson('GET', url, null, { Accept: 'application/json' });
  if (r && r.errcode) {
    const e = new Error(`微信网页授权失败（${r.errcode}）：${r.errmsg || '未知错误'}`);
    e.code = 'wx_oauth_error';
    throw e;
  }
  if (!r || !r.openid) {
    const e = new Error('微信未返回 openid');
    e.code = 'wx_no_openid';
    throw e;
  }
  return { openid: r.openid, accessToken: r.access_token };
}

/**
 * 生成公众号网页授权跳转 URL（state 由调用方生成并校验）。
 * @param {{redirectUri:string, state:string}} p
 */
export function buildWechatAuthorizeUrl({ redirectUri, state }) {
  const appid = env('WXPAY_APPID', 'WECHAT_MINI_APPID');
  if (!appid) {
    const e = new Error('未配置 WXPAY_APPID，无法发起公众号授权');
    e.code = 'not_configured';
    throw e;
  }
  return (
    'https://open.weixin.qq.com/connect/oauth2/authorize' +
    `?appid=${encodeURIComponent(appid)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=snsapi_base&state=${encodeURIComponent(state)}` +
    '#wechat_redirect'
  );
}

/* ======================================================================
 *  支付宝（手机网站支付）
 * ==================================================================== */

const ALI_GATEWAY = 'https://openapi.alipay.com/gateway.do';

/** 支付宝要求的时间格式：yyyy-MM-dd HH:mm:ss（北京时间） */
function aliTimestamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** 待签名串：剔除 sign/sign_type，空值不参与，按 key 升序拼 k=v&k=v */
function aliSignString(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type')
    .filter((k) => params[k] !== undefined && params[k] !== null && String(params[k]) !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/** 用应用私钥做 RSA2(SHA256withRSA) 签名 */
function aliSign(params) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(aliSignString(params), 'utf8');
  sign.end();
  return sign.sign(pem(env('ALIPAY_PRIVATE_KEY')), 'base64');
}

/**
 * 创建支付宝手机网站支付跳转 URL。
 * 前端直接 window.location.href = url 即可跳转收银台。
 * @param {{outTradeNo:string, amountFen:number, subject:string, returnUrl?:string, quitUrl?:string}} p
 * @returns {string}
 */
export function createAlipayWapUrl({ outTradeNo, amountFen, subject, returnUrl, quitUrl }) {
  if (!aliConfigured()) {
    const e = new Error('支付宝未配置：请设置 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY');
    e.code = 'not_configured';
    throw e;
  }
  const params = {
    app_id: env('ALIPAY_APP_ID'),
    method: 'alipay.trade.wap.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: aliTimestamp(),
    version: '1.0',
    notify_url: env('ALIPAY_NOTIFY_URL'),
    biz_content: JSON.stringify({
      out_trade_no: outTradeNo,
      total_amount: (amountFen / 100).toFixed(2),
      subject: subject.slice(0, 120),
      product_code: 'QUICK_WAP_WAY',
      quit_url: quitUrl || returnUrl || env('ALIPAY_RETURN_URL'),
    }),
  };
  if (returnUrl || env('ALIPAY_RETURN_URL')) {
    params.return_url = returnUrl || env('ALIPAY_RETURN_URL');
  }
  params.sign = aliSign(params);

  const qs = Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return `${ALI_GATEWAY}?${qs}`;
}

/**
 * 校验支付宝异步通知签名。
 * @param {Record<string,string>} body 已解析的 form 参数
 * @returns {boolean}
 */
export function verifyAlipayNotify(body) {
  if (!body || !body.sign) return false;
  const sign = body.sign;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(aliSignString(body), 'utf8');
    return verifier.verify(pem(env('ALIPAY_PUBLIC_KEY')), sign, 'base64');
  } catch {
    return false;
  }
}

/* ------------------------- 诊断 ------------------------- */

/** 供 /api/health 展示，不含任何密钥明文 */
export function payStatus() {
  const c = wxCfg();
  return {
    wx: wxConfigured(),
    ali: aliConfigured(),
    wxPublicKeyMode: Boolean(c.publicKey),
    plans: Object.keys(PLANS),
  };
}
