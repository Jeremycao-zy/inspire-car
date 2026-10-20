/**
 * sizePicker.js — 真实轮胎规格选择器（精准适配层级）
 *
 * 为什么不再用滑杆：
 *   滑杆能拖出 237mm 胎宽、18.7 英寸轮辋这类**现实中不存在的规格**。
 *   只要能填出不存在的值，后面任何"间隙判定"都是自欺欺人。
 *   所以规格类参数必须来自**离散的真实序列**，且组合必须是真实存在过的胎。
 *
 * 组件职责：
 *   1. 胎宽/扁平比/轮辋 → 组合成「225/45 R18」这样的标准胎规格标签
 *   2. 组合只在 TIRE_SIZE_SERIES 里存在时才允许应用（不存在则提示最近似组合）
 *   3. ET / J → 离散下拉，附带「比原厂 ±Xmm」的语境（外凸/内缩）
 *   4. 倾角保留滑杆（它是可连续调整的装配角度，不是轮胎规格）
 *   5. 任何时刻都显示「当前是否为原厂规格」——这是可信度的基础
 *
 * 设计约束：
 *   - 不 import three，可被 Node 侧逻辑复用/测试
 *   - 只改选择器的呈现与校验，**不碰 app.params 的写入语义**（key 名保持不变）
 */

import {
  TIRE_WIDTHS_MM, TIRE_ASPECTS, RIM_DIAMETERS_IN, RIM_JS, ET_VALUES_MM,
  TIRE_SIZE_SERIES, isRealTireSize, sizeLabel, getBasis,
} from '../tuning/tireBasis.js';

/* ----------------------------- 纯逻辑（可单测） ----------------------------- */

/**
 * 组合胎规格标签；不存在于真实表时返回 null 并给出最近似候选。
 * @returns {{ok:boolean, label:?string, key:?string, nearest:?string}}
 */
export function evalSize(tireWidthMm, aspect, rimInch) {
  const key = `${Math.round(tireWidthMm)}/${Math.round(aspect)}`;
  const label = sizeLabel({ tireWidthMm, aspect, rimInch });
  if (TIRE_SIZE_SERIES[key]) return { ok: true, label, key, nearest: null };
  // 找同胎宽或同扁平比的最接近组合，作为"你要的可能是这个"的提示
  const w = Math.round(tireWidthMm);
  const a = Math.round(aspect);
  const cands = Object.keys(TIRE_SIZE_SERIES)
    .map((k) => {
      const [cw, ca] = k.split('/').map(Number);
      return { k, d: Math.abs(cw - w) / 10 + Math.abs(ca - a) / 5 };
    })
    .sort((p, q) => p.d - q.d);
  return {
    ok: false,
    label: null,
    key: null,
    nearest: cands.length ? `${cands[0].k} R${rimInch}` : null,
  };
}

/**
 * ET 语境说明：比原厂大 =  wheels 更靠内（flush/不外凸），更小 = 更外凸。
 * 实际外凸量还取决于 J 值与轮距，这里只给出方向性描述，不给绝对值。
 */
export function etHint(et, oeEt) {
  const d = Math.round(et - oeEt);
  if (d === 0) return { text: '原厂 ET', delta: 0 };
  const dir = d > 0 ? '内移' : '外凸';
  return { text: `比原厂 ${Math.abs(d)}mm ${dir}`, delta: d };
}

/** 该轴当前是否与原厂规格一致（全部字段逐一比对） */
export function isOeSpec(cur, oe) {
  if (!oe) return false;
  return (
    Math.round(cur.tireWidthMm) === Math.round(oe.tireWidthMm) &&
    Math.round(cur.aspect) === Math.round(oe.aspect) &&
    Math.round(cur.rimInch) === Math.round(oe.rimInch) &&
    Math.round(cur.j * 2) === Math.round(oe.j * 2) &&
    Math.round(cur.et) === Math.round(oe.et)
  );
}

/**
 * 列出该轴可推荐的真实规格组合。
 * 策略：保持扁平比与轮辋不变，在胎宽序列上取邻近值 —— 这正是真实改装里
 * 「同轮辋换胎宽」的操作方式。ET 保持不变（换胎宽不改偏距）。
 *
 * @param {Object} cur     当前规格
 * @param {Object} oe      原厂规格（可空）
 * @returns {Array<{key:string,label:string,tireWidthMm:number,aspect:number,rimInch:number,tag:string,delta:string}>}
 */
export function recommendSizes(cur, oe) {
  const aspect = Math.round(oe?.aspect ?? cur.aspect);
  const rimInch = Math.round(oe?.rimInch ?? cur.rimInch);
  const curW = Math.round(cur.tireWidthMm);
  const out = [];

  for (const w of TIRE_WIDTHS_MM) {
    const key = `${w}/${aspect}`;
    if (!TIRE_SIZE_SERIES[key]) continue;
    if (Math.abs(w - curW) > 40) continue; // 太远的胎宽不实用
    if (w === curW) continue;
    const delta = w - curW;
    out.push({
      key,
      label: `${key} R${rimInch}`,
      tireWidthMm: w,
      aspect,
      rimInch,
      tag: Math.abs(delta) <= 10 ? '接近' : delta > 0 ? '更宽' : '更窄',
      delta: `${delta > 0 ? '+' : ''}${delta}mm 胎宽`,
    });
  }
  return out.sort((a, b) => Math.abs(a.tireWidthMm - curW) - Math.abs(b.tireWidthMm - curW));
}

/* ----------------------------- DOM 组件 ----------------------------- */

/**
 * 造一个下拉（序列型参数）。
 * @param {Array<number>} values 合法值序列
 * @param {number} current 当前值
 * @param {(v:number)=>void} onPick
 * @param {(v:number)=>string} fmt 值 → 展示文本
 * @param {(tag:string, props?:Object, ...children:any[])=>HTMLElement} el DOM 构造辅助
 */
function makeSelect(el, values, current, onPick, fmt) {
  const sel = el('select', { class: 'spec-select' });
  for (const v of values) {
    sel.appendChild(el('option', { value: String(v) }, fmt(v)));
  }
  sel.value = String(current);
  if (sel.value !== String(current)) {
    // 当前值不在序列内（老数据/滑杆残留）→ 插一个"已吸附"选项，避免静默错位
    sel.appendChild(el('option', { value: String(current) }, `${fmt(current)}（已吸附）`));
    sel.value = String(current);
  }
  sel.addEventListener('change', () => onPick(parseFloat(sel.value)));
  return sel;
}

/**
 * 构建「真实规格选择器」整块 UI。
 *
 * @param {Object} args
 * @param {Object} args.app        应用实例（用于读写 app.params.front/rear）
 * @param {()=>Object} args.getSpec 读当前轴的规格对象 {rimInch,j,et,tireWidthMm,aspect,camber}
 * @param {(patch:Object)=>void} args.applySpec 写回规格
 * @param {()=>void} args.onChange 变更后触发（app.apply）
 * @param {Object|null} args.basis 车型底座（可空 → 只显示规格不给原厂对比）
 * @param {()=>Object} args.el     DOM 构造辅助
 * @returns {{root:HTMLElement, render:Function}}
 */
export function createSpecPicker({ getSpec, applySpec, onChange, basis, el }) {
  // —— 真实胎规格（胎宽 × 扁平比 × 轮辋）——
  const sizeRow = el('div', { class: 'spec-row' });
  const sizeLabelEl = el('div', { class: 'spec-label' }, '胎规格');
  const sizeValue = el('div', { class: 'spec-value' });
  const sizeNote = el('div', { class: 'spec-note' });
  const sizeCtl = el('div', { class: 'spec-ctl' });

  const widthSel = makeSelect(
    el,
    TIRE_WIDTHS_MM,
    getSpec().tireWidthMm,
    (v) => {
      applySpec({ tireWidthMm: v });
      onChange();
      render();
    },
    (v) => `胎宽 ${v}mm`
  );
  const aspectSel = makeSelect(
    el,
    TIRE_ASPECTS,
    getSpec().aspect,
    (v) => {
      applySpec({ aspect: v });
      onChange();
      render();
    },
    (v) => `扁平比 ${v}%`
  );
  const rimSel = makeSelect(
    el,
    RIM_DIAMETERS_IN,
    getSpec().rimInch,
    (v) => {
      applySpec({ rimInch: v });
      onChange();
      render();
    },
    (v) => `轮辋 ${v}"`
  );
  sizeCtl.append(widthSel, aspectSel, rimSel);
  sizeRow.append(sizeLabelEl, sizeValue, sizeCtl, sizeNote);

  // —— 推荐的真实组合（点击直接换）——
  const recRow = el('div', { class: 'spec-rec' });

  // —— ET（偏距）与 J（轮辋宽）——
  const etRow = el('div', { class: 'spec-row' });
  const etValue = el('div', { class: 'spec-value' });
  const etNote = el('div', { class: 'spec-note' });
  const etCtl = el('div', { class: 'spec-ctl' });
  const etSel = makeSelect(
    el,
    ET_VALUES_MM,
    getSpec().et,
    (v) => {
      applySpec({ et: v });
      onChange();
      render();
    },
    (v) => `ET ${v}mm`
  );
  etCtl.appendChild(etSel);
  etRow.append(el('div', { class: 'spec-label' }, '偏距 / 轮辋宽'), etValue, etCtl, etNote);

  const jSel = makeSelect(
    el,
    RIM_JS,
    getSpec().j,
    (v) => {
      applySpec({ j: v });
      onChange();
      render();
    },
    (v) => `J ${v}（${(v * 25.4).toFixed(0)}mm）`
  );

  // —— 倾角（保留滑杆：这是装配角度，不是轮胎规格）——
  const camRow = el('div', { class: 'spec-row' });
  const camValue = el('div', { class: 'spec-value' });
  const camInput = el('input', {
    type: 'range',
    class: 'spec-range',
    min: -6,
    max: 3,
    step: 0.25,
  });
  camInput.addEventListener('input', () => {
    applySpec({ camber: parseFloat(camInput.value) });
    onChange();
    render();
  });
  camRow.append(el('div', { class: 'spec-label' }, '倾角'), camValue, el('div', { class: 'spec-ctl' }, camInput));

  const oeTag = el('div', { class: 'spec-oe-tag' });
  const root = el(
    'div',
    { class: 'spec-picker' },
    sizeRow,
    recRow,
    etRow,
    el('div', { class: 'spec-ctl-row' }, jSel),
    camRow,
    oeTag
  );

  function render() {
    const cur = getSpec();
    const t = cur.axleTarget || 'front';
    const oe = basis ? basis[t === 'rear' ? 'rear' : 'front'] : null;

    // 胎规格
    const ev = evalSize(cur.tireWidthMm, cur.aspect, cur.rimInch);
    sizeValue.textContent = ev.ok ? ev.label : `${sizeLabel(cur)}（非标准）`;
    sizeValue.className = `spec-value${ev.ok ? '' : ' is-warn'}`;
    sizeNote.textContent = ev.ok
      ? TIRE_SIZE_SERIES[ev.key]?.note || '真实规格'
      : ev.nearest
        ? `该组合无此胎，最接近：${ev.nearest}`
        : '该组合无对应轮胎';
    sizeNote.className = `spec-note${ev.ok ? '' : ' is-warn'}`;

    widthSel.value = String(Math.round(cur.tireWidthMm));
    aspectSel.value = String(Math.round(cur.aspect));
    rimSel.value = String(Math.round(cur.rimInch));

    // ET 语境
    if (oe) {
      const h = etHint(cur.et, oe.et);
      etValue.textContent = `${Math.round(cur.et)}mm`;
      etNote.textContent = h.text;
      etNote.className = `spec-note${h.delta === 0 ? '' : ' is-shift'}`;
    } else {
      etValue.textContent = `${Math.round(cur.et)}mm`;
      etNote.textContent = '未建档车型，不给原厂对比';
      etNote.className = 'spec-note';
    }
    etSel.value = String(Math.round(cur.et));
    jSel.value = String(cur.j);

    // 倾角
    camInput.value = String(cur.camber ?? 0);
    camValue.textContent = `${(cur.camber ?? 0).toFixed(2)}°`;
    camValue.className = `spec-value${(cur.camber ?? 0) < -2.5 ? ' is-warn' : ''}`;

    // 推荐组合
    recRow.innerHTML = '';
    const recs = recommendSizes(cur, oe);
    if (recs.length) {
      recRow.appendChild(el('span', { class: 'spec-rec-title' }, '同轮辋可选'));
      for (const r of recs.slice(0, 4)) {
        recRow.appendChild(
          el(
            'button',
            {
              class: 'chip spec-chip',
              title: r.delta,
              onclick: () => {
                applySpec({ tireWidthMm: r.tireWidthMm, aspect: r.aspect, rimInch: r.rimInch });
                onChange();
                render();
              },
            },
            r.label
          )
        );
      }
    }

    // 原厂标记
    if (oe && isOeSpec(cur, oe)) {
      oeTag.className = 'spec-oe-tag is-oe';
      oeTag.textContent = `当前为原厂规格（${oe.confidence === 'oe' ? '手册值' : '厂商公开值'}）`;
    } else {
      oeTag.className = 'spec-oe-tag';
      oeTag.textContent = oe
        ? `已偏离原厂 ${sizeLabel(oe)}（${oe.confidence === 'oe' ? '手册值' : '厂商公开值'}）`
        : '未建档车型：仅作灵感预览，不产出工程结论';
    }
  }

  render();
  return { root, render };
}
