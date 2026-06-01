import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";

// ── State ──────────────────────────────────────────────────────────
let scene, camera, renderer, controls, gridHelper, currentModel;

const textureFiles = new Map();   // name → File
const loadedTextures = new Map(); // name → THREE.Texture
const textureEnabled = new Map(); // name → boolean
const originalMaterials = new Map(); // mesh uuid → { slot, origMap }

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

  // Lighting
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

    // Pre-load texture images into THREE.Texture
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

    // Collect original material texture references
    cacheOriginalMaterials(model);

    // Build texture panel with toggles
    buildTexturePanel();

    setStatus(`Model loaded — ${countMeshes(model)} mesh(es)`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }

  btnLoad.disabled = false;
});

// ── Parse MTL (from File) ──────────────────────────────────────────
function parseMTL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const loader = new MTLLoader();

        // Custom texture resolver: looks up our loaded textures
        const text = reader.result;
        const matCreator = loader.parse(text, "");

        // Override texture loading to use our pre-loaded textures
        const origCreate = matCreator.create.bind(matCreator);
        matCreator.create = function (name) {
          // Let MTLLoader create the material first
        };

        // Instead, manually handle: parse materials then swap textures
        matCreator.preload();

        // For each material, replace textures with our loaded ones
        for (const [name, mat] of Object.entries(matCreator.materials)) {
          patchMaterialTextures(mat);
        }

        resolve(matCreator);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function patchMaterialTextures(material) {
  const mapTypes = ["map", "normalMap", "specularMap", "emissiveMap", "bumpMap", "alphaMap"];
  for (const mt of mapTypes) {
    if (material[mt] && material[mt].image === undefined) {
      // The MTL referenced a texture file — try to match it
      const texName = findTextureMatch(material[mt].name || material[mt].sourceFile || "");
      if (texName && loadedTextures.has(texName)) {
        material[mt] = loadedTextures.get(texName).clone();
        material[mt].needsUpdate = true;
      }
    }
  }
  // Also check if there's a map_Kd reference stored on the material
  if (material.userData && material.userData.mapKd) {
    const texName = findTextureMatch(material.userData.mapKd);
    if (texName && loadedTextures.has(texName)) {
      material.map = loadedTextures.get(texName).clone();
      material.map.needsUpdate = true;
    }
  }
}

function findTextureMatch(refName) {
  if (!refName) return null;
  // Exact match first
  if (textureFiles.has(refName)) return refName;
  // Basename match
  const base = refName.split(/[\\/]/).pop();
  if (textureFiles.has(base)) return base;
  // Case-insensitive
  const lower = base.toLowerCase();
  for (const name of textureFiles.keys()) {
    if (name.toLowerCase() === lower) return name;
  }
  return null;
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

        // If no MTL, apply loaded textures to meshes automatically
        if (!materials && loadedTextures.size > 0) {
          autoApplyTextures(obj);
        }

        // Ensure all materials with textures also reference loaded textures
        obj.traverse((child) => {
          if (child.isMesh) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
              resolveMatTextures(mat);
            }
          }
        });

        resolve(obj);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function resolveMatTextures(mat) {
  const mapTypes = ["map", "normalMap", "specularMap", "emissiveMap", "bumpMap", "alphaMap"];
  for (const mt of mapTypes) {
    const tex = mat[mt];
    if (!tex) continue;
    // If texture has no image data, try resolving from our loaded textures
    if (!tex.image || (tex.image && tex.image.width === 0)) {
      const src = tex.name || tex.sourceFile || (tex.userData && tex.userData.src) || "";
      const match = findTextureMatch(src);
      if (match && loadedTextures.has(match)) {
        mat[mt] = loadedTextures.get(match).clone();
        mat[mt].needsUpdate = true;
      }
    }
  }
}

function autoApplyTextures(obj) {
  // If there's exactly one texture, apply to all meshes
  // If there are multiple, apply to meshes by matching name heuristic or first available
  const texArr = [...loadedTextures.entries()];
  if (texArr.length === 0) return;

  obj.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat.map) {
        // Try to match by mesh/material name, else use first texture
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
        mat.map = loadedTextures.get(texName).clone();
        mat.map.needsUpdate = true;
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

// ── Original material cache ────────────────────────────────────────
function cacheOriginalMaterials(model) {
  originalMaterials.clear();
  model.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat, idx) => {
      const mapTypes = ["map", "normalMap", "specularMap", "emissiveMap", "bumpMap", "alphaMap"];
      for (const mt of mapTypes) {
        if (mat[mt] && mat[mt].name) {
          const key = `${child.uuid}_${idx}_${mt}`;
          originalMaterials.set(key, {
            mesh: child,
            matIndex: idx,
            mapType: mt,
            textureName: mat[mt].name,
            texture: mat[mt],
          });
        }
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

  const names = new Set([...textureFiles.keys(), ...loadedTextures.keys()]);
  // Also collect texture names from the model materials
  if (currentModel) {
    currentModel.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        for (const mt of ["map", "normalMap", "specularMap", "emissiveMap", "bumpMap", "alphaMap"]) {
          if (mat[mt] && mat[mt].name) names.add(mat[mt].name);
        }
      }
    });
  }

  for (const name of names) {
    if (!textureEnabled.has(name)) textureEnabled.set(name, true);

    const div = document.createElement("div");
    div.className = "tex-item";

    // Thumbnail
    const tex = loadedTextures.get(name);
    if (tex && tex.image) {
      const thumb = document.createElement("img");
      thumb.className = "tex-thumb";
      thumb.src = tex.image.src || "";
      div.appendChild(thumb);
    }

    // Label
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = name;
    span.title = name;
    label.appendChild(span);
    div.appendChild(label);

    // Toggle
    const toggle = document.createElement("div");
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
