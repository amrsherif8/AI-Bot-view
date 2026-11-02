/* FUNKE 3D-Viewer: reines WebGL2, keine externe Bibliothek.
 * Lädt die GLB-Datei und spielt Animationen ab (Idle + Clips wie Tanzen, Rechnen, Lesen ...).
 *
 *   const v = FunkeViewer.create(canvas, { url, parts, onReady, onError });
 *   v.play("dance")      einmal abspielen (kurzer Clip)
 *   v.hold("think")      Dauerhaltung, bis v.release() aufgerufen wird
 *   v.release()
 *   v.pick(x, y)         id des Teils (opts.parts-Schlüssel) unter dem Bildschirmpunkt, sonst null
 *   v.busy()             true, solange ein Clip oder eine Haltung läuft
 *   v.names              Liste aller Clips
 *   v.destroy()
 *
 * opts.parts: { id: { node: <Mesh-Knoten in der GLB>, kind: "head"|"body"|"arm"|"leg", side: -1|1 } }
 * side: -1 = rechte Seite des Roboters (links im Bild), 1 = linke Seite des Roboters (rechts im Bild)
 */
(function () {
  "use strict";

  // ---------- kleine Matrix-Helfer (spaltenweise, wie WebGL) ----------
  const M = {
    id: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
          o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      return o;
    },
    trs(t, q, s) {
      const [x, y, z, w] = q, [sx, sy, sz] = s;
      const o = M.id();
      o[0] = (1 - 2 * (y * y + z * z)) * sx; o[1] = (2 * (x * y + z * w)) * sx; o[2] = (2 * (x * z - y * w)) * sx;
      o[4] = (2 * (x * y - z * w)) * sy; o[5] = (1 - 2 * (x * x + z * z)) * sy; o[6] = (2 * (y * z + x * w)) * sy;
      o[8] = (2 * (x * z + y * w)) * sz; o[9] = (2 * (y * z - x * w)) * sz; o[10] = (1 - 2 * (x * x + y * y)) * sz;
      o[12] = t[0]; o[13] = t[1]; o[14] = t[2];
      return o;
    },
    translate: (x, y, z) => { const o = M.id(); o[12] = x; o[13] = y; o[14] = z; return o; },
    rotX(a) { const c = Math.cos(a), s = Math.sin(a), o = M.id(); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; },
    rotY(a) { const c = Math.cos(a), s = Math.sin(a), o = M.id(); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; },
    rotZ(a) { const c = Math.cos(a), s = Math.sin(a), o = M.id(); o[0] = c; o[1] = s; o[4] = -s; o[5] = c; return o; },
    perspective(fov, aspect, near, far) {
      const f = 1 / Math.tan(fov / 2), o = new Float32Array(16);
      o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = (2 * far * near) / (near - far);
      return o;
    },
    // Drehung um einen Punkt: T(p) * R * T(-p)
    around(p, rot) { return M.mul(M.translate(p[0], p[1], p[2]), M.mul(rot, M.translate(-p[0], -p[1], -p[2]))); },
    transformPoint(m, p) {
      return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      ];
    },
  };
  // Reihenfolge wie bisher: erst um Z (seitlich), dann um X (vor/zurück), dann um Y (drehen)
  const euler = (rx, ry, rz) => M.mul(M.rotY(ry), M.mul(M.rotX(rx), M.rotZ(rz)));

  // ---------- GLB lesen ----------
  function parseGlb(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file");
    let off = 12, json = null, bin = null;
    while (off < buf.byteLength) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      const data = buf.slice(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
      else if (type === 0x004e4942) bin = data;
      off += 8 + len;
    }
    if (!json || !bin) throw new Error("GLB chunks missing");
    return { json, bin };
  }

  function accessorData(g, index) {
    const a = g.json.accessors[index], bv = g.json.bufferViews[a.bufferView];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const Type = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    return new Type(g.bin, start, a.count * comps);
  }

  function nodeLocal(n) {
    if (n.matrix) return new Float32Array(n.matrix);
    return M.trs(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
  }

  function worldMatrices(json) {
    const parent = {};
    json.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
    const cache = {};
    const world = (i) => {
      if (cache[i]) return cache[i];
      const local = nodeLocal(json.nodes[i]);
      return (cache[i] = i in parent ? M.mul(world(parent[i]), local) : local);
    };
    return world;
  }

  // ---------- Shader ----------
  const VS = `#version 300 es
  in vec3 aPos; in vec3 aNrm; in vec2 aUv;
  uniform mat4 uModel; uniform mat4 uVP;
  out vec3 vN; out vec2 vUv; out vec3 vW;
  void main() {
    vec4 w = uModel * vec4(aPos, 1.0);
    vW = w.xyz; vN = mat3(uModel) * aNrm; vUv = aUv;
    gl_Position = uVP * w;
  }`;

  const FS = `#version 300 es
  precision highp float;
  in vec3 vN; in vec2 vUv; in vec3 vW;
  uniform sampler2D uBase; uniform sampler2D uEmis;
  uniform vec4 uBaseFactor; uniform float uHasBase; uniform float uHasEmis; uniform float uMetal;
  uniform vec3 uCam;
  out vec4 outColor;
  vec3 env(vec3 d) {
    float h = d.y * 0.5 + 0.5;
    vec3 sky = vec3(0.78, 0.86, 1.0), ground = vec3(0.16, 0.14, 0.15);
    float sun = pow(max(dot(d, normalize(vec3(0.5, 0.8, 0.6))), 0.0), 40.0);
    return mix(ground, sky, smoothstep(0.1, 0.9, h)) + sun * 1.2;
  }
  void main() {
    vec3 N = normalize(vN);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(uCam - vW);
    vec4 base = uBaseFactor;
    if (uHasBase > 0.5) base *= texture(uBase, vUv);
    vec3 albedo = pow(base.rgb, vec3(2.2));
    vec3 L1 = normalize(vec3(0.5, 0.8, 0.6)), L2 = normalize(vec3(-0.7, 0.2, 0.4));
    float d1 = max(dot(N, L1), 0.0), d2 = max(dot(N, L2), 0.0);
    vec3 hemi = mix(vec3(0.16, 0.15, 0.17), vec3(0.42, 0.46, 0.55), N.y * 0.5 + 0.5);
    vec3 light = hemi + vec3(1.0, 0.97, 0.92) * d1 * 0.85 + vec3(0.45, 0.55, 0.8) * d2 * 0.35;
    vec3 col = albedo * light;
    vec3 R = reflect(-V, N);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col = mix(col, albedo * env(R) * 1.1, uMetal * 0.55) + env(R) * (0.05 + 0.25 * fres);
    if (uHasEmis > 0.5) col += pow(texture(uEmis, vUv).rgb, vec3(2.2)) * 0.5;
    outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
  }`;

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  // ---------- Animationen ----------
  // Alle Winkel in Radiant. Jede Funktion gibt nur die Werte zurück, die der Clip übernimmt;
  // alles andere bleibt bei der Idle-Bewegung.
  //   Kopf:  rx>0 = nicken (nach unten), ry = drehen, rz = seitlich neigen
  //   Arm:   rx<0 = nach vorne/oben (-1.57 = waagerecht nach vorne, -3.14 = senkrecht nach oben)
  //          rz = seitlich nach außen: side * Winkel (3.14 = senkrecht nach oben)
  //   Bein:  rx<0 = nach vorne
  //   Root:  yaw = Körperdrehung, pitch = Neigung vor/zurück, roll = seitlich, bob/hop = hoch/runter
  const S = Math.sin, A = Math.abs;
  const CLIPS = {
    // Hallo sagen
    wave: {
      dur: 2.8,
      root: (t) => ({ yaw: S(t * 1.5) * 0.08, bob: S(t * 4) * 0.3 }),
      part: (k, s, t) => {
        if (k === "head") return { ry: S(t * 2) * 0.18, rz: 0.1, rx: 0 };
        if (k === "arm") return s > 0 ? { rz: 2.5 + S(t * 10) * 0.25, rx: 0 } : { rz: -0.12, rx: 0 };
        return null;
      },
    },
    // Tanzen (YouTube / Musik / Standard)
    dance: {
      dur: 3.4,
      root: (t) => ({ yaw: S(t * 3) * 0.55, roll: S(t * 6) * 0.07, hop: A(S(t * 6)) * 1.8 }),
      part: (k, s, t) => {
        const ph = s > 0 ? 0 : Math.PI;
        if (k === "head") return { ry: S(t * 3 + 1) * 0.35, rz: S(t * 6) * 0.14, rx: S(t * 6) * 0.1 };
        if (k === "arm") return { rz: s * (1.7 + 0.9 * S(t * 6 + ph)), rx: S(t * 3 + ph) * 0.5 - 0.2 };
        if (k === "leg") return { rx: S(t * 6 + ph) * 0.4, rz: s * 0.06 };
        return null;
      },
    },
    // Gleichung lösen: schaut zur "Tafel", schreibt mit einem Arm, der andere Arm am Kinn
    solve: {
      dur: 3.6,
      root: (t) => ({ yaw: 0.45 + S(t * 0.8) * 0.08, pitch: 0.05 }),
      part: (k, s, t) => {
        if (k === "head") return { rx: 0.3 + S(t * 2) * 0.05, ry: -0.1 + S(t * 1.3) * 0.25, rz: 0.1 };
        if (k === "arm") {
          return s < 0
            ? { rx: -1.35 + S(t * 8) * 0.1, rz: s * 0.18 + S(t * 5) * 0.08 }
            : { rx: -2.2 + S(t * 1.5) * 0.05, rz: 0.35 };
        }
        return null;
      },
    },
    // Übersetzen / sprechen: Gestik mit beiden Armen, Kopf schaut zwischen zwei "Sprachen" hin und her
    talk: {
      dur: 3.0,
      root: (t) => ({ yaw: S(t * 1.1) * 0.2, bob: S(t * 7) * 0.25 }),
      part: (k, s, t) => {
        const ph = s > 0 ? 0 : Math.PI;
        if (k === "head") return { ry: S(t * 2.2) * 0.32, rx: S(t * 7) * 0.06, rz: 0.05 };
        if (k === "arm") return { rx: -0.7 + S(t * 4.4 + ph) * 0.45, rz: s * (0.55 + 0.3 * S(t * 4.4 + ph + 1.5)) };
        return null;
      },
    },
    // Dokument lesen: Kopf nach unten, scannt hin und her, Arme halten ein "Buch"
    read: {
      dur: 3.4,
      root: (t) => ({ yaw: 0.15, pitch: 0.1 }),
      part: (k, s, t) => {
        if (k === "head") return { rx: 0.38, ry: S(t * 1.4) * 0.4, rz: 0 };
        if (k === "arm") {
          return s > 0
            ? { rx: -1.15, rz: 0.45 + S(t * 3) * 0.03 }
            : { rx: -1.1, rz: -(0.4 + 0.3 * S(t * 0.9)) };
        }
        return null;
      },
    },
    // Zuhören (Dauerhaltung): Kopf geneigt, Hand am "Ohr"
    listen: {
      dur: Infinity,
      root: (t) => ({ yaw: 0, bob: S(t * 2) * 0.25 }),
      part: (k, s, t) => {
        if (k === "head") return { rz: 0.28 + S(t * 1.5) * 0.04, ry: 0.15, rx: -0.02 };
        if (k === "arm" && s > 0) return { rz: 2.1 + S(t * 3) * 0.04, rx: -0.25 };
        return null;
      },
    },
    // Nachdenken (Dauerhaltung): Hand am Kinn
    think: {
      dur: Infinity,
      root: (t) => ({ yaw: -0.2 + S(t * 0.5) * 0.1 }),
      part: (k, s, t) => {
        if (k === "head") return { rz: 0.22 + S(t * 0.9) * 0.05, rx: 0.12, ry: S(t * 0.7) * 0.15 };
        if (k === "arm" && s < 0) return { rx: -2.3 + S(t * 1.2) * 0.04, rz: s * 0.1 };
        return null;
      },
    },
    // Sounds: im Takt wippen
    bop: {
      dur: 3.0,
      root: (t) => ({ yaw: S(t * 2) * 0.25, hop: A(S(t * 4)) * 0.9, roll: S(t * 4) * 0.04 }),
      part: (k, s, t) => {
        const ph = s > 0 ? 0 : Math.PI;
        if (k === "head") return { rx: 0.05 + S(t * 8) * 0.2 };
        if (k === "arm") return { rx: S(t * 4 + ph) * 0.45, rz: s * 0.25 };
        if (k === "leg") return { rx: S(t * 4) * 0.1 };
        return null;
      },
    },
    // Umschauen
    look: {
      dur: 2.8,
      root: (t) => ({ yaw: S(t * 1.6) * 0.3 }),
      part: (k, s, t) => {
        if (k === "head") return { ry: S(t * 1.6) * 0.8, rx: S(t * 3.2) * 0.1 };
        if (k === "arm" && s < 0) return { rx: -2.6, rz: s * 0.1 };
        return null;
      },
    },
    // Wird gerade herumgetragen (beim Ziehen)
    carry: {
      dur: Infinity,
      root: (t) => ({ roll: S(t * 5) * 0.1, bob: 0 }),
      part: (k, s, t) => {
        const ph = s > 0 ? 0 : Math.PI;
        if (k === "head") return { rz: S(t * 5) * 0.2 };
        if (k === "arm") return { rz: s * (2.6 + S(t * 7 + ph) * 0.3), rx: 0 };
        if (k === "leg") return { rx: S(t * 5 + ph) * 0.35 };
        return null;
      },
    },
  };

  const smooth = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
  const FADE_IN = 0.35, FADE_OUT = 0.35;

  // ---------- Hauptklasse ----------
  function create(canvas, opts) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) { opts.onError && opts.onError(new Error("webgl2")); return null; }

    let alive = true, raf = 0, ready = false, paused = false;
    const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const prog = program(gl, VS, FS);
    const U = {};
    ["uModel", "uVP", "uBase", "uEmis", "uBaseFactor", "uHasBase", "uHasEmis", "uMetal", "uCam"]
      .forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));

    const items = [];
    const textures = {};
    let center = [0, 33, 0], extent = [16, 33];       // extent = halbe Breite / halbe Höhe des Modells
    let clock = 0;
    let layers = [];                                   // laufende Animationen { name, t0, dur, releasedAt }

    function makeTexture(bitmap) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
      return tex;
    }

    function buffer(target, data) {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    }

    async function load() {
      let buf;
      if (opts.bytes) buf = opts.bytes();                 // Demo: Modell ist bereits eingebettet
      else {
        const res = await fetch(opts.url, { credentials: "same-origin" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        buf = await res.arrayBuffer();
      }
      const g = parseGlb(buf);
      const world = worldMatrices(g.json);

      const imgIndex = (ref) => (ref ? g.json.textures[ref.index].source : null);
      const needed = new Set();
      g.json.materials.forEach((m) => {
        const a = imgIndex(m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture);
        const b = imgIndex(m.emissiveTexture);
        if (a != null) needed.add(a);
        if (b != null) needed.add(b);
      });
      await Promise.all([...needed].map(async (i) => {
        const im = g.json.images[i], bv = g.json.bufferViews[im.bufferView];
        const blob = new Blob([new Uint8Array(g.bin, bv.byteOffset || 0, bv.byteLength)], { type: im.mimeType });
        const bmp = await createImageBitmap(blob, { imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" });
        textures[i] = makeTexture(bmp);
        bmp.close && bmp.close();
      }));

      const mats = g.json.materials.map((m) => {
        const pbr = m.pbrMetallicRoughness || {};
        const b = imgIndex(pbr.baseColorTexture), e = imgIndex(m.emissiveTexture);
        return {
          factor: pbr.baseColorFactor || [1, 1, 1, 1],
          base: b != null ? textures[b] : null,
          emis: e != null ? textures[e] : null,
          metal: pbr.metallicFactor == null ? 0 : pbr.metallicFactor,
        };
      });

      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const [id, def] of Object.entries(opts.parts)) {
        const node = g.json.nodes[def.node], rest = world(def.node);
        const item = { id, rest, kind: def.kind, side: def.side || 1, parts: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        for (const prim of g.json.meshes[node.mesh].primitives) {
          const pos = accessorData(g, prim.attributes.POSITION);
          const nrm = accessorData(g, prim.attributes.NORMAL);
          const uv = accessorData(g, prim.attributes.TEXCOORD_0);
          const idx = accessorData(g, prim.indices);
          for (let i = 0; i < pos.length; i += 3) {
            const w = M.transformPoint(rest, [pos[i], pos[i + 1], pos[i + 2]]);
            for (let k = 0; k < 3; k++) { item.min[k] = Math.min(item.min[k], w[k]); item.max[k] = Math.max(item.max[k], w[k]); }
          }
          const vao = gl.createVertexArray();
          gl.bindVertexArray(vao);
          const bind = (data, name, size) => {
            const l = gl.getAttribLocation(prog, name);
            if (l < 0) return;
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer(gl.ARRAY_BUFFER, data));
            gl.enableVertexAttribArray(l);
            gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
          };
          bind(pos, "aPos", 3); bind(nrm, "aNrm", 3); bind(uv, "aUv", 2);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer(gl.ELEMENT_ARRAY_BUFFER, idx));
          gl.bindVertexArray(null);
          item.parts.push({ vao, pos, idx, count: idx.length, type: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, mat: mats[prim.material || 0] });
        }
        item.cx = (item.min[0] + item.max[0]) / 2;
        item.cy = (item.min[1] + item.max[1]) / 2;
        item.cz = (item.min[2] + item.max[2]) / 2;
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], item.min[k]); hi[k] = Math.max(hi[k], item.max[k]); }
        items.push(item);
      }
      center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      extent = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2];
    }

    // ---------- Animation auswerten ----------
    function layerWeight(l) {
      const t = clock - l.t0;
      let w = smooth(0, FADE_IN, t);
      if (l.releasedAt != null) w *= 1 - smooth(0, FADE_OUT, clock - l.releasedAt);
      else if (isFinite(l.dur)) w *= 1 - smooth(l.dur - FADE_OUT, l.dur, t);
      return w;
    }
    function layerDone(l) {
      if (l.releasedAt != null) return clock - l.releasedAt >= FADE_OUT;
      return isFinite(l.dur) && clock - l.t0 >= l.dur;
    }

    function idleAngles(kind, s, t, amp) {
      if (kind === "head") return { rx: S(t * 1.3) * 0.07 * amp + 0.02 * amp, ry: S(t * 0.8 + 1) * 0.28 * amp, rz: S(t * 0.8 + 2) * 0.05 * amp };
      if (kind === "arm") return { rx: S(t * 1.6 + (s > 0 ? 0 : Math.PI)) * 0.32 * amp, ry: 0, rz: s * (0.05 + 0.05 * S(t * 1.2)) * amp };
      if (kind === "leg") return { rx: S(t * 1.6 + (s > 0 ? Math.PI : 0)) * 0.12 * amp, ry: 0, rz: 0 };
      return { rx: 0, ry: S(t * 0.8) * 0.05 * amp, rz: S(t * 1.1) * 0.025 * amp };
    }

    function partAngles(it, amp) {
      const a = idleAngles(it.kind, it.side, clock, amp);
      for (const l of layers) {
        const w = layerWeight(l);
        if (w <= 0) continue;
        const c = CLIPS[l.name].part(it.kind, it.side, clock - l.t0);
        if (!c) continue;
        for (const key of ["rx", "ry", "rz"]) {
          if (c[key] !== undefined) a[key] += (c[key] * (reduced ? 0.6 : 1) - a[key]) * w;
        }
      }
      return a;
    }

    function rootPose(amp) {
      const r = { yaw: S(clock * 0.55) * 0.55 * amp, pitch: 0.08, roll: 0, bob: S(clock * 1.7) * 0.7 * amp, hop: 0 };
      for (const l of layers) {
        const w = layerWeight(l);
        if (w <= 0) continue;
        const c = CLIPS[l.name].root((clock - l.t0));
        for (const key of ["yaw", "pitch", "roll", "bob"]) {
          if (c[key] !== undefined) r[key] += (c[key] * (reduced ? 0.6 : 1) - r[key]) * w;
        }
        if (c.hop) r.hop += c.hop * w * (reduced ? 0.5 : 1);
      }
      return r;
    }

    function partMatrix(it, amp) {
      const a = partAngles(it, amp);
      let pivot;
      if (it.kind === "head") pivot = [it.cx, it.min[1] + 2, it.cz - 2];
      else if (it.kind === "arm") pivot = [it.cx, it.max[1] - 3, it.cz];
      else if (it.kind === "leg") pivot = [it.cx, it.max[1] - 2, it.cz];
      else pivot = [it.cx, it.cy, it.cz];
      return M.mul(M.around(pivot, euler(a.rx, a.ry, a.rz)), it.rest);
    }

    // ---------- Zeichnen ----------
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    function camera(rp) {
      const aspect = canvas.width / canvas.height;
      const fov = 0.62, tanH = Math.tan(fov / 2);
      const halfH = extent[1] * 1.12, halfW = extent[0] * 1.55;
      const dist = Math.max(halfH / tanH, halfW / (aspect * tanH));
      const root = M.mul(M.translate(0, rp.bob + rp.hop, 0),
        M.around(center, M.mul(M.rotX(rp.pitch), M.mul(M.rotY(rp.yaw), M.rotZ(rp.roll)))));
      const eye = [center[0], center[1] + 2, center[2] + dist];
      const vp = M.mul(M.perspective(fov, aspect, dist * 0.1, dist * 4), M.translate(-eye[0], -eye[1], -eye[2]));
      return { vp, root, eye };
    }

    let last = performance.now();
    function frame(now) {
      raf = 0;
      if (!alive) return;
      step(Math.min(0.2, (now - last) / 1000));      // Obergrenze: nach Tab-Wechsel kein großer Sprung
      last = now;
      schedule();
    }
    function schedule() { if (alive && !paused && !raf && !document.hidden) raf = requestAnimationFrame(frame); }

    function step(dt) {
      clock += dt;
      layers = layers.filter((l) => !layerDone(l));
      draw();
    }

    function draw() {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!ready) return;
      const amp = reduced ? 0.25 : 1;
      const cam = camera(rootPose(amp));
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(U.uVP, false, cam.vp);
      gl.uniform3fv(U.uCam, cam.eye);
      gl.uniform1i(U.uBase, 0); gl.uniform1i(U.uEmis, 1);
      for (const it of items) {
        gl.uniformMatrix4fv(U.uModel, false, M.mul(cam.root, partMatrix(it, amp)));
        for (const p of it.parts) {
          gl.uniform4fv(U.uBaseFactor, p.mat.factor);
          gl.uniform1f(U.uHasBase, p.mat.base ? 1 : 0);
          gl.uniform1f(U.uHasEmis, p.mat.emis ? 1 : 0);
          gl.uniform1f(U.uMetal, p.mat.metal);
          if (p.mat.base) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, p.mat.base); }
          if (p.mat.emis) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, p.mat.emis); }
          gl.bindVertexArray(p.vao);
          gl.drawElements(gl.TRIANGLES, p.count, p.type, 0);
        }
      }
      gl.bindVertexArray(null);
    }

    // ---------- Klick-Treffer: welches Teil liegt unter dem Zeiger ----------
    // Die Dreiecke werden genau so transformiert wie beim Zeichnen. Getroffen wird das vorderste Dreieck.
    function pickPart(clientX, clientY) {
      if (!ready) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const px = ((clientX - rect.left) / rect.width) * 2 - 1;      // Bildschirm -> NDC (-1..1)
      const py = 1 - ((clientY - rect.top) / rect.height) * 2;
      const amp = reduced ? 0.25 : 1;
      const cam = camera(rootPose(amp));
      let best = null, bestZ = Infinity;
      for (const it of items) {
        const m = M.mul(cam.vp, M.mul(cam.root, partMatrix(it, amp)));
        for (const p of it.parts) {
          const v = p.pos, n = v.length / 3;
          const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), ok = new Uint8Array(n);
          for (let i = 0; i < n; i++) {
            const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (w <= 0) continue;                                       // hinter der Kamera
            sx[i] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
            sy[i] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
            sz[i] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
            ok[i] = 1;
          }
          const idx = p.idx;
          for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t], b = idx[t + 1], c = idx[t + 2];
            if (!ok[a] || !ok[b] || !ok[c]) continue;
            const s1 = (sx[b] - sx[a]) * (py - sy[a]) - (px - sx[a]) * (sy[b] - sy[a]);
            const s2 = (sx[c] - sx[b]) * (py - sy[b]) - (px - sx[b]) * (sy[c] - sy[b]);
            const s3 = (sx[a] - sx[c]) * (py - sy[c]) - (px - sx[c]) * (sy[a] - sy[c]);
            if (!((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0))) continue;
            const z = (sz[a] + sz[b] + sz[c]) / 3;
            if (z < bestZ) { bestZ = z; best = it.id; }
          }
        }
      }
      return best;
    }

    // ---------- Steuerung von außen ----------
    function start(name, dur) {
      if (!CLIPS[name]) return;
      layers.forEach((l) => { if (l.releasedAt == null) l.releasedAt = clock; });      // alte Animation blendet aus
      if (layers.length > 3) layers.shift();
      layers.push({ name, t0: clock, dur: dur == null ? CLIPS[name].dur : dur, releasedAt: null });
    }
    const active = () => layers.find((l) => l.releasedAt == null);

    const onVis = () => { last = performance.now(); schedule(); };
    document.addEventListener("visibilitychange", onVis);

    load().then(() => { ready = true; opts.onReady && opts.onReady(); schedule(); })
      .catch((err) => opts.onError && opts.onError(err));
    schedule();

    return {
      names: Object.keys(CLIPS),
      play(name) { start(name); },
      hold(name) {
        const cur = active();
        if (cur && cur.name === name && !isFinite(cur.dur)) return;       // läuft schon
        start(name, Infinity);
      },
      release() { const cur = active(); if (cur && !isFinite(cur.dur)) cur.releasedAt = clock; },
      pick(clientX, clientY) { return pickPart(clientX, clientY); },      // id des getroffenen Teils oder null
      busy() { return Boolean(active()); },
      current() { const cur = active(); return cur ? cur.name : null; },
      destroy() {
        alive = false; cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVis);
      },
      // nur für Tests: Uhr von Hand vorstellen
      _debug: {
        get ready() { return ready; },
        pause(v) { paused = v; if (!v) schedule(); else { cancelAnimationFrame(raf); raf = 0; } },
        step(seconds) { const n = Math.max(1, Math.round(seconds / 0.05)); for (let i = 0; i < n; i++) step(seconds / n); },
        get clock() { return clock; },
      },
    };
  }

  window.FunkeViewer = { create };
})();
