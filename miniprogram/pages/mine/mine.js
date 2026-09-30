// pages/mine/mine.js — 我的：登录状态 / 用户信息 / 隐私协议 / 客服入口
const app = getApp();
import api from '../../utils/api.js';

Page({
  data: {
    loggedIn: false,
    user: null,
  },

  onShow() {
    const g = app.globalData;
    this.setData({ loggedIn: !!g.token, user: g.user });
  },

  // 重新触发静默登录（token 失效 / 未登录时）
  relogin() {
    if (app.silentLogin) app.silentLogin();
    // 稍等让登录写入
    setTimeout(() => {
      const g = app.globalData;
      this.setData({ loggedIn: !!g.token, user: g.user });
      wx.showToast({ title: g.token ? '登录成功' : '仍未登录，请稍后重试', icon: 'none' });
    }, 1500);
  },

  logout() {
    api.setToken('', null);
    app.globalData.token = '';
    app.globalData.user = null;
    this.setData({ loggedIn: false, user: null });
    wx.showToast({ title: '已退出', icon: 'none' });
  },

  // 隐私协议：优先微信隐私弹窗，失败提示去后台配置
  openPrivacy() {
    if (wx.openPrivacyContract) {
      wx.openPrivacyContract({
        fail: () => wx.showToast({ title: '暂未配置隐私协议', icon: 'none' }),
      });
    } else {
      wx.showToast({ title: '请前往小程序后台配置隐私协议', icon: 'none' });
    }
  },

  // 客服入口（使用微信内置客服会话，需在「小程序后台 → 功能 → 客服」开启）
  // 这里只是兜底提示，真正入口用 WXML 里的 <button open-type="contact">
  contactTip() {
    wx.showToast({ title: '点击下方「联系客服」按钮', icon: 'none' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
