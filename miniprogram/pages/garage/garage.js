// pages/garage/garage.js — 车库：拉取我的方案列表（调后端 API），卡片式展示
import api from '../../utils/api.js';
import theme from '../../utils/theme.js';

Page({
  data: {
    plans: [],
    loading: true,
    error: '',
    placeholder: theme.placeholderDataUri('INSPIRE CAR'),
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.request({ url: '/api/plans', method: 'GET' });
      const raw = Array.isArray(res.plans) ? res.plans : [];
      const plans = raw.map((p) => this.normalize(p));
      this.setData({ plans, loading: false });
    } catch (e) {
      // 优雅降级：网络/鉴权失败时不白屏，显示可读错误 + 重试
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  // 兼容后端 plan 字段的自由结构，尽量取出标题与封面
  normalize(p) {
    return {
      id: p.id || '',
      title: p.title || p.carName || p.name || '未命名方案',
      cover: p.thumbnail || p.imageUrl || p.cover || p.preview || '',
      desc: p.desc || (p.wheels ? '轮毂 / 车漆已定制' : '改装方案'),
    };
  },

  openPlan(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/editor/editor?planId=' + encodeURIComponent(id) });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  retry() {
    this.load();
  },

  placeholder() {
    return theme.placeholderDataUri('我的车库');
  },
});
