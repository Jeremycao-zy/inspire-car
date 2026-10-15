/**
 * clearanceReport.js — 扫掠检测结果的可解释报告（精准适配层级）
 *
 * 目标：把 clearance.js 的数值结果翻译成店主/车主愿意付费的那句话：
 *   「左前（FL）满打方向时翼子板外沿干涉 −3.1mm；建议胎宽 265 → 235mm，
 *     调整后全车最小间隙 −3.1mm → 14.7mm（判定 ok）。」
 *
 * 设计原则（不可妥协）：
 *   1. **不编造**：未建档车型 / est 级数据一律显示「无法判定」，不给任何数字。
 *   2. **不重复承诺**：这是几何检测，替代不了施工签字，措辞必须留出余地。
 *   3. **可执行**：每条建议都带 `change.spec`，能一键回填面板并即时重算。
 *   4. **说清最坏工况**：只报 minGap 是不够的，必须报「哪个角 + 什么工况 + 哪个方向」。
 *
 * 本模块只负责渲染，不做几何计算。
 */

import { analyzeAll, worstCase, suggestFix } from '../tuning/clearance.js';
import { getBasis, canJudge } from '../tuning/tireBasis.js';

/** 工况中文名（与 clearance.js 的 conditionLabel 对齐，兜底用） */
const CONDITION_FALLBACK = {
  static: '静止',
  bump: '满压缩',
  droop: '满回弹',
  lock: '满打方向',
  bumpLock: '满压缩 + 满打方向',
};

const CORNER_FALLBACK = { FL: '左前', FR: '右前', RL: '左后', RR: '右后' };

/** 障碍物 id → 中文名（worstCase 只给 obstacle id，不给 label） */
const OBSTACLE_LABELS = {
  'fender-arch': '轮拱顶',
  'fender-lip': '翼子板外沿',
  'brake-caliper': '内侧卡钳 / 避震',
  'fender-edge': '轮拱开口边缘',
};

/** 判定 → 语义色 class 后缀 */
function verdictClass(v) {
  if (v === 'interfere') return 'is-bad';
  if (v === 'warn') return 'is-warn';
  return 'is-ok';
}

/**
 * 创建可解释报告组件。
 *
 * @param {Object} args
 * @param {Object} args.app  应用实例（读 app.params.front/rear、app.apply）
 * @param {Function} args.el DOM 构造辅助
 * @param {Function} args.onApplied 建议被应用后的回调（用于刷新 3D 与其它读数）
 * @returns {{root:HTMLElement, render:Function}}
 */
export function createClearanceReport({ app, el, onApplied }) {
  const root = el('div', { class: 'clr-report' });

  function render() {
    root.innerHTML = '';
    const basisKey = app.params.realSpecs?.carKey;
    const basis = getBasis(basisKey);

    /* ---- ① 未建档：明确不给结论 ---- */
    if (!basis) {
      root.appendChild(
        el(
          'div',
          { class: 'clr-head' },
          el('div', { class: 'clr-title' }, '动态间隙检测'),
          el('span', { class: 'clr-badge is-na' }, '未建档')
        )
      );
      root.appendChild(
        el(
          'div',
          { class: 'clr-na' },
          el('p', { class: 'clr-na__title' }, '该车型尚未建档，无法做动态间隙判定。'),
          el(
            'p',
            { class: 'clr-na__body' },
            '动态检测需要原厂轮拱、悬挂行程、转向角等基准数据。图生 3D 车模不提供这些，' +
              '用网格反推会把「原厂状态」也算成异常。当前仅支持按真实规格预览改装效果。'
          )
        )
      );
      return;
    }

    /* ---- ② 执行分析 ---- */
    const specs = { front: app.params.front, rear: app.params.rear };
    const result = analyzeAll(basisKey, specs.front, specs.rear);
    if (!result?.available) {
      root.appendChild(el('div', { class: 'clr-na' }, '该车型数据不足，无法判定。'));
      return;
    }

    const w = worstCase(result);
    const mayJudge = canJudge(basisKey);

    /* ---- ③ 头部：全车最差 + 判定 ---- */
    const s = result.summary;
    root.appendChild(
      el(
        'div',
        { class: 'clr-head' },
        el('div', { class: 'clr-title' }, '动态间隙检测'),
        el(
          'span',
          { class: `clr-badge ${verdictClass(s.verdict)}` },
          mayJudge
            ? s.verdict === 'ok'
              ? '全车通过'
              : s.verdict === 'warn'
                ? '临界'
                : '存在干涉'
            : '仅供参考'
        )
      )
    );

    // 统计条：ok / warn / interfere 工况数
    root.appendChild(
      el(
        'div',
        { class: 'clr-stats' },
        el('span', { class: 'clr-stat is-ok' }, '通过 ' + s.okCount),
        el('span', { class: 'clr-stat is-warn' }, '临界 ' + s.warnCount),
        el('span', { class: 'clr-stat is-bad' }, '干涉 ' + s.interfereCount),
        el('span', { class: 'clr-stat-total' }, '共 ' + s.rows + ' 个工况')
      )
    );

    /* ---- ④ 最坏工况（这是报告的核心，必须显眼）---- */
    if (w) {
      const worstBox = el(
        'div',
        { class: `clr-worst ${verdictClass(result.summary.verdict)}` },
        el(
          'div',
          { class: 'clr-worst__where' },
          el('span', { class: 'clr-corner' }, w.cornerLabel || CORNER_FALLBACK[w.corner] || w.corner),
          el('span', { class: 'clr-sep' }, '·'),
          el('span', { class: 'clr-cond' }, w.conditionLabel || CONDITION_FALLBACK[w.condition] || w.condition),
          el('span', { class: 'clr-sep' }, '·'),
          el('span', { class: 'clr-dir' }, w.directionLabel || w.direction)
        ),
        el(
          'div',
          { class: 'clr-worst__value' },
          el('span', { class: 'clr-num' }, (w.value >= 0 ? '+' : '') + w.value.toFixed(1)),
          el('span', { class: 'clr-unit' }, 'mm')
        ),
        el('div', { class: 'clr-worst__obs' }, '最近障碍：' + (OBSTACLE_LABELS[w.obstacle] || w.obstacle))
      );
      root.appendChild(worstBox);
    }

    /* ---- ⑤ 可执行建议 ---- */
    if (w && result.summary.verdict !== 'ok') {
      const fx = suggestFix(w, basisKey, specs);
      const list = el('div', { class: 'clr-suggests' });
      for (const sg of fx.suggestions || []) {
        const item = el(
          'div',
          { class: 'clr-suggest' + (sg.verified ? ' is-verified' : '') },
          el('p', { class: 'clr-suggest__text' }, sg.text)
        );
        if (sg.change?.spec) {
          item.appendChild(
            el(
              'button',
              {
                class: 'btn small primary',
                onClick: () => {
                  // 直接回填面板参数并即时重算 —— 建议必须可执行，而不只是文字
                  const target = sg.change.axle === 'rear' ? app.params.rear : app.params.front;
                  Object.assign(target, sg.change.spec);
                  app.apply();
                  onApplied?.();
                  render();
                },
              },
              '应用此方案'
            )
          );
        }
        list.appendChild(item);
      }
      if (!fx.resolved && fx.note) {
        list.appendChild(el('div', { class: 'clr-suggest__note' }, '已穷举单参数调整，无可行解。'));
      }
      root.appendChild(list);
    } else if (w) {
      root.appendChild(
        el(
          'div',
          { class: 'clr-allgood' },
          '全车 ' + s.rows + ' 个工况最小间隙均达标（最差 ' + w.value.toFixed(1) + 'mm）。'
        )
      );
    }

    /* ---- ⑥ 边界声明：这是适配建议，不是工程签字 ---- */
    root.appendChild(
      el(
        'div',
        { class: 'clr-disclaimer' },
        mayJudge
          ? '基于原厂基准几何（' +
            (basis.confidence === 'oe' ? '手册值' : '厂商公开值') +
            '）的扫掠检测；主销后倾/拖距按 0 处理，真实风险可能被低估。结论为适配建议，不作为施工依据。'
          : '该车型数据为厂商公开级别，结论仅供参考。'
      )
    );
  }

  render();
  return { root, render };
}
