/* ============================================================
   아파트 평면도 비교 · 가구 배치 시뮬레이터
   - 내부 기준 단위: mm (밀리미터)
   - 위치(중심)는 월드 좌표 '미터'로 저장, 렌더 시 px = m * ppm
   ============================================================ */
(function () {
"use strict";

/* ---------- 단위 / 변환 유틸 ---------- */
const UNIT_MM = { mm: 1, cm: 10, m: 1000 };          // 1단위 = ? mm
const PYEONG = 3.305785;                              // 1평 = 3.305785 m²

const uid = () => "id" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function mmToPx(mm, ppm) { return (mm / 1000) * ppm; }
function mToPx(m, ppm) { return m * ppm; }
function pxToM(px, ppm) { return px / ppm; }

function fmtLen(mm) {
  const u = state.unit, v = mm / UNIT_MM[u];
  if (u === "mm") return Math.round(v) + "mm";
  if (u === "cm") return (Math.round(v * 10) / 10) + "cm";
  return (Math.round(v * 100) / 100) + "m";
}
function areaM2(wmm, hmm) { return (wmm * hmm) / 1e6; }
function fmtArea(wmm, hmm) {
  const a = areaM2(wmm, hmm);
  return a.toFixed(2) + "㎡ (" + (a / PYEONG).toFixed(2) + "평)";
}
function hexA(hex, a) {
  hex = (hex || "#888888").replace("#", "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  const r = parseInt(hex.substr(0, 2), 16), g = parseInt(hex.substr(2, 2), 16), b = parseInt(hex.substr(4, 2), 16);
  return "rgba(" + r + "," + g + "," + b + "," + a + ")";
}

/* ---------- 기하 / 충돌 (단위: mm 월드좌표) ---------- */
function shapeDims(item, type) { return { w: item.wmm, h: (type === "room" ? item.hmm : item.dmm) }; }
function getCornersMM(item, type) {
  const d = shapeDims(item, type);
  const cx = (item.xm || 0) * 1000, cy = (item.ym || 0) * 1000;
  const hw = d.w / 2, hh = d.h / 2;
  const a = (item.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(function (p) {
    return { x: cx + p[0] * cos - p[1] * sin, y: cy + p[0] * sin + p[1] * cos };
  });
}
function polyAxes(poly) {
  const ax = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey) || 1;
    ax.push({ x: -ey / len, y: ex / len });
  }
  return ax;
}
function projPoly(poly, ax) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < poly.length; i++) { const d = poly[i].x * ax.x + poly[i].y * ax.y; if (d < mn) mn = d; if (d > mx) mx = d; }
  return [mn, mx];
}
function polyIntersect(A, B, eps) {
  eps = eps || 0;
  const axes = polyAxes(A).concat(polyAxes(B));
  for (let i = 0; i < axes.length; i++) {
    const a = projPoly(A, axes[i]), b = projPoly(B, axes[i]);
    if (a[1] - b[0] <= eps || b[1] - a[0] <= eps) return false; // 분리축 존재
  }
  return true;
}
function pointInConvex(poly, pt) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}
function computeWarnings(data) {
  const furn = data.furniture || [], rooms = data.rooms || [];
  const collide = new Set(), outRoom = new Set();
  const polys = furn.map(function (f) { return getCornersMM(f, "furniture"); });
  for (let i = 0; i < furn.length; i++)
    for (let j = i + 1; j < furn.length; j++)
      if (polyIntersect(polys[i], polys[j], 1)) { collide.add(furn[i].id); collide.add(furn[j].id); }
  const roomPolys = rooms.map(function (r) { return getCornersMM(r, "room"); });
  if (rooms.length) {
    for (let i = 0; i < furn.length; i++) {
      const cx = (furn[i].xm || 0) * 1000, cy = (furn[i].ym || 0) * 1000;
      let inSome = false, fully = false;
      for (let k = 0; k < roomPolys.length; k++) {
        if (pointInConvex(roomPolys[k], { x: cx, y: cy })) {
          inSome = true;
          if (polys[i].every(function (c) { return pointInConvex(roomPolys[k], c); })) { fully = true; break; }
        }
      }
      if (!inSome || !fully) outRoom.add(furn[i].id);
    }
  }
  return { collide: collide, outRoom: outRoom };
}

/* ---------- 가구 카탈로그 (프로젝트와 분리된 영구 저장소) ---------- */
const CATALOG_KEY = "apt_pjt_furniture_catalog_v1";
function defaultCatalog() {
  return [
    { id: uid(), name: "퀸 침대", wmm: 1500, dmm: 2000, hmm: 500, color: "#7c9cff" },
    { id: uid(), name: "3인 소파", wmm: 2000, dmm: 900, hmm: 850, color: "#36c08a" },
    { id: uid(), name: "냉장고", wmm: 900, dmm: 800, hmm: 1800, color: "#e0a14b" },
    { id: uid(), name: "식탁(4인)", wmm: 1200, dmm: 800, hmm: 740, color: "#c07be0" }
  ];
}
// 높이 미입력 가구의 기본 높이(mm) — 이름으로 추정
function guessHeightMM(name) {
  const n = String(name || "");
  if (/침대|매트리스|bed/i.test(n)) return 500;
  if (/소파|sofa|couch/i.test(n)) return 850;
  if (/냉장고|김치냉장고/i.test(n)) return 1800;
  if (/옷장|장롱|붙박이|행거|wardrobe|closet/i.test(n)) return 2100;
  if (/책장|선반|수납장|진열/i.test(n)) return 1800;
  if (/책상|식탁|테이블|desk|table/i.test(n)) return 740;
  if (/세탁기|건조기/i.test(n)) return 850;
  if (/티비|텔레비|tv|모니터/i.test(n)) return 1200;
  if (/서랍|화장대|콘솔/i.test(n)) return 800;
  if (/의자|체어|스툴|chair/i.test(n)) return 900;
  return 800;
}
function furnH(f) { return (f && f.hmm > 0) ? f.hmm : guessHeightMM(f && f.name); }
function loadCatalogRaw() {
  try { const r = localStorage.getItem(CATALOG_KEY); if (r) { const a = JSON.parse(r); if (Array.isArray(a)) return a; } } catch (e) {}
  return null;
}
function loadCatalog() { return loadCatalogRaw() || defaultCatalog(); }
function saveCatalog() {
  try { localStorage.setItem(CATALOG_KEY, JSON.stringify(state.furnitureLib)); } catch (e) {}
}
function catalogKeyOf(f) { return (f.name || "") + "|" + f.wmm + "|" + f.dmm; }
// 저장된 카탈로그를 기준으로, 전달된 항목 중 없는 것만 합쳐서 저장하고 반환
function mergeIntoCatalog(items) {
  let base = loadCatalogRaw();
  if (base === null) { base = (items && items.length) ? items.slice() : defaultCatalog(); }
  else {
    const keys = new Set(base.map(catalogKeyOf));
    (items || []).forEach(function (f) { if (!keys.has(catalogKeyOf(f))) { base.push(f); keys.add(catalogKeyOf(f)); } });
  }
  try { localStorage.setItem(CATALOG_KEY, JSON.stringify(base)); } catch (e) {}
  return base;
}

/* ---------- 상태 ---------- */
const DEFAULT_PPM = 55;
let state = newState();
function newState() {
  return {
    unit: "mm",
    furnitureLib: loadCatalog(),   // 영구 카탈로그에서 로드 (초기화해도 유지)
    plans: {
      A: planData("현재 집 (A)"),
      B: planData("이사갈 집 (B)")
    }
  };
}
function planData(name) {
  return { name: name, ppm: DEFAULT_PPM, showGrid: true, rooms: [], furniture: [], bg: null, wallmm: 2400 };
}

/* ---------- Transformer 옵션 ---------- */
function trOpts() {
  return {
    keepRatio: false,
    rotateEnabled: true,
    rotationSnaps: [0, 90, 180, 270],
    rotationSnapTolerance: 6,
    anchorSize: 9,
    anchorStroke: "#5b7cff",
    anchorFill: "#fff",
    borderStroke: "#5b7cff",
    borderDash: [4, 3],
    rotateAnchorOffset: 26,
    ignoreStroke: true
  };
}

/* ============================================================
   StageView : 하나의 캔버스(도면 또는 비교 방)를 담당
   ============================================================ */
const allViews = [];
let cmpOverlay = false;

function StageView(opts) {
  this.containerId = opts.containerId;
  this.data = opts.data;                    // { rooms, furniture, bg, name, ppm, showGrid }
  this.planId = opts.planId || null;        // 'A' | 'B' | null(비교)
  this.isMain = !!opts.isMain;
  this.roomsLocked = !!opts.roomsLocked;    // 비교창의 방은 편집 불가(틀)
  this.persistFn = opts.persist || function () {};
  this._ppm = (this.data && this.data.ppm) || opts.ppm || DEFAULT_PPM;
  this.gridOn = opts.gridOn != null ? opts.gridOn : (this.data ? this.data.showGrid : false);
  this.ghostRoom = null;                     // 비교창 겹쳐보기용 다른 방
  this.calibrating = false;
  this._calibPts = [];
  this.selectedGroups = [];
  this._dragStart = null;

  const el = document.getElementById(this.containerId);
  el.innerHTML = ""; // 이전/중복 캔버스 제거 — 모바일에서 캔버스가 겹쳐 잔상이 보이는 문제 방지
  this.stage = new Konva.Stage({
    container: this.containerId,
    width: Math.max(50, el.clientWidth),
    height: Math.max(50, el.clientHeight),
    draggable: true   // 빈 영역 드래그 = 패닝
  });
  this.layer = new Konva.Layer();
  this.stage.add(this.layer);
  this.tr = new Konva.Transformer(trOpts());
  this.layer.add(this.tr);

  const self = this;
  this.stage.on("click tap", function (e) {
    if (self.calibrating) { self.handleCalibClick(); return; }
    if (e.target === self.stage || e.target === self.bgNode) {
      self.deselect(); clearInspector();
    }
  });
  this.stage.on("mousemove", function () { if (self.calibrating) self.updateCalibGuide(); });
  this.stage.on("dragend", function () { /* 패닝은 저장 안함(시각적) */ });

  allViews.push(this);
}

StageView.prototype.ppm = function () { return this._ppm; };
StageView.prototype.centerWorld = function () {
  // 스테이지 보이는 중심의 월드 좌표(미터). 패닝(stage.position) 반영.
  const cx = (this.stage.width() / 2 - this.stage.x());
  const cy = (this.stage.height() / 2 - this.stage.y());
  return { xm: pxToM(cx, this._ppm), ym: pxToM(cy, this._ppm) };
};
StageView.prototype.screenToWorld = function (clientX, clientY) {
  // 화면 좌표(clientX/Y) → 도면 월드 좌표(미터). 드롭 위치 계산용.
  const rect = this.stage.container().getBoundingClientRect();
  const sx = clientX - rect.left - this.stage.x();
  const sy = clientY - rect.top - this.stage.y();
  return { xm: pxToM(sx, this._ppm), ym: pxToM(sy, this._ppm) };
};

StageView.prototype.persist = function () { this.persistFn(); };

StageView.prototype.resize = function () {
  const el = document.getElementById(this.containerId);
  if (!el) return;
  this.stage.width(Math.max(50, el.clientWidth));
  this.stage.height(Math.max(50, el.clientHeight));
  this.render();
};

StageView.prototype.findGroupById = function (id) {
  let found = null;
  this.layer.getChildren(function (n) { return n._model && n._model.id === id; }).forEach(function (g) { found = g; });
  return found;
};

/* ---------- 라벨 ---------- */
function labelText(item, type) {
  if (type === "room")
    return item.name + "\n" + fmtLen(item.wmm) + " × " + fmtLen(item.hmm) + "\n" + areaM2(item.wmm, item.hmm).toFixed(2) + "㎡";
  return item.name + "\n" + fmtLen(item.wmm) + "×" + fmtLen(item.dmm);
}
function keepLabelUpright(g) {
  if (g._label) g._label.rotation(-g.rotation());
}

/* ---------- 도형(Group) 생성 ---------- */
StageView.prototype.makeGroup = function (item, type) {
  const self = this, ppm = this._ppm;
  const wpx = mmToPx(item.wmm, ppm);
  const hpx = mmToPx(type === "room" ? item.hmm : item.dmm, ppm);

  const g = new Konva.Group({
    x: mToPx(item.xm || 0, ppm),
    y: mToPx(item.ym || 0, ppm),
    rotation: item.rot || 0,
    draggable: !(type === "room" && this.roomsLocked)
  });
  g._model = item; g._type = type;

  const rect = new Konva.Rect({
    x: -wpx / 2, y: -hpx / 2, width: wpx, height: hpx,
    fill: hexA(item.color, type === "room" ? 0.16 : 0.55),
    stroke: item.color || "#888",
    strokeWidth: type === "room" ? 2 : 1.5,
    cornerRadius: type === "room" ? 0 : 3
  });
  g.add(rect);
  g._rect = rect;

  if (type === "furniture") {
    // 정면 방향 표시선
    const marker = new Konva.Line({
      points: [0, 0, 0, -hpx * 0.42], stroke: "#0c0f1c", strokeWidth: 2, opacity: 0.55, listening: false
    });
    g.add(marker);
  }

  const label = new Konva.Text({
    text: labelText(item, type), fontSize: type === "room" ? 12 : 11,
    fontStyle: "600", fill: type === "room" ? "#dfe6ff" : "#0c0f1c",
    align: "center", lineHeight: 1.25, listening: false
  });
  label.offsetX(label.width() / 2);
  label.offsetY(label.height() / 2);
  g.add(label);
  g._label = label;
  keepLabelUpright(g);

  // ---- 인터랙션 ----
  g.on("mouseenter", function () { self.stage.container().style.cursor = "move"; });
  g.on("mouseleave", function () { self.stage.container().style.cursor = self.calibrating ? "crosshair" : "default"; });

  g.on("click tap", function (e) {
    e.cancelBubble = true;
    if (self.calibrating) return;
    if (compareMode && self.isMain && type === "room") { handleComparePick(self, item); return; }
    const additive = e.evt && (e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
    self.select(g, additive);
  });

  g.on("dragstart", function () {
    if (self.selectedGroups.indexOf(g) < 0) self.select(g);   // 선택 안 된 것을 끌면 단일 선택
    if (self.selectedGroups.length > 1) {
      self._dragStart = self.selectedGroups.map(function (n) { return { node: n, x: n.x(), y: n.y() }; });
      self._dragLead = { x: g.x(), y: g.y() };
    } else { self._dragStart = null; }
  });
  g.on("dragmove", function () {
    if (self._dragStart) {
      const dx = g.x() - self._dragLead.x, dy = g.y() - self._dragLead.y;
      self._dragStart.forEach(function (s) {
        if (s.node !== g) { s.node.x(s.x + dx); s.node.y(s.y + dy); keepLabelUpright(s.node); }
        const m = s.node._model; m.xm = pxToM(s.node.x(), self._ppm); m.ym = pxToM(s.node.y(), self._ppm);
      });
      if (self.tr) self.tr.forceUpdate();
    } else {
      item.xm = pxToM(g.x(), self._ppm);
      item.ym = pxToM(g.y(), self._ppm);
    }
    keepLabelUpright(g);
    self.refreshCollisions();
  });
  g.on("dragend", function () {
    if (self._dragStart) {
      self._dragStart.forEach(function (s) { const m = s.node._model; m.xm = pxToM(s.node.x(), self._ppm); m.ym = pxToM(s.node.y(), self._ppm); });
      self._dragStart = null;
    } else {
      item.xm = pxToM(g.x(), self._ppm);
      item.ym = pxToM(g.y(), self._ppm);
    }
    self.refreshCollisions();
    self.persist();
  });

  if (type === "room" && !this.roomsLocked) {
    g.on("transform", function () { keepLabelUpright(g); });
    g.on("transformend", function () {
      const sx = g.scaleX(), sy = g.scaleY();
      item.wmm = Math.max(100, Math.round(item.wmm * sx));
      item.hmm = Math.max(100, Math.round(item.hmm * sy));
      item.rot = g.rotation();
      item.xm = pxToM(g.x(), self._ppm);
      item.ym = pxToM(g.y(), self._ppm);
      g.scale({ x: 1, y: 1 });
      self.render(item.id);
      self.persist();
    });
  } else {
    g.on("transform", function () { item.rot = g.rotation(); keepLabelUpright(g); self.refreshCollisions(); });
    g.on("transformend", function () {
      item.rot = g.rotation();
      item.xm = pxToM(g.x(), self._ppm);
      item.ym = pxToM(g.y(), self._ppm);
      keepLabelUpright(g);
      self.refreshCollisions();
      self.persist();
    });
  }

  return g;
};

/* ---------- 배경(사진 도면) ---------- */
StageView.prototype.renderBg = function () {
  const self = this, bg = this.data.bg;
  const place = function (imgEl) {
    let scale = bg.scale || 0.2;
    if (bg.mmPerNativePx) scale = (bg.mmPerNativePx / 1000) * self._ppm;
    const kimg = new Konva.Image({
      image: imgEl, x: bg.x || 0, y: bg.y || 0,
      scaleX: scale, scaleY: scale,
      opacity: (bg.opacity != null ? bg.opacity : 55) / 100,
      draggable: true
    });
    kimg.on("dragend", function () { bg.x = kimg.x(); bg.y = kimg.y(); self.persist(); });
    kimg.on("click tap", function (e) { if (!self.calibrating) { e.cancelBubble = false; } });
    self.bgNode = kimg;
    self.layer.add(kimg);
    kimg.moveToBottom();
    self.layer.draw();
  };
  if (bg._img) { place(bg._img); }
  else {
    const im = new Image();
    im.onload = function () {
      bg._img = im;
      if (!bg.scale && !bg.mmPerNativePx) {
        bg.scale = (self.stage.width() * 0.7) / im.naturalWidth;
      }
      place(im);
    };
    im.src = bg.src;
  }
};

/* ---------- 격자 ---------- */
StageView.prototype.renderGrid = function () {
  const ppm = this._ppm, W = this.stage.width(), H = this.stage.height();
  const span = ppm;                    // 1m 간격
  const lines = [];
  for (let i = 0, x = 0; x <= W + span; x += span, i++) {
    lines.push(new Konva.Line({ points: [x, 0, x, H], stroke: i % 5 === 0 ? "#324" : "#222a44", strokeWidth: i % 5 === 0 ? 1 : 0.5, listening: false }));
  }
  for (let i = 0, y = 0; y <= H + span; y += span, i++) {
    lines.push(new Konva.Line({ points: [0, y, W, y], stroke: i % 5 === 0 ? "#324" : "#222a44", strokeWidth: i % 5 === 0 ? 1 : 0.5, listening: false }));
  }
  const grp = new Konva.Group({ listening: false });
  lines.forEach(l => grp.add(l));
  this.layer.add(grp);
};

/* ---------- 겹쳐보기 고스트 ---------- */
StageView.prototype.renderGhost = function () {
  const r = this.ghostRoom, ppm = this._ppm;
  const c = this.centerWorld();
  const wpx = mmToPx(r.wmm, ppm), hpx = mmToPx(r.hmm, ppm);
  const ghost = new Konva.Rect({
    x: mToPx(c.xm, ppm) - wpx / 2, y: mToPx(c.ym, ppm) - hpx / 2,
    width: wpx, height: hpx, stroke: "#e0556b", strokeWidth: 2, dash: [8, 6],
    fill: "rgba(224,85,107,0.06)", listening: false
  });
  const t = new Konva.Text({
    x: mToPx(c.xm, ppm) - wpx / 2 + 4, y: mToPx(c.ym, ppm) - hpx / 2 + 4,
    text: "비교 방: " + r.name + " (" + fmtLen(r.wmm) + "×" + fmtLen(r.hmm) + ")",
    fontSize: 11, fill: "#e0556b", listening: false
  });
  this.layer.add(ghost); this.layer.add(t);
};

/* ---------- 렌더 ---------- */
StageView.prototype.render = function (reselectId) {
  this.selectedGroups = [];
  this._dragStart = null;
  if (this.tr) { try { this.tr.nodes([]); } catch (e) {} } // 파괴될 노드 참조를 먼저 해제 (모바일 재렌더 오류 방지)
  this.layer.destroyChildren();
  this.layer.clear();  // 캔버스 명시적 클리어 — 이전 배율의 잔상 방지
  this.bgNode = null;
  if (this.data.bg && this.data.bg.src) this.renderBg();
  if (this.gridOn) this.renderGrid();
  const self = this;
  this.data.rooms.forEach(function (r) { self.layer.add(self.makeGroup(r, "room")); });
  this.data.furniture.forEach(function (f) { self.layer.add(self.makeGroup(f, "furniture")); });
  if (this.ghostRoom && cmpOverlay) this.renderGhost();
  this.tr = new Konva.Transformer(trOpts());
  this.layer.add(this.tr);
  this.layer.draw();
  this.refreshCollisions();
  if (reselectId) { const g = this.findGroupById(reselectId); if (g) this.select(g); }
  else if (selection.view === this) { selection = { view: null }; clearInspector(); }
  if (this.isMain) refreshAreaSummary();
};

/* ---------- 선택 (단일 + Shift 다중) ---------- */
StageView.prototype.select = function (g, additive) {
  if (g._type === "room" && this.roomsLocked) return; // 틀은 선택 불가
  allViews.forEach(function (v) { if (v !== this && v.selectedGroups.length) v.deselect(); }, this);
  if (additive) {
    const i = this.selectedGroups.indexOf(g);
    if (i >= 0) this.selectedGroups.splice(i, 1); else this.selectedGroups.push(g);
  } else {
    this.selectedGroups = [g];
  }
  this.applySelection();
};
StageView.prototype.applySelection = function () {
  const groups = this.selectedGroups;
  if (!groups.length) { this.deselect(); clearInspector(); return; }
  if (groups.length === 1) {
    const g = groups[0];
    if (g._type === "room") {
      this.tr.enabledAnchors(["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"]);
      this.tr.resizeEnabled(true); this.tr.rotateEnabled(true);
    } else {
      this.tr.enabledAnchors([]); this.tr.resizeEnabled(false); this.tr.rotateEnabled(true);
    }
    selection = { view: this, group: g, model: g._model, type: g._type };
  } else {
    // 다중 선택: 이동 전용 (크기·회전 핸들 비활성, 함께 드래그)
    this.tr.enabledAnchors([]); this.tr.resizeEnabled(false); this.tr.rotateEnabled(false);
    selection = { view: this, multi: true, groups: groups.slice() };
  }
  this.tr.nodes(groups);
  this.layer.batchDraw();
  renderInspector();
};
StageView.prototype.deselect = function () {
  this.selectedGroups = [];
  this._dragStart = null;
  if (this.tr) { this.tr.nodes([]); this.layer.batchDraw(); }
  if (selection.view === this) selection = { view: null };
};

/* ---------- 충돌/경고 갱신 ---------- */
StageView.prototype.refreshCollisions = function () {
  const w = computeWarnings(this.data);
  this._warn = w;
  this.layer.getChildren(function (n) { return n._type === "furniture"; }).forEach(function (g) {
    const id = g._model.id, rect = g._rect, col = g._model.color || "#888";
    if (w.collide.has(id)) { rect.stroke("#ff5a72"); rect.strokeWidth(3); rect.dash([6, 4]); rect.fill(hexA("#ff5a72", 0.42)); }
    else if (w.outRoom.has(id)) { rect.stroke("#ffb13b"); rect.strokeWidth(2.5); rect.dash([5, 4]); rect.fill(hexA("#ffb13b", 0.42)); }
    else { rect.stroke(col); rect.strokeWidth(1.5); rect.dash([]); rect.fill(hexA(col, 0.55)); }
  });
  this.layer.batchDraw();
  this.updateWarnBadge();
};
StageView.prototype.updateWarnBadge = function () {
  if (!this.isMain || !this.planId) return;
  const el = document.querySelector('.plan-meta[data-plan="' + this.planId + '"]');
  if (!el) return;
  const w = this._warn || { collide: new Set(), outRoom: new Set() };
  const c = w.collide.size, o = w.outRoom.size;
  el.className = "plan-meta";
  if (c || o) {
    el.classList.add(c ? "collide" : "warn");
    el.textContent = "⚠ " + (c ? "충돌 " + c + "개" : "") + (c && o ? " · " : "") + (o ? "방 이탈 " + o + "개" : "");
  } else {
    el.classList.add("ok");
    el.textContent = (this.data.furniture && this.data.furniture.length) ? "✓ 충돌 없음" : "";
  }
};

/* ---------- 축척 보정 ---------- */
StageView.prototype.startCalibration = function () {
  if (!this.data.bg || !this.data.bg.src) { toast("먼저 배경 사진을 업로드해 주세요."); return; }
  this.calibrating = true; this._calibPts = [];
  this.stage.container().style.cursor = "crosshair";
  toast("축척 보정: 도면에서 길이를 아는 두 점을 차례로 클릭해 주세요.");
};
StageView.prototype.handleCalibClick = function () {
  const p = this.stage.getPointerPosition();
  if (!p || !this.bgNode) return;
  const local = this.bgNode.getAbsoluteTransform().copy().invert().point(p); // 이미지 원본 px
  this._calibPts.push(local);
  if (this._calibPts.length === 1) {
    toast("두 번째 점을 클릭해 주세요.");
  } else if (this._calibPts.length >= 2) {
    const a = this._calibPts[0], b = this._calibPts[1];
    const nativeDist = Math.hypot(b.x - a.x, b.y - a.y);
    this.finishCalibration(nativeDist);
  }
};
StageView.prototype.updateCalibGuide = function () {
  if (this._calibPts.length !== 1 || !this.bgNode) return;
  const p = this.stage.getPointerPosition();
  if (this._guide) this._guide.destroy();
  const a = this.bgNode.getAbsoluteTransform().point(this._calibPts[0]);
  this._guide = new Konva.Line({ points: [a.x, a.y, p.x, p.y], stroke: "#ffd24b", strokeWidth: 2, dash: [6, 4], listening: false });
  this.layer.add(this._guide); this.layer.draw();
};
StageView.prototype.finishCalibration = function (nativeDist) {
  this.calibrating = false;
  if (this._guide) { this._guide.destroy(); this._guide = null; }
  this.stage.container().style.cursor = "default";
  if (nativeDist < 2) { toast("두 점이 너무 가깝습니다. 다시 시도해 주세요."); return; }
  const ans = window.prompt("두 점 사이의 실제 길이를 입력해 주세요 (단위: " + state.unit + ")", "1000");
  if (ans == null) return;
  const realMM = parseFloat(ans) * UNIT_MM[state.unit];
  if (!(realMM > 0)) { toast("올바른 숫자를 입력해 주세요."); return; }
  this.data.bg.mmPerNativePx = realMM / nativeDist;
  this.persist();
  this.render();
  toast("축척이 보정되었습니다. 이제 도면 위에 방을 그대로 따라 그릴 수 있습니다.");
};

/* ============================================================
   전역 선택 / 속성 패널(Inspector)
   ============================================================ */
let selection = { view: null };

function clearInspector() {
  selection = { view: null };
  document.getElementById("inspectorBody").innerHTML =
    '<p class="hint">도형을 선택하면 여기에서 이름·치수·회전·색상을 편집할 수 있습니다.</p>';
}

function renderMultiInspector() {
  const groups = selection.groups, view = selection.view;
  const nRoom = groups.filter(function (g) { return g._type === "room"; }).length;
  const nFurn = groups.length - nRoom;
  let html = '<span class="sel-tag">다중 선택 · ' + groups.length + "개</span>";
  html += '<p class="hint" style="margin:4px 0 12px">방 ' + nRoom + "개 · 가구 " + nFurn + "개가 함께 선택되었습니다. 아무 도형이나 <b>드래그하면 함께 이동</b>합니다. (Shift+클릭으로 선택을 추가·해제)</p>";
  html += '<div class="prop-row two">' +
    '<div><button class="btn full" id="ins_clearsel">선택 해제</button></div>' +
    '<div><button class="btn danger full" id="ins_delmulti">선택 삭제</button></div></div>';
  const body = document.getElementById("inspectorBody");
  body.innerHTML = html;
  body.querySelector("#ins_clearsel").addEventListener("click", function () { view.deselect(); clearInspector(); });
  body.querySelector("#ins_delmulti").addEventListener("click", function () { deleteSelected(); });
}

function renderInspector() {
  if (!selection.view) { clearInspector(); return; }
  if (selection.multi) { renderMultiInspector(); return; }
  const m = selection.model, type = selection.type, view = selection.view;
  const u = state.unit;
  const wVal = (m.wmm / UNIT_MM[u]);
  const hVal = ((type === "room" ? m.hmm : m.dmm) / UNIT_MM[u]);
  const step = u === "mm" ? 10 : (u === "cm" ? 1 : 0.1);

  let html = "";
  html += '<span class="sel-tag">' + (type === "room" ? "방" : "가구") + "</span>";
  html += '<div class="prop-row"><label>이름</label><input id="ins_name" type="text" value="' + escapeHtml(m.name) + '"></div>';
  html += '<div class="prop-row two">' +
    '<div><label>' + (type === "room" ? "가로" : "가로(폭)") + " (" + u + ')</label><input id="ins_w" type="number" step="' + step + '" value="' + round2(wVal) + '"></div>' +
    '<div><label>' + (type === "room" ? "세로" : "세로(깊이)") + " (" + u + ')</label><input id="ins_h" type="number" step="' + step + '" value="' + round2(hVal) + '"></div>' +
    "</div>";
  if (type === "furniture")
    html += '<div class="prop-row"><label>높이 (' + u + ') — 3D 보기에서 사용</label><input id="ins_ht" type="number" step="' + step + '" value="' + round2(furnH(m) / UNIT_MM[u]) + '"></div>';
  html += '<div class="prop-row"><label>회전: <span class="rot-readout" id="ins_rotread">' + Math.round(m.rot || 0) + '°</span></label>' +
    '<input id="ins_rot" type="range" min="0" max="360" step="1" value="' + (Math.round(m.rot || 0)) + '"></div>';
  html += '<div class="prop-row two">' +
    '<div><label>색상</label><input id="ins_color" type="color" value="' + (m.color || "#7c9cff") + '"></div>' +
    '<div><label>빠른 회전</label><div class="prop-row two" style="margin:0">' +
      '<button class="btn sm" id="ins_rot90" style="flex:1">+90°</button>' +
      '<button class="btn sm" id="ins_rot45" style="flex:1">+45°</button></div></div>' +
    "</div>";
  if (type === "room")
    html += '<div class="prop-row"><label>면적</label><div class="rot-readout">' + fmtArea(m.wmm, m.hmm) + "</div></div>";
  html += '<div class="prop-row"><button class="btn danger full" id="ins_del">선택 도형 삭제</button></div>';

  const body = document.getElementById("inspectorBody");
  body.innerHTML = html;

  const g = selection.group;
  const setRot = function (deg) {
    deg = ((deg % 360) + 360) % 360;
    m.rot = deg; g.rotation(deg); keepLabelUpright(g);
    view.layer.batchDraw();
    document.getElementById("ins_rotread").textContent = Math.round(deg) + "°";
    document.getElementById("ins_rot").value = Math.round(deg);
    view.persist();
  };

  body.querySelector("#ins_name").addEventListener("input", function (e) {
    m.name = e.target.value; g._label.text(labelText(m, type));
    g._label.offsetX(g._label.width() / 2); g._label.offsetY(g._label.height() / 2);
    view.layer.batchDraw(); view.persist();
    if (view.isMain) refreshAreaSummary();
  });
  const applySize = function () {
    const wv = parseFloat(document.getElementById("ins_w").value);
    const hv = parseFloat(document.getElementById("ins_h").value);
    if (wv > 0) m.wmm = wv * UNIT_MM[u];
    if (hv > 0) { if (type === "room") m.hmm = hv * UNIT_MM[u]; else m.dmm = hv * UNIT_MM[u]; }
    view.render(m.id); view.persist();
  };
  body.querySelector("#ins_w").addEventListener("change", applySize);
  body.querySelector("#ins_h").addEventListener("change", applySize);
  const htInp = body.querySelector("#ins_ht");
  if (htInp) htInp.addEventListener("change", function () {
    const hv = parseFloat(htInp.value);
    if (hv > 0) { m.hmm = hv * UNIT_MM[u]; view.persist(); }
  });
  body.querySelector("#ins_rot").addEventListener("input", function (e) { setRot(parseFloat(e.target.value)); });
  body.querySelector("#ins_rot90").addEventListener("click", function () { setRot((m.rot || 0) + 90); });
  body.querySelector("#ins_rot45").addEventListener("click", function () { setRot((m.rot || 0) + 45); });
  body.querySelector("#ins_color").addEventListener("input", function (e) {
    m.color = e.target.value;
    g._rect.stroke(e.target.value);
    g._rect.fill(hexA(e.target.value, type === "room" ? 0.16 : 0.55));
    view.layer.batchDraw(); view.persist();
  });
  body.querySelector("#ins_del").addEventListener("click", function () { deleteSelected(); });
}

function deleteSelected() {
  if (!selection.view) return;
  const view = selection.view;
  const models = selection.multi ? selection.groups.map(function (g) { return g._model; }) : [selection.model];
  const ids = {};
  models.forEach(function (m) { ids[m.id] = true; });
  view.data.rooms = view.data.rooms.filter(function (r) { return !ids[r.id]; });
  view.data.furniture = view.data.furniture.filter(function (f) { return !ids[f.id]; });
  view.deselect(); clearInspector(); view.render(); view.persist();
}

/* ============================================================
   가구 라이브러리 UI
   ============================================================ */
let editingLibId = null;

function renderFurnitureLib() {
  const list = document.getElementById("furnitureList");
  list.innerHTML = "";
  if (!state.furnitureLib.length) {
    list.innerHTML = '<p class="hint">등록된 가구가 없습니다.</p>';
  }
  state.furnitureLib.forEach(function (f) {
    const item = document.createElement("div");
    item.className = "furn-item";
    item.innerHTML =
      '<span class="swatch" style="background:' + f.color + '"></span>' +
      '<span class="fmeta"><span class="nm">' + escapeHtml(f.name) + '</span><br>' +
      '<span class="dim">' + fmtLen(f.wmm) + " × " + fmtLen(f.dmm) + " · 높이 " + fmtLen(furnH(f)) + "</span></span>" +
      '<span class="fbtns">' +
        '<button data-act="A" title="A 도면에 추가">→A</button>' +
        '<button data-act="B" title="B 도면에 추가">→B</button>' +
        '<button data-act="edit" title="수정">✎</button>' +
        '<button data-act="del" class="del" title="삭제">✕</button>' +
      "</span>";
    item.querySelector('[data-act="A"]').addEventListener("click", function () { addFurnitureToPlan(f.id, "A"); });
    item.querySelector('[data-act="B"]').addEventListener("click", function () { addFurnitureToPlan(f.id, "B"); });
    item.querySelector('[data-act="edit"]').addEventListener("click", function () { loadFurnitureToForm(f); });
    item.querySelector('[data-act="del"]').addEventListener("click", function () {
      state.furnitureLib = state.furnitureLib.filter(function (x) { return x.id !== f.id; });
      renderFurnitureLib(); saveCatalog(); saveLocal();
    });
    makeFurnDraggable(item, f);
    list.appendChild(item);
  });
}

function loadFurnitureToForm(f) {
  editingLibId = f.id;
  document.getElementById("fName").value = f.name;
  document.getElementById("fW").value = round2(f.wmm / UNIT_MM[state.unit]);
  document.getElementById("fD").value = round2(f.dmm / UNIT_MM[state.unit]);
  document.getElementById("fH").value = round2(furnH(f) / UNIT_MM[state.unit]);
  document.getElementById("fColor").value = f.color;
  document.getElementById("btnAddFurniture").textContent = "✓ 가구 수정";
}

function submitFurnitureForm() {
  const name = document.getElementById("fName").value.trim() || "가구";
  const w = parseFloat(document.getElementById("fW").value);
  const d = parseFloat(document.getElementById("fD").value);
  const h = parseFloat(document.getElementById("fH").value);
  const color = document.getElementById("fColor").value;
  if (!(w > 0) || !(d > 0)) { toast("가로·세로 치수를 입력해 주세요."); return; }
  const wmm = w * UNIT_MM[state.unit], dmm = d * UNIT_MM[state.unit];
  const hmm = (h > 0) ? h * UNIT_MM[state.unit] : guessHeightMM(name);
  if (editingLibId) {
    const f = state.furnitureLib.find(function (x) { return x.id === editingLibId; });
    if (f) { f.name = name; f.wmm = wmm; f.dmm = dmm; f.hmm = hmm; f.color = color; }
    editingLibId = null;
    document.getElementById("btnAddFurniture").textContent = "+ 가구 등록";
  } else {
    state.furnitureLib.push({ id: uid(), name: name, wmm: wmm, dmm: dmm, hmm: hmm, color: color });
  }
  document.getElementById("fName").value = "";
  document.getElementById("fW").value = "";
  document.getElementById("fD").value = "";
  document.getElementById("fH").value = "";
  renderFurnitureLib(); saveCatalog(); saveLocal();
}

function addFurnitureToPlan(libId, planId) {
  const f = state.furnitureLib.find(function (x) { return x.id === libId; });
  if (!f) return;
  const view = views[planId];
  const c = view.centerWorld();
  const inst = { id: uid(), libId: libId, name: f.name, color: f.color, wmm: f.wmm, dmm: f.dmm, hmm: furnH(f), xm: c.xm, ym: c.ym, rot: 0 };
  state.plans[planId].furniture.push(inst);
  view.render(inst.id);
  saveLocal();
  toast(f.name + " 을(를) " + planId + " 도면에 추가했습니다.");
}

/* ---------- 드래그 앤 드롭 배치 ---------- */
let dragFurn = null;
function makeFurnInstance(f) {
  return { id: uid(), libId: f.id, name: f.name, color: f.color, wmm: f.wmm, dmm: f.dmm, hmm: furnH(f), xm: 0, ym: 0, rot: 0 };
}
function placeOnView(view, f, clientX, clientY) {
  const w = view.screenToWorld(clientX, clientY);
  const inst = makeFurnInstance(f); inst.xm = w.xm; inst.ym = w.ym;
  view.data.furniture.push(inst);
  view.render(inst.id);
  if (view.isMain) saveLocal();
  return inst;
}
function makeFurnDraggable(el, f) {
  el.setAttribute("draggable", "true");
  el.addEventListener("dragstart", function (e) {
    dragFurn = f;
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", f.name); }
  });
  el.addEventListener("dragend", function () { dragFurn = null; });
}
function setupDropTarget(containerId, getView) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.addEventListener("dragover", function (e) {
    if (dragFurn && getView()) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; el.classList.add("drop-hover"); }
  });
  el.addEventListener("dragleave", function () { el.classList.remove("drop-hover"); });
  el.addEventListener("drop", function (e) {
    el.classList.remove("drop-hover");
    const v = getView();
    if (dragFurn && v) { e.preventDefault(); placeOnView(v, dragFurn, e.clientX, e.clientY); toast(dragFurn.name + " 을(를) 배치했습니다."); }
    dragFurn = null;
  });
}

/* ============================================================
   도면 툴바
   ============================================================ */
function addRoom(planId) {
  const name = window.prompt("방 이름을 입력해 주세요.", "방");
  if (name == null) return;
  const u = state.unit;
  const ws = window.prompt("가로 길이 (" + u + ")", u === "mm" ? "3000" : (u === "cm" ? "300" : "3"));
  if (ws == null) return;
  const hs = window.prompt("세로 길이 (" + u + ")", u === "mm" ? "3000" : (u === "cm" ? "300" : "3"));
  if (hs == null) return;
  const wmm = parseFloat(ws) * UNIT_MM[u], hmm = parseFloat(hs) * UNIT_MM[u];
  if (!(wmm > 0) || !(hmm > 0)) { toast("올바른 치수를 입력해 주세요."); return; }
  const view = views[planId];
  const c = view.centerWorld();
  const n = state.plans[planId].rooms.length;
  const room = {
    id: uid(), name: name || "방", wmm: wmm, hmm: hmm,
    xm: c.xm + (n % 3) * 0.4, ym: c.ym + Math.floor(n / 3) * 0.4,
    rot: 0, color: roomColor(n)
  };
  state.plans[planId].rooms.push(room);
  view.render(room.id);
  saveLocal();
}
function roomColor(n) {
  const palette = ["#5b7cff", "#36c08a", "#e0a14b", "#c07be0", "#e0556b", "#4bc0d9", "#d9c84b"];
  return palette[n % palette.length];
}

function zoomPlan(planId, factor) {
  const view = views[planId];
  view._ppm = clamp(view._ppm * factor, 8, 400);
  state.plans[planId].ppm = view._ppm;
  view.render();
  saveLocal();
}
// 이 도면의 축척(배율)을 반대쪽 도면과 동일하게 맞춤 (보고 있는 중심은 유지)
function matchScale(planId) {
  const other = planId === "A" ? "B" : "A";
  const view = views[planId], target = views[other]._ppm;
  if (Math.abs(view._ppm - target) < 1e-6) { toast("이미 두 도면의 축척이 같습니다."); return; }
  const c = view.centerWorld();                 // 변경 전 화면 중심의 월드 좌표
  view._ppm = target;
  state.plans[planId].ppm = target;
  view.stage.x(view.stage.width() / 2 - c.xm * target);   // 같은 지점이 중심에 오도록 패닝 보정
  view.stage.y(view.stage.height() / 2 - c.ym * target);
  view.render();
  saveLocal();
  const side = planId === "A" ? "왼쪽" : "오른쪽", oside = other === "A" ? "왼쪽" : "오른쪽";
  toast(side + " 도면 축척을 " + oside + " 도면에 맞췄습니다. (1m = " + Math.round(target) + "px)");
}

// 두 도면의 내용(배경·방·가구·배율·격자)을 맞바꿈. 패널 이름/위치는 그대로 유지.
function swapPlans(force) {
  if (!force && !window.confirm("현재 집(A)과 이사갈 집(B)의 내용(배경·방·가구)을 맞바꿀까요?\n(패널 이름은 그대로 두고 내용만 교환합니다. 다시 누르면 원복됩니다.)")) return;
  const A = state.plans.A, B = state.plans.B;
  ["rooms", "furniture", "bg", "ppm", "showGrid"].forEach(function (f) { const t = A[f]; A[f] = B[f]; B[f] = t; });
  ["A", "B"].forEach(function (pid) {
    const v = views[pid], p = state.plans[pid];
    v._ppm = p.ppm || DEFAULT_PPM;
    v.gridOn = p.showGrid !== false;
    v.deselect();
    v.stage.position({ x: 0, y: 0 });   // 패닝 초기화
    const bg = p.bg;
    document.querySelector('.bg-controls[data-plan="' + pid + '"]').hidden = !(bg && bg.src);
    const op = document.querySelector('.bgOpacity[data-plan="' + pid + '"]');
    if (op) op.value = (bg && bg.opacity != null) ? bg.opacity : 55;
  });
  clearInspector();
  views.A.render(); views.B.render();
  saveLocal();
  toast("현재 집(A)과 이사갈 집(B)의 내용을 맞바꿨습니다.");
}
function toggleGrid(planId) {
  const view = views[planId];
  view.gridOn = !view.gridOn;
  state.plans[planId].showGrid = view.gridOn;
  view.render(); saveLocal();
}

function handleBgUpload(planId, file) {
  const reader = new FileReader();
  reader.onload = function (e) {
    state.plans[planId].bg = { src: e.target.result, x: 0, y: 0, opacity: 55, scale: null, mmPerNativePx: null };
    views[planId].render();
    document.querySelector('.bg-controls[data-plan="' + planId + '"]').hidden = false;
    saveLocal();
    toast("배경을 불러왔습니다. '축척보정'으로 실제 치수를 맞춰 주세요.");
  };
  reader.readAsDataURL(file);
}
function removeBg(planId) {
  state.plans[planId].bg = null;
  views[planId].render();
  document.querySelector('.bg-controls[data-plan="' + planId + '"]').hidden = true;
  saveLocal();
}

/* ============================================================
   면적 요약
   ============================================================ */
function refreshAreaSummary() {
  const box = document.getElementById("areaSummary");
  let html = "";
  ["A", "B"].forEach(function (pid) {
    const p = state.plans[pid];
    let total = 0;
    html += '<div style="margin-bottom:10px"><div style="font-weight:700;font-size:12.5px;margin-bottom:4px">' + escapeHtml(p.name) + "</div>";
    if (!p.rooms.length) html += '<div class="hint" style="margin:0">방이 없습니다.</div>';
    p.rooms.forEach(function (r) {
      const a = areaM2(r.wmm, r.hmm); total += a;
      html += '<div class="area-line"><span class="nm">' + escapeHtml(r.name) + " · " + fmtLen(r.wmm) + "×" + fmtLen(r.hmm) +
        '</span><span class="val">' + a.toFixed(2) + "㎡</span></div>";
    });
    html += '<div class="area-total"><span>합계</span><span>' + total.toFixed(2) + "㎡ / " + (total / PYEONG).toFixed(2) + "평</span></div></div>";
  });
  box.innerHTML = html;
}

/* ============================================================
   방 비교 모드 / 모달
   ============================================================ */
let compareMode = false;
let comparePicks = [];
let cmpViews = {};

function toggleCompareMode() {
  compareMode = !compareMode;
  comparePicks = [];
  document.body.classList.toggle("compare-mode", compareMode);
  const btn = document.getElementById("btnCompare");
  btn.classList.toggle("active", compareMode);
  removeBanner();
  if (compareMode) showBanner("비교할 방을 2개 클릭해 주세요 (각 도면에서 1개씩 권장).");
}
function handleComparePick(view, room) {
  comparePicks.push({ planId: view.planId, roomId: room.id, name: room.name });
  flashRoom(view, room.id);
  if (comparePicks.length === 1) {
    showBanner("1개 선택됨 — 비교할 두 번째 방을 클릭해 주세요.");
  } else {
    const picks = comparePicks.slice(0, 2);
    compareMode = false;
    document.body.classList.remove("compare-mode");
    document.getElementById("btnCompare").classList.remove("active");
    removeBanner();
    openCompareModal(picks[0], picks[1]);
    comparePicks = [];
  }
}
function flashRoom(view, roomId) {
  const g = view.findGroupById(roomId);
  if (!g) return;
  const old = g._rect.shadowBlur();
  g._rect.shadowColor("#5b7cff"); g._rect.shadowBlur(24);
  view.layer.draw();
  setTimeout(function () { g._rect.shadowBlur(old); view.layer.draw(); }, 600);
}

function findRoom(pick) {
  return state.plans[pick.planId].rooms.find(function (r) { return r.id === pick.roomId; });
}

function openCompareModal(pickA, pickB) {
  const roomA = findRoom(pickA), roomB = findRoom(pickB);
  if (!roomA || !roomB) { toast("방을 찾을 수 없습니다."); return; }
  cmpOverlay = false;
  document.getElementById("cmpOverlayToggle").textContent = "겹쳐보기: 끔";

  const modal = document.getElementById("compareModal");
  modal.hidden = false;

  document.getElementById("cmpTitleA").textContent = state.plans[pickA.planId].name + " · " + roomA.name + "  (" + fmtLen(roomA.wmm) + "×" + fmtLen(roomA.hmm) + ", " + areaM2(roomA.wmm, roomA.hmm).toFixed(2) + "㎡)";
  document.getElementById("cmpTitleB").textContent = state.plans[pickB.planId].name + " · " + roomB.name + "  (" + fmtLen(roomB.wmm) + "×" + fmtLen(roomB.hmm) + ", " + areaM2(roomB.wmm, roomB.hmm).toFixed(2) + "㎡)";

  renderCompareMetrics(roomA, roomB);
  renderCmpTray();

  // 두 방을 같은 축척으로: 더 큰 방 기준으로 화면에 맞춤
  requestAnimationFrame(function () {
    const elA = document.getElementById("cmpStageA");
    const maxMM = Math.max(roomA.wmm, roomA.hmm, roomB.wmm, roomB.hmm);
    const fitPx = Math.min(elA.clientWidth, elA.clientHeight) * 0.78;
    const ppm = clamp((fitPx / (maxMM / 1000)), 8, 400);

    cmpViews.A = makeCmpView("cmpStageA", roomA, roomB, ppm);
    cmpViews.B = makeCmpView("cmpStageB", roomB, roomA, ppm);
    cmpViews.A.render();
    cmpViews.B.render();
  });
}

function makeCmpView(containerId, room, otherRoom, ppm) {
  const data = { rooms: [], furniture: [], bg: null };
  const view = new StageView({ containerId: containerId, data: data, planId: null, isMain: false, roomsLocked: true, ppm: ppm, gridOn: true });
  view._ppm = ppm;
  view.stage.draggable(false); // 비교창은 패닝 비활성(정렬 유지)
  const c = view.centerWorld();
  const roomCopy = { id: uid(), name: room.name, wmm: room.wmm, hmm: room.hmm, xm: c.xm, ym: c.ym, rot: 0, color: room.color };
  data.rooms.push(roomCopy);
  view.ghostRoom = otherRoom;
  return view;
}

function renderCompareMetrics(a, b) {
  const box = document.getElementById("cmpMetrics");
  const aArea = areaM2(a.wmm, a.hmm), bArea = areaM2(b.wmm, b.hmm);
  const dA = bArea - aArea;
  const dW = (b.wmm - a.wmm), dH = (b.hmm - a.hmm);
  const sign = function (v) { return v > 0 ? "+" : ""; };
  const cls = function (v) { return v >= 0 ? "pos" : "neg"; };
  box.innerHTML =
    card("왼쪽 방", fmtLen(a.wmm) + " × " + fmtLen(a.hmm), aArea.toFixed(2) + "㎡ / " + (aArea / PYEONG).toFixed(2) + "평") +
    card("오른쪽 방", fmtLen(b.wmm) + " × " + fmtLen(b.hmm), bArea.toFixed(2) + "㎡ / " + (bArea / PYEONG).toFixed(2) + "평") +
    cardDiff("면적 차이 (오른쪽-왼쪽)", sign(dA) + dA.toFixed(2) + "㎡ (" + sign(dA) + (dA / PYEONG).toFixed(2) + "평)", cls(dA)) +
    cardDiff("가로 / 세로 차이", sign(dW) + fmtLen(Math.abs(dW)).replace(/^/, dW < 0 ? "-" : "") + " / " + (sign(dH)) + (dH < 0 ? "-" : "") + fmtLen(Math.abs(dH)), cls(Math.min(dW, dH)));
}
function card(t, big, sub) {
  return '<div class="metric-card"><div class="mt">' + t + '</div><div class="mv">' + big + '</div><div class="mt">' + sub + "</div></div>";
}
function cardDiff(t, big, cls) {
  return '<div class="metric-card diff"><div class="mt">' + t + '</div><div class="mv ' + cls + '">' + big + "</div></div>";
}

function renderCmpTray() {
  const tray = document.getElementById("cmpFurnTray");
  tray.innerHTML = "";
  if (!state.furnitureLib.length) { tray.innerHTML = '<p class="hint">등록된 가구가 없습니다.</p>'; return; }
  state.furnitureLib.forEach(function (f) {
    const item = document.createElement("div");
    item.className = "furn-item";
    item.innerHTML =
      '<span class="swatch" style="background:' + f.color + '"></span>' +
      '<span class="fmeta"><span class="nm">' + escapeHtml(f.name) + '</span><br><span class="dim">' + fmtLen(f.wmm) + "×" + fmtLen(f.dmm) + "</span></span>" +
      '<span class="fbtns"><button data-s="A">◀넣기</button><button data-s="B">넣기▶</button></span>';
    item.querySelector('[data-s="A"]').addEventListener("click", function () { addFurnToCmp(f, "A"); });
    item.querySelector('[data-s="B"]').addEventListener("click", function () { addFurnToCmp(f, "B"); });
    makeFurnDraggable(item, f);
    tray.appendChild(item);
  });
}
function addFurnToCmp(f, side) {
  const view = cmpViews[side];
  if (!view) return;
  const c = view.centerWorld();
  const inst = { id: uid(), name: f.name, color: f.color, wmm: f.wmm, dmm: f.dmm, hmm: furnH(f), xm: c.xm, ym: c.ym, rot: 0 };
  view.data.furniture.push(inst);
  view.render(inst.id);
}

function closeCompareModal() {
  document.getElementById("compareModal").hidden = true;
  if (selection.view === cmpViews.A || selection.view === cmpViews.B) clearInspector();
  ["A", "B"].forEach(function (s) {
    if (cmpViews[s]) {
      const idx = allViews.indexOf(cmpViews[s]);
      if (idx >= 0) allViews.splice(idx, 1);
      cmpViews[s].stage.destroy();
      cmpViews[s] = null;
    }
  });
}
function toggleCmpOverlay() {
  cmpOverlay = !cmpOverlay;
  document.getElementById("cmpOverlayToggle").textContent = "겹쳐보기: " + (cmpOverlay ? "켬" : "끔");
  if (cmpViews.A) cmpViews.A.render();
  if (cmpViews.B) cmpViews.B.render();
}

/* ---------- 비교 모드 배너 ---------- */
function showBanner(text) {
  removeBanner();
  const b = document.createElement("div");
  b.className = "compare-banner"; b.id = "compareBanner"; b.textContent = text;
  document.body.appendChild(b);
}
function removeBanner() { const b = document.getElementById("compareBanner"); if (b) b.remove(); }

/* ============================================================
   저장 / 불러오기 / 내보내기
   ============================================================ */
const LS_KEY = "apt_pjt_state_v1";
let saveTimer = null;

function serialize() {
  return JSON.stringify(state, function (k, v) { return k.charAt(0) === "_" ? undefined : v; });
}
function saveLocal() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try { localStorage.setItem(LS_KEY, serialize()); } catch (e) {}
  }, 250);
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (obj && obj.plans) { state = obj; return true; }
  } catch (e) {}
  return false;
}

function exportJSON() {
  const name = "아파트도면_" + dateStamp() + ".json";
  if (window.AndroidBridge) {
    downloadDataUrl("data:application/json;base64," + b64EncodeUtf8(serialize()), name);
    return;
  }
  const blob = new Blob([serialize()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
function importJSON(file) {
  // 이미지를 잘못 넣은 경우 안내
  if ((file.type && file.type.indexOf("image/") === 0) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)) {
    alert('"JSON 열기"는 저장해 둔 프로젝트(.json) 복원용입니다.\n평면도 사진(이미지)을 올리시려면 도면 툴바의 "📷 도면사진" 버튼을 사용해 주세요.');
    return;
  }
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const obj = JSON.parse(e.target.result);
      if (!obj.plans) throw new Error("형식 오류");
      state = obj;
      state.furnitureLib = mergeIntoCatalog(state.furnitureLib || []); // 불러온 가구도 카탈로그에 보존
      applyLoadedState();
      toast("불러오기를 완료했습니다.");
    } catch (err) { toast('JSON 파일이 아닙니다. 사진은 "📷 도면사진" 버튼으로 올려 주세요. (' + err.message + ")"); }
  };
  reader.readAsText(file);
}
function dateStamp() {
  const d = new Date();
  const p = function (n) { return ("0" + n).slice(-2); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
}

function applyLoadedState() {
  document.getElementById("unitSelect").value = state.unit || "mm";
  document.getElementById("fUnitLbl").textContent = state.unit || "mm";
  ["A", "B"].forEach(function (pid) {
    const v = views[pid];
    v.data = state.plans[pid];
    v._ppm = state.plans[pid].ppm || DEFAULT_PPM;
    v.gridOn = state.plans[pid].showGrid !== false;
    document.querySelector('.plan-name[data-plan="' + pid + '"]').value = state.plans[pid].name || "";
    document.querySelector('.bg-controls[data-plan="' + pid + '"]').hidden = !(state.plans[pid].bg && state.plans[pid].bg.src);
    v.render();
  });
  renderFurnitureLib();
  refreshAreaSummary();
}

/* ============================================================
   토스트 / 기타 유틸
   ============================================================ */
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function round2(v) { return Math.round(v * 100) / 100; }
function nowStr() {
  const d = new Date(), p = function (n) { return ("0" + n).slice(-2); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function downloadDataUrl(url, name) {
  // 안드로이드 앱(WebView)에서는 네이티브 브리지로 '다운로드' 폴더에 저장
  if (window.AndroidBridge && url.indexOf("data:") === 0) {
    window.AndroidBridge.saveBase64DataUrl(url, name);
    return;
  }
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
function b64EncodeUtf8(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

/* ============================================================
   배치도 내보내기 (PNG / PDF) — 모델을 직접 캔버스에 렌더(줌/팬 영향 없음)
   ============================================================ */
function planBoundsMM(data) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  const acc = function (pts) { pts.forEach(function (p) { any = true; if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }); };
  (data.rooms || []).forEach(function (r) { acc(getCornersMM(r, "room")); });
  (data.furniture || []).forEach(function (f) { acc(getCornersMM(f, "furniture")); });
  if (!any) return null;
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
}
function labelLines(item, type) {
  if (type === "room") return [item.name, fmtLen(item.wmm) + " × " + fmtLen(item.hmm), areaM2(item.wmm, item.hmm).toFixed(2) + "㎡"];
  return [item.name, fmtLen(item.wmm) + "×" + fmtLen(item.dmm)];
}
function drawRectShape(ctx, item, type, P, scale) {
  const d = shapeDims(item, type), c = P(item.xm * 1000, item.ym * 1000);
  const wpx = d.w * scale, hpx = d.h * scale;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate((item.rot || 0) * Math.PI / 180);
  ctx.fillStyle = hexA(item.color, type === "room" ? 0.18 : 0.6);
  ctx.strokeStyle = item.color || "#888";
  ctx.lineWidth = type === "room" ? 2 : 1.5;
  ctx.fillRect(-wpx / 2, -hpx / 2, wpx, hpx);
  ctx.strokeRect(-wpx / 2, -hpx / 2, wpx, hpx);
  if (type === "furniture") {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -hpx * 0.42);
    ctx.strokeStyle = "rgba(0,0,0,.5)"; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = type === "room" ? "#dfe6ff" : "#0c0f1c";
  ctx.font = (type === "room" ? "600 13px" : "600 11px") + ' "Malgun Gothic", sans-serif';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const lines = labelLines(item, type), lh = type === "room" ? 15 : 13;
  lines.forEach(function (ln, i) { ctx.fillText(ln, c.x, c.y + (i - (lines.length - 1) / 2) * lh); });
}
function drawPlanToCtx(ctx, data, box) {
  ctx.save();
  ctx.fillStyle = "#11152a"; ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = "#2a3050"; ctx.lineWidth = 1; ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
  ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  const b = planBoundsMM(data);
  if (!b) {
    ctx.fillStyle = "#9aa3c4"; ctx.font = '14px "Malgun Gothic", sans-serif'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("배치된 방·가구가 없습니다", box.x + box.w / 2, box.y + box.h / 2);
    ctx.restore(); return;
  }
  const pad = 26;
  const scale = Math.min((box.w - 2 * pad) / (b.w || 1), (box.h - 2 * pad) / (b.h || 1));
  const offX = box.x + (box.w - b.w * scale) / 2 - b.minX * scale;
  const offY = box.y + (box.h - b.h * scale) / 2 - b.minY * scale;
  const P = function (xmm, ymm) { return { x: offX + xmm * scale, y: offY + ymm * scale }; };
  (data.rooms || []).forEach(function (r) { drawRectShape(ctx, r, "room", P, scale); });
  (data.furniture || []).forEach(function (f) { drawRectShape(ctx, f, "furniture", P, scale); });
  ctx.restore();
}
function drawSummaryLine(ctx, x, y, pid) {
  const p = state.plans[pid]; let total = 0;
  (p.rooms || []).forEach(function (r) { total += areaM2(r.wmm, r.hmm); });
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#c9d2f0"; ctx.font = '600 13px "Malgun Gothic", sans-serif';
  ctx.fillText("합계 " + total.toFixed(2) + "㎡ / " + (total / PYEONG).toFixed(2) + "평  ·  방 " + (p.rooms || []).length + "개  ·  가구 " + (p.furniture || []).length + "개", x, y);
  const w = computeWarnings(p);
  if (w.collide.size || w.outRoom.size) {
    ctx.fillStyle = "#ffb13b"; ctx.font = '12px "Malgun Gothic", sans-serif';
    ctx.fillText("⚠ 충돌 가구 " + w.collide.size + "개 · 방 이탈 " + w.outRoom.size + "개", x, y + 18);
  }
}
function buildExportSheet() {
  const sup = 2, W = 1600, H = 980;
  const canvas = document.createElement("canvas");
  canvas.width = W * sup; canvas.height = H * sup;
  const ctx = canvas.getContext("2d"); ctx.scale(sup, sup);
  ctx.fillStyle = "#0f1220"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#e8ebf5"; ctx.font = '700 24px "Malgun Gothic", sans-serif'; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText("아파트 평면도 비교 · 가구 배치도", 40, 46);
  ctx.fillStyle = "#9aa3c4"; ctx.font = '13px "Malgun Gothic", sans-serif';
  ctx.fillText("생성일 " + nowStr() + "   ·   단위 " + state.unit, 40, 68);
  const top = 96, gap = 30, boxW = (W - 80 - gap) / 2, boxH = H - top - 120;
  ctx.fillStyle = "#e8ebf5"; ctx.font = '700 16px "Malgun Gothic", sans-serif';
  ctx.fillText(state.plans.A.name, 40, top - 8);
  ctx.fillText(state.plans.B.name, 40 + boxW + gap, top - 8);
  drawPlanToCtx(ctx, state.plans.A, { x: 40, y: top, w: boxW, h: boxH });
  drawPlanToCtx(ctx, state.plans.B, { x: 40 + boxW + gap, y: top, w: boxW, h: boxH });
  drawSummaryLine(ctx, 40, top + boxH + 28, "A");
  drawSummaryLine(ctx, 40 + boxW + gap, top + boxH + 28, "B");
  return canvas;
}
function exportPNG() {
  try {
    const canvas = buildExportSheet();
    downloadDataUrl(canvas.toDataURL("image/png"), "배치도_" + dateStamp() + ".png");
    toast("PNG 이미지로 저장했습니다.");
  } catch (e) { toast("이미지 생성 실패: " + e.message); }
}
function exportPDF() {
  try {
    const jp = window.jspdf;
    if (!jp || !jp.jsPDF) { toast("PDF 라이브러리를 불러오지 못했습니다."); return; }
    const canvas = buildExportSheet();
    const pdf = new jp.jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const ar = canvas.width / canvas.height;
    let iw = pw - 36, ih = iw / ar;
    if (ih > ph - 36) { ih = ph - 36; iw = ih * ar; }
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", (pw - iw) / 2, (ph - ih) / 2, iw, ih);
    const pdfName = "배치도_" + dateStamp() + ".pdf";
    if (window.AndroidBridge) downloadDataUrl(pdf.output("datauristring"), pdfName);
    else pdf.save(pdfName);
    toast("PDF로 저장했습니다.");
  } catch (e) { toast("PDF 생성 실패: " + e.message); }
}

/* ============================================================
   사진 치수 자동인식 (OCR) — Tesseract.js
   ============================================================ */
let ocrState = { planId: null, picks: [], numbers: [], pairs: [] };

function loadTesseract() {
  return new Promise(function (res, rej) {
    if (window.Tesseract) return res();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    s.onload = function () { res(); };
    s.onerror = function () { rej(new Error("OCR 라이브러리 로드 실패 — 인터넷 연결이 필요합니다.")); };
    document.head.appendChild(s);
  });
}
function setOcrStatus(t) { document.getElementById("ocrStatus").textContent = t; }
function openOcrModal() { document.getElementById("ocrModal").hidden = false; }
function closeOcrModal() { document.getElementById("ocrModal").hidden = true; }

async function runOCR(planId) {
  const bg = state.plans[planId].bg;
  if (!bg || !bg.src) { toast("먼저 해당 도면에 배경 사진을 업로드해 주세요."); return; }
  if (location.protocol === "file:") {
    alert("OCR은 로컬 서버에서 동작합니다.\n\nstart.ps1 을 실행하여 http://localhost 주소로 열어 주세요.\n(브라우저 보안 정책상 file:// 에서는 OCR 워커가 차단됩니다.)");
    return;
  }
  ocrState = { planId: planId, picks: [], numbers: [], pairs: [] };
  openOcrModal();
  document.getElementById("ocrPairs").innerHTML = "";
  document.getElementById("ocrNumbers").innerHTML = "";
  document.getElementById("ocrMakeRoom").disabled = true;
  document.getElementById("ocrPick").textContent = "";
  setOcrStatus("OCR 엔진 로딩 중…");
  try { await loadTesseract(); } catch (e) { setOcrStatus(e.message); return; }
  setOcrStatus("이미지 분석 준비 중…");
  try {
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: function (m) { if (m.status === "recognizing text") setOcrStatus("인식 중 " + Math.round((m.progress || 0) * 100) + "%"); }
    });
    await worker.setParameters({ tessedit_char_whitelist: "0123456789xX×*.," });
    const out = await worker.recognize(bg.src);
    await worker.terminate();
    processOcr(out.data || {});
  } catch (e) { setOcrStatus("인식 실패: " + e.message); }
}
function processOcr(data) {
  const text = (data.text || "").replace(/[,]/g, "");
  const pairs = [], re = /(\d{2,5})\s*[x×*X]\s*(\d{2,5})/g;
  let m;
  while ((m = re.exec(text))) { pairs.push([parseInt(m[1], 10), parseInt(m[2], 10)]); }
  const rawNums = (text.match(/\d{2,5}/g) || []).map(Number).filter(function (v) { return v >= 50 && v <= 30000; });
  const uniq = Array.from(new Set(rawNums)).sort(function (a, b) { return a - b; });
  ocrState.pairs = pairs;
  ocrState.numbers = uniq;
  renderOcrResults();
  setOcrStatus("인식 완료 — 치수 후보 " + uniq.length + "개, 가로×세로 쌍 " + pairs.length + "개");
}
function renderOcrResults() {
  const pairsBox = document.getElementById("ocrPairs");
  pairsBox.innerHTML = "";
  const u = document.getElementById("ocrUnit").value;
  if (!ocrState.pairs.length) pairsBox.innerHTML = '<p class="hint" style="margin:0">인식된 "가로×세로" 패턴이 없습니다. 아래 숫자에서 직접 골라 주세요.</p>';
  ocrState.pairs.forEach(function (pr) {
    const a = areaM2(pr[0] * UNIT_MM[u], pr[1] * UNIT_MM[u]);
    const row = document.createElement("div");
    row.className = "ocr-pair";
    row.innerHTML = '<span class="pv">' + pr[0] + " × " + pr[1] + " " + u + '</span><span class="pa">' + a.toFixed(2) + "㎡</span>";
    const btn = document.createElement("button");
    btn.className = "btn sm primary"; btn.textContent = "방 생성";
    btn.addEventListener("click", function () { createRoomFromDims(pr[0], pr[1]); });
    row.appendChild(btn);
    pairsBox.appendChild(row);
  });
  const numBox = document.getElementById("ocrNumbers");
  numBox.innerHTML = "";
  ocrState.numbers.forEach(function (v) {
    const chip = document.createElement("div");
    chip.className = "ocr-chip"; chip.textContent = v;
    chip.addEventListener("click", function () { toggleOcrPick(v, chip); });
    numBox.appendChild(chip);
  });
}
function toggleOcrPick(v, chip) {
  const idx = ocrState.picks.indexOf(v);
  if (idx >= 0) { ocrState.picks.splice(idx, 1); chip.classList.remove("sel"); }
  else {
    if (ocrState.picks.length >= 2) {
      const first = ocrState.picks.shift();
      document.querySelectorAll(".ocr-chip").forEach(function (c) { if (c.textContent == first && c.classList.contains("sel")) c.classList.remove("sel"); });
    }
    ocrState.picks.push(v); chip.classList.add("sel");
  }
  const u = document.getElementById("ocrUnit").value;
  document.getElementById("ocrMakeRoom").disabled = ocrState.picks.length !== 2;
  document.getElementById("ocrPick").textContent = ocrState.picks.length
    ? "선택: 가로 " + (ocrState.picks[0] || "-") + (ocrState.picks[1] != null ? " · 세로 " + ocrState.picks[1] : "") + " " + u
    : "";
}
function createRoomFromDims(wv, hv) {
  const u = document.getElementById("ocrUnit").value;
  const wmm = wv * UNIT_MM[u], hmm = hv * UNIT_MM[u];
  if (!(wmm > 0) || !(hmm > 0)) { toast("치수를 확인해 주세요."); return; }
  const pid = ocrState.planId, view = views[pid], c = view.centerWorld();
  const n = state.plans[pid].rooms.length;
  const room = { id: uid(), name: "방", wmm: wmm, hmm: hmm, xm: c.xm + (n % 3) * 0.4, ym: c.ym + Math.floor(n / 3) * 0.4, rot: 0, color: roomColor(n) };
  state.plans[pid].rooms.push(room);
  view.render(room.id); saveLocal();
  toast(pid + " 도면에 방 생성: " + fmtLen(wmm) + " × " + fmtLen(hmm));
}

/* ============================================================
   초기화 / 이벤트 바인딩
   ============================================================ */
let views = {};

function seedDemo() {
  // A: 현재 집
  state.plans.A.rooms = [
    { id: uid(), name: "거실", wmm: 5000, hmm: 3400, xm: 3.0, ym: 1.9, rot: 0, color: roomColor(0) },
    { id: uid(), name: "안방", wmm: 3600, hmm: 3300, xm: 2.4, ym: 5.4, rot: 0, color: roomColor(1) },
    { id: uid(), name: "작은방", wmm: 2700, hmm: 2700, xm: 6.0, ym: 5.4, rot: 0, color: roomColor(2) }
  ];
  const L = state.furnitureLib;
  const mk = function (f, xm, ym, rot) { return f ? { id: uid(), libId: f.id, name: f.name, color: f.color, wmm: f.wmm, dmm: f.dmm, hmm: furnH(f), xm: xm, ym: ym, rot: rot } : null; };
  // 데모: 소파와 겹치는 식탁(충돌) · 방 밖에 둔 냉장고(방 이탈)
  state.plans.A.furniture = [
    mk(L[0], 2.4, 5.4, 90), mk(L[1], 3.0, 1.4, 0), mk(L[3], 3.4, 1.6, 0), mk(L[2], 8.0, 3.0, 0)
  ].filter(Boolean);
  // B: 이사갈 집
  state.plans.B.rooms = [
    { id: uid(), name: "거실", wmm: 4600, hmm: 3700, xm: 2.9, ym: 2.0, rot: 0, color: roomColor(0) },
    { id: uid(), name: "안방", wmm: 3300, hmm: 3200, xm: 2.3, ym: 5.6, rot: 0, color: roomColor(1) },
    { id: uid(), name: "작은방", wmm: 2500, hmm: 2900, xm: 5.8, ym: 5.6, rot: 0, color: roomColor(2) }
  ];
}

function init() {
  // 터치 기기(모바일/태블릿) 감지 → 3D 터치 조작·모바일 UI 활성화
  if ("ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0) {
    document.body.classList.add("touchdev");
  }
  // 모바일 드로어 토글 (좁은 화면에서 가구 라이브러리/속성 패널)
  const dLib = document.getElementById("btnDrawerLib");
  const dIns = document.getElementById("btnDrawerIns");
  if (dLib) dLib.addEventListener("click", function () {
    document.body.classList.toggle("drawer-lib");
    document.body.classList.remove("drawer-ins");
  });
  if (dIns) dIns.addEventListener("click", function () {
    document.body.classList.toggle("drawer-ins");
    document.body.classList.remove("drawer-lib");
  });
  // 드로어 밖(도면) 터치 시 드로어 닫기
  document.getElementById("plans").addEventListener("pointerdown", function () {
    document.body.classList.remove("drawer-lib", "drawer-ins");
  });

  const loaded = loadLocal();
  state.furnitureLib = mergeIntoCatalog(state.furnitureLib); // 영구 카탈로그와 동기화
  if (!loaded && /[?&]demo/.test(location.search)) seedDemo();

  views.A = new StageView({ containerId: "stageA", data: state.plans.A, planId: "A", isMain: true });
  views.B = new StageView({ containerId: "stageB", data: state.plans.B, planId: "B", isMain: true });

  // 단위
  const unitSel = document.getElementById("unitSelect");
  unitSel.value = state.unit;
  document.getElementById("fUnitLbl").textContent = state.unit;
  unitSel.addEventListener("change", function () {
    state.unit = unitSel.value;
    document.getElementById("fUnitLbl").textContent = state.unit;
    views.A.render(); views.B.render();
    if (selection.view) renderInspector();
    saveLocal();
  });

  // 도면 이름
  document.querySelectorAll(".plan-name").forEach(function (inp) {
    inp.value = state.plans[inp.dataset.plan].name;
    inp.addEventListener("input", function () { state.plans[inp.dataset.plan].name = inp.value; refreshAreaSummary(); saveLocal(); });
  });

  // 툴바 버튼
  bindAll(".addRoom", function (pid) { addRoom(pid); });
  bindAll(".zoomIn", function (pid) { zoomPlan(pid, 1.2); });
  bindAll(".zoomOut", function (pid) { zoomPlan(pid, 1 / 1.2); });
  bindAll(".matchScale", function (pid) { matchScale(pid); });
  bindAll(".grid", function (pid) { toggleGrid(pid); });
  bindAll(".calib", function (pid) { views[pid].startCalibration(); });
  bindAll(".view3d", function (pid) {
    if (window.open3DView) window.open3DView(pid);
    else toast("3D 모듈을 불러오지 못했습니다. (vendor/three.min.js 확인)");
  });
  document.querySelectorAll(".addFurnBtn").forEach(function (b) {
    b.addEventListener("click", function () { openPlanFurnChooser(b.dataset.plan, b); });
  });

  // 배경 업로드
  document.querySelectorAll(".bgFile").forEach(function (inp) {
    inp.addEventListener("change", function (e) {
      if (e.target.files[0]) handleBgUpload(inp.dataset.plan, e.target.files[0]);
      e.target.value = "";
    });
  });
  document.querySelectorAll(".bgRemove").forEach(function (b) {
    b.addEventListener("click", function () { removeBg(b.dataset.plan); });
  });
  document.querySelectorAll(".ocrBtn").forEach(function (b) {
    b.addEventListener("click", function () { runOCR(b.dataset.plan); });
  });
  document.querySelectorAll(".autoRoom").forEach(function (b) {
    b.addEventListener("click", function () {
      if (window.openAutoRoom) window.openAutoRoom(b.dataset.plan);
    });
  });
  document.querySelectorAll(".bgOpacity").forEach(function (r) {
    r.addEventListener("input", function () {
      const pid = r.dataset.plan;
      if (state.plans[pid].bg) { state.plans[pid].bg.opacity = parseInt(r.value, 10); views[pid].render(); saveLocal(); }
    });
  });

  // 가구 라이브러리
  document.getElementById("btnAddFurniture").addEventListener("click", submitFurnitureForm);
  document.getElementById("fName").addEventListener("keydown", function (e) { if (e.key === "Enter") submitFurnitureForm(); });

  // 드래그 앤 드롭 배치 대상 (도면 A/B, 비교창 좌/우)
  setupDropTarget("stageA", function () { return views.A; });
  setupDropTarget("stageB", function () { return views.B; });
  setupDropTarget("cmpStageA", function () { return cmpViews.A; });
  setupDropTarget("cmpStageB", function () { return cmpViews.B; });

  // 상단 액션
  document.getElementById("btnCompare").addEventListener("click", toggleCompareMode);
  document.getElementById("btnSwap").addEventListener("click", function () { swapPlans(); });
  document.getElementById("btnPng").addEventListener("click", exportPNG);
  document.getElementById("btnPdf").addEventListener("click", exportPDF);
  document.getElementById("btnSave").addEventListener("click", function () { localStorage.setItem(LS_KEY, serialize()); toast("저장했습니다."); });
  document.getElementById("btnExport").addEventListener("click", exportJSON);
  document.getElementById("btnImport").addEventListener("click", function () { document.getElementById("importFile").click(); });
  document.getElementById("importFile").addEventListener("change", function (e) { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; });
  document.getElementById("btnReset").addEventListener("click", function () {
    if (!window.confirm("모든 도면·가구 데이터를 초기화할까요? 이 동작은 되돌릴 수 없습니다.")) return;
    state = newState(); localStorage.removeItem(LS_KEY); applyLoadedState();
    toast("초기화했습니다.");
  });

  // 비교 모달
  document.getElementById("cmpClose").addEventListener("click", closeCompareModal);
  document.getElementById("cmpOverlayToggle").addEventListener("click", toggleCmpOverlay);

  // OCR 모달
  document.getElementById("ocrClose").addEventListener("click", closeOcrModal);
  document.getElementById("ocrUnit").addEventListener("change", function () { if (ocrState.numbers.length || ocrState.pairs.length) renderOcrResults(); });
  document.getElementById("ocrMakeRoom").addEventListener("click", function () {
    if (ocrState.picks.length === 2) createRoomFromDims(ocrState.picks[0], ocrState.picks[1]);
  });

  // 키보드
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const in3d = window.is3DOpen && window.is3DOpen();
    if (in3d) {
      // 3D 보기 중에는 이동 키와 충돌하지 않도록 Esc만 처리
      if (e.key === "Escape" && window.close3DView) window.close3DView();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selection.view) { e.preventDefault(); deleteSelected(); }
    if (e.key === "Escape") {
      const am = document.getElementById("autoModal");
      if (am && !am.hidden) am.hidden = true;
      else if (!document.getElementById("ocrModal").hidden) closeOcrModal();
      else if (!document.getElementById("compareModal").hidden) closeCompareModal();
      else if (compareMode) toggleCompareMode();
      else if (selection.view) { selection.view.deselect(); clearInspector(); }
    }
  });

  // 리사이즈
  let rt = null;
  window.addEventListener("resize", function () {
    if (rt) clearTimeout(rt);
    rt = setTimeout(function () { views.A.resize(); views.B.resize(); }, 150);
  });
  // 모바일 bfcache(뒤로가기 캐시) 복원 시 캔버스 강제 재생성 — 잔상 방지
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) { views.A.resize(); views.B.resize(); }
  });

  // 초기 렌더
  views.A.render(); views.B.render();
  renderFurnitureLib();
  refreshAreaSummary();
}

function bindAll(sel, fn) {
  document.querySelectorAll(sel).forEach(function (b) {
    b.addEventListener("click", function () { fn(b.dataset.plan); });
  });
}

/* 도면 툴바의 '+가구' 선택 메뉴 */
function openPlanFurnChooser(planId, anchorEl) {
  if (!state.furnitureLib.length) { toast("먼저 좌측에서 가구를 등록해 주세요."); return; }
  const old = document.getElementById("furnChooser");
  if (old) old.remove();
  const menu = document.createElement("div");
  menu.id = "furnChooser";
  menu.style.cssText = "position:fixed;z-index:90;background:#1f2438;border:1px solid #2a3050;border-radius:10px;padding:6px;box-shadow:0 10px 30px rgba(0,0,0,.5);max-height:300px;overflow:auto;min-width:180px";
  state.furnitureLib.forEach(function (f) {
    const b = document.createElement("button");
    b.className = "btn sm full";
    b.style.cssText = "text-align:left;margin-bottom:4px;display:flex;align-items:center;gap:8px";
    b.innerHTML = '<span style="width:14px;height:14px;border-radius:3px;background:' + f.color + ';display:inline-block"></span>' + escapeHtml(f.name) + ' <span style="color:#9aa3c4;margin-left:auto">' + fmtLen(f.wmm) + "×" + fmtLen(f.dmm) + "</span>";
    b.addEventListener("click", function () { addFurnitureToPlan(f.id, planId); menu.remove(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = r.left + "px";
  menu.style.top = (r.bottom + 4) + "px";
  setTimeout(function () {
    document.addEventListener("click", function close(ev) {
      if (!menu.contains(ev.target) && ev.target !== anchorEl) { menu.remove(); document.removeEventListener("click", close); }
    });
  }, 0);
}

/* ---------- 3D 뷰어(viewer3d.js) · 방 자동인식(autoroom.js) 연동 API ---------- */
window.APT = {
  getPlan: function (pid) { return state.plans[pid]; },
  getUnit: function () { return state.unit; },
  getPpm: function (pid) { return views[pid] ? views[pid]._ppm : DEFAULT_PPM; },
  furnitureHeight: furnH,
  computeWarnings: computeWarnings,
  planBoundsMM: planBoundsMM,
  fmtLen: fmtLen,
  saveLocal: function () { saveLocal(); },
  toast: toast,
  loadTesseract: loadTesseract,
  roomColor: roomColor,
  // 자동인식된 방 목록을 도면에 추가. defs: [{name, wmm, hmm, xm, ym}]
  addRooms: function (pid, defs) {
    const p = state.plans[pid];
    defs.forEach(function (rd, i) {
      p.rooms.push({
        id: uid(), name: rd.name || "방", wmm: Math.round(rd.wmm), hmm: Math.round(rd.hmm),
        xm: rd.xm, ym: rd.ym, rot: 0, color: roomColor(p.rooms.length + i)
      });
    });
    views[pid].render();
    saveLocal();
  },
  // 자동 추정된 축척을 배경 사진에 반영(사진과 생성된 방이 정렬되도록)
  setBgScale: function (pid, mmPerNativePx) {
    const bg = state.plans[pid].bg;
    if (bg && mmPerNativePx > 0) { bg.mmPerNativePx = mmPerNativePx; views[pid].render(); saveLocal(); }
  }
};

document.addEventListener("DOMContentLoaded", init);
})();
