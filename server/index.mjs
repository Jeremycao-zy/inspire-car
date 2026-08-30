/**
 * server/index.mjs — 本地 API 服务（无第三方依赖，纯 Node 内置模块）
 *
 * 提供路由：
 *   GET  /api/health              健康状态 + 当前运行模式（live=真实调用 / demo=离线演示）
 *   POST /api/generate            SSE：上传照片 → 调 3D 引擎(Rodin/Hunyuan/HiGen) → 下载 GLB → 回传可访问 URL
 *   POST /api/bang                SSE：BANG 拆解（Hyper3D），把整车模型拆成多个部件
 *   GET  /api/asset/:name         取回生成好的 GLB
 *   POST /api/recognize           车型识别（视觉模型）
 *
 * 多引擎共存：
 *   - 配了 HUNYUAN3D_TOKEN（或 ~/.workbuddy/tokens/hunyuan3d）→ hunyuan 走 live
 *   - 配了 HYPER3D_API_KEY（或 ~/.workbuddy/tokens/hyper3d）→ hyper3d(Rodin/BANG) 走 live
 *   - 都没有 → demo，直接返回 public/models 下的预置模型，全链路 UI 照样跑通
 *
 * 红线：
 *   - auth/quota 失败绝不自动降级到 demo 模型，必须回传对应终止态让用户换票/等明天。
 *   - /download / BANG 返回的 URL 会过期，必须立即下载落本地，绝不只存 URL。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as hy3d from './hunyuan3d.mjs';
import * as hyper3d from './hyper3d.mjs';
import * as fal from './fal3d.mjs';
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

/* ------------------------- Token 解析（混元） ------------------------- */

/**
 * 优先级：环境变量 > ~/.workbuddy/tokens/hunyuan3d
 * 平台下发的 tempToken（tk_ 开头）与 JWT 都可以用。
 *
 * 返回 { token, expiresAt, tokenId }：
 *   - token：凭证字符串（无则空串）
 *   - expiresAt：ISO8601 精确过期时间；若文件未携带第二行，降级为文件 mtime + 16h 估算
 *   - tokenId：token 的 sha256 前 8 位。用来让前端识别"是不是换了新票"，
 *              而不用把 token 本身发给浏览器。
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
 * body: { kind: 'car'|'wheel', images: [{name, dataUrl}], prompt?, engine?, precision?, resumeJobId? }
 *
 * engine 路由：
 *   'higen3d' → HiGen3D 引擎（独立 key）
 *   'hyper3d' → Hyper3D Rodin Gen-2.5 生成
 *   未指定    → 混元 3D（默认保留，向后兼容旧调用）
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

  const engine = body.engine || 'hunyuan';

  /* ---------- 多引擎路由：HiGen3D（独立 key，与混元通道无关） ---------- */
  if (engine === 'higen3d') {
    await runHigen3D({ kind, images, body, taskTitle, emit, fail, closed });
    return;
  }

  /* ---------- 多引擎路由：Hyper3D Rodin Gen-2.5 ---------- */
  if (engine === 'hyper3d') {
    await runHyper3D({ kind, images, body, taskTitle, emit, fail, closed, isClosed: () => closed });
    return;
  }

  /* ---------- 多引擎路由：fal.ai 上的 Rodin（按次计费，精度更高，无每日上限） ---------- */
  if (engine === 'fal') {
    await runFal3D({ kind, images, body, taskTitle, emit, fail, isClosed: () => closed });
    return;
  }

  /* ---------- 默认：混元 3D（保留向后兼容） ---------- */

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

  const t = resolveToken();
  const token = t.token;

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
        // 红线：凭证失效 → 走换票引导；额度用完 → 走配额引导；其余才是普通失败
        const cls = hy3d.classifyError(e);
        if (cls === 'auth') {
          authError(e);
          return;
        }
        if (cls === 'quota') {
          emit({
            stage: 'quota_exceeded',
            progress: 1,
            message: '今日 hy-3d 额度已用完，请明天再试或改用演示模型',
            detail: `${e?.code || ''} ${e.message}`.trim(),
          });
          if (!closed) res.end();
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
      engine: 'hunyuan',
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
        engine: 'hunyuan',
      },
    });
    if (!closed) res.end();
  } catch (e) {
    // 兜底：LIVE 失败一律 error，绝不降级到 DEMO 演示模型（红线）
    fail(e.message || '生成失败', e.stack);
  }
}

/**
 * Hyper3D Rodin Gen-2.5 生成流。
 * 无 HYPER3D_API_KEY 时走 DEMO（返回预置模型，绝不冒充真实结果）；
 * auth/quota 失败绝不降级 demo，必须回传 auth_error / quota_exceeded。
 */
async function runHyper3D({ kind, images, body, taskTitle, emit, fail, closed, isClosed }) {
  const h = hyper3d.resolveToken();
  const token = h.token;

  const authError = (e) => {
    emit({
      stage: 'auth_error',
      progress: 1,
      message: 'Hyper3D 凭证已失效或无效，请在换票后点「我已更新」',
      detail: `${e?.code || ''} ${e?.message || ''}`.trim(),
      tokenId: h.tokenId,
    });
  };

  /* ---------- DEMO 模式 ---------- */
  if (!token) {
    const demoFile = kind === 'wheel' ? 'wheel.glb' : 'my-car.glb';
    const demoUrl = `/models/${demoFile}`;
    const steps =
      kind === 'wheel'
        ? ['读取轮毂照片', '识别轮辋参数', '重建辐条几何', '生成 PBR 材质', '导出 GLB']
        : ['读取整车照片', '姿态估计', '重建车身曲面', '生成 PBR 材质', '导出 GLB'];
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
      result: { url: demoUrl, kind, mode: 'demo', engine: 'hyper3d' },
    });
    return;
  }

  /* ---------- LIVE 模式 ---------- */
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });

    const b64List = images
      .map((im) => String(im.dataUrl || ''))
      .map((s) => (s.includes(',') ? s.slice(s.indexOf(',') + 1) : s))
      .filter(Boolean);

    // precision → Rodin tier
    const TIER = {
      standard: 'Gen-2.5-Medium',
      high: 'Gen-2.5-High',
      extreme: 'Gen-2.5-Extreme-High',
    };
    const tier = TIER[body.precision] || 'Gen-2.5-High';

    emit({
      stage: 'submit',
      progress: 0.05,
      message: `提交 Hyper3D Rodin 任务（${b64List.length} 张图，档位 ${tier}）`,
    });

    let sub;
    try {
      sub = await hyper3d.submitRodin({
        imagesBase64: b64List,
        prompt: body.prompt || '',
        tier,
        meshMode: 'Raw',
        material: 'PBR',
        geometryFileFormat: 'glb',
      });
    } catch (e) {
      const cls = hyper3d.classifyError(e);
      if (cls === 'auth') {
        authError(e);
        return;
      }
      if (cls === 'quota') {
        emit({
          stage: 'quota_exceeded',
          progress: 1,
          message: '今日 Hyper3D 额度已用完，请明天再试或改用演示模型',
          detail: `${e?.code || ''} ${e.message}`.trim(),
        });
        return;
      }
      fail(`提交失败：${e.message}`, e.stack);
      return;
    }
    emit({
      stage: 'accepted',
      progress: 0.12,
      message: `任务已受理 ${String(sub.taskUuid).slice(0, 12)}…`,
    });

    // 轮询（Gen-2.5 通常 1~4 分钟）
    const deadline = Date.now() + Number(process.env.MAX_POLL_MS || 12 * 60 * 1000);
    const interval = Number(process.env.POLL_INTERVAL_MS || 5000);
    let tick = 0;
    let done = false;
    const taskUuid = sub.taskUuid;
    while (Date.now() < deadline) {
      if (closed) return;
      await sleep(interval);
      let jobs;
      try {
        jobs = await hyper3d.queryStatus(sub.subscriptionKey);
      } catch (e) {
        if (hyper3d.classifyError(e) === 'auth') {
          authError(e);
          return;
        }
        fail(`查询失败：${e.message}`, e.stack);
        return;
      }
      tick += 1;
      const anyFail = jobs.some((j) => hyper3d.STATUS.FAIL.includes(j.status));
      const allDone = jobs.length > 0 && jobs.every((j) => hyper3d.STATUS.DONE.includes(j.status));
      if (anyFail) {
        fail('云端生成失败，可用同样参数重试', JSON.stringify(jobs).slice(0, 300));
        return;
      }
      if (allDone) {
        done = true;
        break;
      }
      const p = Math.min(0.9, 0.12 + tick * 0.028);
      emit({
        stage: 'polling',
        progress: p,
        message: `生成中…（已等待 ${tick * (interval / 1000)}s）`,
      });
    }

    if (!done) {
      emit({ stage: 'timeout', progress: 1, message: '生成超时（云端任务仍在继续）', detail: taskUuid });
      return;
    }

    emit({ stage: 'downloading', progress: 0.93, message: '下载模型…' });
    let dl;
    try {
      dl = await hyper3d.downloadTask(taskUuid);
    } catch (e) {
      if (hyper3d.classifyError(e) === 'auth') {
        authError(e);
      } else {
        fail(`下载失败：${e.message}`, e.stack);
      }
      return;
    }
    const glb = dl.files.find((f) => /\.glb$/i.test(f.name)) || dl.files[0];
    if (!glb || !glb.buffer) {
      fail('云端未返回 GLB', JSON.stringify(dl.files.map((f) => f.name)).slice(0, 300));
      return;
    }

    // 可读命名：{kind}-{YYYYMMDD-HHmm}-{hash6}.glb
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const name = `${kind}-${ts}-${crypto.randomBytes(3).toString('hex')}.glb`;
    await fsp.writeFile(path.join(CACHE_DIR, name), glb.buffer);

    // 写历史索引 + 额度计数（仅成功生成计入消耗）
    const usage = bumpUsage();
    appendIndex({
      name,
      kind,
      size: glb.buffer.length,
      createdAt: d.toISOString(),
      imageCount: b64List.length,
      precision: body.precision || null,
      taskUuid,
      engine: 'hyper3d',
      title: taskTitle,
    });

    /* ---------- 自动 BANG 拆解：用户不用动手，生成完直接拆好交付 ----------
     * 用 Rodin 任务的 uuid 当 asset_id，云端直接引用刚生成的资产，
     * 不必把几十 MB 的 GLB 再上传一遍（省带宽也更快）。
     * 拆解失败不推翻已生成的整车：仍交付整车，只是没有部件。 */
    let parts = null;
    if (body.autoBang !== false) {
      try {
        parts = await runBangPhase({
          assetId: taskUuid,
          strength: Math.min(12, Math.max(2, Number(body.bangStrength) || 5)),
          resolution: body.bangResolution === 'High' ? 'High' : 'Basic',
          material: ['PBR', 'Shaded', 'All', 'None'].includes(body.bangMaterial)
            ? body.bangMaterial
            : 'PBR',
          parent: kind,
          emit,
          isClosed,
          range: [0.93, 0.99], // 接在生成进度之后，进度条不跳变
        });
        if (parts) bumpUsage();
      } catch (e) {
        console.warn('[bang] 自动拆解失败，仅交付整车：', e.message);
        emit({
          stage: 'polling',
          progress: 0.97,
          message: `自动拆解未成功（${e.message}），仍交付整车模型`,
        });
        parts = null;
      }
    }

    emit({
      stage: 'done',
      progress: 1,
      message: parts
        ? `完成，已拆解为 ${parts.length} 个部件（${(glb.buffer.length / 1024 / 1024).toFixed(1)}MB）`
        : `完成（${(glb.buffer.length / 1024 / 1024).toFixed(1)}MB）`,
      result: {
        url: `/api/asset/${name}`,
        kind,
        mode: 'live',
        bytes: glb.buffer.length,
        name,
        title: taskTitle,
        usage,
        engine: 'hyper3d',
        // 前端据此自动挂载部件，用户无需任何额外操作
        parts: parts || null,
      },
    });
  } catch (e) {
    // 兜底：LIVE 失败一律 error，绝不降级到 DEMO 演示模型（红线）
    fail(e.message || '生成失败', e.stack);
  }
}

/**
 * HiGen3D 引擎生成流（骨架）。
 * 当前 higen3d.submitJob 在缺少官方 API 文档时抛 EngineNotConfigured，
 * 故本函数会就地给出「待配置」友好错误，绝不降级到 DEMO 演示模型（红线）。
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

/**
 * fal.ai Rodin 生成流。
 *
 * 与混元相比：按次计费（$0.4/次）、无每日 5 次上限、档位更高（Gen-2.5 High/Extreme-High、
 * 可加 HighPack 拿 4K 贴图），用于解决"混元精度不够高"的问题。
 * 无 FAL_KEY 时直接给出配置指引，绝不降级到演示模型冒充结果（红线）。
 */
async function runFal3D({ kind, images, body, taskTitle, emit, fail, isClosed }) {
  const f = fal.resolveToken();
  if (!f.token) {
    fail('fal.ai 未配置：请把 API Key 写入 ~/.workbuddy/tokens/fal，或设置环境变量 FAL_KEY', 'no-fal-key');
    return;
  }

  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });

    const b64List = images
      .map((im) => String(im.dataUrl || ''))
      .map((s) => (s.includes(',') ? s.slice(s.indexOf(',') + 1) : s))
      .filter(Boolean);

    const TIER = {
      standard: 'Gen-2.5-Medium',
      high: 'Gen-2.5-High',
      extreme: 'Gen-2.5-Extreme-High',
    };
    const tier = TIER[body.precision] || 'Gen-2.5-High';
    // HighPack：4K 贴图 + 高模，画质更好但按 3 倍计费，默认不开
    const addons = body.falHighPack ? ['HighPack'] : [];

    emit({
      stage: 'submit',
      progress: 0.05,
      message: `提交 fal.ai Rodin（${b64List.length} 张图，档位 ${tier}${addons.length ? ' + HighPack' : ''}）`,
    });

    let sub;
    try {
      sub = await fal.submitRodin({
        imagesBase64: b64List,
        prompt: body.prompt || '',
        tier,
        quality: 'high',
        geometryFileFormat: body.geometryFileFormat || 'glb',
        material: 'PBR',
        addons,
        token: f.token,
      });
    } catch (e) {
      const cls = fal.classifyError(e);
      if (cls === 'auth') {
        emit({ stage: 'auth_error', progress: 1, message: 'fal.ai Key 无效或已失效，请换一个 Key' });
        return;
      }
      if (cls === 'quota') {
        emit({
          stage: 'quota_exceeded',
          progress: 1,
          message: 'fal.ai 余额已用尽（账户被锁定），请到 fal.ai/dashboard/billing 充值后重试',
          detail: e.message,
        });
        return;
      }
      fail(`提交失败：${e.message}`, e.stack);
      return;
    }
    emit({ stage: 'accepted', progress: 0.12, message: `任务已受理 ${String(sub.requestId).slice(0, 12)}…` });

    // 轮询
    const deadline = Date.now() + Number(process.env.MAX_POLL_MS || 12 * 60 * 1000);
    const interval = Number(process.env.POLL_INTERVAL_MS || 5000);
    let tick = 0;
    let done = false;
    while (Date.now() < deadline) {
      if (isClosed?.()) return;
      await sleep(interval);
      let st;
      try {
        st = await fal.queryStatus(sub.statusUrl, f.token);
      } catch (e) {
        if (fal.classifyError(e) === 'auth') {
          emit({ stage: 'auth_error', progress: 1, message: 'fal.ai Key 无效或已失效，请换一个 Key' });
          return;
        }
        fail(`查询失败：${e.message}`, e.stack);
        return;
      }
      tick += 1;
      if (fal.STATUS.FAIL.includes(st.status)) {
        fail('云端生成失败，可用同样参数重试', st.status);
        return;
      }
      if (fal.STATUS.DONE.includes(st.status)) {
        done = true;
        break;
      }
      emit({
        stage: 'polling',
        progress: Math.min(0.9, 0.12 + tick * 0.028),
        message: `生成中…（已等待 ${tick * (interval / 1000)}s，${st.status}）`,
      });
    }

    if (!done) {
      emit({ stage: 'timeout', progress: 1, message: '生成超时（云端任务仍在继续）', detail: sub.requestId });
      return;
    }

    emit({ stage: 'downloading', progress: 0.93, message: '下载模型…' });
    let buf = null;
    try {
      const result = await fal.getResult(sub.responseUrl, f.token);
      buf = await fal.downloadBuffer(result.meshUrl);
    } catch (e) {
      if (fal.classifyError(e) === 'auth') {
        emit({ stage: 'auth_error', progress: 1, message: 'fal.ai Key 无效或已失效，请换一个 Key' });
      } else {
        fail(`下载失败：${e.message}`, e.stack);
      }
      return;
    }

    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const ext = (body.geometryFileFormat || 'glb') === 'obj' ? '.obj' : '.glb';
    const name = `${kind}-${ts}-${crypto.randomBytes(3).toString('hex')}${ext}`;
    await fsp.writeFile(path.join(CACHE_DIR, name), buf);

    const usage = bumpUsage();
    appendIndex({
      name,
      kind,
      size: buf.length,
      createdAt: d.toISOString(),
      imageCount: b64List.length,
      precision: body.precision || null,
      jobId: sub.requestId,
      title: taskTitle,
      engine: 'fal',
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
        name,
        title: taskTitle,
        usage,
        engine: 'fal',
      },
    });
  } catch (e) {
    fail(e.message || '生成失败', e.stack);
  }
}

/* ------------------------- BANG 拆解流 ------------------------- */

/**
 * 解析前端传来的 modelUrl，落到本地 Buffer 或 Hyper3D asset_id。
 *   - UUID                       → { assetId }
 *   - /api/asset/:name           → 读 .cache/models/:name
 *   - /models/xxx.glb             → 读 public/models/xxx.glb
 *   - 其它本地路径 / 文件名        → 在 cache / public 目录里找
 */
async function resolveBangModel(modelUrl) {
  if (!modelUrl) return null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(modelUrl.trim())) return { assetId: modelUrl.trim() };

  let filePath = null;
  if (modelUrl.startsWith('/api/asset/')) {
    const nm = path.basename(modelUrl.slice('/api/asset/'.length));
    filePath = path.join(CACHE_DIR, nm);
  } else if (modelUrl.startsWith('/models/')) {
    const nm = path.basename(modelUrl.slice('/models/'.length));
    filePath = path.join(ROOT, 'public', 'models', nm);
  } else if (modelUrl.startsWith('/')) {
    const nm = path.basename(modelUrl);
    const cands = [path.join(CACHE_DIR, nm), path.join(ROOT, 'public', 'models', nm)];
    filePath = cands.find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }) || null;
  } else {
    const nm = path.basename(modelUrl);
    const cands = [path.join(CACHE_DIR, nm), path.join(ROOT, 'public', 'models', nm), modelUrl];
    filePath = cands.find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }) || null;
  }
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = await fsp.readFile(filePath);
  return { modelBuffer: buf, modelName: path.basename(filePath), name: path.basename(filePath) };
}

/** 把一个部件 Buffer 落本地，返回可访问 URL */
async function writeBangPart(buffer, parent, index, hash, ext = '.glb') {
  const name = `bang-${parent}-${index}-${hash}${ext}`;
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.writeFile(path.join(CACHE_DIR, name), buffer);
  return `/api/asset/${name}`;
}

/**
 * BANG 拆解流水线阶段：提交 → 轮询 → 下载 → 落盘。
 *
 * 被两处共用：
 *   1) 生成完成后「自动拆解」（用 Rodin 任务的 asset_id，不必回传模型文件）
 *   2) /api/bang 程序化拆解（传本地模型 Buffer 或 asset_id）
 *
 * 本函数只抛错、不写 SSE 终止态：调用方按 classifyError 决定
 * 是「整条生成失败」还是「只丢部件、仍交付整车」。
 *
 * @param {Object} o
 * @param {string=} o.assetId      Rodin 任务 uuid（与 modelBuffer 二选一）
 * @param {Buffer=} o.modelBuffer  本地模型文件（与 assetId 二选一）
 * @param {(obj)=>void} o.emit     SSE 推送
 * @param {()=>boolean} o.isClosed 连接是否断开（生成器，避免闭包拿到过期布尔值）
 * @param {number[]} o.range       进度区间 [from, to]，便于嵌进生成流而不跳变
 * @returns {Promise<Array<{name:string,url:string,index:number}>>}
 */
async function runBangPhase(o) {
  const {
    assetId = null,
    modelBuffer = null,
    modelName = null,
    strength = 5,
    resolution = 'Basic',
    material = 'PBR',
    geometryFileFormat = 'glb',
    parent = 'model',
    emit = () => {},
    isClosed = () => false,
    range = [0.05, 1],
  } = o || {};

  const [p0, p1] = range;
  const at = (t) => p0 + (p1 - p0) * t;

  await fsp.mkdir(CACHE_DIR, { recursive: true });

  emit({
    stage: 'submit',
    progress: at(0.02),
    message: `提交 BANG 拆解（strength=${strength}, resolution=${resolution}）`,
  });

  const sub = await hyper3d.submitBang({
    modelBuffer: modelBuffer || null,
    modelName: modelName || null,
    assetId: assetId || null,
    imageBase64: null,
    prompt: '',
    strength,
    geometryFileFormat,
    material,
    resolution,
  });

  emit({
    stage: 'accepted',
    progress: at(0.1),
    message: `拆解任务已受理 ${String(sub.taskUuid).slice(0, 12)}…`,
  });

  const deadline = Date.now() + Number(process.env.MAX_POLL_MS || 12 * 60 * 1000);
  const interval = Number(process.env.POLL_INTERVAL_MS || 5000);
  let tick = 0;
  let done = false;

  while (Date.now() < deadline) {
    if (isClosed()) return null;
    await sleep(interval);
    const jobs = await hyper3d.queryStatus(sub.subscriptionKey);
    tick += 1;

    if (jobs.some((j) => hyper3d.STATUS.FAIL.includes(j.status))) {
      const e = new Error('BANG 拆解失败，可用同样参数重试');
      e.bangFailed = true;
      throw e;
    }
    if (jobs.length > 0 && jobs.every((j) => hyper3d.STATUS.DONE.includes(j.status))) {
      done = true;
      break;
    }
    emit({
      stage: 'polling',
      progress: at(Math.min(0.85, 0.1 + tick * 0.028)),
      message: `拆解中…（已等待 ${tick * (interval / 1000)}s）`,
    });
  }

  if (!done) {
    const e = new Error('拆解超时（云端任务仍在继续）');
    e.bangTimeout = true;
    throw e;
  }

  emit({ stage: 'downloading', progress: at(0.9), message: '下载部件…' });
  const dl = await hyper3d.downloadTask(sub.taskUuid);

  const parts = [];
  for (let i = 0; i < dl.files.length; i++) {
    const f = dl.files[i];
    const ext = f.name && f.name.includes('.') ? path.extname(f.name) : '.glb';
    const url = await writeBangPart(f.buffer, parent, i, crypto.randomBytes(3).toString('hex'), ext);
    parts.push({ name: path.basename(url), url, index: i });
  }

  if (!parts.length) {
    const e = new Error('BANG 未返回任何部件文件');
    e.bangEmpty = true;
    throw e;
  }
  return parts;
}

/**
 * BANG 拆解流（POST /api/bang，SSE）。
 * body: { modelUrl, strength?, resolution?, material?, geometryFileFormat? }
 *
 * 红线：
 *   - auth/quota 失败绝不降级 demo；
 *   - 下载的部件 URL 立即落本地（downloadTask 内部已完成），本函数只负责写盘命名。
 * DEMO 无 token：把源 GLB 当作单部件返回，UI 照样跑通。
 */
async function handleBang(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }

  const modelUrl = typeof body.modelUrl === 'string' ? body.modelUrl.trim() : '';
  if (!modelUrl) {
    sendJson(res, 400, { error: '缺少 modelUrl' });
    return;
  }
  const strength = Math.min(12, Math.max(2, Number(body.strength) || 5));
  const resolution = body.resolution === 'High' ? 'High' : 'Basic';
  const material = ['PBR', 'Shaded', 'All', 'None'].includes(body.material)
    ? body.material
    : 'PBR';
  const geometryFileFormat = body.geometryFileFormat || 'glb';

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

  const h = hyper3d.resolveToken();
  const token = h.token;

  const authError = (e) => {
    emit({
      stage: 'auth_error',
      progress: 1,
      message: 'Hyper3D 凭证已失效或无效，请在换票后点「我已更新」',
      detail: `${e?.code || ''} ${e?.message || ''}`.trim(),
      tokenId: h.tokenId,
    });
  };

  /* ---------- DEMO 降级：把源 GLB 当作单部件返回 ---------- */
  if (!token) {
    try {
      const resolved = await resolveBangModel(modelUrl);
      if (!resolved || !resolved.modelBuffer) {
        fail('演示模式需要本地模型文件（找不到要拆解的模型）');
        return;
      }
      const url = await writeBangPart(
        resolved.modelBuffer,
        'demo',
        0,
        crypto.randomBytes(3).toString('hex')
      );
      emit({
        stage: 'done',
        progress: 1,
        message: '完成（离线演示：源模型作为单部件返回）',
        result: {
          url,
          kind: 'bang',
          mode: 'demo',
          engine: 'hyper3d',
          parts: [{ name: resolved.name || 'part0', url, index: 0 }],
        },
      });
    } catch (e) {
      fail(`演示拆解失败：${e.message}`, e.stack);
    }
    return;
  }

  /* ---------- LIVE 模式 ---------- */
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const resolved = await resolveBangModel(modelUrl);
    if (!resolved) {
      fail('找不到要拆解的模型（请确认 modelUrl 指向本地 GLB 或 Hyper3D asset_id）');
      return;
    }

    const parent = resolved.assetId
      ? 'asset'
      : resolved.modelName
        ? path.basename(resolved.modelName, path.extname(resolved.modelName))
        : 'model';

    let parts;
    try {
      parts = await runBangPhase({
        assetId: resolved.assetId || null,
        modelBuffer: resolved.modelBuffer || null,
        modelName: resolved.modelName || null,
        strength,
        resolution,
        material,
        geometryFileFormat,
        parent,
        emit,
        isClosed: () => closed,
        range: [0.05, 1],
      });
    } catch (e) {
      const cls = hyper3d.classifyError(e);
      if (cls === 'auth') {
        authError(e);
        return;
      }
      if (cls === 'quota') {
        emit({
          stage: 'quota_exceeded',
          progress: 1,
          message: '今日 Hyper3D / BANG 额度已用完，请明天再试',
          detail: `${e?.code || ''} ${e.message}`.trim(),
        });
        return;
      }
      if (e?.bangTimeout) {
        emit({ stage: 'timeout', progress: 1, message: e.message });
        return;
      }
      fail(e.message || '拆解失败', e.stack);
      return;
    }
    if (!parts) return; // 连接已断开

    const usage = bumpUsage();
    emit({
      stage: 'done',
      progress: 1,
      message: `拆解完成，共 ${parts.length} 个部件`,
      result: {
        url: parts[0].url,
        kind: 'bang',
        mode: 'live',
        parts,
        usage,
        engine: 'hyper3d',
      },
    });
  } catch (e) {
    fail(e.message || '拆解失败', e.stack);
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

/* ------------------------- 部件导入（BANG 手动拆解产物） ------------------------- */

/**
 * POST /api/upload-part
 * 入参：{ name, dataUrl }   单个 GLB 文件（base64 dataURL）
 * 出参：{ url, name, bytes }
 *
 * 用途：用户在 Hyper3D 网页版 / Scenario 用 BANG 拆完部件后，把多个 GLB 拖回本项目。
 * 这样 BANG 成本压到按次付费（约 $0.75/台），不必买 $120/月的 API 订阅；
 * 后续的识别与装车自动化留在本项目侧完成。
 */
async function handleUploadPart(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }
  const dataUrl = String(body?.dataUrl || '');
  if (!dataUrl) {
    sendJson(res, 400, { error: '缺少 dataUrl' });
    return;
  }
  const raw = String(body?.name || 'part.glb');
  if (!raw.toLowerCase().endsWith('.glb')) {
    sendJson(res, 400, { error: '只接受 .glb 文件' });
    return;
  }
  const b64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    sendJson(res, 400, { error: 'base64 解析失败' });
    return;
  }
  if (buf.length < 12 || buf.readUInt32LE(0) !== 0x46546c67) {
    sendJson(res, 400, { error: '不是合法的 GLB（缺少 glTF magic）' });
    return;
  }
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const out = `part-${ts}-${crypto.randomBytes(3).toString('hex')}.glb`;
  await fsp.writeFile(path.join(CACHE_DIR, out), buf);
  sendJson(res, 200, { url: `/api/asset/${out}`, name: path.basename(raw), bytes: buf.length });
}

/* ------------------------- 车型识别（视觉模型） ------------------------- */

/**
 * POST /api/recognize
 * 入参：{ images: [{ dataUrl }] }   前端已压缩好的 JPEG dataURL
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
    const hk = hyper3d.resolveToken();
    sendJson(res, 200, {
      ok: true,
      mode: tk.token ? 'live' : 'demo',
      expiresAt: tk.expiresAt || null,
      tokenId: tk.tokenId || null, // 只是 token 的短哈希，不含凭证本身
      endpoint: hy3d.ENDPOINT,
      engines: {
        hunyuan: { mode: tk.token ? 'live' : 'demo' },
        hyper3d: { mode: hk.token ? 'live' : 'demo', endpoint: hyper3d.ENDPOINT },
        fal: { mode: fal.resolveToken().token ? 'live' : 'demo', endpoint: fal.ENDPOINT, model: fal.MODEL },
        higen3d: { available: higen.available(), endpoint: higen.ENDPOINT_INFO.ENDPOINT },
        vision: vision.getVisionStatus(),
      },
      hint: tk.token
        ? '已配置凭证，将真实调用混元 3D'
        : '未配置凭证，当前为离线演示模式',
    });
    return;
  }

  if (u.pathname === '/api/generate' && req.method === 'POST') {
    await handleGenerate(req, res);
    return;
  }

  if (u.pathname === '/api/bang' && req.method === 'POST') {
    await handleBang(req, res);
    return;
  }

  if (u.pathname.startsWith('/api/asset/')) {
    await handleAsset(req, res, u.pathname.slice('/api/asset/'.length));
    return;
  }

  if (u.pathname === '/api/upload-part' && req.method === 'POST') {
    await handleUploadPart(req, res);
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
  const hk = hyper3d.resolveToken();
  console.log(`\n  ▸ API 服务已启动  http://127.0.0.1:${PORT}`);
  console.log(
    `  ▸ 运行模式：混元 ${tk.token ? 'LIVE' : 'DEMO'}  |  Hyper3D ${hk.token ? 'LIVE' : 'DEMO'}`
  );
  console.log(`  ▸ 混元网关：${hy3d.ENDPOINT}`);
  console.log(`  ▸ Hyper3D ：${hyper3d.ENDPOINT}`);
  if (!tk.token && !hk.token) {
    console.log(
      `  ▸ 想切到真实生成：export HYPER3D_API_KEY=<你的 key>  或写入 ~/.workbuddy/tokens/hyper3d\n`
    );
  }
});
