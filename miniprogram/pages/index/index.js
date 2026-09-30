// pages/index/index.js — 首页：品牌视觉 + 主 CTA + 功能卡片
const app = getApp();

Page({
  data: {
    loggedIn: false,
    user: null,
  },

  onShow() {
    const g = app.globalData;
    this.setData({ loggedIn: !!g.token, user: g.user });
  },

  // 主 CTA：进入 3D 编辑器（web-view 承载现有 Web 应用）
  goEditor() {
    wx.navigateTo({ url: '/pages/editor/editor' });
  },

  // 功能卡片：上传照片 → 编辑器（上传/生成在 Web 端完成）
  goUpload() {
    wx.navigateTo({ url: '/pages/editor/editor?mode=upload' });
  },

  // 功能卡片：我的车库
  goGarage() {
    wx.switchTab({ url: '/pages/garage/garage' });
  },
});
