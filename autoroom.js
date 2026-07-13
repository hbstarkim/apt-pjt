/* ============================================================
   도면 사진 → 방 자동인식 (autoroom.js)
   1) 영상처리: Otsu 이진화로 벽선 추출 → 모폴로지 닫힘(문틈 메움)
      → 외부 영역 제거 → 연결요소 분석으로 닫힌 공간(방) 검출
   2) OCR(Tesseract, 선택적): 한글 방 이름(거실/침실/욕실…) 자동 지정,
      "가로×세로" 치수 텍스트로 축척(mm/px) 자동 추정
   3) 검토 모달: 미리보기 + 이름 수정 + 선택 생성
   - app.js 의 window.APT 를 통해 도면에 반영
   ============================================================ */
(function () {
"use strict";

let ar = null; // 현재 분석 상태 { planId, img, det, ocrWords, ocrPairs, mmPer, mmSrc }

function el(id) { return document.getElementById(id); }
function setStatus(t) { el("autoStatus").textContent = t; }

/* ============ 1. 영상처리 파이프라인 ============ */

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = i; }
  }
  return thr;
}

// 이진 마스크 1D 팽창/침식 (prefix sum, 가로·세로 분리 적용)
function morph1D(src, W, H, r, isDilate, horizontal) {
  const out = new Uint8Array(W * H);
  const len = horizontal ? W : H, lines = horizontal ? H : W;
  const pre = new Int32Array(len + 1);
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < len; i++) {
      const idx = horizontal ? l * W + i : i * W + l;
      pre[i + 1] = pre[i] + src[idx];
    }
    for (let i = 0; i < len; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(len, i + r + 1);
      const s = pre[hi] - pre[lo];
      const idx = horizontal ? l * W + i : i * W + l;
      out[idx] = isDilate ? (s > 0 ? 1 : 0) : (s === hi - lo ? 1 : 0);
    }
  }
  return out;
}
function closing(mask, W, H, r) {
  let m = morph1D(mask, W, H, r, true, true);
  m = morph1D(m, W, H, r, true, false);
  m = morph1D(m, W, H, r, false, true);
  m = morph1D(m, W, H, r, false, false);
  return m;
}

// closeFrac: 문틈 메움 반경 (도면 폭 대비 비율)
function detectRooms(imgEl, closeFrac) {
  const natW = imgEl.naturalWidth, natH = imgEl.naturalHeight;
  const f = Math.min(1, 1000 / natW);
  const W = Math.max(60, Math.round(natW * f)), H = Math.max(60, Math.round(natH * f));
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); // 투명 PNG 대비
  ctx.drawImage(imgEl, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const N = W * H;

  // 그레이스케일 + Otsu 임계값
  const gray = new Uint8Array(N);
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) {
    const g = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0;
    gray[i] = g; hist[g]++;
  }
  const thr = otsu(hist, N);

  // 어두운 픽셀(벽선·문자) 마스크 → 닫힘 연산으로 문틈 메움
  const wall = new Uint8Array(N);
  for (let i = 0; i < N; i++) wall[i] = gray[i] < thr ? 1 : 0;
  const r = Math.max(2, Math.round(W * closeFrac));
  const closed = closing(wall, W, H, r);

  // 외부(테두리와 연결된 빈 영역) 플러드필 제거
  const OUT = 1, seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const push = function (idx) { if (!seen[idx] && !closed[idx]) { seen[idx] = OUT; stack[sp++] = idx; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp > 0) {
    const i = stack[--sp], x = i % W, y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }

  // 내부 연결요소(=방 후보) 라벨링
  const comps = [];
  for (let start = 0; start < N; start++) {
    if (closed[start] || seen[start]) continue;
    let area = 0, minX = W, minY = H, maxX = 0, maxY = 0;
    const colCnt = new Uint16Array(W), rowCnt = new Uint16Array(H);
    seen[start] = 2; stack[0] = start; sp = 1;
    while (sp > 0) {
      const i = stack[--sp], x = i % W, y = (i / W) | 0;
      area++; colCnt[x]++; rowCnt[y]++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && !seen[i - 1] && !closed[i - 1]) { seen[i - 1] = 2; stack[sp++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && !closed[i + 1]) { seen[i + 1] = 2; stack[sp++] = i + 1; }
      if (y > 0 && !seen[i - W] && !closed[i - W]) { seen[i - W] = 2; stack[sp++] = i - W; }
      if (y < H - 1 && !seen[i + W] && !closed[i + W]) { seen[i + W] = 2; stack[sp++] = i + W; }
    }
    if (area < N * 0.003) continue;              // 너무 작음(문자 구멍 등)
    if (area > N * 0.6) continue;                // 사실상 전체

    // 문틈으로 새어나간 얇은 돌출부 절단: 점유율이 최대치의 35% 미만인
    // 가장자리 열/행을 잘라내 실제 방 사각형에 근접시킴
    let mc = 0, mr = 0;
    for (let x = minX; x <= maxX; x++) if (colCnt[x] > mc) mc = colCnt[x];
    for (let y = minY; y <= maxY; y++) if (rowCnt[y] > mr) mr = rowCnt[y];
    let x0 = minX, x1 = maxX, y0 = minY, y1 = maxY;
    while (x0 < x1 && colCnt[x0] < mc * 0.35) x0++;
    while (x1 > x0 && colCnt[x1] < mc * 0.35) x1--;
    while (y0 < y1 && rowCnt[y0] < mr * 0.35) y0++;
    while (y1 > y0 && rowCnt[y1] < mr * 0.35) y1--;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < W * 0.045 || bh < H * 0.045) continue;
    const fill = Math.min(1, area / (bw * bh));
    if (fill < 0.4) continue;                    // 방이라기엔 형태가 산만
    comps.push({ x: x0, y: y0, w: bw, h: bh, area: area, fill: fill });
  }
  comps.sort(function (a, b) { return b.area - a.area; });
  return { W: W, H: H, f: f, natW: natW, natH: natH, rooms: comps.slice(0, 12), canvas: cv, thr: thr, radius: r };
}

// 문틈 메움 반경 자동 탐색: 여러 반경을 시도해 방이 가장 많이(그리고
// 안정적으로) 분리되는 결과를 채택
const AUTO_RADII = [0.007, 0.010, 0.014, 0.019, 0.026, 0.034];
function detectRoomsAuto(imgEl) {
  let best = null;
  for (let i = 0; i < AUTO_RADII.length; i++) {
    const det = detectRooms(imgEl, AUTO_RADII[i]);
    if (!best || det.rooms.length > best.rooms.length) best = det;
  }
  return best;
}

/* ============ 2. OCR — 이름 지정 · 축척 추정 ============ */

const NAME_RULES = [
  [/거실|리빙|LIVING/i, "거실"],
  [/안방|MASTER/i, "안방"],
  [/침실|BED/i, "침실"],
  [/주방|부엌|식당|KITCHEN|DINING|LDK|DK/i, "주방"],
  [/욕실|화장실|BATH|TOILET|WC/i, "욕실"],
  [/현관|ENT/i, "현관"],
  [/발코니|베란다|BALCONY/i, "발코니"],
  [/다용도|UTILITY/i, "다용도실"],
  [/드레스|WIC|W\.I\.C/i, "드레스룸"],
  [/팬트리|PANTRY/i, "팬트리"],
  [/서재|STUDY/i, "서재"],
  [/알파룸|ALPHA/i, "알파룸"]
];
function canonicalName(text) {
  for (let i = 0; i < NAME_RULES.length; i++) if (NAME_RULES[i][0].test(text)) return NAME_RULES[i][1];
  return null;
}
function normMM(v) {
  if (v >= 1000) return v;        // mm
  if (v >= 100) return v * 10;    // cm → mm
  return 0;                        // 신뢰 불가
}

async function runOcrPass(src) {
  if (location.protocol === "file:") throw new Error("file:// 환경에서는 OCR을 사용할 수 없습니다");
  await window.APT.loadTesseract();
  const worker = await Tesseract.createWorker("kor+eng", 1, {
    logger: function (m) {
      if (m.status === "recognizing text") setStatus("문자 인식 중 " + Math.round((m.progress || 0) * 100) + "% (방 이름·치수 읽는 중)");
      else if (m.status && m.progress != null) setStatus("OCR 준비: " + m.status + " " + Math.round(m.progress * 100) + "%");
    }
  });
  // Tesseract.js v5: 단어/줄 좌표는 blocks 출력 옵션으로 받아 순회
  const out = await worker.recognize(src, {}, { blocks: true, text: true });
  await worker.terminate();
  const data = out.data || {};
  const allWords = [], allLines = [];
  if (data.blocks) {
    data.blocks.forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (ln) {
          if (ln.text && ln.bbox) allLines.push(ln);
          (ln.words || []).forEach(function (w) { if (w.text && w.bbox) allWords.push(w); });
        });
      });
    });
  }
  // (구버전 호환) data.words / data.lines 가 있으면 함께 사용
  (data.words || []).forEach(function (w) { if (w.text && w.bbox) allWords.push(w); });
  (data.lines || []).forEach(function (ln) { if (ln.text && ln.bbox) allLines.push(ln); });

  const words = [];
  allWords.forEach(function (w) {
    const nm = canonicalName(w.text);
    if (nm) words.push({ name: nm, cx: (w.bbox.x0 + w.bbox.x1) / 2, cy: (w.bbox.y0 + w.bbox.y1) / 2 });
  });
  const pairs = [];
  allLines.forEach(function (ln) {
    const re = /(\d{3,5})\s*[xX×*]\s*(\d{3,5})/g;
    let m;
    while ((m = re.exec(ln.text.replace(/[,\.]/g, "")))) {
      const a = normMM(parseInt(m[1], 10)), b = normMM(parseInt(m[2], 10));
      if (a && b) pairs.push({ a: a, b: b, cx: (ln.bbox.x0 + ln.bbox.x1) / 2, cy: (ln.bbox.y0 + ln.bbox.y1) / 2 });
    }
  });
  return { words: words, pairs: pairs };
}

// OCR 결과를 검출된 방에 대응 (bbox 좌표: 원본 px → 축소 px 는 *f)
function applyOcr(det, ocr) {
  det.rooms.forEach(function (rm) { rm.ocrName = null; rm.pair = null; });
  const inRoom = function (rm, cx, cy) {
    const x = cx * det.f, y = cy * det.f;
    return x >= rm.x && x <= rm.x + rm.w && y >= rm.y && y <= rm.y + rm.h;
  };
  ocr.words.forEach(function (w) {
    for (let i = 0; i < det.rooms.length; i++) {
      if (inRoom(det.rooms[i], w.cx, w.cy)) { if (!det.rooms[i].ocrName) det.rooms[i].ocrName = w.name; break; }
    }
  });
  const ests = [];
  ocr.pairs.forEach(function (p) {
    for (let i = 0; i < det.rooms.length; i++) {
      const rm = det.rooms[i];
      if (!inRoom(rm, p.cx, p.cy)) continue;
      const nw = rm.w / det.f, nh = rm.h / det.f;    // 방 크기(원본 px)
      const sA = Math.max(p.a, p.b) / Math.max(nw, nh);
      const sB = Math.min(p.a, p.b) / Math.min(nw, nh);
      if (Math.abs(sA - sB) / ((sA + sB) / 2) < 0.35) {
        const s = (sA + sB) / 2;
        ests.push(s);
        rm.pair = p;
      }
      break;
    }
  });
  let mmPer = null;
  if (ests.length) {
    ests.sort(function (a, b) { return a - b; });
    mmPer = ests[Math.floor(ests.length / 2)];      // 중앙값
  }
  return mmPer;
}

/* ============ 3. 검토 모달 UI ============ */

function defaultName(det, idx, mmPer) {
  const rm = det.rooms[idx];
  if (rm.ocrName) return rm.ocrName;
  if (idx === 0) return "거실";
  if (mmPer) {
    const a = (rm.w / det.f * mmPer) * (rm.h / det.f * mmPer) / 1e6; // ㎡
    if (a < 5) return "욕실";
  }
  return "방 " + idx;
}

function drawPreview(det) {
  const pv = el("autoPreview");
  const maxW = 470;
  const s = Math.min(1, maxW / det.W);
  pv.width = Math.round(det.W * s); pv.height = Math.round(det.H * s);
  const ctx = pv.getContext("2d");
  ctx.drawImage(det.canvas, 0, 0, pv.width, pv.height);
  det.rooms.forEach(function (rm, i) {
    const col = window.APT.roomColor(i);
    ctx.fillStyle = col + "44";
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.fillRect(rm.x * s, rm.y * s, rm.w * s, rm.h * s);
    ctx.strokeRect(rm.x * s, rm.y * s, rm.w * s, rm.h * s);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(rm.x * s + 14, rm.y * s + 14, 11, 0, 7); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "700 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), rm.x * s + 14, rm.y * s + 15);
  });
}

function fmtRoomSize(det, rm, mmPer) {
  if (!mmPer) return Math.round(rm.w / det.f) + "×" + Math.round(rm.h / det.f) + " px";
  const wmm = rm.w / det.f * mmPer, hmm = rm.h / det.f * mmPer;
  return window.APT.fmtLen(wmm) + " × " + window.APT.fmtLen(hmm) + " (" + (wmm * hmm / 1e6).toFixed(1) + "㎡)";
}

function renderList() {
  const det = ar.det, mmPer = ar.mmPer;
  const box = el("autoList");
  box.innerHTML = "";
  if (!det.rooms.length) {
    box.innerHTML = '<p class="hint">닫힌 공간을 찾지 못했습니다. "벽 연결 강도"를 올리거나 더 선명한 도면 사진을 사용해 보세요.</p>';
    return;
  }
  det.rooms.forEach(function (rm, i) {
    const row = document.createElement("div");
    row.className = "auto-row";
    row.innerHTML =
      '<input type="checkbox" checked data-i="' + i + '" />' +
      '<span class="auto-idx" style="background:' + window.APT.roomColor(i) + '">' + (i + 1) + "</span>" +
      '<input type="text" class="auto-name" value="' + defaultName(det, i, mmPer) + '" />' +
      '<span class="auto-dim">' + fmtRoomSize(det, rm, mmPer) + (rm.pair ? " · 치수인식됨" : "") + "</span>";
    box.appendChild(row);
  });
  el("autoScaleInfo").textContent = ar.mmPer
    ? "축척: 1px ≈ " + ar.mmPer.toFixed(2) + "mm (" + ar.mmSrc + ")"
    : "축척 미확정 — 생성 시 가장 큰 방의 실제 가로 길이를 물어봅니다";
  el("autoMake").disabled = false;
  el("autoMake").textContent = "선택한 방 생성";
}

function analyze(manual) {
  setStatus("이미지 분석 중… (벽선 추출 → 공간 검출)");
  setTimeout(function () {
    if (manual) {
      const frac = parseInt(el("autoClose").value, 10) / 1000; // 슬라이더: 6~35 → 0.006~0.035
      ar.det = detectRooms(ar.img, frac);
    } else {
      ar.det = detectRoomsAuto(ar.img);   // 자동: 최적 반경 탐색
      const pct = Math.round(ar.det.radius / ar.det.W * 1000);
      el("autoClose").value = Math.max(6, Math.min(35, pct));
      el("autoCloseVal").textContent = (pct / 10).toFixed(1) + "% (자동)";
    }
    if (ar.ocr) ar.mmFromOcr = applyOcr(ar.det, ar.ocr);
    resolveScale();
    drawPreview(ar.det);
    renderList();
    setStatus("공간 " + ar.det.rooms.length + "개 검출" + (ar.ocr ? " · 문자 인식 완료" : ""));
  }, 30);
}

function resolveScale() {
  const bg = window.APT.getPlan(ar.planId).bg;
  if (bg && bg.mmPerNativePx > 0) { ar.mmPer = bg.mmPerNativePx; ar.mmSrc = "축척보정값 사용"; }
  else if (ar.mmFromOcr) { ar.mmPer = ar.mmFromOcr; ar.mmSrc = "사진 속 치수로 자동 추정"; }
  else { ar.mmPer = null; ar.mmSrc = null; }
}

async function startOcr() {
  try {
    ar.ocr = await runOcrPass(window.APT.getPlan(ar.planId).bg.src);
    if (ar.det) {
      ar.mmFromOcr = applyOcr(ar.det, ar.ocr);
      resolveScale();
      renderList();
      drawPreview(ar.det);
    }
    setStatus("공간 " + (ar.det ? ar.det.rooms.length : 0) + "개 검출 · 이름 " +
      ar.ocr.words.length + "개 · 치수 " + ar.ocr.pairs.length + "개 인식");
  } catch (e) {
    setStatus("문자 인식 생략(" + e.message + ") — 공간 검출 결과만 사용합니다");
  }
}

function makeRooms() {
  const det = ar.det;
  let mmPer = ar.mmPer;
  if (!mmPer) {
    const big = det.rooms[0];
    const ans = window.prompt("축척을 알 수 없습니다.\n미리보기 1번(가장 큰) 공간의 실제 가로 길이를 입력해 주세요 (mm)", "4500");
    if (ans == null) return;
    const v = parseFloat(ans);
    if (!(v > 0)) { window.APT.toast("올바른 숫자를 입력해 주세요."); return; }
    mmPer = v / (big.w / det.f);
  }
  const ppm = window.APT.getPpm(ar.planId);
  const bg = window.APT.getPlan(ar.planId).bg || {};
  const bx = (bg.x || 0) / ppm, by = (bg.y || 0) / ppm;   // 배경 위치(월드 m)
  const defs = [];
  const rows = el("autoList").querySelectorAll(".auto-row");
  rows.forEach(function (row, i) {
    if (!row.querySelector("input[type=checkbox]").checked) return;
    const rm = det.rooms[i];
    const nw = rm.w / det.f, nh = rm.h / det.f; // 원본 px
    let wmm, hmm;
    if (rm.pair) {
      // 사진 속 치수 인식값을 그대로 사용 (긴 변끼리 대응)
      const mx = Math.max(rm.pair.a, rm.pair.b), mn = Math.min(rm.pair.a, rm.pair.b);
      if (nw >= nh) { wmm = mx; hmm = mn; } else { wmm = mn; hmm = mx; }
    } else {
      wmm = nw * mmPer; hmm = nh * mmPer;
    }
    defs.push({
      name: row.querySelector(".auto-name").value.trim() || "방",
      wmm: wmm,
      hmm: hmm,
      xm: bx + (rm.x + rm.w / 2) / det.f * mmPer / 1000,
      ym: by + (rm.y + rm.h / 2) / det.f * mmPer / 1000
    });
  });
  if (!defs.length) { window.APT.toast("생성할 방을 선택해 주세요."); return; }
  window.APT.addRooms(ar.planId, defs);
  window.APT.setBgScale(ar.planId, mmPer);   // 사진도 같은 축척으로 정렬
  el("autoModal").hidden = true;
  window.APT.toast("방 " + defs.length + "개를 " + ar.planId + " 도면에 생성했습니다. 속성창에서 치수를 보정할 수 있습니다.");
}

/* ============ 진입점 ============ */

window.openAutoRoom = function (planId) {
  const plan = window.APT.getPlan(planId);
  if (!plan.bg || !plan.bg.src) { window.APT.toast("먼저 해당 도면에 📷 도면사진을 업로드해 주세요."); return; }
  ar = { planId: planId, img: null, det: null, ocr: null, mmFromOcr: null, mmPer: null, mmSrc: null };
  el("autoModal").hidden = false;
  el("autoList").innerHTML = "";
  el("autoMake").disabled = true;
  setStatus("이미지 불러오는 중…");
  const im = new Image();
  im.onload = function () {
    ar.img = im;
    analyze();     // 1차: 형태 검출 (즉시)
    startOcr();    // 2차: OCR 로 이름/축척 보강 (비동기)
  };
  im.onerror = function () { setStatus("이미지를 불러오지 못했습니다."); };
  im.src = plan.bg.src;
};

document.addEventListener("DOMContentLoaded", function () {
  el("autoClose2").addEventListener("click", function () { el("autoModal").hidden = true; });
  el("autoReRun").addEventListener("click", function () { if (ar && ar.img) analyze(true); });
  el("autoClose").addEventListener("input", function () {
    el("autoCloseVal").textContent = (parseInt(el("autoClose").value, 10) / 10).toFixed(1) + "%";
  });
  el("autoMake").addEventListener("click", makeRooms);
});
})();
