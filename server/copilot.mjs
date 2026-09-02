/**
 * copilot.mjs — 「改装工程师」AI 助手（对话 + 工具调用）
 *
 * 定位：只聊车。用户输入自然语言（或语音转写），模型返回
 *   ① 给用户的解释文字
 *   ② 结构化工具调用（由前端校验后执行，真正改 3D 参数）
 *
 * 为什么工具必须由前端执行：
 *   模型可能给出离谱数值（如 ET=-100）。若让模型直接写参数会瞬间把场景搞崩。
 *   所以这里只"提议"工具调用，真正的数值钳制与写入在前端 tools.js 完成。
 *
 * 凭证：复用 server/vision.mjs 的 resolveChatConfig()——同一个 DashScope key /
 *   端点 / 供应商体系，避免各模块重复实现凭证解析（vision.mjs 已注释说明这一点）。
 *
 * 模型：默认 qwen-plus（中文好、支持 function calling、便宜）。
 *   可用 COPILOT_MODEL 环境变量覆盖。
 */

import { resolveChatConfig } from './vision.mjs';

/* ------------------------- 模型配置 ------------------------- */

/** qwen-plus 走文本对话；qwen3-vl-* 是视觉模型，不适合纯文本工具调用 */
const DEFAULT_MODEL = 'qwen-plus';

function chatConfig() {
  const cfg = resolveChatConfig();
  if (!cfg) return null;
  return {
    ...cfg,
    model: process.env.COPILOT_MODEL || DEFAULT_MODEL,
  };
}

/** 对外：当前 copilot 是否可用（不含 key 明文） */
export function getCopilotStatus() {
  const cfg = chatConfig();
  if (!cfg) return { available: false, reason: 'no-key' };
  return {
    available: true,
    provider: cfg.name,
    model: cfg.model,
    endpoint: cfg.endpoint,
  };
}

/* ------------------------- 工具定义 ------------------------- */

/**
 * OpenAI function calling 格式的工具 schema。
 * 参数范围与前端 panel.js 的滑杆范围保持一致，写在 description 里让模型"知道边界"。
 */
export const COPILOT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_wheel',
      description:
        '调整轮毂与轮胎规格。axle 指定前轴/后轴/全部。只传要改的字段，未传的保持不变。' +
        '取值范围：rimInch 15~24 英寸；j 5~13（轮辋宽度，1J=25.4mm）；' +
        'et 0~60 mm（偏距，越小轮毂越外凸）；tireWidthMm 185~355 mm（胎宽）；' +
        'aspect 25~60（扁平比%）；camber -6~3 度（倾角，负值=顶部内倾）。' +
        '注意：胎宽必须和 J 值匹配，一般 8.5J 配 235~255，9.5J 配 265~285，11J 配 295 以上。',
      parameters: {
        type: 'object',
        properties: {
          axle: { type: 'string', enum: ['front', 'rear', 'all'], description: '作用轴，默认 all' },
          rimInch: { type: 'number', description: '轮辋直径（英寸）' },
          j: { type: 'number', description: '轮辋宽度（J 值）' },
          et: { type: 'number', description: '偏距 ET（mm），越小越外凸' },
          tireWidthMm: { type: 'number', description: '轮胎断面宽（mm）' },
          aspect: { type: 'number', description: '扁平比（%）' },
          camber: { type: 'number', description: '倾角（度），负值内倾' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_suspension',
      description:
        '调整悬挂降低量。deltaMm 为车身降低毫米数，范围 -10~75（>0 降低，<0 升高）。' +
        '一般街道改装 25~40mm，姿态玩家 50~75mm。降太多会蹭地，需配合倾角。',
      parameters: {
        type: 'object',
        properties: {
          deltaMm: { type: 'number', description: '降低量（mm）' },
        },
        required: ['deltaMm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_body_color',
      description: '更换车漆颜色。hex 为 6 位十六进制颜色（如 #1a2b3c）。solid 为 true 时做纯色重喷（覆盖原贴图），false 时保留贴图做着色叠加。',
      parameters: {
        type: 'object',
        properties: {
          hex: { type: 'string', description: '十六进制颜色值，如 #ff0000' },
          solid: { type: 'boolean', description: '是否纯色重喷' },
        },
        required: ['hex'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_car_length',
      description: '调整车身长度（米）。会等比缩放整车。常见范围 4.0~5.5 米。',
      parameters: {
        type: 'object',
        properties: {
          meters: { type: 'number', description: '车长（米）' },
        },
        required: ['meters'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_preset',
      description:
        '一键套用整套改装风格预设，比逐项调参更高效。' +
        'stock=原厂保守；flush=齐平翼子板；wide=宽体外扩；hellaflush=极致低趴大倾角。',
      parameters: {
        type: 'object',
        properties: {
          style: { type: 'string', enum: ['stock', 'flush', 'wide', 'hellaflush'] },
        },
        required: ['style'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_environment',
      description: '切换展示场景/环境。常用值 studio（摄影棚）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '环境 id，如 studio' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_view',
      description:
        '切换相机视角。可选：iso（等轴测，默认全景）、side（正侧面，看姿态最清楚）、' +
        'front（正面）、rear（尾部）、top（俯视）、wheel（特写左前轮，看轮毂细节用）。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['iso', 'side', 'front', 'rear', 'top', 'wheel'] },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_specs',
      description: '读取当前车辆的完整改装参数快照。当用户问"现在是什么规格""当前设置"时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/* ------------------------- 人设 ------------------------- */

const SYSTEM_PROMPT = `你是「改装工程师」，一位在改装店干了十五年、见过上千台车落地的主理人。你坐在用户旁边，实时看他改车，随时搭话。

说话方式：
· 像老师傅聊天，短句为主，别写成报告。一次说三到五句就够了。
· 有观点就直说。用户说要 ET 15 配 9J，你会直接讲"这太外凸了，翼子板要卷边，日常开容易蹭"。
· 术语用行话但要带一句解释，比如"ET 越小轮毂越往外凸，30 左右基本齐平翼子板"。
· 不确定的事说不确定，别编造具体车型的原厂数据。

工作原则：
· 用户描述想要的感觉（"要低趴一点""想齐平翼子板"），你先翻译成具体参数再动手。
· 参数之间有关联：降车身要配倾角，否则蹭叶子板；加宽轮毂要同步加胎宽。你改一项时要考虑连带影响，并在回复里点出来。
· 用户给了明确数值就照做，但要提醒后果。用户只给风格就你先给一套合理参数。
· 只聊车。聊别的就一句话带过拉回来。

动手方式：
· 需要改车就调用工具，不要只在文字里描述"建议你改成……"。
· 可以连续调用多个工具（比如同时改轮毂和悬挂）。
· 改完用一两句话说明你改了什么、为什么这么配。`;

/* ------------------------- HTTP ------------------------- */

/** 复用 vision.mjs 同款代理逻辑（沙箱/公司网走 CONNECT 隧道） */
async function postChat({ endpoint, apiKey, payload }) {
  const { URL } = await import('node:url');
  const https = (await import('node:https')).default;
  const http = (await import('node:http')).default;

  const PROXY_URL =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  let agent = null;
  if (PROXY_URL) {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    agent = new HttpsProxyAgent(PROXY_URL);
  }

  const u = new URL(endpoint);
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  const options = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    timeout: 60000,
  };
  if (isHttps && agent) options.agent = agent;

  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          reject(new Error(`copilot 返回非 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 200)}`));
          return;
        }
        if (json.error) {
          const e = new Error(json.error.message || 'copilot 接口错误');
          e.status = res.statusCode;
          reject(e);
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('copilot 接口超时')));
    req.on('error', reject);
    req.write(Buffer.from(payload, 'utf8'));
    req.end();
  });
}

/* ------------------------- 对外主入口 ------------------------- */

/**
 * 与模型对话一轮。
 *
 * @param {object} o
 * @param {Array<{role:string, content:string}>} o.messages 对话历史（不含 system）
 * @param {object} o.specs 当前车辆参数快照，注入到 system prompt 让模型"看得见车"
 * @returns {Promise<{available:boolean, reason?:string, content?:string,
 *                    toolCalls?:Array<{id:string,name:string,arguments:object}>,
 *                    usage?:object}>}
 */
export async function chat({ messages = [], specs = null } = {}) {
  const cfg = chatConfig();
  if (!cfg) return { available: false, reason: 'no-key' };

  // 把当前车况塞进 system，模型才知道"现在是什么规格"
  let system = SYSTEM_PROMPT;
  if (specs) {
    system += `\n\n【当前车辆状态】\n${typeof specs === 'string' ? specs : JSON.stringify(specs, null, 2)}`;
  }

  const payload = JSON.stringify({
    model: cfg.model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: COPILOT_TOOLS,
    tool_choice: 'auto',
    // qwen-plus 支持；关掉思考让回复更直接，也避免污染工具调用
    enable_thinking: false,
  });

  try {
    const body = await postChat({ endpoint: cfg.endpoint, apiKey: cfg.key, payload });
    const msg = body?.choices?.[0]?.message || {};
    const toolCalls = (msg.tool_calls || []).map((tc) => {
      let args = {};
      try {
        args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
      } catch {
        args = {};
      }
      return { id: tc.id, name: tc.function?.name, arguments: args };
    });
    return {
      available: true,
      content: msg.content || '',
      toolCalls,
      usage: body.usage || null,
    };
  } catch (e) {
    const isAuth =
      e.status === 401 ||
      e.status === 403 ||
      /401|403|unauthorized|invalid|forbidden|api.?key|authentication/i.test(e.message || '');
    return { available: false, reason: isAuth ? 'auth' : 'error', detail: e.message };
  }
}
