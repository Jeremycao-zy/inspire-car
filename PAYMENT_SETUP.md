# 支付接入说明（微信 V3 + 支付宝手机网站）

> 本次落地日期：2026-11-03
> 代码风格遵循项目约定：**零三方依赖**（只用 `node:https` + `node:crypto`）、双模式存储（PostgreSQL / JSON 回退）、外部依赖失败不打死进程。

---

## 一、本次改了什么

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/pay.mjs` | **新增** | 微信支付 V3 + 支付宝手机网站支付的签名、下单、验签、解密；套餐配置 |
| `server/db.mjs` | 修改 | 新增 `orders` / `entitlements` / `payment_logs` 三张表（SQL）与 `.cache/pay/*.json`（JSON 回退）；新增建单、幂等改单、发放权益、扣减额度等函数 |
| `server/index.mjs` | 修改 | 新增支付路由；新增 `readRawBody` / `parseForm` / `sendText` 三个 helper（回调必须用原始报文验签） |
| `public/pay.html` | **新增** | 自包含的收银页（微信内走 JSAPI，浏览器走支付宝），无构建依赖 |
| `.env.example` | 修改 | 追加支付段环境变量说明 |

---

## 二、接口一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/pay/plans` | 否 | 套餐列表 + 各通道是否已配置 |
| POST | `/api/pay/create` | 是 | 建单；`{planId, channel:'wx'\|'ali', openid?}` |
| POST | `/api/pay/wx/notify` | 否（验签） | 微信支付回调 |
| POST | `/api/pay/ali/notify` | 否（验签） | 支付宝异步通知 |
| GET | `/api/pay/order/:outTradeNo` | 是 | 查订单状态（前端轮询用） |
| GET | `/api/pay/orders` | 是 | 我的订单列表 |
| GET | `/api/pay/entitlements` | 是 | 剩余次数 / 会员到期 |
| GET | `/api/pay/wx/authorize` | 否 | 302 跳公众号网页授权（静默拿 code） |
| POST | `/api/pay/wx/openid` | 否 | 用 code 换 openid |

**套餐**（`server/pay.mjs` 的 `PLANS`，改价只动这里）：

| id | 名称 | 价格 | 单次价 | 类型 |
|---|---|---|---|---|
| `single` | 单次体验 | ¥29.00 | ¥29.0 | 1 次，永久 |
| `pack5` | 5 次包 | ¥99.00 | ¥19.8 | 5 次，永久 |
| `pack12` | 12 次包 | ¥199.00 | ¥16.6 | 12 次，永久 |
| `studio` | 工作室月卡 | ¥399.00 | ¥20.0 | 30 天 20 次 |
| `pro` | 专业版月卡 | ¥999.00 | ¥16.7 | 30 天 60 次 |

> 售卖单位是「次」：1 次 = 一次完整整车方案（Rodin 生成 + BANG 拆解）。
> 单次内部成本约 ¥5.3，定价下限 = 3 × 成本，任何套餐单次价不得低于 ¥15。
> 订阅同样带次数上限（`quota`），扣减逻辑在 `db.consumeQuota`，别再改回「不限次」。
> id 与 `src/ui/subscribe.js` 对齐，改价时两边同步。

---

## 三、环境变量

把 `.env.example` 的支付段复制到实际环境（本地 `.env` 或 Railway Variables）。

### 微信（公众号内 H5 / JSAPI）

| 变量 | 从哪拿 |
|---|---|
| `WXPAY_APPID` | 公众号后台 → 设置与开发 → 基本配置 |
| `WXPAY_APPSECRET` | 同上（仅换 openid 用） |
| `WXPAY_MCHID` | 微信支付商户平台 → 账户中心 |
| `WXPAY_SERIAL_NO` | 商户平台 → 账户中心 → API 安全 → 证书序列号 |
| `WXPAY_PRIVATE_KEY` | 申请 API 证书后下载的 `apiclient_key.pem` 全文 |
| `WXPAY_APIV3_KEY` | 商户平台 → API 安全 → 设置 APIv3 密钥（32 位） |
| `WXPAY_PUBLIC_KEY` / `WXPAY_PUBLIC_KEY_ID` | 商户平台 → API 安全 → 微信支付公钥（**推荐**，免平台证书） |
| `WXPAY_NOTIFY_URL` | `https://inspire-car.com/api/pay/wx/notify` |

> PEM 支持整段粘贴，也支持把换行写成字面量 `\n`——`server/pay.mjs` 的 `pem()` 会自动还原。

### 支付宝（手机网站支付）

| 变量 | 从哪拿 |
|---|---|
| `ALIPAY_APP_ID` | 支付宝开放平台 → 应用详情 |
| `ALIPAY_PRIVATE_KEY` | 你用工具生成的应用私钥 |
| `ALIPAY_PUBLIC_KEY` | 开放平台 → 应用 → 接口加签方式 → **支付宝公钥** |
| `ALIPAY_NOTIFY_URL` | `https://inspire-car.com/api/pay/ali/notify` |
| `ALIPAY_RETURN_URL` | `https://inspire-car.com/pay.html?paid=1` |

---

## 四、本地怎么自测（无凭证也能测）

```bash
node server/index.mjs          # 或 npm run api
```

1. 打开 `http://127.0.0.1:8787/api/pay/plans`
   → 应返回 3 个套餐，`channels` 为 `{"wx":false,"ali":false}`（说明未配置，属正常）
2. 主站登录后访问 `http://127.0.0.1:8787/pay.html`
   → 能看到套餐卡片；点购买会提示"通道未配置"
3. 数据层逻辑（幂等 / 发权益 / 扣次数）已通过脚本验证：

```
1 建单 OK pending
2 首次标记支付: true
3 重复标记支付(应 false): false
4 首次发权益: { granted: true }
5 重复发权益(应已发): { granted: false, reason: 'already_granted' }
7 扣次数: { ok: true, via: 'quota', remaining: 0 }
8 再扣(应失败): { ok: false, reason: 'no_quota' }
9 订阅后: { quota: 0, active: true, expiresAt: '...' }
10 订阅期内消费: { ok: true, via: 'subscription' }
```

---

## 五、上线前必须完成的前置（业务侧，不是代码）

1. **营业执照**（已有）
2. **认证服务号**（¥300/年）—— 微信内支付必需
3. **微信支付商户号** + 与服务号 APPID 绑定
4. **支付宝企业账号** + 签约「手机网站支付」
5. **`inspire-car.com` 备案完成 + 解析到大陆服务器 + HTTPS**
6. 公众号后台「网页授权域名」= `inspire-car.com`
7. 商户平台「支付授权目录」= `https://inspire-car.com/`

---

## 六、端到端验证清单

- [ ] `/api/pay/plans` 的 `channels` 变成 `{"wx":true,"ali":true}`
- [ ] 微信内打开 `pay.html` → 点购买 → 弹收银台 → 付 0.01
- [ ] 浏览器打开 `pay.html` → 点购买 → 跳支付宝 → 付 0.01
- [ ] 支付后 `GET /api/pay/order/:no` 的 `status` 变 `paid`
- [ ] `GET /api/pay/entitlements` 的次数/到期时间正确增加
- [ ] **重复回调不重复发货**（在微信/支付宝后台点"重发通知"，权益只加一次）
- [ ] 退款流程走通（目前需在商户后台手动退，代码未接退款接口）

---

## 七、常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `微信回调验签失败` | 公钥/平台证书不对，或 `WXPAY_APIV3_KEY` 错 | 核对 `WXPAY_PUBLIC_KEY_ID` 与 `Wechatpay-Serial` 是否一致 |
| 下单报 `签名错误` | 私钥没换行 / 用错密钥 | 确认 `pem()` 已还原换行；私钥必须与证书序列号配套 |
| 微信内点购买没反应 | 未拿到 openid | 先走 `/api/pay/wx/authorize` 授权 |
| 支付宝跳转后 `验签失败` | 用了"应用公钥"而非"支付宝公钥" | 换成开放平台里的**支付宝公钥** |
| 钱扣了但没权益 | 回调地址不通 / 返回不是 `success` | 检查 `*_NOTIFY_URL` 公网可达；响应体必须是 `success` / `{"code":"SUCCESS"}` |
| 权益重复到账 | 改了 `markOrderPaid` 的 `status='pending'` 条件 | 该条件是幂等核心，不要删 |

---

## 八、购买入口（已接好）

- **订阅弹窗**：`src/ui/subscribe.js` 的 `handleSelect()` 已改为跳转 `/pay.html?plan=<id>`，收银页会高亮对应方案。
- **主站 token**：存在 `localStorage['inspire-auth-token']`（见 `src/auth.js`），收银页自动读取。
- **独立入口**：任何按钮直接 `location.href = '/pay.html'` 也能用。

需要内嵌（不跳页）时，按同样顺序调：
1. `GET /api/pay/plans` 渲染套餐
2. `POST /api/pay/create` 拿 `wx` 参数或 `ali` 的 `url`
3. 微信：`WeixinJSBridge.invoke('getBrandWCPayRequest', ...)`；支付宝：`location.href = url`
4. 轮询 `GET /api/pay/order/:no` 直到 `status === 'paid'`

（`public/pay.html` 里的实现可直接抄，逻辑约 150 行。）

---

## 九、还没做的（下一步）

- **退款接口**：目前只能在商户后台手动退款
- **超时关单**：建议加定时任务，把 30 分钟未支付的 `pending` 单关掉
- **对账**：每日拉微信/支付宝账单与 `orders` 比对
- **`/api/generate` 接入额度校验**：在生成前调 `db.consumeQuota(uid)`，返回 `no_quota` 时提示购买（**这是把支付和产品真正连起来的关键一步，建议优先做**）
