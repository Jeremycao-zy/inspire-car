/**
 * tools.js — 「改装工程师」工具注册表
 *
 * 模型只负责"提议"调用哪个工具、传什么参数；真正的数值钳制与写入在这里完成。
 * 为什么必须钳制：模型可能给出 ET=-100、rimInch=99 这类越界值，
 * 直接写进 params 会让轮毂飞出车身、场景当场崩掉。
 *
 * 所有数值范围与 src/ui/panel.js 的滑杆范围严格一致，
 * 保证"模型能改的"和"用户手动能拖的"是同一套边界。
 */

/* ------------------------- 范围定义（与 panel.js 滑杆一致） ------------------------- */

const RANGE = {
  et: { min: 0, max: 60, step: 1 },
  j: { min: 5, max: 13, step: 0.5 },
  camber: { min: -6, max: 3, step: 0.25 },
  rimInch: { min: 15, max: 24, step: 0.5 },
  tireWidthMm: { min: 185, max: 355, step: 5 },
  aspect: { min: 25, max: 60, step: 1 },
  suspensionDelta: { min: -10, max: 75, step: 1 },
  carLength: { min: 3.5, max: 6.0, step: 0.05 },
};

/** 风格预设（与 panel.js PRESETS 一致） */
const PRESETS = {
  stock: { et: 38, j: 8.5, camber: -0.5, rimInch: 18, tireWidthMm: 255, aspect: 40 },
  flush: { et: 32, j: 9.5, camber: -1.5, rimInch: 19, tireWidthMm: 265, aspect: 35 },
  wide: { et: 20, j: 11, camber: -2.5, rimInch: 19, tireWidthMm: 295, aspect: 30 },
  hellaflush: { et: 12, j: 10.5, camber: -4.5, rimInch: 19, tireWidthMm: 275, aspect: 30 },
};

const PRESET_LABEL = {
  stock: '原厂',
  flush: '齐平 Flush',
  wide: '宽体',
  hellaflush: 'HellaFlush',
};

const FIELD_LABEL = {
  rimInch: '轮辋直径',
  j: 'J 值',
  et: 'ET 偏距',
  tireWidthMm: '胎宽',
  aspect: '扁平比',
  camber: '倾角',
};

/* ------------------------- 工具函数 ------------------------- */

function clamp(v, { min, max }) {
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

/** 按 step 对齐，避免 20.3 寸这类无意义精度 */
function quantize(v, step) {
  if (step == null) return v;
  return Math.round(v / step) * step;
}

/** 解析颜色：支持 #rgb / #rrggbb / 中文常见色名 */
function parseColor(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();

  const NAMED = {
    黑: '#000000', 黑色: '#000000', 白: '#ffffff', 白色: '#ffffff',
    红: '#d92b2b', 红色: '#d92b2b', 蓝: '#1e5fd8', 蓝色: '#1e5fd8',
    绿: '#1f8a4c', 绿色: '#1f8a4c', 黄: '#e0b400', 黄色: '#e0b400',
    银: '#c0c4c8', 银色: '#c0c4c8', 灰: '#6b7280', 灰色: '#6b7280',
    橙: '#e2701e', 橙色: '#e2701e', 紫: '#7c3aed', 紫色: '#7c3aed',
    青: '#00f0ff', 青色: '#00f0ff', 粉: '#ff2e97', 粉色: '#ff2e97',
    墨绿: '#1f4d3a', 酒红: '#7b1e2b', 哑光黑: '#1a1a1a', 珍珠白: '#f2f4f7',
  };
  if (NAMED[s]) return NAMED[s];

  s = s.replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(s)) return null;
  return '#' + s;
}

/* ------------------------- 工具注册表 ------------------------- */

/**
 * 创建工具注册表。
 *
 * @param {object} app   main.js 暴露的 app 实例
 * @param {object} panel panel.js 返回的面板实例（用于 syncAll 同步滑杆）
 * @returns {Record<string, (args:object)=>{ok:boolean, message:string}>}
 */
export function createTools(app, panel) {
  /** 改完参数后的统一收尾：重绘 + 同步滑杆 */
  function commit() {
    app.apply?.();
    panel?.syncAll?.();
  }

  /** 取要作用的轴（front / rear / 两者） */
  function targets(axle) {
    if (axle === 'front') return ['front'];
    if (axle === 'rear') return ['rear'];
    return ['front', 'rear'];
  }

  const tools = {
    set_wheel(args = {}) {
      const axles = targets(args.axle);
      const fields = ['rimInch', 'j', 'et', 'tireWidthMm', 'aspect', 'camber'];
      const applied = [];
      const rejected = [];

      for (const ax of axles) {
        const spec = app.params[ax];
        if (!spec) continue;
        for (const f of fields) {
          const raw = args[f];
          if (raw === undefined || raw === null) continue;
          const num = Number(raw);
          const c = clamp(num, RANGE[f]);
          if (c === null) {
            rejected.push(`${FIELD_LABEL[f]} 不是数字`);
            continue;
          }
          const q = quantize(c, RANGE[f].step);
          if (Math.abs(q - num) > 0.001) rejected.push(`${FIELD_LABEL[f]} ${num} → 钳制为 ${q}`);
          spec[f] = q;
          applied.push(`${ax === 'front' ? '前' : '后'}轮 ${FIELD_LABEL[f]} ${q}`);
        }
      }

      if (!applied.length) {
        return { ok: false, message: rejected.length ? rejected.join('；') : '没有需要修改的轮毂参数' };
      }
      commit();
      let msg = applied.join('，');
      if (rejected.length) msg += `（${rejected.join('；')}）`;
      return { ok: true, message: msg };
    },

    set_suspension(args = {}) {
      const num = Number(args.deltaMm);
      const c = clamp(num, RANGE.suspensionDelta);
      if (c === null) return { ok: false, message: '降低量必须是数字' };
      const q = quantize(c, RANGE.suspensionDelta.step);
      app.params.suspensionDelta = q;
      commit();
      const warn = q !== num ? `（${num} 超出范围，钳制为 ${q}）` : '';
      const tip = q >= 60 ? '降太多日常容易托底' : q >= 35 ? '街道够低了' : '';
      return { ok: true, message: `车身降低 ${q}mm${warn}${tip ? '，' + tip : ''}` };
    },

    set_body_color(args = {}) {
      const hex = parseColor(args.hex);
      if (!hex) return { ok: false, message: `无法识别颜色「${args.hex}」` };
      const solid = args.solid === true;
      app.setBodyColor?.(hex, solid);
      commit();
      return { ok: true, message: `车漆改为 ${hex}${solid ? '（纯色重喷）' : '（保留贴图叠加）'}` };
    },

    set_car_length(args = {}) {
      const num = Number(args.meters);
      const c = clamp(num, RANGE.carLength);
      if (c === null) return { ok: false, message: '车长必须是数字' };
      app.params.carLength = c;
      app.rescaleCar?.(c);
      commit();
      return { ok: true, message: `车长调整为 ${c.toFixed(2)} 米` };
    },

    apply_preset(args = {}) {
      const style = String(args.style || '').toLowerCase();
      const p = PRESETS[style];
      if (!p) {
        return { ok: false, message: `未知风格「${style}」，可选：${Object.keys(PRESETS).join(' / ')}` };
      }
      for (const ax of ['front', 'rear']) {
        const spec = app.params[ax];
        if (!spec) continue;
        for (const [k, v] of Object.entries(p)) spec[k] = v;
      }
      commit();
      return { ok: true, message: `套用「${PRESET_LABEL[style]}」风格：${p.rimInch}寸 ${p.j}J ET${p.et} 胎宽${p.tireWidthMm} 扁平比${p.aspect} 倾角${p.camber}°` };
    },

    set_environment(args = {}) {
      const id = String(args.id || '').trim();
      if (!id) return { ok: false, message: '缺少环境 id' };
      app.setEnvironment?.(id);
      commit();
      return { ok: true, message: `场景切换为 ${id}` };
    },

    set_view(args = {}) {
      const key = String(args.key || '').trim();
      const VALID = ['iso', 'side', 'front', 'rear', 'top', 'wheel'];
      if (!VALID.includes(key)) return { ok: false, message: `未知视角「${key}」` };
      app.setView?.(key);
      return { ok: true, message: `视角切换为 ${key}` };
    },

    get_current_specs() {
      const f = app.params.front || {};
      const r = app.params.rear || {};
      return {
        ok: true,
        message:
          `前轮 ${f.rimInch}寸 ${f.j}J ET${f.et} 胎宽${f.tireWidthMm} 扁平比${f.aspect} 倾角${f.camber}°；` +
          `后轮 ${r.rimInch}寸 ${r.j}J ET${r.et} 胎宽${r.tireWidthMm} 扁平比${r.aspect} 倾角${r.camber}°；` +
          `悬挂降低 ${app.params.suspensionDelta ?? 0}mm；车漆 ${app.params.bodyColor}`,
      };
    },
  };

  return tools;
}

/**
 * 按安全顺序执行一批工具调用。
 *
 * 顺序很重要：apply_preset 必须先跑。
 * 实测模型会同时返回「apply_preset(flush) + set_wheel(rimInch:20)」——
 * 若先套预设再改轮毂，用户明确指定的 20 寸才能生效；反过来的话预设会把它覆盖回 19 寸。
 *
 * @param {object} tools createTools 的返回值
 * @param {Array<{id:string,name:string,arguments:object}>} calls
 * @returns {Array<{name:string, ok:boolean, message:string}>}
 */
export function runToolCalls(tools, calls = []) {
  const PRIORITY = { apply_preset: 0 };
  const ordered = [...calls]
    .map((c, i) => ({ ...c, _i: i }))
    .sort((a, b) => (PRIORITY[a.name] ?? 99) - (PRIORITY[b.name] ?? 99) || a._i - b._i);

  const results = [];
  for (const c of ordered) {
    const fn = tools[c.name];
    if (!fn) {
      results.push({ name: c.name, ok: false, message: `未知工具 ${c.name}` });
      continue;
    }
    try {
      const r = fn(c.arguments || {});
      results.push({ name: c.name, ok: !!r.ok, message: r.message || '' });
    } catch (e) {
      results.push({ name: c.name, ok: false, message: `执行出错：${e.message}` });
    }
  }
  return results;
}

/** 当前参数快照，随每轮对话发给模型，让它"看得见车" */
export function specsSnapshot(app) {
  const f = app.params.front || {};
  const r = app.params.rear || {};
  return {
    front: {
      rimInch: f.rimInch, j: f.j, et: f.et,
      tireWidthMm: f.tireWidthMm, aspect: f.aspect, camber: f.camber,
    },
    rear: {
      rimInch: r.rimInch, j: r.j, et: r.et,
      tireWidthMm: r.tireWidthMm, aspect: r.aspect, camber: r.camber,
    },
    suspensionDelta: app.params.suspensionDelta ?? 0,
    bodyColor: app.params.bodyColor,
    carLength: app.params.carLength,
  };
}
