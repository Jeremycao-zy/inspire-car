// app.js — 小程序全局配置与启动逻辑
// =============================================================
// ！！上线前需要替换的地方（详见 README / 微信后台配置清单）：
//   1) project.config.json 里的 appid 现在用的是占位 "touristappid"
//      （微信开发者工具游客模式可直开）。正式发布必须换成你自己的小程序 AppID。
//   2) 下面的 CONFIG.API_BASE / WEB_BASE 现在都是占位域名，
//      必须换成你的真实后端与 Web 应用域名（且必须是 https）。
//   3) 微信后台需配置：
//      - request 合法域名：你的 API_BASE（https）
//      - 业务域名：你的 WEB_BASE（承载 3D 编辑器 web-view，需下载校验文件放根目录）
//      本地开发可在开发者工具「详情 → 本地设置」勾选「不校验合法域名…」。
// =============================================================

const CONFIG = {
  // 后端 API 基地址（不带末尾斜杠）
  // 当前指向已上线的站点。换成国内备案域名后，只需改 API_BASE / WEB_BASE 这两行，其余代码不动。
  // 开发示例：'http://127.0.0.1:8787'（需在开发者工具勾选「不校验合法域名」）
  API_BASE: 'https://inspire-car.fly.dev',

  // 现有 Web 应用基地址（编辑器以 <web-view> 承载）
  WEB_BASE: 'https://inspire-car.fly.dev',

  // 编辑器路径：最终打开 `${WEB_BASE}${STUDIO_PATH}?token=<JWT>`
  // 深链（/studio 等未知子路径）自 2026-10-15 起已修复，线上返回 200（此前会 502，
  // 根因是 server/static.mjs 给 sendFile 传了合成 req 对象、缺 .on() 导致 Node 进程崩溃）。
  // 这里仍保持根路径 '/'：前端是单页应用、没有路由，/studio 只是回落到同一个首页，
  // 换成 '/studio' 不会打开不同的页面。等前端哪天做了真正的路由（如 #/studio），
  // 直接把这里改成对应路径即可，其余代码不用动。
  // Web 端 src/auth.js 的 consumeOAuthCallback 同时支持 oauth_token 与 token，用 token 即可。
  STUDIO_PATH: '/',

  // 本地存储键
  TOKEN_KEY: 'ic_token',
  USER_KEY: 'ic_user',
};

App({
  globalData: {
    config: CONFIG,
    token: '',
    user: null,
  },

  onLaunch() {
    const token = wx.getStorageSync(CONFIG.TOKEN_KEY) || '';
    const user = wx.getStorageSync(CONFIG.USER_KEY) || null;
    this.globalData.token = token;
    this.globalData.user = user;
    // 启动时静默登录：wx.login 拿 code → 后端换本站 JWT → 存 storage。
    // 失败仅告警，各页面自行优雅降级（不白屏）。
    this.silentLogin();
  },

  /**
   * 静默换取本站 JWT。
   * 任何一步失败都不抛错、不打断启动，仅 console.warn。
   */
  silentLogin() {
    const self = this;
    wx.login({
      success(res) {
        if (!res.code) {
          console.warn('[app] wx.login 未返回 code');
          return;
        }
        wx.request({
          url: self.globalData.config.API_BASE + '/api/auth/wechat/mini',
          method: 'POST',
          data: { code: res.code },
          timeout: 15000,
          header: { 'Content-Type': 'application/json' },
          success(r) {
            const d = r.data || {};
            if (d && d.token) {
              self.globalData.token = d.token;
              self.globalData.user = d.user || null;
              wx.setStorageSync(CONFIG.TOKEN_KEY, d.token);
              if (d.user) wx.setStorageSync(CONFIG.USER_KEY, d.user);
              console.log('[app] 小程序静默登录成功');
            } else if (d && d.error) {
              // 例如未配置 WECHAT_MINI_APPID → 明确错误，不打断使用
              console.warn('[app] 小程序登录未成功：', d.error);
            }
          },
          fail(e) {
            console.warn('[app] 小程序登录请求失败：', e);
          },
        });
      },
      fail(e) {
        console.warn('[app] wx.login 失败：', e);
      },
    });
  },
});
