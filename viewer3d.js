/* ============================================================
   3D 공간 뷰어 (Three.js) — 1인칭 FPS 시점
   - 방: 바닥 + 반투명 벽 (벽 높이 조절 가능)
   - 가구: 실제 가로×깊이×높이 박스 + 이름/치수 라벨
   - 조작: 화면 클릭 → 마우스 시점, W/A/S/D 이동, Shift 달리기,
           Space/C 위·아래, Esc 마우스 해제 → 한 번 더 Esc 닫기
   - 데이터는 app.js 가 노출하는 window.APT 를 통해 읽음
   ============================================================ */
(function () {
"use strict";

let renderer = null, scene = null, camera = null;
let opened = false, planId = null, rafId = null, prevT = 0;
let yaw = 0, pitch = 0, locked = false;
let startPos = { x: 0, y: 1.6, z: 3 };
const keys = {};
let wallMats = [];          // 벽 재질 (투명도 일괄 조절용)
let wallOp = 35;            // 벽 투명도 %
const EYE = 1.6;            // 눈높이 (m)
// 터치 조작 상태 (모바일)
let joyT = null;            // 조이스틱 터치 { id, ox, oy }
let lookT = null;           // 시점 터치 { id, x, y }
let tvec = { x: 0, y: 0 };  // 조이스틱 벡터 (-1..1) x=좌우, y=앞뒤(+앞)
function isTouchDev() { return document.body.classList.contains("touchdev"); }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function el(id) { return document.getElementById(id); }

/* ---------- 라벨 스프라이트 ---------- */
function makeLabelSprite(lines) {
  const fs = 34, lh = 44, pad = 16;
  const cv = document.createElement("canvas");
  let ctx = cv.getContext("2d");
  ctx.font = '600 ' + fs + 'px "Malgun Gothic", sans-serif';
  let tw = 0;
  lines.forEach(function (l) { tw = Math.max(tw, ctx.measureText(l).width); });
  cv.width = Math.ceil(tw + pad * 2);
  cv.height = lh * lines.length + pad * 2;
  ctx = cv.getContext("2d");
  ctx.fillStyle = "rgba(10,13,26,0.75)";
  ctx.beginPath();
  const r = 14, W = cv.width, H = cv.height;
  ctx.moveTo(r, 0); ctx.arcTo(W, 0, W, H, r); ctx.arcTo(W, H, 0, H, r); ctx.arcTo(0, H, 0, 0, r); ctx.arcTo(0, 0, W, 0, r);
  ctx.fill();
  ctx.font = '600 ' + fs + 'px "Malgun Gothic", sans-serif';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach(function (l, i) {
    ctx.fillStyle = i === 0 ? "#e8ebf5" : "#9fb0e8";
    ctx.fillText(l, W / 2, pad + lh * i + lh / 2);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  const h = 0.22 * lines.length + 0.1;
  sp.scale.set(h * (W / H), h, 1);
  return sp;
}

/* ---------- 씬 구성 ---------- */
function disposeScene() {
  if (!scene) return;
  scene.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
  scene = null;
  wallMats = [];
}

function buildScene(plan) {
  disposeScene();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1020);
  scene.fog = new THREE.Fog(0x0d1020, 30, 90);

  scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x1a1d2e, 0.95));
  const dir = new THREE.DirectionalLight(0xffffff, 0.65);
  dir.position.set(10, 20, 6);
  scene.add(dir);

  // 바닥면 + 1m 격자
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshLambertMaterial({ color: 0x0c0f1c })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  const grid = new THREE.GridHelper(120, 120, 0x2a3050, 0x1b2036);
  grid.position.y = -0.005;
  scene.add(grid);

  const wallH = (plan.wallmm > 0 ? plan.wallmm : 2400) / 1000;
  const warn = window.APT.computeWarnings(plan);

  // ----- 방: 바닥 슬래브 + 반투명 벽 -----
  (plan.rooms || []).forEach(function (r) {
    const w = r.wmm / 1000, d = r.hmm / 1000;
    const grp = new THREE.Group();
    grp.position.set(r.xm || 0, 0, r.ym || 0);
    grp.rotation.y = -(r.rot || 0) * Math.PI / 180;

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.04, d),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(r.color || "#5b7cff"), transparent: true, opacity: 0.5 })
    );
    floor.position.y = 0.02;
    grp.add(floor);

    const t = 0.06; // 벽 두께
    const wm = function () {
      const m = new THREE.MeshLambertMaterial({
        color: new THREE.Color(r.color || "#5b7cff"),
        transparent: true, opacity: wallOp / 100, side: THREE.DoubleSide, depthWrite: false
      });
      wallMats.push(m);
      return m;
    };
    const mkWall = function (ww, dd, x, z) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(ww, wallH, dd), wm());
      wall.position.set(x, wallH / 2, z);
      grp.add(wall);
    };
    mkWall(w + 2 * t, t, 0, -d / 2 - t / 2);   // 뒤
    mkWall(w + 2 * t, t, 0, d / 2 + t / 2);    // 앞
    mkWall(t, d, -w / 2 - t / 2, 0);           // 좌
    mkWall(t, d, w / 2 + t / 2, 0);            // 우

    // 방 외곽선
    const eg = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, wallH, d)),
      new THREE.LineBasicMaterial({ color: new THREE.Color(r.color || "#5b7cff"), transparent: true, opacity: 0.8 })
    );
    eg.position.y = wallH / 2;
    grp.add(eg);

    const lbl = makeLabelSprite([r.name, window.APT.fmtLen(r.wmm) + " × " + window.APT.fmtLen(r.hmm)]);
    lbl.position.set(0, wallH + 0.35, 0);
    grp.add(lbl);

    scene.add(grp);
  });

  // ----- 가구: 실제 치수 박스 -----
  (plan.furniture || []).forEach(function (f) {
    const w = f.wmm / 1000, d = f.dmm / 1000, h = window.APT.furnitureHeight(f) / 1000;
    const grp = new THREE.Group();
    grp.position.set(f.xm || 0, 0, f.ym || 0);
    grp.rotation.y = -(f.rot || 0) * Math.PI / 180;

    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(f.color || "#7c9cff"), transparent: true, opacity: 0.92 });
    if (warn.collide.has(f.id)) mat.emissive = new THREE.Color(0x7a1626);        // 충돌: 붉게
    else if (warn.outRoom.has(f.id)) mat.emissive = new THREE.Color(0x6e4a12);   // 방 이탈: 주황빛
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    box.position.y = h / 2 + 0.001;
    grp.add(box);

    const eg = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({ color: 0x0c0f1c, transparent: true, opacity: 0.7 })
    );
    eg.position.y = h / 2 + 0.001;
    grp.add(eg);

    const lbl = makeLabelSprite([
      f.name,
      window.APT.fmtLen(f.wmm) + "×" + window.APT.fmtLen(f.dmm) + "×H" + window.APT.fmtLen(window.APT.furnitureHeight(f))
    ]);
    lbl.position.set(0, h + 0.3, 0);
    grp.add(lbl);

    scene.add(grp);
  });
}

/* ---------- 시작 위치 ---------- */
function computeStart(plan) {
  const b = window.APT.planBoundsMM(plan);
  if (b) {
    startPos = { x: (b.minX + b.maxX) / 2000, y: EYE, z: b.maxY / 1000 + 1.5 };
  } else {
    startPos = { x: 0, y: EYE, z: 3 };
  }
}
function resetCamera() {
  camera.position.set(startPos.x, startPos.y, startPos.z);
  yaw = 0; pitch = -0.1;
}

/* ---------- 열기 / 닫기 ---------- */
function ensureRenderer() {
  if (renderer) return true;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el("v3dCanvasWrap").appendChild(renderer.domElement);
    renderer.domElement.id = "v3dCanvas";
    return true;
  } catch (e) {
    window.APT.toast("3D를 시작할 수 없습니다 (WebGL 미지원): " + e.message);
    renderer = null;
    return false;
  }
}
function sizeRenderer() {
  const wrap = el("v3dCanvasWrap");
  const w = Math.max(50, wrap.clientWidth), h = Math.max(50, wrap.clientHeight);
  renderer.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

window.open3DView = function (pid) {
  if (!window.THREE) { alert("3D 라이브러리(vendor/three.min.js)를 불러오지 못했습니다."); return; }
  const plan = window.APT.getPlan(pid);
  if (!plan) return;
  if (!(plan.rooms || []).length && !(plan.furniture || []).length) {
    window.APT.toast("먼저 방이나 가구를 배치해 주세요. 3D로 보여드릴 내용이 없습니다.");
    return;
  }
  planId = pid;
  el("modal3d").hidden = false;
  if (!ensureRenderer()) { el("modal3d").hidden = true; return; }

  camera = camera || new THREE.PerspectiveCamera(72, 1, 0.05, 300);
  camera.rotation.order = "YXZ";

  el("v3dTitle").textContent = "🧊 " + plan.name + " — 3D 보기";
  el("v3dWallH").value = plan.wallmm > 0 ? plan.wallmm : 2400;
  el("v3dWallOp").value = wallOp;

  buildScene(plan);
  computeStart(plan);
  resetCamera();
  sizeRenderer();

  opened = true;
  el("v3dHint").hidden = isTouchDev();
  el("v3dHintTouch").hidden = !isTouchDev();
  el("v3dCross").hidden = true;
  joyT = null; lookT = null; tvec = { x: 0, y: 0 };
  prevT = 0;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
};

window.close3DView = function () {
  if (!opened) return;
  opened = false;
  if (document.pointerLockElement) document.exitPointerLock();
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  for (const k in keys) keys[k] = false;
  joyT = null; lookT = null; tvec = { x: 0, y: 0 };
  el("v3dJoy").hidden = true;
  disposeScene();
  el("modal3d").hidden = true;
};

window.is3DOpen = function () { return opened; };

/* ---------- 렌더 루프 / 이동 ---------- */
function tick(t) {
  if (!opened) return;
  rafId = requestAnimationFrame(tick);
  const dt = prevT ? Math.min(0.05, (t - prevT) / 1000) : 0.016;
  prevT = t;

  const run = keys.ShiftLeft || keys.ShiftRight;
  const sp = (run ? 4.5 : 2.0) * dt;
  let fx = 0, fz = 0, fy = 0;
  if (keys.KeyW || keys.ArrowUp) fz += 1;
  if (keys.KeyS || keys.ArrowDown) fz -= 1;
  if (keys.KeyA || keys.ArrowLeft) fx -= 1;
  if (keys.KeyD || keys.ArrowRight) fx += 1;
  if (keys.Space) fy += 1;
  if (keys.KeyC || keys.ControlLeft) fy -= 1;

  if (fx || fz) {
    const len = Math.hypot(fx, fz);
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    camera.position.x += ((fz * -sy) + (fx * cy)) / len * sp;
    camera.position.z += ((fz * -cy) + (fx * -sy)) / len * sp;
  }
  // 가상 조이스틱(터치) 이동 — 기울인 정도에 비례, 끝까지 밀면 달리기
  if (tvec.x || tvec.y) {
    const mag = Math.min(1, Math.hypot(tvec.x, tvec.y));
    const tsp = 2.0 * dt * mag * (mag > 0.92 ? 2.2 : 1);
    const sy2 = Math.sin(yaw), cy2 = Math.cos(yaw);
    const jx = tvec.x, jz = tvec.y;
    camera.position.x += ((jz * -sy2) + (jx * cy2)) * tsp;
    camera.position.z += ((jz * -cy2) + (jx * -sy2)) * tsp;
  }
  if (fy) camera.position.y = clamp(camera.position.y + fy * sp, 0.25, 40);

  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  renderer.render(scene, camera);
}

/* ---------- 입력 ---------- */
document.addEventListener("keydown", function (e) {
  if (!opened) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  keys[e.code] = true;
  if (e.code === "Space") e.preventDefault();
});
document.addEventListener("keyup", function (e) {
  if (!opened) return;
  keys[e.code] = false;
});
document.addEventListener("mousemove", function (e) {
  if (!opened || !locked) return;
  yaw -= (e.movementX || 0) * 0.0022;
  pitch = clamp(pitch - (e.movementY || 0) * 0.0022, -1.55, 1.55);
});
document.addEventListener("pointerlockchange", function () {
  locked = !!renderer && document.pointerLockElement === renderer.domElement;
  if (opened) {
    el("v3dHint").hidden = locked;
    el("v3dCross").hidden = !locked;
  }
});
document.addEventListener("pointerlockerror", function () {
  if (opened) window.APT.toast("마우스 잠금에 실패했습니다. 화면을 다시 클릭해 주세요.");
});

window.addEventListener("resize", function () {
  if (opened && renderer) sizeRenderer();
});

/* ---------- HUD 바인딩 ---------- */
document.addEventListener("DOMContentLoaded", function () {
  el("v3dCanvasWrap").addEventListener("click", function () {
    if (!opened || locked || !renderer || isTouchDev()) return;
    renderer.domElement.requestPointerLock();
  });

  // ----- 터치 조작: 왼쪽 절반 = 가상 조이스틱(이동), 나머지 = 시점 드래그 -----
  const wrap = el("v3dCanvasWrap");
  const JOY_R = 55; // 조이스틱 반경(px)
  wrap.addEventListener("touchstart", function (e) {
    if (!opened) return;
    el("v3dHintTouch").hidden = true;
    const rect = wrap.getBoundingClientRect();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.target && t.target.closest && t.target.closest(".v3d-updown")) continue; // 버튼은 통과
      const lx = t.clientX - rect.left;
      if (!joyT && lx < rect.width * 0.45) {
        joyT = { id: t.identifier, ox: t.clientX, oy: t.clientY };
        const joy = el("v3dJoy");
        joy.hidden = false;
        joy.style.left = lx + "px";
        joy.style.top = (t.clientY - rect.top) + "px";
        el("v3dJoyKnob").style.transform = "translate(-50%, -50%)";
      } else if (!lookT) {
        lookT = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
    }
    e.preventDefault();
  }, { passive: false });
  wrap.addEventListener("touchmove", function (e) {
    if (!opened) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (joyT && t.identifier === joyT.id) {
        let dx = t.clientX - joyT.ox, dy = t.clientY - joyT.oy;
        const d = Math.hypot(dx, dy);
        if (d > JOY_R) { dx = dx / d * JOY_R; dy = dy / d * JOY_R; }
        tvec.x = dx / JOY_R;
        tvec.y = -dy / JOY_R;   // 위로 밀면 전진
        el("v3dJoyKnob").style.transform = "translate(calc(-50% + " + dx + "px), calc(-50% + " + dy + "px))";
      } else if (lookT && t.identifier === lookT.id) {
        yaw -= (t.clientX - lookT.x) * 0.005;
        pitch = clamp(pitch - (t.clientY - lookT.y) * 0.005, -1.55, 1.55);
        lookT.x = t.clientX; lookT.y = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = function (e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (joyT && t.identifier === joyT.id) {
        joyT = null; tvec.x = 0; tvec.y = 0;
        el("v3dJoy").hidden = true;
      } else if (lookT && t.identifier === lookT.id) {
        lookT = null;
      }
    }
  };
  wrap.addEventListener("touchend", endTouch);
  wrap.addEventListener("touchcancel", endTouch);

  // 상승/하강 버튼 (터치 기기 전용 표시)
  const hold = function (btnId, code) {
    const b = el(btnId);
    b.addEventListener("touchstart", function (e) { keys[code] = true; e.preventDefault(); }, { passive: false });
    b.addEventListener("touchend", function () { keys[code] = false; });
    b.addEventListener("touchcancel", function () { keys[code] = false; });
  };
  hold("v3dUp", "Space");
  hold("v3dDown", "KeyC");
  el("v3dClose").addEventListener("click", function () { window.close3DView(); });
  el("v3dReset").addEventListener("click", function () { resetCamera(); });
  el("v3dWallH").addEventListener("change", function () {
    if (!opened) return;
    const v = parseFloat(el("v3dWallH").value);
    const plan = window.APT.getPlan(planId);
    if (v >= 500 && v <= 6000) {
      plan.wallmm = v;
      window.APT.saveLocal();
      buildScene(plan);
    }
  });
  el("v3dWallOp").addEventListener("input", function () {
    wallOp = parseInt(el("v3dWallOp").value, 10);
    wallMats.forEach(function (m) { m.opacity = wallOp / 100; });
  });
});
})();
