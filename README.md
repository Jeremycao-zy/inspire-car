# 汽车改装 3D 预览 · Three.js + Vite

照片进、可调参的整车预览出。上传整车多角度照片 → 混元 3D 生成 GLB → 自动替换基础模型；
上传轮毂照片 → 生成独立轮毂 GLB → 自动复制 4 份装到车轮坐标；拖滑杆调 **ET / J / 倾角**，3D 里实时位移、缩放、旋转。

全流程自动：选完照片立即开始生成，模型就绪自动装载、自动归一、自动装配，**不需要手动点选任何零件**。

---

## 快速开始

```bash
cd garage-vite
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>。

首屏会自动载入 `public/models/my-car.glb`（一辆真实奔驰 SL350 的图生 3D 结果），
轮毂若 `public/models/wheel.glb` 存在则自动装载，否则自动回退到程序化轮毂。
**不配任何凭证也能直接玩**——上传照片走离线演示链路，界面与调参完全可用。

---

## 两种运行模式

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| **DEMO**（默认） | 未配置 `HUNYUAN3D_TOKEN` | 上传照片后返回预置模型，全流程 UI 跑通，不消耗额度 |
| **LIVE** | 配了凭证 | 真实调用混元 3D，单张约 2–5 分钟 |

切到 LIVE：

```bash
mkdir -p ~/.workbuddy/tokens
echo -n 'tk_你的token' > ~/.workbuddy/tokens/hunyuan3d
# 或者 export HUNYUAN3D_TOKEN=tk_xxx
npm run dev
```

侧栏顶部会显示当前模式（● LIVE / ○ DEMO）。

---

## 目录结构

```
garage-vite/
├── index.html                  页面骨架（侧栏 + 3D 视口）
├── vite.config.js              /api 代理到 8787
├── public/models/
│   ├── my-car.glb              预置整车（图生 3D 产物）
│   └── wheel.glb               预置轮毂（文生 3D 产物）
├── server/
│   ├── index.mjs               API 服务：SSE 进度、GLB 落盘、模式判定
│   └── hunyuan3d.mjs           混元 3D 客户端：TC3-HMAC-SHA256 签名 + 提交/轮询
└── src/
    ├── main.js                 入口：装配、启动序列、相机视角
    ├── core/
    │   ├── viewer.js           渲染器 / 相机 / 轨道控制 / RoomEnvironment / 主循环
    │   └── glb.js              GLB 加载与自动归一（整车 + 轮毂各一套）
    ├── tuning/
    │   ├── wheelRig.js         ★ 四轮装配 + ET/J/倾角实时变换
    │   ├── wheelFit.js         轮位自动推算 + 齐平度读数
    │   ├── tire.js             程序化轮胎（LatheGeometry 车削）
    │   └── proceduralRim.js    程序化轮毂兜底
    ├── api/generate.js         前端管线：压缩 → SSE → 拿 GLB
    └── ui/
        ├── panel.js            声明式控制面板（上传区 / 滑杆 / 预设 / 读数）
        └── styles.css
```

---

## 三个核心参数是怎么变成 3D 变换的

坐标约定：**+X 车头，+Y 上，+Z 车身左侧，车轮轴向 = Z**。

每个车轮的层级（`src/tuning/wheelRig.js`）：

```
mount        position = (轴X, 0, side × (半轮距 + ET位移 + 轮距微调))
 │            位置放在 y=0（接地印痕），倾角才是"绕接地点"旋转而不是绕轮心
 └── camberPivot   rotation.x = 倾角(rad) × side
      └── axle     position.y = 轮胎外半径 R
           ├── rimRoot   scale = (直径系数, 直径系数, J宽度系数)  ← 轮毂 GLB 的 clone
           └── tireMesh  程序化轮胎（四个角共享同一份几何）
```

| 参数 | 物理含义 | 实现 |
| --- | --- | --- |
| **ET（偏距 mm）** | 安装面相对轮辋中心线的偏移 | `offset = (ET_REF − ET) / 1000`，ET 越小越外凸；作用在 `mount.position.z`，接地印痕跟着一起外移 |
| **J（轮辋宽度 in）** | 轮辋两侧唇缘间距 | `宽度 = J × 25.4mm`，作用在 `rimRoot.scale.z`，关于轮心对称生长 |
| **倾角（度）** | 车轮相对垂直面的倾斜 | 作用在 `camberPivot.rotation.x`，负值 = 顶部内倾（内八）；`× side` 保证左右两侧都朝车身内侧倒 |

> **为什么 ET 放在 mount 而不是轮心**：换 ET 时接地印痕也会外移，这是真车行为。
> 只挪轮心不动接地点会出现"轮子飞出去、影子留在原地"的穿帮。

**轮胎外径** 遵循改装第一原则：`外径 = 轮辋直径 + 2 × 胎宽 × 扁平比`。
改扁平比时外径随之变化，轮辋可见尺寸跟着变——这也是为什么改参数能直接看出"胎薄了、圈大了"。

### 轮位自动推算

图生 3D 的 GLB 没有语义信息，读不出轮拱。用整车包围盒 + 工程经验比例反推（`wheelFit.js`）：

```
前轴中心 ≈ 距车头 21.5% 车长处
后轴中心 ≈ 距车尾 24.5% 车长处
半轮距   ≈ 车宽/2 − 轮辋宽/2 − 8mm   （胎侧基本与翼子板齐平）
```

算出来只是初值，"装配微调"里提供轮距 / 前轴 / 后轴微调滑杆，不调也能看。

---

## 混元 3D 接口契约

浏览器不能直接调：一是签名密钥不能进前端，二是网关不允许跨域。所以所有调用都走本地 Node 服务。

```
provider      : hy-3d
service       : ai3d
version       : 2025-05-13
region        : ap-guangzhou
submit action : SubmitHunyuanTo3DProJob
query  action : QueryHunyuanTo3DProJob

鉴权：TC3-HMAC-SHA256
  secretId  = "hy-3d.<token>"
  secretKey = "codebuddy"          # 代理网关内置签名串

响应：{ Response: { JobId } } / { Response: { Status, ResultFile3Ds: [{Type, Url}] } }
Status ∈ { RUN | DONE | FAIL }
```

请求体字段：`Model`（3.1）、`ImageBase64`、`Prompt`、`EnablePBR`、`FaceCount`、
`ResultFormat`（**必须大写**，仅支持 `OBJ / GLB / STL / FBX / USDZ`）。

完整实现见 `server/hunyuan3d.mjs`，零第三方依赖，只用 Node 内置 `crypto` / `https`。

### 关于多视角

`MultiViewImages` 字段需要**公网可访问的 URL**，本地文件没法直接传。
当前实现用主视角的 `ImageBase64`（单图即可出效果），多视角接口已在
`submitJob({ multiViewJson })` 留好入口——接上对象存储后把
`[{ViewType:'front', ViewImageUrl:'...'}]` 传进来即可，前端无需改动。

---

## 交互说明

- **上传**：点击虚线框或把照片拖进去，选中即开始生成，不需要二次确认
- **照片建议**：整车 3–5 张（正前 45°、侧面、正后 45°、正前、正尾）；轮毂 3–5 张（正面、侧面、斜 45°）
- **预设**：原厂 / 齐平Flush / 宽体 / HellaFlush，一键切换整套数据
- **读数**：实时显示当前设定下轮辋外缘相对车身侧面凸出多少 mm，并给出齐平 / 外凸 / 内凹判定
- **视角**：45° / 正侧 / 正前 / 正后 / 俯视 / 轮毂特写（特写适合判断 ET 与倾角）
- **车长校准**：图生 3D 输出的绝对尺度不可靠，按真车长度（SL350 = 4.53m）拉一下就准了
- **车身转 90°**：图生 3D 朝向不定，一键摆正

调试入口：`window.__garage`（`app` / `rig` / `viewer`），
`__garage.rig.worldPositions()` 可以打印四个轮心的世界坐标。

---

## 常见问题

**Q：侧栏显示 ○ DEMO，但我有 token？**
Token 要写到 `~/.workbuddy/tokens/hunyuan3d` 或用 `HUNYUAN3D_TOKEN` 环境变量导出，
然后重启 `npm run dev`（后端启动时读取一次）。

**Q：LIVE 模式下提交就报 `ResultFormat 不在支持列表`？**
`ResultFormat` 必须大写 `GLB`。代码里已修正，二次开发时留意别改回小写。

**Q：轮毂看起来比车身大/小很多？**
图生 3D 的绝对尺度不可靠。轮毂侧靠"轮辋直径 / J 值"两个滑杆校准，
车身侧拉"车长校准"到真车长度，两边就对上了。

**Q：生成的轮毂里包含轮胎，J 值看着不对？**
轮毂归一只做"量尺"不做缩放，最终宽度由 J 值滑杆直接指定，
所以不管模型里是裸轮辋还是带胎总成，拖 J 值都会校正到目标宽度。

**Q：想换掉预置模型？**
直接替换 `public/models/my-car.glb` 与 `public/models/wheel.glb` 即可，启动时自动加载。

---

## 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时起前端（5173）与后端（8787） |
| `npm run web` | 只起前端 |
| `npm run api` | 只起后端 |
| `npm run build` | 打包到 `dist/` |
| `npm run preview` | 预览打包产物 |
