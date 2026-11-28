/**
 * A small Live2D-like renderer: textured grid meshes (parts) hang from a tree of deformers.
 *
 * Every coordinate is in one rig space (the pet's logo units: facing right, ground at y=256).
 * A part is a texture stretched over a box in that space, cut into a grid of quads. Each frame
 * the grid's rest points run through the part's deformer chain, innermost first:
 *   rot  – turn/scale/move about a pivot: p' = pivot + t + R(a)·S·(p − pivot)
 *   warp – a displacement field over a rect: p' = p + fn(u, v), u/v = p's place in the rect
 *            (points outside the rect take the field at the nearest edge)
 * Deformers are defined in rest space too, so a child always acts before its parent.
 *
 * A part may carry a second texture under `<tex>@mix` (same layout): `st.mix` (0..1) crossfades to it,
 * which is how a figure fades from one colour scheme to another.
 * A part with `blend: 'multiply'` multiplies the colours under it (a shadow layer, see render).
 *
 * Rendering runs through ONE module-level shared offscreen WebGL context (`sharedHost`),
 * blitting each frame onto the target rig's lightweight 2D `<canvas>`. This avoids Chromium/WebView2's
 * ~16 active WebGL context cap when spawning 17+ subagent pets alongside the main pet.
 */

// GLSL ES 1.00 and no vertex array objects: the same code runs on a WebGL 1 context, which some
// machines give where WebGL 2 is refused (older Macs whose GPU ANGLE drives through OpenGL)
const VS = `
attribute vec2 aPos; attribute vec2 aUv;
uniform vec4 uView; // x0, y0, 1/w, 1/h
varying vec2 vUv;
void main() {
  vec2 n = (aPos - uView.xy) * uView.zw;
  gl_Position = vec4(n.x * 2.0 - 1.0, 1.0 - n.y * 2.0, 0.0, 1.0);
  vUv = aUv;
}`;
const FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uTex2;
uniform float uMix;
uniform float uAlpha;
uniform vec4 uTint; // rgb multiply, a = mix toward it
void main() {
  vec4 c = mix(texture2D(uTex, vUv), texture2D(uTex2, vUv), uMix);
  c.rgb = mix(c.rgb, c.rgb * uTint.rgb, uTint.a);
  gl_FragColor = c * uAlpha;
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const GL_ATTRS = { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: true };
const WATCHDOG_MS = 2500;
const pot = (n) => (n & (n - 1)) === 0;
const isWebGL2 = (gl) => typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

function createGLContext(glCanvas) {
  return glCanvas.getContext('webgl2', GL_ATTRS) || glCanvas.getContext('webgl', GL_ATTRS);
}

function getStaticUrlKey(src) {
  if (!src) return null;
  if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) return null;
  if (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas) return null;
  if (src.tagName === 'CANVAS' || src.nodeName === 'CANVAS') return null;
  if (typeof src.src === 'string' && src.src.length > 0) {
    return (typeof src.currentSrc === 'string' && src.currentSrc.length > 0) ? src.currentSrc : src.src;
  }
  return null;
}

function uploadTexture(gl, gl2, tex, src) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  const canMip = gl2 || (pot(src.width) && pot(src.height));
  if (canMip) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, canMip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

let sharedHost = null;

function compileHostProgram(host) {
  const gl = host.gl;
  const shaders = [shader(gl, gl.VERTEX_SHADER, VS), shader(gl, gl.FRAGMENT_SHADER, FS)];
  const prog = gl.createProgram();
  for (const s of shaders) gl.attachShader(prog, s);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const loc = {
    aPos: gl.getAttribLocation(prog, 'aPos'), aUv: gl.getAttribLocation(prog, 'aUv'),
    uView: gl.getUniformLocation(prog, 'uView'), uTex: gl.getUniformLocation(prog, 'uTex'),
    uAlpha: gl.getUniformLocation(prog, 'uAlpha'), uTint: gl.getUniformLocation(prog, 'uTint'),
    uTex2: gl.getUniformLocation(prog, 'uTex2'), uMix: gl.getUniformLocation(prog, 'uMix'),
  };
  gl.enableVertexAttribArray(loc.aPos);
  gl.enableVertexAttribArray(loc.aUv);
  host.shaders = shaders;
  host.prog = prog;
  host.loc = loc;
}

function rebuildHostGL(host) {
  if (host.disposed) return;
  const gl = host.gl;
  if (!gl || gl.isContextLost?.()) {
    host.lost = true;
    return;
  }
  compileHostProgram(host);
  for (const [urlKey, entry] of host.sharedTextures) {
    if (entry.refs <= 0) {
      host.sharedTextures.delete(urlKey);
      continue;
    }
    entry.tex = gl.createTexture();
    uploadTexture(gl, host.gl2, entry.tex, entry.src);
  }
  for (const rig of host.rigs) {
    rig._rebuildGL();
  }
}

function detachHostListeners(host) {
  if (!host.glCanvas) return;
  if (host.onLost) host.glCanvas.removeEventListener('webglcontextlost', host.onLost);
  if (host.onRestored) host.glCanvas.removeEventListener('webglcontextrestored', host.onRestored);
}

function recreateHostContext(host) {
  if (host.disposed || host.rigs.size === 0) return;
  const prevCanvas = host.glCanvas;
  detachHostListeners(host);

  const nextCanvas = document.createElement('canvas');
  nextCanvas.width = Math.max(512, prevCanvas?.width || 512);
  nextCanvas.height = Math.max(512, prevCanvas?.height || 512);
  const nextGl = createGLContext(nextCanvas);

  host.glCanvas = nextCanvas;
  host.gl = nextGl || null;
  host.gl2 = nextGl ? isWebGL2(nextGl) : false;
  host.prog = null;
  host.shaders = [];
  host.loc = null;

  attachHostListeners(host);

  if (!nextGl || nextGl.isContextLost?.()) {
    host.lost = true;
    return;
  }
  host.lost = false;
  rebuildHostGL(host);
}

function attachHostListeners(host) {
  const onLost = (e) => {
    if (host.disposed || host.rigs.size === 0) return;
    e.preventDefault();
    host.lost = true;
    if (host.recoveryTimer != null) clearTimeout(host.recoveryTimer);
    host.recoveryTimer = setTimeout(() => {
      host.recoveryTimer = null;
      if (host.disposed || !host.lost || host.rigs.size === 0) return;
      recreateHostContext(host);
    }, WATCHDOG_MS);
  };
  const onRestored = () => {
    if (host.disposed) return;
    if (host.recoveryTimer != null) {
      clearTimeout(host.recoveryTimer);
      host.recoveryTimer = null;
    }
    host.lost = false;
    rebuildHostGL(host);
  };
  host.onLost = onLost;
  host.onRestored = onRestored;
  host.glCanvas.addEventListener('webglcontextlost', onLost);
  host.glCanvas.addEventListener('webglcontextrestored', onRestored);
}

function teardownSharedHost(host) {
  if (host.disposed) return;
  host.disposed = true;
  host.lost = true;
  if (host.recoveryTimer != null) {
    clearTimeout(host.recoveryTimer);
    host.recoveryTimer = null;
  }
  detachHostListeners(host);
  const gl = host.gl;
  try {
    if (gl && !gl.isContextLost?.()) {
      for (const entry of host.sharedTextures.values()) {
        if (entry.tex) gl.deleteTexture(entry.tex);
      }
      if (host.prog) gl.deleteProgram(host.prog);
      for (const s of host.shaders) gl.deleteShader(s);
    }
  } finally {
    host.sharedTextures.clear();
    host.prog = null;
    host.shaders = [];
    host.loc = null;
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Ignore extension errors if the context was already dropped by the browser
    }
    host.gl = null;
    if (sharedHost === host) sharedHost = null;
  }
}

function getSharedHost() {
  if (sharedHost && !sharedHost.disposed) return sharedHost;

  const glCanvas = document.createElement('canvas');
  glCanvas.width = 512;
  glCanvas.height = 512;
  const gl = createGLContext(glCanvas);
  if (!gl) throw new Error('webgl unavailable');

  const host = {
    glCanvas,
    gl,
    gl2: isWebGL2(gl),
    prog: null,
    shaders: [],
    loc: null,
    rigs: new Set(),
    sharedTextures: new Map(),
    lost: Boolean(gl.isContextLost?.()),
    disposed: false,
    recoveryTimer: null,
    onLost: null,
    onRestored: null,
    acquireSharedTexture(urlKey, src) {
      let entry = host.sharedTextures.get(urlKey);
      if (entry) {
        entry.refs += 1;
        if (src) entry.src = src;
        if (!entry.tex && !host.lost && host.gl && !host.gl.isContextLost?.()) {
          entry.tex = host.gl.createTexture();
          uploadTexture(host.gl, host.gl2, entry.tex, entry.src);
        }
        return entry.tex;
      }
      let tex = null;
      if (!host.lost && host.gl && !host.gl.isContextLost?.()) {
        tex = host.gl.createTexture();
        uploadTexture(host.gl, host.gl2, tex, src);
      }
      entry = { tex, src, refs: 1 };
      host.sharedTextures.set(urlKey, entry);
      return tex;
    },
    releaseSharedTexture(urlKey) {
      const entry = host.sharedTextures.get(urlKey);
      if (!entry) return;
      entry.refs -= 1;
      if (entry.refs <= 0) {
        if (entry.tex && host.gl && !host.lost && !host.gl.isContextLost?.()) {
          host.gl.deleteTexture(entry.tex);
        }
        host.sharedTextures.delete(urlKey);
      }
    },
  };

  try {
    if (!host.lost) compileHostProgram(host);
    attachHostListeners(host);
  } catch (err) {
    teardownSharedHost(host);
    throw err;
  }

  sharedHost = host;
  return host;
}

/** Diagnostic telemetry for the shared WebGL host and active rigs. */
export function getRigStats() {
  if (!sharedHost) {
    return { activeRigs: 0, hasSharedContext: false, contextLost: false, sharedTextureCount: 0 };
  }
  const gl = sharedHost.gl;
  return {
    activeRigs: sharedHost.rigs.size,
    hasSharedContext: Boolean(gl),
    contextLost: Boolean(sharedHost.lost || !gl || gl.isContextLost?.()),
    sharedTextureCount: sharedHost.sharedTextures.size,
  };
}

export function createRig(canvas, model) {
  const host = getSharedHost();
  const ctx2d = canvas.getContext('2d');
  const defs = model.deformers;
  let view = model.view; // [x0, y0, x1, y1]

  // deformer chain per part, innermost first
  const chainOf = id => { const c = []; for (let d = id; d && defs[d]; d = defs[d].parent) c.push(d); return c; };

  // Precompute CPU-side mesh geometry once per rig; GL buffers are allocated in _buildBuffers()
  const meshData = model.parts.map(p => {
    const [nx, ny] = p.grid || [6, 6];
    const [x, y, w, h] = p.box;
    const [u0, v0, u1, v1] = p.uvBox || [0, 0, 1, 1];
    const rest = new Float32Array((nx + 1) * (ny + 1) * 2), uv = new Float32Array(rest.length);
    let k = 0;
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      rest[k] = x + w * i / nx; rest[k + 1] = y + h * j / ny;
      uv[k] = u0 + (u1 - u0) * i / nx; uv[k + 1] = v0 + (v1 - v0) * j / ny;
      k += 2;
    }
    const idx = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    return {
      part: p,
      rest,
      out: new Float32Array(rest.length),
      uv,
      idx: new Uint16Array(idx),
      count: idx.length,
      chain: chainOf(p.parent),
    };
  });

  let meshes = [];
  function _buildBuffers() {
    const gl = host.gl;
    if (!gl || host.lost || gl.isContextLost?.()) return;
    meshes = meshData.map(d => {
      const pos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.bufferData(gl.ARRAY_BUFFER, d.rest.byteLength, gl.DYNAMIC_DRAW);
      const uvb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvb);
      gl.bufferData(gl.ARRAY_BUFFER, d.uv, gl.STATIC_DRAW);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.idx, gl.STATIC_DRAW);
      return { part: d.part, rest: d.rest, out: d.out, pos, uvb, ib, count: d.count, chain: d.chain };
    });
  }

  // `boundTextures`: key -> { kind: 'shared', urlKey } | { kind: 'own', src }
  // `ownTextures`: key -> { tex, src } for dynamic non-URL sources (e.g. HTMLCanvasElement faceFx)
  const boundTextures = new Map();
  const ownTextures = new Map();
  let disposed = false;

  function releaseBinding(key) {
    const prev = boundTextures.get(key);
    if (!prev) return;
    boundTextures.delete(key);
    if (prev.kind === 'shared') {
      host.releaseSharedTexture(prev.urlKey);
    } else if (prev.kind === 'own') {
      const own = ownTextures.get(key);
      if (own) {
        if (own.tex && host.gl && !host.lost && !host.gl.isContextLost?.()) {
          host.gl.deleteTexture(own.tex);
        }
        ownTextures.delete(key);
      }
    }
  }

  function resolveTex(key) {
    const b = boundTextures.get(key);
    if (!b) return null;
    if (b.kind === 'shared') return host.sharedTextures.get(b.urlKey)?.tex || null;
    return ownTextures.get(key)?.tex || null;
  }

  function upload(key, src) {
    if (disposed || !src) return null;
    const urlKey = getStaticUrlKey(src);
    if (urlKey) {
      const prev = boundTextures.get(key);
      if (prev && prev.kind === 'shared' && prev.urlKey === urlKey) {
        const existing = host.sharedTextures.get(urlKey);
        if (existing) {
          if (!existing.tex && !host.lost && host.gl && !host.gl.isContextLost?.()) {
            existing.tex = host.gl.createTexture();
            uploadTexture(host.gl, host.gl2, existing.tex, src);
          }
          return existing.tex;
        }
      }
      releaseBinding(key);
      const tex = host.acquireSharedTexture(urlKey, src);
      boundTextures.set(key, { kind: 'shared', urlKey });
      return tex;
    }

    // Dynamic canvas source (no static URL): keep per-rig private texture and update in-place
    const prev = boundTextures.get(key);
    if (prev && prev.kind === 'shared') {
      host.releaseSharedTexture(prev.urlKey);
    }
    let own = ownTextures.get(key);
    if (!own) {
      own = { tex: null, src };
      ownTextures.set(key, own);
    } else {
      own.src = src;
    }
    boundTextures.set(key, { kind: 'own', src });
    if (!host.lost && host.gl && !host.gl.isContextLost?.()) {
      if (!own.tex) own.tex = host.gl.createTexture();
      uploadTexture(host.gl, host.gl2, own.tex, src);
    }
    return own.tex;
  }

  function _rebuildGL() {
    if (disposed || host.lost || !host.gl || host.gl.isContextLost?.()) return;
    _buildBuffers();
    for (const own of ownTextures.values()) {
      own.tex = host.gl.createTexture();
      uploadTexture(host.gl, host.gl2, own.tex, own.src);
    }
  }

  const rigEntry = { _rebuildGL };
  host.rigs.add(rigEntry);
  try {
    _buildBuffers();
  } catch (err) {
    host.rigs.delete(rigEntry);
    if (host.rigs.size === 0) teardownSharedHost(host);
    throw err;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const gl = host.gl;
    const glAlive = Boolean(gl && !host.lost && !gl.isContextLost?.());
    if (glAlive) {
      for (const m of meshes) {
        gl.deleteBuffer(m.pos);
        gl.deleteBuffer(m.uvb);
        gl.deleteBuffer(m.ib);
      }
    }
    meshes = [];
    for (const key of Array.from(boundTextures.keys())) {
      releaseBinding(key);
    }
    for (const own of ownTextures.values()) {
      if (own.tex && glAlive) gl.deleteTexture(own.tex);
    }
    ownTextures.clear();
    host.rigs.delete(rigEntry);
    if (host.rigs.size === 0) {
      teardownSharedHost(host);
    }
  }

  /** Writes deformed vertex coordinates directly into `out[outIdx], out[outIdx + 1]` (zero per-vertex allocation!). */
  function applyChainInPlace(chain, st, x, y, out, outIdx) {
    for (let k = 0; k < chain.length; k++) {
      const id = chain[k];
      const d = defs[id], s = st[id];
      if (!s) continue;
      if (d.kind === 'rot') {
        const px = d.pivot[0], py = d.pivot[1];
        const a = (s.a || 0) * 0.017453292519943295;
        const c = Math.cos(a), sn = Math.sin(a);
        const sx = s.sx ?? s.s ?? 1, sy = s.sy ?? s.s ?? 1;
        const lx = (x - px) * sx, ly = (y - py) * sy;
        x = px + (s.tx || 0) + lx * c - ly * sn;
        y = py + (s.ty || 0) + lx * sn + ly * c;
      } else if (d.kind === 'warp' && s.fn) {
        const [x0, y0, x1, y1] = d.rect;
        const u = Math.min(1, Math.max(0, (x - x0) / (x1 - x0))), v = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
        const r = s.fn(u, v, x, y);
        x += r[0]; y += r[1];
      }
    }
    out[outIdx] = x;
    out[outIdx + 1] = y;
  }

  function applyChain(chain, st, x, y) {
    const tmp = [0, 0];
    applyChainInPlace(chain, st, x, y, tmp, 0);
    return tmp;
  }

  function render(st, opts = {}) {
    if (disposed || host.lost || !host.gl || host.gl.isContextLost?.()) return;
    const W = canvas.width | 0, H = canvas.height | 0;
    if (W <= 0 || H <= 0) return;

    const gl = host.gl, glCanvas = host.glCanvas, { prog, loc } = host;
    if (!prog || !loc) return;
    if (meshes.length === 0 && meshData.length > 0) _buildBuffers();

    const maxDim = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 2048, 2048);
    const targetW = Math.min(W, maxDim), targetH = Math.min(H, maxDim);
    if (glCanvas.width < targetW) glCanvas.width = targetW;
    if (glCanvas.height < targetH) glCanvas.height = targetH;

    const drawW = Math.min(W, glCanvas.width);
    const drawH = Math.min(H, glCanvas.height);
    const vy = glCanvas.height - drawH;

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, vy, drawW, drawH);
    gl.viewport(0, vy, drawW, drawH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.enableVertexAttribArray(loc.aPos);
    gl.enableVertexAttribArray(loc.aUv);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(loc.uView, view[0], view[1], 1 / (view[2] - view[0]), 1 / (view[3] - view[1]));
    gl.uniform1i(loc.uTex, 0);
    gl.uniform1i(loc.uTex2, 1);

    const mixK = Math.min(1, Math.max(0, st.mix || 0));
    const order = meshes.filter(m => !(opts.hidden && opts.hidden[m.part.id]))
      .map(m => ({ m, z: st.z?.[m.part.id] ?? m.part.z })).sort((a, b) => a.z - b.z);
    for (let idx = 0; idx < order.length; idx++) {
      const m = order[idx].m;
      const p = m.part, alpha = st.alpha?.[p.id] ?? p.alpha ?? 1;
      const tex = resolveTex(p.tex);
      if (!tex || alpha <= 0.001) continue;
      const rest = m.rest, out = m.out, chain = m.chain;
      for (let i = 0; i < rest.length; i += 2) {
        applyChainInPlace(chain, st, rest[i], rest[i + 1], out, i);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.out);
      gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.uvb);
      gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
      const tex2 = mixK > 0 ? resolveTex(p.tex + '@mix') : null;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex2 || tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1f(loc.uMix, tex2 ? mixK : 0);
      gl.uniform1f(loc.uAlpha, alpha);
      const tint = st.tint?.[p.id];
      gl.uniform4f(loc.uTint, ...(tint || [1, 1, 1, 0]));
      // a `multiply` part darkens what is already drawn under it and leaves the coverage alone,
      // so a shadow shows only on the parts below it and never over empty canvas
      if (p.blend === 'multiply') gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
      if (p.blend === 'multiply') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    gl.disable(gl.SCISSOR_TEST);

    if (ctx2d) {
      ctx2d.clearRect(0, 0, W, H);
      ctx2d.drawImage(glCanvas, 0, 0, drawW, drawH, 0, 0, W, H);
    }
  }

  return {
    get gl() { return host.gl; },
    upload,
    render,
    dispose,
    /** Where a rest point lands this frame (for overlays and hit tests). */
    point(deformer, st, x, y) { return applyChain(chainOf(deformer), st, x, y); },
    setView(v) { view = v; },
    get view() { return view; },
  };
}
