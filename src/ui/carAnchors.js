import * as THREE from 'three';

/**
 * 车身旁空间锚点系统（方案 B：3D 空间锚点）
 *
 * 在 3D 视口（#stage）上叠加一层 pointer-events:none 的 HTML 锚点层，
 * 每帧把车身 / 车轮的「世界坐标」投影到屏幕像素，定位可点击锚点。
 * 锚点随车自转一并转动，符合「贴在车上」的语义；被车身挡住或在相机
 * 背面时自动隐藏，避免误触。
 *
 * 不引入 raycaster——车轮锚直接读 corner.tireMesh 的世界坐标，其它锚点
 * 用 carInner.localToWorld（基于归一后真实尺寸参数）算出世界坐标再投影。
 *
 * 点击行为全部委托给 panel / app 的既有方法，保证与侧栏完全同构、零重复逻辑。
 */
export function createCarAnchors({ stage, viewer, rig, carInner, app, panel }) {
  const layer = document.createElement('div');
  layer.className = 'car-anchors';
  stage.appendChild(layer);

  const tmp = new THREE.Vector3();
  const ndc = new THREE.Vector3();

  function worldToScreen(worldVec) {
    ndc.copy(worldVec).project(viewer.camera);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const x = (ndc.x * 0.5 + 0.5) * w;
    const y = (-ndc.y * 0.5 + 0.5) * h;
    const behind = ndc.z > 1; // 投影到相机背后
    return { x, y, behind };
  }

  function place(el, worldVec) {
    const s = worldToScreen(worldVec);
    if (s.behind) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.setProperty('--ax', `${s.x.toFixed(1)}px`);
    el.style.setProperty('--ay', `${s.y.toFixed(1)}px`);
  }

  function makeAnchor(cls, label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `car-anchor ${cls}`;
    b.title = title;
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClick();
    });
    layer.appendChild(b);
    return b;
  }

  // 四轮：点击进该轮毂编辑（作用域落到所属轴）。
  // 轮毂在 loadPlanCar 之后才装配，startTuner 初始化时 corners 可能还为空，
  // 故每帧按 rig.corners 实际数量动态同步，轮装配后锚点自动出现。
  let wheelAnchors = [];
  function syncWheels() {
    const corners = rig.corners || [];
    if (wheelAnchors.length === corners.length) return;
    for (const a of wheelAnchors) a.el.remove();
    wheelAnchors = corners.map((c) => ({
      corner: c,
      el: makeAnchor('wheel', '', `编辑 ${c.label} 轮毂`, () => panel.selectWheel(c.id)),
    }));
  }

  // 朝向：车头左转 / 车尾右转 / 顶部翻转
  const headAnchor = makeAnchor('orient', '↺', '车头朝向左转 90°', () => app.rotateCar(1));
  const tailAnchor = makeAnchor('orient', '↻', '车尾朝向右转 90°', () => app.rotateCar(-1));
  const flipAnchor = makeAnchor('orient flip', '⇋', '翻转 180°', () => app.rotateCar(2));

  // 爆炸分解：切换 拆解装配 / 整车单体
  const bangAnchor = makeAnchor('bang', '✣', '切换拆解 / 整车视图', () => panel.toggleBang());

  // 四角悬挂
  const SUSP = ['FL', 'FR', 'RL', 'RR'];
  const suspAnchors = SUSP.map((id) => ({
    id,
    el: makeAnchor('susp', '', `调节 ${id} 悬挂高度`, () => panel.focusSuspension(id)),
  }));

  // 重置视角：固定在视口右下角，不随车投影
  const resetBtn = makeAnchor('reset', '⟲', '重置视角（回到默认机位）', () => {
    try {
      const box = new THREE.Box3().setFromObject(carInner);
      viewer.frameBox(box, 1.25);
    } catch {
      /* 盒子算不出也不影响其它锚点 */
    }
  });
  resetBtn.style.left = 'auto';
  resetBtn.style.top = 'auto';
  resetBtn.style.right = '16px';
  resetBtn.style.bottom = '16px';

  // 把车身局部坐标（基于归一后真实尺寸）转世界坐标
  function localPoint(lx, ly, lz) {
    tmp.set(lx, ly, lz);
    carInner.updateWorldMatrix(true, false);
    carInner.localToWorld(tmp);
    return tmp;
  }

  function update() {
    syncWheels();
    const L = app.params.carLength || 4.6;
    const W = app.params.carWidth || 2.0;
    const H = app.params.carHeight || 1.4;

    // 车轮：直接读轮胎世界坐标（跟随调参 / 自转实时）
    for (const a of wheelAnchors) {
      if (a.corner.tireMesh) {
        a.corner.tireMesh.getWorldPosition(tmp);
        place(a.el, tmp);
      }
    }

    // 朝向与爆炸锚：相对车身本体的局部点
    place(headAnchor, localPoint(L * 0.46, H * 0.55, 0));
    place(tailAnchor, localPoint(-L * 0.46, H * 0.55, 0));
    place(flipAnchor, localPoint(0, H * 1.04, 0));
    place(bangAnchor, localPoint(0, H * 0.5, W * 0.42));

    // 四角悬挂：车底四角
    const hx = L * 0.42;
    const hz = W * 0.42;
    const map = {
      FL: [hx, hz],
      FR: [hx, -hz],
      RL: [-hx, hz],
      RR: [-hx, -hz],
    };
    for (const a of suspAnchors) {
      const [lx, lz] = map[a.id];
      place(a.el, localPoint(lx, 0.05, lz));
    }
  }

  const unsub = viewer.onUpdate(update);

  return {
    refresh() {
      update();
    },
    dispose() {
      unsub();
      layer.remove();
    },
  };
}
