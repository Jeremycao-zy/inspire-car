/**
 * server/index.mjs — 本地 API 服务（无第三方依赖，纯 Node 内置模块）
 *
 * 提供三条路由：
 *   GET  /api/health              健康状态 + 当前运行模式（live=真实调用 / demo=离线演示）
 *   POST /api/generate            SSE：上传照片 → 调混元 3D → 下载 GLB → 回传可访问 URL
 *   GET  /api/asset/:name         取回生成好的 GLB
 *
 * 运行模式：
 *   - 配了 HUNYUAN3D_TOKEN（或 ~/.workbuddy/tokens/hunyuan3d）→ live，真实调用
 *   - 没配 → demo，直接返回 public/models 下的预置模型，全链路 UI 照样跑通
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as hy3d from './hunyuan3d.mjs';
import * as vision from './vision.mjs';
import * as higen from './higen3d.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'models');

const PORT = Number(process.env.API_PORT || 8787);
const MAX_BODY = Number(process.env.MAX_BODY_MB || 80) * 1024 * 1024;

/* 默认面数：标准档；请求体可带 faceCount 覆盖，用于实测上限或后续「高精档」UI */
const DEFAULT_FACE_COUNT = {
  car: 220000,
  wheel: 150000,
};

/* 精度档位 → 面数 / 模型（与前端 src/api/generate.js 的 PRECISION_TIERS 概念一致，
 * 后端仅消费 faceCount/model；输入分辨率/质量由前端本地 shrinkImage 处理）。
 * 标准/高精/极限三档，extreme 为待实测占位（探顶通过前上线默认走 high）。 */
const PRECISION_TIERS = {
  standard: { faceCount: 150000, model: '3.1' },
  high: { faceCount: 225000, model: '3.1' },
  extreme: { faceCount: 250000, model: '3.1' },
};

/* ------------------------- Token 解析 ------------------------- */

/**
 * 优先级：环境变量 > ~/.workbuddy/tokens/hunyuan3d
 * 平台下发的 tempToken（tk_ 开头）与 JWT 都可以用。
 *
 * 返回 { token, expiresAt, tokenId }：
 *   - token：凭证字符串（无则空串）
 *   - expiresAt：ISO8601 精确过期时间；若文件未携带第二行，降级为文件 mtime + 16h 估算
 *   - tokenId：token 的 sha256 前 8 位。用来让前端识别"是不是换了新票"，
 *              而不用把 token 本身发给浏览器。
 *
 * 为什么需要 tokenId：expiresAt 只是"声明"的过期时间，票可能被提前吊销、
 * 或者用户手抄错一位——这两种情况下文件还在、时间还没到，但云端会直接 401。
 * 前端记住"哪个 tokenId 被云端拒过"，才能把状态卡从 LIVE 切成已失效；
 * 等文件换成新票、tokenId 变了，才自动解除。
 */
function resolveToken() {
  let raw = '';
  let fromEnv = false;
  if (process.env.HUNYUAN3D_TOKEN) {
    raw = process.env.HUNYUAN3D_TOKEN;
    fromEnv = true;
  } else {
    const p = path.join(process.env.HOME || '', '.workbuddy', 'tokens', 'hunyuan3d');
    try {
      raw = fs.readFileSync(p, 'utf8').trim();
    } catch {
      /* 文件不存在就当没配 */
    }
  }

  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const token = lines[0] || '';
  let expiresAt = null;

  // 第二行：可选 ISO8601 精确过期时间
  if (lines[1]) {
    const d = new Date(lines[1]);
    if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
  }
  // 文件未携带时：mtime + 16h 估算（仅文件来源，环境变量无法携带）
  if (!expiresAt && !fromEnv && token) {
    const p = path.join(process.env.HOME || '', '.workbuddy', 'tokens', 'hunyuan3d');
    try {
      const m = fs.statSync(p).mtimeMs;
      expiresAt = new Date(m + 16 * 3600 * 1000).toISOString();
    } catch {
      /* 忽略 */
    }
  }

  const tokenId = token
    ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 8)
    : '';

  return { token, expiresAt, tokenId };
}

/* ------------------------- 工具 ------------------------- */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`请求体过大（>${MAX_BODY / 1024 / 1024}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- SSE 生成流 ------------------------- */

/**
 * 处理一次生成请求，以 SSE 持续推送进度。
 * body: { kind: 'car'|'wheel', images: [{name, dataUrl}], prompt? }
 */
async function handleGenerate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }

  const kind = body.kind === 'wheel' ? 'wheel' : 'car';
  const images = Array.isArray(body.images) ? body.images : [];
  // 任务名称：来自前端识别/用户手填；缺省给一个中性默认，保证索引可读
  const taskTitle =
    (body.title && String(body.title).trim()) ||
    (kind === 'wheel' ? '轮毂改装件' : '整车改装');
  // resumeJobId 是"续等已提交任务"，此时不需要重传图片
  if (!images.length && !body.prompt && !body.resumeJobId) {
    sendJson(res, 400, { error: '缺少图片或文本描述' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const emit = (obj) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const fail = (msg, detail) => {
    emit({ stage: 'error', progress: 1, message: msg, detail: String(detail || '').slice(0, 500) });
    if (!closed) res.end();
  };

  const t = resolveToken();
  const token = t.token;

  /**
   * 凭证失效的统一出口（红线：这里绝不返回演示模型冒充结果）。
   * 带上 tokenId，前端才能把"这张票被拒过"记下来，并在换票后自动解除。
   */
  const authError = (e) => {
    emit({
      stage: 'auth_error',
      progress: 1,
      message: '凭证已失效或无效，请在换票后点「我已更新」',
      detail: `${e?.code || ''} ${e?.message || ''}`.trim(),
      tokenId: t.tokenId,
    });
    if (!closed) res.end();
  };

  /* ---------- 多引擎路由：指定 higen3d 时走 HiGen3D 引擎（独立 key，与混元通道无关） ---------- */
  if (body.engine === 'higen3d') {
    await runHigen3D({ kind, images, body, taskTitle, emit, fail, closed });
    return;
  }

  /* ---------- DEMO 模式：不消耗额度，走预置模型 ---------- */
  if (!token) {
    const demoFile = kind === 'wheel' ? 'wheel.glb' : 'my-car.glb';
    const demoUrl = `/models/${demoFile}`;
    const steps =
      kind === 'wheel'
        ? ['读取轮毂照片', '识别轮辋直径与螺栓孔位', '重建辐条几何', '生成 PBR 材质', '导出 GLB']
        : ['读取整车照片', '长轴与姿态估计', '重建车身曲面', '生成 PBR 材质', '导出 GLB'];
    for (let i = 0; i < steps.length; i++) {
      if (closed) return;
      emit({ stage: 'demo', progress: (i + 1) / steps.length, message: `[离线演示] ${steps[i]}` });
      await sleep(700);
    }
    const exists = fs.existsSync(path.join(ROOT, 'public', 'models', demoFile));
    if (!exists) {
      fail('演示模型缺失，请确认 public/models 下有 ' + demoFile);
      return;
    }
    emit({
      stage: 'done',
      progress: 1,
      message: '完成（离线演示模型）',
      result: { url: demoUrl, kind, mode: 'demo' },
    });
    if (!closed) res.end();
    return;
  }

  /* ---------- LIVE 模式：真实调用混元 3D ---------- */
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });

    const b64List = images
      .map((im) => String(im.dataUrl || ''))
      .map((s) => (s.includes(',') ? s.slice(s.indexOf(',') + 1) : s))
      .filter(Boolean);

    // 续等模式：前端超时后携带原 JobId 二次请求，跳过重新提交
    let jobId = body.resumeJobId || null;
    // 精度档位 → 面数 / 模型（前端 PRECISION_TIERS 为单一真值；body.faceCount 仍可显式覆盖）
    const tier = (body.precision && PRECISION_TIERS[body.precision]) || null;
    const effectiveFaceCount =
      Number(body.faceCount) || (tier && tier.faceCount) || DEFAULT_FACE_COUNT[kind] || 220000;
    const effectiveModel = body.model || (tier && tier.model) || '3.1';

    if (!jobId) {
      emit({
        stage: 'submit',
        progress: 0.05,
        message: `提交任务（${b64List.length} 张图，主视角 ${Math.round((b64List[0]?.length || 0) / 1024)}KB，面数 ${effectiveFaceCount.toLocaleString()}）`,
      });
      try {
        const sub = await hy3d.submitJob({
          imagesBase64: b64List,
          prompt: body.prompt || '', // 有图时后端会自动丢弃 Prompt，避免与 ImageBase64 冲突
          multiViewJson: body.multiView || null,
          token,
          model: effectiveModel,
          faceCount: effectiveFaceCount,
          enablePbr: true,
        });
        jobId = sub.jobId;
      } catch (e) {
        // 红线：凭证失效 → 走换票引导，绝不当成普通失败
        if (hy3d.classifyError(e) === 'auth') {
          authError(e);
          return;
        }
        fail(`提交失败：${e.message}`, e.stack);
        return;
      }
      emit({ stage: 'accepted', progress: 0.12, message: `任务已受理 JobId=${jobId.slice(0, 12)}…` });
    } else {
      emit({ stage: 'accepted', progress: 0.12, message: `继续等待任务 ${jobId.slice(0, 12)}…` });
    }

    // 轮询（混元 3D 单张通常 2~5 分钟）
    const deadline = Date.now() + Number(process.env.MAX_POLL_MS || 12 * 60 * 1000);
    const interval = Number(process.env.POLL_INTERVAL_MS || 5000);
    let tick = 0;
    let result = null;

    while (Date.now() < deadline) {
      if (closed) return;
      await sleep(interval);
      let q;
      try {
        q = await hy3d.queryJob(jobId, token);
      } catch (e) {
        if (hy3d.classifyError(e) === 'auth') {
          authError(e);
          return;
        }
        fail(`查询失败：${e.message}`, e.stack);
        return;
      }
      tick += 1;

      if (hy3d.STATUS.DONE.includes(q.status)) {
        result = q;
        break;
      }
      if (hy3d.STATUS.FAIL.includes(q.status)) {
        fail('云端生成失败，可用同样参数重试', q.raw?.Message || q.status);
        return;
      }
      // 进度条用渐近曲线，避免给用户"卡住"的错觉
      const p = Math.min(0.9, 0.12 + tick * 0.028);
      emit({ stage: 'polling', progress: p, message: `生成中…（已等待 ${tick * (interval / 1000)}s，状态 ${q.status}）` });
    }

    if (!result) {
      // 超时：保留 JobId，前端可点「继续等待 8 分钟」续等（不判死）
      emit({ stage: 'timeout', progress: 1, message: '生成超时（云端任务仍在继续）', detail: jobId });
      if (!closed) res.end();
      return;
    }

    const glb = result.files.find((f) => f.type === 'glb') || result.files[0];
    if (!glb) {
      fail('云端未返回 GLB', JSON.stringify(result.files).slice(0, 300));
      return;
    }

    emit({ stage: 'downloading', progress: 0.93, message: '下载模型…' });
    // 下载失败自动重试 2 次（模型已在云端，重试不重复扣额度）
    let buf = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        buf = await hy3d.download(glb.url);
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) {
          emit({ stage: 'retry', progress: 0.94, message: `下载失败，第 ${attempt + 1} 次重试…` });
          await sleep(attempt === 0 ? 2000 : 6000);
        }
      }
    }
    if (!buf) {
      if (hy3d.classifyError(lastErr) === 'auth') {
        authError(lastErr);
      } else {
        fail(`下载失败：${lastErr?.message || '未知错误'}`, lastErr?.stack);
      }
      return;
    }

    // 可读命名：{kind}-{YYYYMMDD-HHmm}-{hash6}.glb
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const name = `${kind}-${ts}-${crypto.randomBytes(3).toString('hex')}.glb`;
    await fsp.writeFile(path.join(CACHE_DIR, name), buf);

    // 写历史索引 + 额度计数（仅成功生成计入消耗）
    const usage = bumpUsage();
    appendIndex({
      name,
      kind,
      size: buf.length,
      createdAt: d.toISOString(),
      imageCount: b64List.length,
      faceCount: effectiveFaceCount,
      model: effectiveModel,
      precision: body.precision || null,
      jobId,
      title: taskTitle,
    });

    emit({
      stage: 'done',
      progress: 1,
      message: `完成（${(buf.length / 1024 / 1024).toFixed(1)}MB）`,
      result: {
        url: `/api/asset/${name}`,
        kind,
        mode: 'live',
        bytes: buf.length,
        preview: glb.preview,
        name,
        title: taskTitle,
        usage,
      },
    });
    if (!closed) res.end();
  } catch (e) {
    // 兜底：LIVE 失败一律 error，绝不降级到 DEMO 演示模型（红线）
    fail(e.message || '生成失败', e.stack);
  }
}

/**
 * HiGen3D 引擎生成流（骨架）。
 * 当前 higen3d.submitJob 在缺少官方 API 文档时抛 EngineNotConfigured，
 * 故本函数会就地给出「待配置」友好错误，绝不降级到 DEMO 演示模型（红线）。
 * 拿到 higen3d.com Studio 控制台文档后，仅需填充 higen3d.mjs 的真实调用并补全流程。
 */
async function runHigen3D({ kind, images, body, taskTitle, emit, fail, closed }) {
  if (!higen.available()) {
    fail('HiGen3D 引擎未配置：请订阅 Studio 套餐，把 API Key 写入 ~/.workbuddy/tokens/higen3d', 'no-engine-key');
    return;
  }
  try {
    const b64List = images
      .map((im) => String(im.dataUrl || ''))
      .map((s) => (s.includes(',') ? s.slice(s.indexOf(',') + 1) : s))
      .filter(Boolean);

    emit({ stage: 'submit', progress: 0.05, message: `提交 HiGen3D 任务（${b64List.length} 张图）` });
    const sub = await higen.submitJob({
      images: b64List,
      mode: body.higenMode || 'best', // Fast / Quality / Best
      kind,
    });
    // TODO(订阅后填充)：依据官方文档实现 轮询/回调 → 下载 GLB → 命名写缓存 → 下发 done 事件
    // 可参考上方混元 LIVE 段的命名（kind-{ts}-{hash}.glb）、bumpUsage/appendIndex 与 emit done 逻辑。
    void sub;
    fail('HiGen3D 引擎待配置：submitJob 尚未实现，需官方 API 文档', 'engine-not-impl');
  } catch (e) {
    if (e?.code === 'ENGINE_NOT_CONFIGURED' || e?.code === 'engine-not-impl') {
      fail('HiGen3D 引擎待配置：请订阅 Studio 并把官方 API 文档发给开发者', e.message);
      return;
    }
    fail(`HiGen3D 生成失败：${e.message}`, e.stack);
  }
}

/* ------------------------- 历史索引 / 额度计数（仅成功生成计入消耗） ------------------------- */

function bumpUsage() {
  try {
    const p = path.join(CACHE_DIR, 'usage.json');
    let data = { success: 0, failed: 0 };
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* 不存在则用默认 */
    }
    data.success = (data.success || 0) + 1;
    data.lastAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return data;
  } catch {
    return { success: 1, failed: 0 };
  }
}

function appendIndex(record) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const p = path.join(CACHE_DIR, 'index.json');
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* 不存在则用空 */
    }
    if (!Array.isArray(list)) list = [];
    list.push(record);
    fs.writeFileSync(p, JSON.stringify(list, null, 2));
  } catch {
    /* 记录失败不影响主流程 */
  }
}

/* ------------------------- 静态资源 ------------------------- */

async function handleAsset(req, res, name) {
  const safe = path.basename(name);
  // 只允许取 GLB，避免把 usage.json / index.json 当模型下发
  if (!safe.toLowerCase().endsWith('.glb')) {
    sendJson(res, 404, { error: 'asset not found' });
    return;
  }
  const file = path.join(CACHE_DIR, safe);
  try {
    const st = await fsp.stat(file);
    res.writeHead(200, {
      'Content-Type': 'model/gltf-binary',
      'Content-Length': st.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'asset not found' });
  }
}

/* ------------------------- 车型识别（视觉模型） ------------------------- */

/**
 * POST /api/recognize
 * 入参：{ images: [{ dataUrl }] }   前端已压缩好的 JPEG dataURL
 * 出参：
 *   { available:true, brand, model, year, trim, fullName, confidence, raw }
 *   { available:false, reason:'no-key' }      未配置视觉 key
 *   { available:false, reason:'auth', detail } key 失效
 *   { available:false, reason:'error', detail } 其它
 */
async function handleRecognize(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }
  const images = Array.isArray(body.images) ? body.images : [];
  const first = images.find((im) => im && im.dataUrl) || null;
  if (!first) {
    sendJson(res, 400, { error: '缺少图片' });
    return;
  }
  const r = await vision.recognize({ dataUrl: first.dataUrl });
  sendJson(res, 200, r);
}

/* ------------------------- 启动 ------------------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (u.pathname === '/api/health') {
    const tk = resolveToken();
    sendJson(res, 200, {
      ok: true,
      mode: tk.token ? 'live' : 'demo',
      expiresAt: tk.expiresAt || null,
      tokenId: tk.tokenId || null, // 只是 token 的短哈希，不含凭证本身
      endpoint: hy3d.ENDPOINT,
      engines: {
        hunyuan: { mode: tk.token ? 'live' : 'demo' },
        higen3d: { available: higen.available(), endpoint: higen.ENDPOINT_INFO.ENDPOINT },
        vision: vision.getVisionStatus(),
      },
      hint: tk.token ? '已配置凭证，将真实调用混元 3D' : '未配置凭证，当前为离线演示模式',
    });
    return;
  }

  if (u.pathname === '/api/generate' && req.method === 'POST') {
    await handleGenerate(req, res);
    return;
  }

  if (u.pathname.startsWith('/api/asset/')) {
    await handleAsset(req, res, u.pathname.slice('/api/asset/'.length));
    return;
  }

  if (u.pathname === '/api/recognize' && req.method === 'POST') {
    await handleRecognize(req, res);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  const tk = resolveToken();
  console.log(`\n  ▸ API 服务已启动  http://127.0.0.1:${PORT}`);
  console.log(`  ▸ 运行模式：${tk.token ? 'LIVE（真实调用混元 3D）' : 'DEMO（离线演示，不消耗额度）'}`);
  console.log(`  ▸ 网关地址：${hy3d.ENDPOINT}`);
  if (!tk.token) {
    console.log(
      `  ▸ 想切到真实生成：export HUNYUAN3D_TOKEN=<你的 token>  或写入 ~/.workbuddy/tokens/hunyuan3d\n`
    );
  } else {
    console.log(`  ▸ 凭证预计过期：${tk.expiresAt || '未知（文件未携带第二行）'}`);
  }
});
