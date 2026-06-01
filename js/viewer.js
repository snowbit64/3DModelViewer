import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";

// ── State ──────────────────────────────────────────────────────────
let scene, camera, renderer, controls, gridHelper, currentModel;

const textureFiles = new Map();   // name → File
const loadedTextures = new Map(); // name → THREE.Texture
const textureEnabled = new Map(); // name → boolean
const originalMaterials = new Map(); // key → { mesh, matIndex, mapType, textureName, texture }

let objFile = null;
let mtlFile = null;

// ── DOM refs ───────────────────────────────────────────────────────
const canvas    = document.getElementById("viewer-canvas");
const objInput  = document.getElementById("obj-input");
const mtlInput  = document.getElementById("mtl-input");
const texInput  = document.getElementById("tex-input");
const btnLoad   = document.getElementById("btn-load");
const btnClear  = document.getElementById("btn-clear");
const fileInfo  = document.getElementById("file-info");
const texList   = document.getElementById("texture-list");
const statusBar = document.getElementById("status-bar");

// ── Init three.js ──────────────────────────────────────────────────
function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  camera = new THREE.PerspectiveCamera(60, 1, 0.01, 5000);
  camera.position.set(3, 3, 3);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const dir1 = new THREE.DirectionalLight(0xffffff, 1.0);
  dir1.position.set(5, 10, 7);
  scene.add(dir1);

  const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dir2.position.set(-5, 5, -5);
  scene.add(dir2);

  gridHelper = new THREE.GridHelper(20, 20, 0x333355, 0x222244);
  scene.add(gridHelper);

  onResize();
  window.addEventListener("resize", onResize);
  animate();
}

function onResize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const panelW = document.getElementById("texture-panel").offsetWidth;
  const w = rect.width - panelW;
  const h = rect.height;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ── File handling ──────────────────────────────────────────────────
objInput.addEventListener("change", (e) => {
  objFile = e.target.files[0] || null;
  updateFileInfo();
});

mtlInput.addEventListener("change", (e) => {
  mtlFile = e.target.files[0] || null;
  updateFileInfo();
});

texInput.addEventListener("change", (e) => {
  for (const f of e.target.files) {
    textureFiles.set(f.name, f);
  }
  updateFileInfo();
  buildTexturePanel();
});

function updateFileInfo() {
  const parts = [];
  if (objFile) parts.push(`OBJ: ${objFile.name}`);
  if (mtlFile) parts.push(`MTL: ${mtlFile.name}`);
  if (textureFiles.size) parts.push(`Textures: ${textureFiles.size}`);
  fileInfo.textContent = parts.join(" | ") || "";
  btnLoad.disabled = !objFile;
}

// ── Load model ─────────────────────────────────────────────────────
btnLoad.addEventListener("click", async () => {
  if (!objFile) return;
  setStatus("Loading model…");
  btnLoad.disabled = true;

  try {
    clearModel();

    await loadAllTextures();

    let materials = null;
    if (mtlFile) {
      materials = await parseMTL(mtlFile);
    }

    const model = await parseOBJ(objFile, materials);
    currentModel = model;
    scene.add(model);

    // Center & scale
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 4 / (maxDim || 1);
    model.scale.setScalar(scale);
    model.position.sub(center.multiplyScalar(scale));

    cacheOriginalMaterials(model);
    buildTexturePanel();

    setStatus(`Model loaded — ${countMeshes(model)} mesh(es)`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }

  btnLoad.disabled = false;
});

// ── Texture name matching ──────────────────────────────────────────
function findTextureMatch(refName) {
  if (!refName) return null;
  if (loadedTextures.has(refName)) return refName;
  const base = refName.split(/[\\/]/).pop();
  if (loadedTextures.has(base)) return base;
  const lower = base.toLowerCase();
  for (const name of loadedTextures.keys()) {
    if (name.toLowerCase() === lower) return name;
  }
  return null;
}

// ── Parse MTL (from File) ──────────────────────────────────────────
function parseMTL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const loader = new MTLLoader();
        const text = reader.result;
        const matCreator = loader.parse(text, "");

        // Override the internal loadTexture so MTLLoader uses our
        // pre-loaded in-memory textures instead of fetching URLs
        matCreator.loadTexture = function (url, mapping, onLoad) {
          const match = findTextureMatch(url);
          if (match && loadedTextures.has(match)) {
            const tex = loadedTextures.get(match).clone();
            tex.name = match;
            if (mapping !== undefined) tex.mapping = mapping;
            tex.needsUpdate = true;
            if (onLoad) onLoad(tex);
            return tex;
          }
          // Return blank texture for unresolved references
          const blank = new THREE.Texture();
          blank.name = url;
          if (onLoad) onLoad(blank);
          return blank;
        };

        matCreator.preload();
        resolve(matCreator);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ── Parse OBJ (from File) ──────────────────────────────────────────
function parseOBJ(file, materials) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const loader = new OBJLoader();
        if (materials) {
          loader.setMaterials(materials);
        }
        const obj = loader.parse(reader.result);

        // If no MTL provided but textures are loaded, auto-apply
        if (!materials && loadedTextures.size > 0) {
          autoApplyTextures(obj);
        }

        resolve(obj);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function autoApplyTextures(obj) {
  const texArr = [...loadedTextures.entries()];
  if (texArr.length === 0) return;

  obj.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat.map) {
        let matched = null;
        for (const [name] of texArr) {
          const meshName = (child.name || "").toLowerCase();
          const matName = (mat.name || "").toLowerCase();
          const tName = name.replace(/\.[^.]+$/, "").toLowerCase();
          if (meshName.includes(tName) || matName.includes(tName) || tName.includes(meshName) || tName.includes(matName)) {
            matched = name;
            break;
          }
        }
        const texName = matched || texArr[0][0];
        const tex = loadedTextures.get(texName).clone();
        tex.name = texName;
        tex.needsUpdate = true;
        mat.map = tex;
        mat.needsUpdate = true;
      }
    }
  });
}

// ── Texture loading ────────────────────────────────────────────────
async function loadAllTextures() {
  loadedTextures.clear();
  const promises = [];

  for (const [name, file] of textureFiles) {
    promises.push(
      loadTextureFromFile(file).then((tex) => {
        tex.name = name;
        loadedTextures.set(name, tex);
        if (!textureEnabled.has(name)) {
          textureEnabled.set(name, true);
        }
      })
    );
  }

  await Promise.all(promises);
}

function loadTextureFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const tex = new THREE.Texture(img);
        tex.needsUpdate = true;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        resolve(tex);
      };
      img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Original material cache (for texture toggles) ──────────────────
function cacheOriginalMaterials(model) {
  originalMaterials.clear();
  model.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat, idx) => {
      const mapTypes = ["map", "normalMap", "specularMap", "emissiveMap", "bumpMap", "alphaMap"];
      for (const mt of mapTypes) {
        const tex = mat[mt];
        if (!tex) continue;
        const texName = tex.name || "";
        if (!texName) continue;
        const key = `${child.uuid}_${idx}_${mt}`;
        originalMaterials.set(key, {
          mesh: child,
          matIndex: idx,
          mapType: mt,
          textureName: texName,
          texture: tex,
        });
      }
    });
  });
}

// ── Texture panel (toggles) ───────────────────────────────────────
function buildTexturePanel() {
  texList.innerHTML = "";

  if (textureFiles.size === 0 && loadedTextures.size === 0) {
    texList.innerHTML = "<em>No textures loaded</em>";
    return;
  }

  // Collect all texture names: from loaded files + from model materials
  const names = new Set([...loadedTextures.keys()]);
  for (const entry of originalMaterials.values()) {
    if (entry.textureName) names.add(entry.textureName);
  }

  for (const name of names) {
    if (!textureEnabled.has(name)) textureEnabled.set(name, true);

    const div = document.createElement("div");
    div.className = "tex-item";

    // Thumbnail
    const tex = loadedTextures.get(name);
    if (tex && tex.image && tex.image.src) {
      const thumb = document.createElement("img");
      thumb.className = "tex-thumb";
      thumb.src = tex.image.src;
      div.appendChild(thumb);
    }

    // Label
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = name;
    span.title = name;
    label.appendChild(span);
    div.appendChild(label);

    // Toggle switch — use <label> so clicking the slider toggles the checkbox
    const toggle = document.createElement("label");
    toggle.className = "toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = textureEnabled.get(name);
    const slider = document.createElement("span");
    slider.className = "slider";
    toggle.appendChild(cb);
    toggle.appendChild(slider);
    div.appendChild(toggle);

    cb.addEventListener("change", () => {
      textureEnabled.set(name, cb.checked);
      applyTextureToggle(name, cb.checked);
    });

    texList.appendChild(div);
  }
}

function applyTextureToggle(texName, enabled) {
  if (!currentModel) return;

  currentModel.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat, idx) => {
      for (const mt of ["map", "normalMap", "specularMap", "emissiveMap", "bumpMap", "alphaMap"]) {
        const key = `${child.uuid}_${idx}_${mt}`;
        const cached = originalMaterials.get(key);
        if (cached && cached.textureName === texName) {
          if (enabled) {
            mat[mt] = cached.texture;
          } else {
            mat[mt] = null;
          }
          mat.needsUpdate = true;
        }
      }
    });
  });
}

// ── Clear ──────────────────────────────────────────────────────────
btnClear.addEventListener("click", () => {
  clearAll();
});

function clearModel() {
  if (currentModel) {
    scene.remove(currentModel);
    currentModel.traverse((child) => {
      if (child.isMesh) {
        child.geometry.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => m.dispose());
      }
    });
    currentModel = null;
  }
  originalMaterials.clear();
}

function clearAll() {
  clearModel();
  objFile = null;
  mtlFile = null;
  textureFiles.clear();
  loadedTextures.clear();
  textureEnabled.clear();
  objInput.value = "";
  mtlInput.value = "";
  texInput.value = "";
  fileInfo.textContent = "";
  btnLoad.disabled = true;
  texList.innerHTML = "<em>No textures loaded</em>";
  setStatus("Cleared");
}

// ── Helpers ────────────────────────────────────────────────────────
function countMeshes(obj) {
  let c = 0;
  obj.traverse((ch) => { if (ch.isMesh) c++; });
  return c;
}

function setStatus(msg) {
  statusBar.textContent = msg;
}

// ── Bootstrap ──────────────────────────────────────────────────────
initScene();
