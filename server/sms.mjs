/**
 * server/sms.mjs — 短信验证码发送
 *
 * 两种运行模式：
 *
 *   · 生产模式（SMS_PROVIDER=aliyun 且密钥/签名/模板齐备）：
 *       走阿里云 Dysmsapi（SendSms）下发真实短信。
 *       签名用 ROA 风格：GET + 规范化查询串 + HMAC-SHA1(AccessKeySecret&)。
 *
 *   · 开发 / 未配置模式（默认）：
 *       不发真实短信，仅把验证码打印到服务端日志，
 *       并返回 { dev:true, code } 让前端在本地直接显示，便于先跑通整条链路。
 *
 * 调用方（auth.mjs）不关心是哪种模式，只拿 { ok, dev?, code?, error? }。
 */

import crypto from 'node:crypto';

function configured() {
  return (
    process.env.SMS_PROVIDER === 'aliyun' &&
    !!process.env.SMS_ACCESS_KEY_ID &&
    !!process.env.SMS_ACCESS_KEY_SECRET &&
    !!process.env.SMS_SIGN_NAME &&
    !!process.env.SMS_TEMPLATE_CODE
  );
}

/** 是否已配置真实短信通道（用于日志/提示） */
export function isSmsConfigured() {
  return configured();
}

/**
 * 发送验证码短信。
 * @param {string} phone 手机号
 * @param {string} code  6 位验证码
 * @returns {Promise<{ok:boolean, dev?:boolean, code?:string, error?:string}>}
 */
export async function sendSmsCode(phone, code) {
  if (!configured()) {
    console.log(
      `\n  [SMS:dev] 验证码（开发模式，未配置真实短信商）\n` +
        `        手机号 ${phone} 的登录验证码为：${code}\n` +
        `        —— 生产环境请配置 SMS_PROVIDER=aliyun 及 AccessKey/签名/模板环境变量。\n`
    );
    return { ok: true, dev: true, code };
  }
  try {
    await sendAliyun(phone, code);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `短信网关错误：${e.message || e}` };
  }
}

/* ------------------------- 阿里云 Dysmsapi（ROA） ------------------------- */

async function sendAliyun(phone, code) {
  const accessKeyId = process.env.SMS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.SMS_ACCESS_KEY_SECRET;
  const signName = process.env.SMS_SIGN_NAME;
  const templateCode = process.env.SMS_TEMPLATE_CODE;
  const endpoint = process.env.SMS_ENDPOINT || 'dysmsapi.aliyuncs.com';

  // 模板参数：把验证码塞进模板占位符（模板需含 ${code} 变量）
  const templateParam = JSON.stringify({ code });

  const params = {
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: process.env.SMS_REGION_ID || 'cn-hangzhou',
    SignName: signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: templateCode,
    TemplateParam: templateParam,
    Timestamp: new Date().toISOString(),
    Version: '2017-05-25',
  };

  // 1) 规范化查询串：按 key 升序、key=value 各做 encodeURIComponent 再拼接
  const canonicalized = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');

  // 2) 待签串：GET&/&规范化查询串（都做 encodeURIComponent）
  const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonicalized)}`;

  // 3) HMAC-SHA1，密钥末尾加 &，再做 base64
  const signature = crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');

  // 4) 拼最终 URL（Signature 也需 encode）
  const url =
    `https://${endpoint}/?Signature=${encodeURIComponent(signature)}&${canonicalized}`;

  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { Code: 'ParseError', Message: text };
  }
  if (body.Code !== 'OK') {
    throw new Error(body.Message || body.Code || 'unknown');
  }
  return body;
}
