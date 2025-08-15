// app.js
// Draw → 3D base, then draw directly on the model to add layered patches.
// index.html canvas should be transparent:
// <canvas id="draw" style="position:fixed;inset:0;touch-action:none;background:transparent;"></canvas>

import * as THREE from "https://unpkg.com/three@0.161/build/three.module.js";
import { OrbitControls } from "https://unpkg.com/three@0.161/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "https://unpkg.com/three@0.161/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "https://unpkg.com/three@0.161/examples/jsm/exporters/STLExporter.js";
import { OBJExporter } from "https://unpkg.com/three@0.161/examples/jsm/exporters/OBJExporter.js";

//
// ---------------------------
// State
// ---------------------------
const state = {
  drawing: false,
  points: [],            // screen-space points for base strokes
  mode: "draw",          // "draw" | "orbit"
  makeMode: "extrude",   // "extrude" | "lathe" (for the first/base object)
  meshes: [],            // all user-created meshes
  // surface-drawing:
  drawingOnSurface: false,
  color: "#4d7471",      // color for NEW additions (including base)

  // robust surface sampling
  surfacePoints3D: [],
  surfaceNormals: [],
  drawTarget: null,      // mesh hit at stroke start
  baseMesh: null,        // very first/original figure
};

//
// ---------------------------
// 2D draw canvas (top layer)
// ---------------------------
const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
const drawCanvas = document.getElementById("draw");
if (!drawCanvas) throw new Error('Missing <canvas id="draw">');
const ctx = drawCanvas.getContext("2d");
Object.assign(drawCanvas.style, { position: "fixed", inset: "0", zIndex: "2", touchAction: "none" });

function resize2D() {
  const w = innerWidth, h = innerHeight;
  drawCanvas.width = Math.floor(w * dpr);
  drawCanvas.height = Math.floor(h * dpr);
  drawCanvas.style.width = w + "px";
  drawCanvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawStroke();
}
resize2D();
addEventListener("resize", resize2D);

const getPt = (e) => (e.touches && e.touches[0])
  ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
  : { x: e.clientX, y: e.clientY };

function redrawStroke() {
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  if (!state.points.length) return;
  ctx.lineWidth = 6; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = "#000";
  ctx.beginPath();
  state.points.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
  ctx.stroke();
}

//
// ---------------------------
/** THREE scene */
// ---------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
document.body.appendChild(renderer.domElement);
Object.assign(renderer.domElement.style, { position: "fixed", inset: "0", zIndex: "1", pointerEvents: "none" });
renderer.setPixelRatio(Math.min(2, dpr));

const scene = new THREE.Scene();
const userGroup = new THREE.Group(); scene.add(userGroup);

const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 100);
camera.position.set(0, 1.2, 4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 1.0));
const dir = new THREE.DirectionalLight(0xffffff, 0.7); dir.position.set(1,2,2); scene.add(dir);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20,20),
  new THREE.MeshStandardMaterial({ color: 0xeeeeee })
);
floor.rotation.x = -Math.PI/2; floor.position.y = -0.6; scene.add(floor);

function resize3D(){
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w,h,false);
  camera.aspect = w/h; camera.updateProjectionMatrix();
}
resize3D(); addEventListener("resize", resize3D);

//
// ---------------------------
/** Raycasting & helpers */
// ---------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function toNDC(e){
  const r = renderer.domElement.getBoundingClientRect();
  const x = (((e.touches?e.touches[0].clientX:e.clientX)-r.left)/r.width)*2 - 1;
  const y = -(((e.touches?e.touches[0].clientY:e.clientY)-r.top)/r.height)*2 + 1;
  ndc.set(x,y);
}

// Find the top-level mesh under userGroup for a hit object
function findUserMeshRoot(obj) {
  let cur = obj;
  while (cur && cur.parent && cur.parent !== userGroup) cur = cur.parent;
  return cur || obj;
}

// Average a list of normals
function averageNormal(normals) {
  const n = new THREE.Vector3();
  for (const v of normals) n.add(v);
  if (n.lengthSq() === 0) return null;
  return n.normalize();
}

// PCA-based fallback normal (smallest-variance direction)
function pcaNormal(points) {
  const c = new THREE.Vector3();
  points.forEach(p => c.add(p));
  c.multiplyScalar(1 / points.length);

  let xx=0, xy=0, xz=0, yy=0, yz=0, zz=0;
  for (const p of points) {
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
    xx += x*x; xy += x*y; xz += x*z;
    yy += y*y; yz += y*z; zz += z*z;
  }
  const m = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  let bestV = new THREE.Vector3(1,0,0), bestVal = Infinity;
  const dirs = [
    new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1),
    new THREE.Vector3(1,1,0).normalize(), new THREE.Vector3(1,0,1).normalize(),
    new THREE.Vector3(0,1,1).normalize(), new THREE.Vector3(1,1,1).normalize(),
    new THREE.Vector3(1,-1,0).normalize(), new THREE.Vector3(1,0,-1).normalize(),
    new THREE.Vector3(0,1,-1).normalize(), new THREE.Vector3(1,-1,-1).normalize()
  ];
  function q(v){
    const x=v.x,y=v.y,z=v.z;
    return m[0][0]*x*x + 2*m[0][1]*x*y + 2*m[0][2]*x*z + m[1][1]*y*y + 2*m[1][2]*y*z + m[2][2]*z*z;
  }
  for (const v of dirs){
    const val = q(v);
    if (val < bestVal){ bestVal = val; bestV = v.clone(); }
  }
  return bestV.clone().normalize();
}

// Does a candidate geom touch ANY existing user mesh?
function touchesAnyUserMesh(geom, eps = 0.004) {
  const tmp = new THREE.Mesh(geom);
  const patchBox = new THREE.Box3().setFromObject(tmp).expandByScalar(eps);
  for (const child of userGroup.children) {
    if (!child.isMesh) continue;
    const b = new THREE.Box3().setFromObject(child).expandByScalar(eps);
    if (patchBox.intersectsBox(b)) return true;
  }
  return false;
}

//
// ---------------------------
// Patch builder (always in the start surface plane, extruded along its normal)
// ---------------------------
function makePatchFromSurfacePoints(worldPts, normals, depth=0.06, eps=0.004) {
  if (!worldPts || worldPts.length < 3) return null;

  // Plane = surface where the user FIRST touched
  const origin = worldPts[0].clone();
  let nUse = (normals && normals[0]) ? normals[0].clone().normalize() : null;
  if (!nUse || !isFinite(nUse.x)) {
    nUse = averageNormal(normals) || pcaNormal(worldPts) || new THREE.Vector3(0,1,0);
  }

  // Build local frame whose +Z is the surface normal at the start point
  const up = Math.abs(nUse.y) < 0.99 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
  const xAxis = new THREE.Vector3().crossVectors(up, nUse).normalize();
  const yAxis = new THREE.Vector3().crossVectors(nUse, xAxis).normalize();
  const frame = new THREE.Matrix4().makeBasis(xAxis, yAxis, nUse);
  frame.setPosition(origin);
  const inv = new THREE.Matrix4().copy(frame).invert();

  // Project sampled 3D points into that plane
  const local2 = [];
  for (const p of worldPts) {
    const lp = p.clone().applyMatrix4(inv);
    const v2 = new THREE.Vector2(lp.x, lp.y);
    const last = local2[local2.length-1];
    if (!last || last.distanceTo(v2) > 0.003) local2.push(v2);
  }
  if (local2.length < 3) return null;

  // 2D shape in that plane
  const shape = new THREE.Shape();
  local2.forEach((p,i)=> i?shape.lineTo(p.x,p.y):shape.moveTo(p.x,p.y));
  const d = local2[0].distanceTo(local2[local2.length-1]);
  if (d < 0.02) shape.lineTo(local2[0].x, local2[0].y);
  shape.closePath();

  // Extrude along +Z of the plane (perpendicular to the surface)
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled:true, bevelThickness:0.01, bevelSize:0.01, bevelSegments:1, curveSegments:24
  });

  // Nudge outward to avoid z-fighting, then back to world
  const tMat = new THREE.Matrix4().makeTranslation(0,0,eps);
  geom.applyMatrix4(tMat);
  geom.applyMatrix4(frame);
  return geom;
}

//
// ---------------------------
// Origin-centered framing (reset + first placement)
// ---------------------------
function frameToOrigin(padFactor = 1.8) {
  const box = new THREE.Box3().setFromObject(userGroup);
  let maxSize = 1;
  if (isFinite(box.min.x)) {
    const size = new THREE.Vector3(); box.getSize(size);
    maxSize = Math.max(size.x, size.y, size.z);
  }
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitH = maxSize / (2 * Math.tan(fov / 2));
  const fitW = fitH / camera.aspect;
  const dist = padFactor * Math.max(fitH, fitW) + 0.5;

  const origin = new THREE.Vector3(0, 0, 0);
  const viewDir = new THREE.Vector3(0.8, 0.5, 1).normalize();

  controls.target.copy(origin);
  camera.position.copy(origin.clone().addScaledVector(viewDir, dist));
  camera.near = Math.max(0.01, dist / 100);
  camera.far  = Math.max(100,  dist * 10);
  camera.updateProjectionMatrix();
  controls.update();
}

//
// ---------------------------
// Drawing events
// ---------------------------
function startDraw(e){
  if (state.mode !== "draw") return;
  state.drawing = true;
  state.points = [];
  state.surfacePoints3D = [];
  state.surfaceNormals  = [];
  state.drawTarget = null;

  toNDC(e);

  if (userGroup.children.length){
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(userGroup.children, true);
    if (hits.length){
      state.drawingOnSurface = true;
      state.drawTarget = findUserMeshRoot(hits[0].object);
      state.surfacePoints3D.push(hits[0].point.clone());
      const n0 = (hits[0].face?.normal || new THREE.Vector3(0,1,0))
        .clone().transformDirection(hits[0].object.matrixWorld).normalize();
      state.surfaceNormals.push(n0);
    } else {
      state.drawingOnSurface = false;
    }
  } else {
    state.drawingOnSurface = false; // first/base object
  }

  state.points.push(getPt(e));
  redrawStroke();
}

function moveDraw(e){
  if (!state.drawing || state.mode !== "draw") return;

  const p = getPt(e);
  const last = state.points[state.points.length-1];
  if (!last || Math.hypot(p.x-last.x, p.y-last.y) > 2){
    state.points.push(p); redrawStroke();
  }

  if (state.drawingOnSurface){
    toNDC(e);
    raycaster.setFromCamera(ndc, camera);

    let hit = null;
    if (state.drawTarget) {
      const hs = raycaster.intersectObject(state.drawTarget, true);
      if (hs.length) hit = hs[0];
    }
    if (!hit) {
      const hs = raycaster.intersectObjects(userGroup.children, true);
      if (hs.length) hit = hs[0];
    }

    if (hit){
      const world = hit.point.clone();
      const n = (hit.face?.normal || new THREE.Vector3(0,1,0))
        .clone().transformDirection(hit.object.matrixWorld).normalize();
      const last3 = state.surfacePoints3D[state.surfacePoints3D.length-1];
      if (!last3 || last3.distanceTo(world) > 0.003){
        state.surfacePoints3D.push(world);
        state.surfaceNormals.push(n);
      }
    }
  }
}

// quick hint toast
let hintTimer = null;
function hint(msg){
  if (hintTimer) clearTimeout(hintTimer);
  let el = document.getElementById("hint-toast");
  if (!el){
    el = document.createElement("div");
    el.id = "hint-toast";
    Object.assign(el.style, {
      position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)",
      background: "rgba(0,0,0,.75)", color: "white", padding: "8px 12px",
      borderRadius: "12px", fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
      fontSize: "13px", zIndex: "9999", pointerEvents: "none", transition: "opacity .2s"
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  hintTimer = setTimeout(()=>{ el.style.opacity = "0"; }, 1500);
}

function endDraw(){
  if (!state.drawing || state.mode !== "draw") return;
  state.drawing = false;

  // ADDITIONS (a model already exists)
  if (state.meshes.length > 0) {
    if (state.drawingOnSurface && state.surfacePoints3D.length >= 3){
      const geom = makePatchFromSurfacePoints(
        state.surfacePoints3D,
        state.surfaceNormals,
        0.06,
        0.004
      );
      if (geom) {
        const touches = touchesAnyUserMesh(geom, 0.006);
        if (touches) {
          addMesh(geom);           // keep perspective unchanged
        } else {
          hint("Addition ignored: it must touch the model.");
        }
      } else {
        hint("Too few points to add a patch.");
      }
    } else {
      hint("Additions must start on the model.");
    }

    // cleanup & UI
    state.points = [];
    state.surfacePoints3D = [];
    state.surfaceNormals  = [];
    state.drawTarget = null;
    redrawStroke();
    return;
  }

  // BASE OBJECT (no model yet)
  make3DFromPoints(state.points, state.makeMode);
  state.points = []; redrawStroke();
}

drawCanvas.addEventListener("pointerdown", startDraw);
drawCanvas.addEventListener("pointermove", moveDraw);
addEventListener("pointerup", endDraw);
drawCanvas.addEventListener("touchstart", startDraw, { passive:true });
drawCanvas.addEventListener("touchmove", moveDraw, { passive:true });
addEventListener("touchend", endDraw);

//
// ---------------------------
// Base geometry builders
// ---------------------------
function pointsToNormalized(points){
  if (!points || points.length < 2) return null;
  const xs = points.map(p=>p.x), ys = points.map(p=>p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(1, maxX-minX), h = Math.max(1, maxY-minY);
  return points.map(p=>({ x: ((p.x-minX)/w - 0.5)*2, y: -((p.y-minY)/h - 0.5)*2 }));
}

function makeExtrude(norm){
  const shape = new THREE.Shape();
  norm.forEach((p,i)=> i?shape.lineTo(p.x,p.y):shape.moveTo(p.x,p.y));
  const last = norm[norm.length-1];
  const d = Math.hypot(norm[0].x - last.x, norm[0].y - last.y);
  if (d < 0.2) shape.lineTo(norm[0].x, norm[0].y);
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: 0.5, bevelEnabled:true, bevelThickness:0.05, bevelSize:0.05, bevelSegments:2, curveSegments:32
  });
  geom.center();
  return geom;
}

function makeLathe(norm){
  const sorted = [...norm].sort((a,b)=>a.y-b.y);
  const profile = sorted.map(p=>new THREE.Vector2(Math.max(0.02, Math.abs(p.x)), p.y));
  const geom = new THREE.LatheGeometry(profile, 64);
  geom.center();
  return geom;
}

//
// ---------------------------
// Add / place meshes
// ---------------------------
function addMesh(geom){
  if (!geom) return;
  const mat = new THREE.MeshStandardMaterial({ color: state.color, metalness: 0.05, roughness: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  userGroup.add(mesh);
  state.meshes.push(mesh);
}

function applyBaseMeshCentered(geom) {
  if (!geom) return;

  const mat = new THREE.MeshStandardMaterial({ color: state.color, metalness: 0.05, roughness: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);

  geom.computeBoundingBox();
  const minY = geom.boundingBox.min.y;
  const pad = 0.02;
  mesh.position.set(0, floor.position.y - minY + pad, 0);

  userGroup.add(mesh);
  state.meshes.push(mesh);
  state.baseMesh = mesh;

  // Frame once around origin & model
  frameToOrigin(1.8);
}

function make3DFromPoints(points, mode="extrude"){
  if (!points || points.length < 3) return;
  const norm = pointsToNormalized(points); if (!norm) return;
  const geom = (mode === "lathe") ? makeLathe(norm) : makeExtrude(norm);
  if (state.meshes.length === 0) {
    applyBaseMeshCentered(geom);
  }
}

//
// ---------------------------
// Mode toggle
// ---------------------------
function applyMode(){
  const drawOn = state.mode === "draw";
  renderer.domElement.style.pointerEvents = drawOn ? "none" : "auto";
  drawCanvas.style.pointerEvents = drawOn ? "auto" : "none";
  controls.enabled = !drawOn;
}
applyMode();

//
// ---------------------------
// Reset View helper & key
// ---------------------------
function resetViewToIllustration() { frameToOrigin(1.8); }
addEventListener("keydown", (e) => { if (e.key.toLowerCase?.() === "r") resetViewToIllustration(); });

//
// ---------------------------
/** UI — bottom-left controls */
// ---------------------------
function addButton(txt, onClick){
  const b = document.createElement("button");
  b.textContent = txt;
  Object.assign(b.style, {
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    fontSize: "16px",
    padding: "10px 14px",
    margin: "0 8px 8px 0",
    borderRadius: "14px",
    border: "0",
    boxShadow: "0 2px 8px rgba(0,0,0,.15)",
    background: "#4d7471",
    color: "white",
    cursor: "pointer",
  });
  b.addEventListener("click", onClick);
  return b;
}

const uiBL = document.createElement("div");
Object.assign(uiBL.style, { position: "fixed", left: "12px", bottom: "12px", zIndex: "3", display: "flex", flexWrap: "wrap", alignItems: "center" });
document.body.appendChild(uiBL);

const modeBtn  = addButton("Mode: Draw ✍️", () => {
  state.mode = state.mode === "draw" ? "orbit" : "draw";
  modeBtn.textContent = state.mode === "draw" ? "Mode: Draw ✍️" : "Mode: Orbit 🌀";
  applyMode();
});
const typeBtn  = addButton("Make: Extrude 🍪", () => {
  state.makeMode = state.makeMode === "extrude" ? "lathe" : "extrude";
  typeBtn.textContent = state.makeMode === "extrude" ? "Make: Extrude 🍪" : "Make: Lathe 🏺";
});
const undoBtn  = addButton("Undo ⬅️", () => {
  const m = state.meshes.pop();
  if (!m) return;
  if (m === state.baseMesh) state.baseMesh = null;
  userGroup.remove(m);
  m.geometry.dispose(); m.material.dispose();
});
const clearBtn = addButton("Clear All 🧽", () => {
  state.points = []; redrawStroke();
  state.meshes.forEach(m => { userGroup.remove(m); m.geometry.dispose(); m.material.dispose(); });
  state.meshes = [];
  state.baseMesh = null;
});
const resetBtn = addButton("Reset View 🔄", resetViewToIllustration);

uiBL.append(modeBtn, typeBtn, undoBtn, clearBtn, resetBtn);

//
// ---------------------------
// Color panel — top-right (includes brown)
// ---------------------------
const colorUI = document.createElement("div");
Object.assign(colorUI.style, {
  position: "fixed", right: "12px", top: "12px", zIndex: "4",
  background: "rgba(255,255,255,0.92)", padding: "8px 10px",
  borderRadius: "12px", boxShadow: "0 2px 10px rgba(0,0,0,.15)",
  display: "flex", alignItems: "center", gap: "8px"
});
document.body.appendChild(colorUI);

const label = document.createElement("div");
label.textContent = "Color:";
Object.assign(label.style, { fontFamily:"system-ui,-apple-system,Segoe UI,Roboto,sans-serif", fontSize:"14px", color:"#333" });
colorUI.appendChild(label);

const swatches = ["#f44336","#ff9800","#ffeb3b","#4caf50","#2196f3","#3f51b5","#9c27b0","#8B4513","#ffffff","#000000"];
let selectedSwatchEl = null;

function makeSwatch(c){
  const s = document.createElement("button");
  Object.assign(s.style, {
    width:"22px", height:"22px", borderRadius:"50%", border:"1px solid #ccc",
    background:c, cursor:"pointer"
  });
  s.addEventListener("click", () => {
    state.color = c;
    if (selectedSwatchEl) selectedSwatchEl.style.outline = "none";
    s.style.outline = "2px solid #222"; selectedSwatchEl = s;
    colorInput.value = toHex(c);
  });
  return s;
}
function toHex(c){
  const tmp = new Option().style; tmp.color = c;
  document.body.appendChild(tmp);
  const rgb = getComputedStyle(tmp).color; document.body.removeChild(tmp);
  const m = rgb.match(/\d+/g).map(Number);
  return "#" + m.slice(0,3).map(n=>n.toString(16).padStart(2,"0")).join("");
}
swatches.forEach(c => colorUI.appendChild(makeSwatch(c)));

const colorInput = document.createElement("input");
colorInput.type = "color"; colorInput.value = state.color;
Object.assign(colorInput.style, { width:"28px", height:"28px", border:"none", background:"transparent", padding:"0", cursor:"pointer" });
colorInput.addEventListener("input", (e) => {
  state.color = e.target.value;
  if (selectedSwatchEl) selectedSwatchEl.style.outline = "none";
  selectedSwatchEl = null;
});
colorUI.appendChild(colorInput);

// Preselect default color
setTimeout(() => {
  const btns = colorUI.querySelectorAll("button");
  for (const b of btns){ if (toHex(b.style.backgroundColor).toLowerCase() === state.color.toLowerCase()){ b.click(); break; } }
}, 0);

//
// ---------------------------
// Export menu — top-left (dropdown)
// ---------------------------
const uiTL = document.createElement("div");
Object.assign(uiTL.style, {
  position: "fixed",
  left: "12px",
  top: "12px",
  zIndex: "4"
});
document.body.appendChild(uiTL);

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function ensureExportable() {
  if (!state.meshes.length) { alert("Nothing to export yet."); return false; }
  scene.updateMatrixWorld(true);
  userGroup.updateMatrixWorld(true);
  return true;
}
function makeMenuItem(label, onClick) {
  const item = document.createElement("button");
  item.textContent = label;
  Object.assign(item.style, {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    background: "white",
    color: "#222",
    border: "none",
    cursor: "pointer",
    fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    fontSize: "14px"
  });
  item.addEventListener("click", () => { hideMenu(); onClick(); });
  item.addEventListener("mouseenter", () => item.style.background = "#f3f3f3");
  item.addEventListener("mouseleave", () => item.style.background = "white");
  return item;
}

const menu = document.createElement("div");
Object.assign(menu.style, {
  position: "absolute",
  top: "44px",
  left: "0",
  minWidth: "180px",
  background: "white",
  borderRadius: "12px",
  boxShadow: "0 10px 24px rgba(0,0,0,.18)",
  border: "1px solid #e6e6e6",
  overflow: "hidden",
  display: "none"
});
uiTL.appendChild(menu);

function showMenu() { menu.style.display = "block"; }
function hideMenu() { menu.style.display = "none"; }

const saveBtn = document.createElement("button");
saveBtn.textContent = "Save ⬇️";
Object.assign(saveBtn.style, {
  fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
  fontSize: "16px",
  padding: "10px 14px",
  borderRadius: "14px",
  border: "0",
  boxShadow: "0 2px 8px rgba(0,0,0,.15)",
  background: "#4d7471",
  color: "white",
  cursor: "pointer"
});
saveBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (menu.style.display === "block") hideMenu(); else showMenu();
});
uiTL.appendChild(saveBtn);

// Close on outside click / ESC
addEventListener("click", (e) => { if (!uiTL.contains(e.target)) hideMenu(); });
addEventListener("keydown", (e) => { if (e.key === "Escape") hideMenu(); });

// ==== Dropdown items (GLB / GLTF / STL / OBJ) ====
menu.appendChild(makeMenuItem("GLB (glTF 2.0, binary)", () => {
  if (!ensureExportable()) return;
  const exporter = new GLTFExporter();
  exporter.parse(
    userGroup,
    (buffer) => saveBlob(new Blob([buffer], { type: "model/gltf-binary" }), "drawing-3d.glb"),
    { binary: true, onlyVisible: true, forceIndices: true, includeCustomExtensions: false }
  );
}));
menu.appendChild(makeMenuItem("GLTF (glTF 2.0, JSON)", () => {
  if (!ensureExportable()) return;
  const exporter = new GLTFExporter();
  exporter.parse(
    userGroup,
    (gltf) => saveBlob(new Blob([JSON.stringify(gltf)], { type: "model/gltf+json" }), "drawing-3d.gltf"),
    { binary: false, onlyVisible: true, forceIndices: true, includeCustomExtensions: false }
  );
}));
menu.appendChild(makeMenuItem("STL (geometry only)", () => {
  if (!ensureExportable()) return;
  const exporter = new STLExporter();
  const arrayBuffer = exporter.parse(userGroup, { binary: true });
  saveBlob(new Blob([arrayBuffer], { type: "model/stl" }), "drawing-3d.stl");
}));
menu.appendChild(makeMenuItem("OBJ (geometry + groups)", () => {
  if (!ensureExportable()) return;
  const exporter = new OBJExporter();
  const objText = exporter.parse(userGroup);
  saveBlob(new Blob([objText], { type: "text/plain" }), "drawing-3d.obj");
}));

// ---------------------------
// Onboarding popup (first run)
// ---------------------------
function showOnboardingModal() {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,.45)",
    zIndex: "9999",
    display: "grid",
    placeItems: "center",
  });

  const card = document.createElement("div");
  Object.assign(card.style, {
    width: "min(92vw, 560px)",
    background: "white",
    color: "#222",
    borderRadius: "16px",
    boxShadow: "0 10px 30px rgba(0,0,0,.25)",
    padding: "18px 20px",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  });
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.innerHTML = `
    <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;">Welcome to Manifest</h2>
    <p style="margin:0 0 12px;font-size:14px;">Quick how-to:</p>
    <ul style="padding-left:18px;margin:0 0 12px;line-height:1.5;font-size:14px;">
      <li><b>Draw anywhere</b> to create your first shape (toggle <i>Make: Extrude/Lathe</i>).</li>
      <li>After that, draw <b>on the model</b> to add patches. Patches are built in the touched surface plane and <b>extrude perpendicular</b> to that surface.</li>
      <li>Use <b>Mode: Orbit</b> to look around (touch: 1-finger rotate, 2-finger pan/zoom). Press <b>R</b> or use <b>Reset View</b> anytime.</li>
      <li>Pick a <b>color</b> (top-right). Use <b>Undo/Clear</b> (bottom-left). <b>Save</b> via the top-left button.</li>
    </ul>
  `;

  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" });

  const label = document.createElement("label");
  Object.assign(label.style, { fontSize: "13px", display: "flex", alignItems: "center", gap: "8px" });
  const cb = document.createElement("input");
  cb.type = "checkbox";
  label.append(cb, document.createTextNode("Don’t show this again"));

  const ok = document.createElement("button");
  ok.textContent = "Got it";
  Object.assign(ok.style, {
    fontSize: "16px", padding: "10px 14px", borderRadius: "14px", border: "0",
    background: "#4d7471", color: "white", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,.15)",
  });

  function close() {
    if (cb.checked) { try { localStorage.setItem("drawing3d_onboarded", "1"); } catch {} }
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  }
  function onKey(e){ if (e.key === "Escape") close(); }

  ok.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", onKey);

  row.append(label, ok);
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// Show once on first load
try {
  const skip = localStorage.getItem("drawing3d_onboarded") === "1";
  if (!skip) showOnboardingModal();
} catch {
  showOnboardingModal();
}

//
// ---------------------------
// Route input to draw canvas in draw mode
// ---------------------------
renderer.domElement.style.pointerEvents = "none";
drawCanvas.style.pointerEvents = "auto";

//
// ---------------------------
// Render loop
// ---------------------------
(function loop(){
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
})();
