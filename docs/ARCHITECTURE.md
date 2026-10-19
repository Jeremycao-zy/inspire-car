# 架构与关键工程决策

> 本文记录**为什么代码是现在这样**，而不是"代码做了什么"（后者读代码即可）。
> 每条决策都标注了踩坑背景，改动相关代码前务必先读对应章节，否则极易把已解决的
> 问题重新引入。
>
> 文档版本：v1.0 · 2026-10-20

---

## 1. 总体架构

```
浏览器 (Three.js 0.160 WebGL)
  └─ Vite 构建产物 dist/（原生 JS ESM，无框架）
        │ HTTPS / JSON
Node.js 单端口服务 (server/index.mjs, PORT 8080)
  ├─ 静态产物托管 (server/static.mjs)
  ├─ REST API 30+ 端点
  ├─ AI 模型编排层（多引擎 + 自动降级）
  └─ 数据层（PostgreSQL / 本地 JSON 降级）
```

**选型理由**：
- **不引入 React/Vue**：包体是 3D 站的第一敌人，首屏 JS 已 1MB，框架只会更糟。
- **后端零框架**：Node 原生 http。30 个端点用手写路由完全可控，省一层依赖。
- **单端口全栈**：Docker 一层搞定前后端，备案场景只需放行一个 80 端口。
- **双模数据层**：开发期 `DATABASE_URL` 不设即走 JSON，生产一键切 PG。

---

## 2. 车型尺寸：权威库优先 + 保形门控

### 根因
早期版本让 LLM 按车型名"背"尺寸参数（"奔驰 SL350 车长 4.9 米"），**与用户上传的照片
完全解耦**——照片里是台改装车，尺寸却按原厂 4.9 米套。叠加归一化时的非等比拉伸，
结果是"结构对、比例假"。

### 三层解法
```
① 权威库 DB-first   server/carSpecs.db.json（种子 12 款，进 git）
                   归一化车型名 → 核心车型子串模糊匹配（阈值 0.85）
                   命中 → source:'official-db'  confidence:0.95（绿徽章）
                   未命中 → 退回 LLM（source:'model-llm'，琥珀徽章）

② 保形门控        normalizeCar(glb.js) 的 fit:'auto'|'lengthOnly'|'stretch'
                   尺寸不可信时只"纯等比锁车长"，绝不拉伸车身比例
                   偏差阈值 DEV_LO=0.85 / DEV_HI=1.18，超出则降级为估算

③ 置信度分离       nameConfidence = 车名识别把握（视觉模型给的）
                   confidence    = 参数可信度（official-db 固定 0.95）
                   面板据此显示来源徽章，诚实告知用户
```

### 铁律
- **`CONF_HIGH=0.85` 在 `src/main.js` 与 `server/specs.js` 必须一致**（代码注释已标
  "须与 server 一致"）。改一处不改另一处会出现前端显示绿徽章、后端却按估算处理的割裂。
- 保形优先于准确：**不可信尺寸只锁车长**，宁可尺寸略偏也不要比例失真。

---

## 3. 车身拆解：BANG 云端自动拆解，禁止 CSG 切割

### 根因
图生 3D 返回的是"整车"，四个轮子焊死在车身上。而改装应用的核心是**换轮毂**——轮子
不独立就没法换。

行业常规方案是 Three.js CSG 布尔运算切开车身腾出轮拱空间。**该方案已在本项目彻底废弃**
（`src/tuning/shellCutter.js` 整文件删除，commit `4009f3b`），原因：
1. 切割破坏原始网格拓扑，边缘出现锯齿和破面；
2. 车身自带纹理坐标被破坏，改色时直接出问题。

### 现行方案：Hyper3D BANG
BANG 在云端把整车 GLB 自动拆成**独立子网格**（车身 1 + 四轮 4），坐标与原始整车完全一致。

```
BANG 输出 = 单个 GLB，内含 5 个独立子网格
    ↓ splitBangFile()
车身 → 挂进 carInner（与 carGroup 共享归一变换）
四轮 → 不入场景，仅用质心反推轴距/轮距/轮心高
    ↓ 隐藏原始整车 → refitCar({recapture:true})
    重建轮位与底盘（车身自带真实轮拱，无需切割）
```

### 铁律
- **拆解产物只保留车身**。四轮的价值是提供轮心坐标，随后被"轮毂+轮胎+悬挂"程序化重建
  的部件替代——既拿到真实轮位，又不被低质量车轮模型拖累画质。
- **绝不能不拆**（只剩未拆解整车，换不了轮毂）也**绝不能整文件摆到车旁**（会变成双车）。
- 涉及"车身"的遍历（上色 collectBodyMaterials / 切原车轮 / 判断是否切过）统一走
  `bodyRoots()`，同时覆盖 carGroup 与装配体。
- **零额度取回**：服务端 `.cache/models/bang-index.json`（整车资产→部件）+
  `GET /api/bang-index?model=`；前端 `restoreBangForPlan()` 三级取值
  （方案自带 → 索引 → 提示重新拆解）。生成后立刻 `garage.upsertPlan()` 落盘，
  **别让产物只活在内存里**。

---

## 4. 轮毂落位：实测绝对坐标，禁用 ±轴距/2

### 根因（反直觉）
真实汽车**前后悬不等长**，所以**轴距中心 ≠ 车身包围盒中心**。行业常见的 `±轴距/2`
摆放左右轮毂在数学上对称，但真实车辆轴距中心通常不在包围盒几何中心。
**实测样本偏差达 +99mm**（将近 10 厘米），一眼就能看出的廉价感来源。

### 全链路
```
BANG 轮心质心
    ↓ deriveWheelGeometry()  返回 xFront / xRear（实测绝对坐标）
    ↓ params.axleXFront / axleXRear
    ↓ chassis.derive(real.axleX_F / R)        底盘按实测轴位重建
    ↓ rig.setRealGeometry({axleXFront, axleXRear})   轮毂按实测轴位摆位
```

### 铁律
- **实测值不要套 clamp**。`chassis.js` 的 `clamp(0.15L, 0.40L)` 只是给"估算模式"兜底的，
  对实测值套上会让实测退化成估算，**等于白测**。只做合理性校验。
- **换车必须调用 `rig.clearAxlePositions()`**。轴距/轮距是标量（旧值只是略偏），但
  **axleX 是绝对坐标**，留着上一辆车的值会把新轮毂直接摆飞。
- 轮毂识别阈值 `partClassify.js` 的 `maxThin` 现为 **0.65**（从早期 0.55 放宽）。
  0.55 是用窄胎样本反推的（胎宽 66mm→厚径比 0.38），遇宽胎车会失效。放宽是安全的：
  圆度 ≥0.75 已挡住车身（车身圆度通常 0.27~0.47），三条判据是与关系。

---

## 5. 轮毂生成：形状校验 + 拒绝降级

图生 3D 做轮毂时，AI 经常把轮毂照片重建成**整车尺寸的大块**（实测 1.81×1.16×1.90m），
装上去变成四个小车。

```
wheelShapeOf() 校验规则：
  圆度(roundness) > 0.75              // 轮毂是圆形，车身是长方体
  厚径比(thinness)  ∈ [0.10, 0.55]    // 轮毂是薄圆盘
```

**过不了校验 → 直接拒绝并保留程序化轮毂（WheelRig）**。宁可平庸，不可出错。
这一步保证 AI 能力的边界不会污染基础体验。

---

## 6. 移动端：WebGL 上下文生命周期管理

### 现象
iPhone Safari 打开工作台提示"此网页重复出现问题，因此已重新载入"，iPad 偶发白屏。

### 根因
不是普通内存溢出，而是 **WebGL 上下文泄漏 + 持续 GPU 负载触发系统 jetsam 杀 WebContent
进程**。页面里同时存在的 WebGL 上下文越多，触发概率越高；切换到大 3D 视图后，旧视图若
仍在渲染，上下文就会无限堆积。

### 原则：同时只活一个

| 模块 | 处理方式 |
|---|---|
| `core/viewer.js` | `setAnimationLoop(null)` 真正暂停（不只设布尔开关空跑）；`dispose()` 里 `renderer.dispose()` 后**必须** `renderer.forceContextLoss?.()` 立即归还上下文 |
| `ui/garage.js` | hero 预览的 RAF 在 `pause()` 里 `cancelAnimationFrame`；`dispose()` 遍历释放几何/材质/贴图；重复挂载先销毁旧实例 |
| `ui/planPreview.js` | 卡片是静态侧视图，**不常驻 60fps RAF**；"脏标记 + 按需渲染"，无待渲染卡片就停转 |
| `ui/loading3d.js` | 单例（全局最多一个加载上下文）；`ownerHost` 校验防两处互抢互杀 |

**这是移动端能不能用的分界线**，很多同类 3D Web 项目就倒在这里。

---

## 7. 部署与运维

### 现况
- **Fly.io**：`inspire-car`（sin 新加坡），单端口 8080，卷 `inspire_car_data` → `/app/.cache`。
- **⚠️ Fly 不监听 GitHub**。历史上因此误判过"已上线"（push 后线上纹丝不动）。
  **已配 CI/CD**：`.github/workflows/deploy.yml`，push 到 main 即自动构建+部署+冒烟测试。
  唯一需要的 GitHub Secret 是 `FLY_API_TOKEN`。

### 生产单端口
后端 `node server/index.mjs` 同时托管 `dist/` 静态 + `/api/*`。
环境变量：`PORT=8080` / `HOST=0.0.0.0` / `SERVE_STATIC=1`` / `SPA_FALLBACK=1`。
**敏感密钥走 `fly secrets set`，绝不进仓库**（HYPER3D/HUNYUAN3D/QWEN/FAL/WECHAT）。

### 数据持久化
- 无 `DATABASE_URL` → JSON 模式（数据在 `.cache` 各子目录）
- 有 `DATABASE_URL` → PostgreSQL
- ⚠️ **Fly volume 只能挂单机**，机器数必须 = 1。将来要横向扩容，必须先把 GLB/上传迁到
  对象存储（COS/S3），卷只适合存数据库类小文件。

### 深链 502 已修（commit `595aa10`）
真因：`static.mjs` 的 `sendIndex` 把**合成 req 对象**传给 `sendFile`（缺 `.on()`）→ 抛错 →
headersSent 二次写 → unhandled rejection → **Node 进程退出** → 网关 502。
**教训：合成请求对象是致命的**，静态服务里所有 `req.on` 调用都要做存在性判断 + 顶层 catch。

### 微信业务域名校验文件
必须放**域名根目录**（`https://域名/MP_verify_xxxx.txt`），**不是** `.well-known/`
（那是 Let's Encrypt 的）。SPA 回落会让缺失文件返回 200+HTML，
**自检必须 curl 看内容，不能只看状态码**。

---

## 8. 合规路线（上架前必读）

| 环节 | 要求 |
|---|---|
| **主体一致铁律** | 小程序主体 = ICP 备案主体 = 微信支付商户号主体，必须同一家企业 |
| **备案省份** | 按**营业执照注册地**，与服务器机房所在地无关。选错省份必被驳回 |
| **实名满 3 天** | 域名企业实名通过后需满 3 个日历天（工信部同步）才能提交备案 |
| **备案期间** | 网站须关闭，域名不得提前解析到境内 IP，否则被云厂商拦截 |
| **软著** | 著作权人可填个人（独立开发者）；用企业主体上架时附《软件著作权授权书》 |
| **APP/小程序备案** | 与网站备案是两件事，接入境内云服务的小程序需单独做 APP 备案 |

---

## 9. 本地开发

```bash
npm run dev        # 前端 5173 + 后端 8787（scripts/dev.mjs 双进程）
npm run build      # Vite 构建 → dist/
npm run verify     # 可持续回归验证（7 个 verify-* 脚本）
```

### 生成失败排查顺序（踩过）
1. `pgrep -f "scripts/dev.mjs"` 看进程还在不在
2. curl 两个端口
3. `cat .cache/models/usage.json` 看额度
4. 再查代码

> 典型现象：页面能开、生成必失败、usage.json 显示几分钟前还成功过
> → **服务被回收了**。

### 离线排查工具
- `node scripts/_glb-info.mjs <file.glb>` —— GLB 结构（子网格包围盒/材质/贴图）
- `node scripts/_qa-bang-axle.mjs` —— BANG 轮位链路（已归档，见 `tools/archive/`）

### 已知环境坑
- **本机 DNS 可能被 VPN 劫持**：查域名可注册性必须走 RDAP/CNNIC whois，
  `dig`/`nslookup` 结果不可信。
- `server/rodinPrompt.mjs` 在 Node 端，**Vite HMR 不处理它**，改了必须重启后端。
- 一次性调试脚本请用 `_qa-` 前缀（`.gitignore` 已自动忽略），别提交进仓库。
