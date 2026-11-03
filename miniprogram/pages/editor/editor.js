// pages/editor/editor.js — 3D 编辑器：用 <web-view> 承载现有 Web 应用（TUNING STUDIO）
// 只负责拼出 web-view 的 src：WEB_BASE + STUDIO_PATH + '?token=<JWT>'（+可选 planId）
// token 来自 app 全局存储（启动静默登录已写入）；若尚未就绪，先触发一次静默登录再打开。
const app = getApp();
import api from '../../utils/api.js';

Page({
  data: {
    url: '',
  },

  onLoad(query) {
    this.buildUrl(query);
  },

  buildUrl(query) {
    const config = app.globalData.config;
    let token = app.globalData.token || api.getToken();

    const finish = (tk) => {
      let url =
        config.WEB_BASE + config.STUDIO_PATH + '?token=' + encodeURIComponent(tk || '');
      const planId = query && query.planId;
      if (planId) url += '&planId=' + encodeURIComponent(planId);
      // 上传模式：透传 mode 给 Web 端（若 Web 端支持）
      const mode = query && query.mode;
      if (mode) url += '&mode=' + encodeURIComponent(mode);
      this.setData({ url });
    };

    if (token) {
      finish(token);
    } else {
      // 微信 web-view 需要非空 src 才能渲染，这里先给占位，触发登录后回填
      this.setData({ url: '' });
      if (app.silentLogin) app.silentLogin();
      // 最多等 ~1.2s 让静默登录拿到 token
      let waited = 0;
      const timer = setInterval(() => {
        waited += 200;
        const tk = app.globalData.token || api.getToken();
        if (tk || waited >= 1200) {
          clearInterval(timer);
          finish(tk);
        }
      }, 200);
    }
  },
});
