/* FUNKE 3D-Viewer: reines WebGL2, keine externe Bibliothek.
 * Lädt die GLB-Datei, spielt eine Idle-Animation (Schweben, Drehen, Kopf, Arme, Beine)
 * und meldet, welches Körperteil angeklickt wurde.
 *
 *   const v = FunkeViewer.create(canvas, { url, parts, onPick, onReady, onError });
 *   v.pick(id)  -> löst dasselbe aus wie ein Klick auf das Teil
 *   v.destroy()
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
    scale: (s) => { const o = M.id(); o[0] = o[5] = o[10] = s; return o; },
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
  uniform vec3 uCam; uniform vec3 uGlowColor; uniform float uGlow;
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
    col += uGlowColor * uGlow * (0.35 + 0.9 * fres);
    outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
  }`;

  const VS_ID = `#version 300 es
  in vec3 aPos; uniform mat4 uModel; uniform mat4 uVP;
  void main() { gl_Position = uVP * uModel * vec4(aPos, 1.0); }`;
  const FS_ID = `#version 300 es
  precision highp float; uniform vec4 uId; out vec4 outColor;
  void main() { outColor = uId; }`;

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

  // ---------- Hauptklasse ----------
  // opts.parts: { id: { node: <Index des Mesh-Knotens>, pivot: "head"|"arm"|"leg"|"body", side: -1|1 } }
  function create(canvas, opts) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) { opts.onError && opts.onError(new Error("webgl2")); return null; }

    let alive = true, visible = true, raf = 0, ready = false;
    const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const prog = program(gl, VS, FS), progId = program(gl, VS_ID, FS_ID);
    const loc = (p, n) => gl.getUniformLocation(p, n);
    const U = {};
    ["uModel", "uVP", "uBase", "uEmis", "uBaseFactor", "uHasBase", "uHasEmis", "uMetal", "uCam", "uGlowColor", "uGlow"]
      .forEach((n) => (U[n] = loc(prog, n)));
    const UI = { uModel: loc(progId, "uModel"), uVP: loc(progId, "uVP"), uId: loc(progId, "uId") };

    const items = [];            // { id, parts: [{vao, vaoId, count, mat}], rest, pivot, kind, side, pulse }
    const textures = {};
    let center = [0, 33, 0], radius = 40;

    const view = { yaw: 0, pitch: 0.08, dragYaw: 0, dragPitch: 0 };
    let fbo = null, fboRb = null, fboDepth = null, fboW = 0, fboH = 0;

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

      // Texturen laden (nur die, die gebraucht werden)
      const imgIndex = (texRef) => (texRef ? g.json.textures[texRef.index].source : null);
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
        const item = { id, rest, kind: def.kind, side: def.side || 1, pulse: 0, parts: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
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
          // eigenes VAO für den ID-Pass (nur Position)
          const vaoId = gl.createVertexArray();
          gl.bindVertexArray(vaoId);
          const lp = gl.getAttribLocation(progId, "aPos");
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer(gl.ARRAY_BUFFER, pos));
          gl.enableVertexAttribArray(lp);
          gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer(gl.ELEMENT_ARRAY_BUFFER, idx));
          gl.bindVertexArray(null);
          item.parts.push({ vao, vaoId, count: idx.length, type: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, mat: mats[prim.material || 0] });
        }
        item.cx = (item.min[0] + item.max[0]) / 2;
        item.cy = (item.min[1] + item.max[1]) / 2;
        item.cz = (item.min[2] + item.max[2]) / 2;
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], item.min[k]); hi[k] = Math.max(hi[k], item.max[k]); }
        items.push(item);
      }
      center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
      items.forEach((it, n) => (it.idColor = [(n + 1) / 255, 0, 0, 1]));
    }

    // ---------- Animation pro Teil ----------
    function partMatrix(it, t, amp) {
      const s = it.side;
      let rot = M.id();
      let pivot = [it.cx, it.cy, it.cz];
      if (it.kind === "head") {
        pivot = [it.cx, it.min[1] + 2, it.cz - 2];
        rot = M.mul(M.rotY(Math.sin(t * 0.8 + 1) * 0.28 * amp), M.rotX(Math.sin(t * 1.3) * 0.07 * amp + 0.02 * amp));
        rot = M.mul(rot, M.rotZ(Math.sin(t * 0.8 + 2) * 0.05 * amp));
      } else if (it.kind === "arm") {
        pivot = [it.cx, it.max[1] - 3, it.cz];
        rot = M.mul(M.rotX(Math.sin(t * 1.6 + (s > 0 ? 0 : Math.PI)) * 0.32 * amp), M.rotZ(s * (0.05 + 0.05 * Math.sin(t * 1.2)) * amp));
      } else if (it.kind === "leg") {
        pivot = [it.cx, it.max[1] - 2, it.cz];
        rot = M.rotX(Math.sin(t * 1.6 + (s > 0 ? Math.PI : 0)) * 0.12 * amp);
      } else {
        pivot = [it.cx, it.cy, it.cz];
        rot = M.mul(M.rotY(Math.sin(t * 0.8) * 0.05 * amp), M.rotZ(Math.sin(t * 1.1) * 0.025 * amp));
      }
      let m = M.around(pivot, rot);
      if (it.pulse > 0.001) {                     // Klick-Reaktion: kurzes Aufpoppen
        const k = 1 + 0.10 * Math.sin(it.pulse * Math.PI);
        m = M.mul(M.around([it.cx, it.cy, it.cz], M.scale(k)), m);
      }
      return M.mul(m, it.rest);
    }

    // ---------- Zeichnen ----------
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    function camera(t, amp) {
      const aspect = canvas.width / canvas.height;
      const fov = 0.62;
      const dist = (radius * 1.05) / Math.sin(fov / 2) / Math.min(1, aspect * 1.05);
      const yaw = view.yaw + view.dragYaw + Math.sin(t * 0.55) * 0.55 * amp;
      const pitch = view.pitch + view.dragPitch;
      const bob = Math.sin(t * 1.7) * 0.7 * amp;
      const root = M.mul(M.translate(0, bob, 0), M.around(center, M.mul(M.rotX(pitch), M.rotY(yaw))));
      const eye = [center[0], center[1] + 2, center[2] + dist];
      const viewM = M.translate(-eye[0], -eye[1], -eye[2]);
      const vp = M.mul(M.perspective(fov, aspect, dist * 0.1, dist * 4), viewM);
      return { vp, root, eye };
    }

    let last = performance.now(), clock = 0;
    function frame(now) {
      raf = 0;
      if (!alive) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      clock += dt;
      items.forEach((it) => { if (it.pulse > 0) it.pulse = Math.max(0, it.pulse - dt / 0.7); });
      draw();
      schedule();
    }
    function schedule() { if (alive && visible && !raf && !document.hidden) raf = requestAnimationFrame(frame); }

    function draw() {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!ready) return;
      const amp = reduced ? 0.25 : 1;
      const cam = camera(clock, amp);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(U.uVP, false, cam.vp);
      gl.uniform3fv(U.uCam, M.transformPoint(M.id(), cam.eye));
      gl.uniform1i(U.uBase, 0); gl.uniform1i(U.uEmis, 1);
      for (const it of items) {
        gl.uniformMatrix4fv(U.uModel, false, M.mul(cam.root, partMatrix(it, clock, amp)));
        gl.uniform3f(U.uGlowColor, 1.0, 0.42, 0.17);
        gl.uniform1f(U.uGlow, Math.sin(it.pulse * Math.PI) * 0.9);
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
      draw.cam = cam;
    }

    // ---------- Picking: ID-Farben in einen Offscreen-Buffer zeichnen ----------
    function ensureFbo() {
      if (fbo && fboW === canvas.width && fboH === canvas.height) return;
      if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(fboRb); gl.deleteRenderbuffer(fboDepth); }
      fboW = canvas.width; fboH = canvas.height;
      fbo = gl.createFramebuffer(); fboRb = gl.createRenderbuffer(); fboDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, fboRb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, fboW, fboH);
      gl.bindRenderbuffer(gl.RENDERBUFFER, fboDepth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, fboW, fboH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, fboRb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, fboDepth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    function idAt(clientX, clientY) {
      if (!ready || !draw.cam) return null;
      const r = canvas.getBoundingClientRect();
      const x = Math.floor(((clientX - r.left) / r.width) * canvas.width);
      const y = canvas.height - 1 - Math.floor(((clientY - r.top) / r.height) * canvas.height);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
      ensureFbo();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, fboW, fboH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(progId);
      gl.uniformMatrix4fv(UI.uVP, false, draw.cam.vp);
      const amp = reduced ? 0.25 : 1;
      for (const it of items) {
        gl.uniformMatrix4fv(UI.uModel, false, M.mul(draw.cam.root, partMatrix(it, clock, amp)));
        gl.uniform4fv(UI.uId, it.idColor);
        for (const p of it.parts) {
          gl.bindVertexArray(p.vaoId);
          gl.drawElements(gl.TRIANGLES, p.count, p.type, 0);
        }
      }
      gl.bindVertexArray(null);
      const px = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return px[3] === 0 ? null : (items[px[0] - 1] || null);
    }

    function trigger(it) {
      it.pulse = 1;
      opts.onPick && opts.onPick(it.id);
    }

    // ---------- Maus / Touch: Klick = Teil wählen, Ziehen = drehen ----------
    let down = null;
    const onDown = (e) => {
      down = { x: e.clientX, y: e.clientY, yaw: view.dragYaw, pitch: view.dragPitch, moved: false };
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) down.moved = true;
      if (down.moved) {
        view.dragYaw = down.yaw + dx * 0.01;
        view.dragPitch = Math.max(-0.5, Math.min(0.5, down.pitch + dy * 0.006));
      }
    };
    const onUp = (e) => {
      if (!down) return;
      const wasClick = !down.moved;
      down = null;
      if (wasClick) { const it = idAt(e.clientX, e.clientY); if (it) trigger(it); }
    };
    const onHover = (e) => {
      if (down) return;
      canvas.style.cursor = idAt(e.clientX, e.clientY) ? "pointer" : "grab";
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointermove", onHover);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", () => (down = null));

    const io = "IntersectionObserver" in window
      ? new IntersectionObserver((es) => { visible = es[0].isIntersecting; schedule(); })
      : null;
    io && io.observe(canvas);
    const onVis = () => { last = performance.now(); schedule(); };
    document.addEventListener("visibilitychange", onVis);

    load().then(() => { ready = true; opts.onReady && opts.onReady(); schedule(); })
      .catch((err) => opts.onError && opts.onError(err));
    schedule();

    return {
      pick(id) { const it = items.find((x) => x.id === id); if (it) trigger(it); },
      destroy() {
        alive = false; cancelAnimationFrame(raf);
        io && io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
      },
      // nur für Tests
      _debug: { items, get ready() { return ready; }, idAt, get clock() { return clock; } },
    };
  }

  window.FunkeViewer = { create };
})();
