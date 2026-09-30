// utils/api.js — 统一请求封装
// 关键点：
//   · 自动带上 Authorization: Bearer <token>（token 来自 app 全局存储）。
//   · 统一错误处理：网络失败 / 后端 { ok:false } / 401 都 reject 出可读错误。
//   · 401（token 失效）时清空本地 token，并触发一次静默登录刷新，便于后续重试。
//   · 所有调用方都应 catch 错误并「优雅降级」（空态 / 提示），不要白屏。

function getAppConfig() {
  const app = getApp();
  return (app && app.globalData && app.globalData.config) || { API_BASE: '' };
}

function getToken() {
  const app = getApp();
  if (app && app.globalData && app.globalData.token) return app.globalData.token;
  try {
    return wx.getStorageSync('ic_token') || '';
  } catch (e) {
    return '';
  }
}

function setToken(token, user) {
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.token = token;
    if (user !== undefined) app.globalData.user = user;
  }
  try {
    if (token) wx.setStorageSync('ic_token', token);
    else wx.removeStorageSync('ic_token');
    if (user !== undefined) {
      if (user) wx.setStorageSync('ic_user', user);
      else wx.removeStorageSync('ic_user');
    }
  } catch (e) {}
}

/** 触发静默登录（token 失效后刷新用） */
function refreshLogin() {
  const app = getApp();
  if (app && typeof app.silentLogin === 'function') app.silentLogin();
}

/**
 * 发起请求。
 * @param {object} opt { url, method='GET', data, auth=true }
 * @returns {Promise<any>} resolve 后端 data；reject { message, code, status }
 */
function request(opt) {
  const config = getAppConfig();
  const base = config.API_BASE || '';
  const url = opt.url.startsWith('http') ? opt.url : base + opt.url;
  const useAuth = opt.auth !== false;
  const token = getToken();

  const header = Object.assign({ 'Content-Type': 'application/json' }, opt.header || {});
  if (useAuth && token) header['Authorization'] = 'Bearer ' + token;

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: opt.method || 'GET',
      data: opt.data,
      header,
      timeout: opt.timeout || 15000,
      success(res) {
        const status = res.statusCode;
        const data = res.data || {};
        // 后端约定：登录类接口可能返回 { ok:false, error, code }（HTTP 200）
        if (status >= 200 && status < 300 && data.ok !== false) {
          resolve(data);
          return;
        }
        // 401 或业务失败
        if (status === 401 || data.code === 'unauthorized') {
          setToken('', null); // 清空失效 token
          refreshLogin();
          reject({ message: (data && data.error) || '登录已失效，请重试', code: data.code || 'unauthorized', status });
          return;
        }
        reject({
          message: (data && data.error) || ('请求失败（' + status + '）'),
          code: (data && data.code) || 'http_' + status,
          status,
        });
      },
      fail(err) {
        reject({ message: '网络请求失败：' + (err && err.errMsg ? err.errMsg : '未知错误'), code: 'network', status: 0 });
      },
    });
  });
}

export default { request, getToken, setToken, refreshLogin, getAppConfig };
