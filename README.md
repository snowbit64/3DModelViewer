# 3D Model Viewer

Browser-based 3D model viewer with texture support. No server required — runs entirely in the browser via [Three.js](https://threejs.org/).

## Features

- **OBJ + MTL loading** — Load `.obj` geometry and `.mtl` material files
- **Texture support** — Load PNG/JPEG textures; automatically mapped via MTL references
- **Auto-texturing** — When no MTL is provided, textures are applied automatically to meshes
- **Per-texture toggle** — Enable/disable individual textures in real-time via the side panel
- **Orbit controls** — Rotate, pan, and zoom with mouse

## Usage

1. Open the viewer (via GitHub Pages or locally)
2. Click **Load OBJ** to select a `.obj` file
3. Optionally click **Load MTL** to select the corresponding `.mtl` file
4. Click **Load Textures** to add PNG/JPEG texture files
5. Click **Load Model** to render
6. Toggle textures on/off in the right panel

## Deploy

The project deploys automatically to GitHub Pages on push to `main` via the included GitHub Actions workflow.

## Local Development

Simply serve the project root with any static HTTP server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open `http://localhost:8000` (or the port shown).

## License

MIT
