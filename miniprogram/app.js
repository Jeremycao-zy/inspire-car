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
  // 开发示例：'http://127.0.0.1:8787'（需勾选不校验域名）
  // 生产示例：'https://api.your-domain.com'
  API_BASE: 'https://your-domain.example.com',

  // 现有 Web 应用基地址（编辑器以 <web-view> 承载）
  // 生产示例：'https://your-domain.com'
  WEB_BASE: 'https://your-domain.example.com',

  // 编辑器路径：最终打开 `${WEB_BASE}${STUDIO_PATH}?token=<JWT>`
  // 注意：现有 Web 应用目前消费的是 URL 里的 `oauth_token` 参数，
  // 上线前需确认 /studio 页面能读取 `token`（或此处改为 `oauth_token=`）。
  STUDIO_PATH: '/studio',

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
