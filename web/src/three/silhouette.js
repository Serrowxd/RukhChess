import * as THREE from 'three';

/** Where the edge fades in by view depth past the board centre, and only for pieces not close up. */
export const FAR = { start: 0.4, ramp: 1.6, near: [5, 8] };

/** How far from a piece pixel (CSS pixels) the ring looks for open background. */
export const RING_CSS = 1.2;

/** The ring in buffer pixels for a drawing buffer with `pxPerCss` pixels per CSS pixel. */
export function ringTexels(pxPerCss) {
  return RING_CSS * pxPerCss;
}

/** A ring under one buffer pixel still lights a whole one: its edge is dimmed to the share it covers. */
export function ringWeight(pxPerCss) {
  return Math.min(1, ringTexels(pxPerCss));
}

const ramp01 = (v, lo, hi) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));

/** How far a pixel lies into the far half of the board, 0 (centre, nearer, or close up) .. 1 (the far ranks). */
export function edgeFar(depth, focus) {
  return ramp01(depth - focus, FAR.start, FAR.start + FAR.ramp) * ramp01(depth, FAR.near[0], FAR.near[1]);
}

const MASK_V = [
  'varying float vDepth;',
  'void main() {',
  '  vec4 mv = modelViewMatrix * vec4( position, 1.0 );',
  '  vDepth = -mv.z;',
  '  gl_Position = projectionMatrix * mv;',
  '}',
].join('\n');

const MASK_F = [
  'uniform float uFocus; uniform float uStart; uniform float uRamp; uniform vec2 uNear; uniform float uOpacity;',
  'varying float vDepth;',
  'void main() {',
  '  float far = clamp( ( vDepth - uFocus - uStart ) / uRamp, 0.0, 1.0 );',
  '  far *= clamp( ( vDepth - uNear.x ) / ( uNear.y - uNear.x ), 0.0, 1.0 );',
  '  gl_FragColor = vec4( 1.0, far, uOpacity, 1.0 );',
  '}',
].join('\n');

const QUAD_V = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';

// coverage here x how much background the ring around it holds
const EDGE_F = [
  'uniform sampler2D tFrame; uniform sampler2D tMask; uniform vec2 uTexel; uniform vec3 uColor; uniform float uRing;',
  'varying vec2 vUv;',
  'highp float edgeDither( const in vec2 uv ) {',
  '  highp float dt = dot( uv, vec2( 12.9898, 78.233 ) );',
  '  return fract( sin( mod( dt, 3.141592653589793 ) ) * 43758.5453 );',
  '}',
  'vec3 toLight( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) ); }',
  'vec3 toDisplay( vec3 c ) { return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) ); }',
  'void main() {',
  '  vec4 f = texture2D( tFrame, vUv );',
  '  vec4 m = texture2D( tMask, vUv );',
  '  float open = 0.0;',
  '  for ( int i = 0; i < 8; i ++ ) {',
  '    float a = float( i ) * 0.78539816;',
  '    open = max( open, 1.0 - texture2D( tMask, vUv + vec2( cos( a ), sin( a ) ) * uRing * uTexel ).r );',
  '  }',
  '  float far = m.g / max( m.r, 1e-3 ), opacity = m.b / max( m.r, 1e-3 );',
  '  float edge = m.r * open * far * opacity;',
  '  vec3 c = toDisplay( min( toLight( f.rgb ) + uColor * edge, vec3( 1.0 ) ) );',
  '  c += ( edgeDither( gl_FragCoord.xy ) - 0.5 ) / 255.0 * step( 0.001, edge );',
  '  gl_FragColor = vec4( c, f.a );',
  '}',
].join('\n');

export function createSilhouette(renderer, isPiece, standInOf = () => null) {
  const mask = new THREE.WebGLRenderTarget(1, 1, { samples: 4, depthBuffer: true, stencilBuffer: false });

  const maskMat = new THREE.ShaderMaterial({
    vertexShader: MASK_V, fragmentShader: MASK_F, side: THREE.DoubleSide,
    uniforms: {
      uFocus: { value: 12 }, uStart: { value: FAR.start }, uRamp: { value: FAR.ramp },
      uNear: { value: new THREE.Vector2(FAR.near[0], FAR.near[1]) }, uOpacity: { value: 1 },
    },
  });

  // a fading piece keeps its full shape in the mask; only its edge is scaled, per mesh
  const opacityHooks = new Map();   // opacity -> onBeforeRender

  const opacityHook = (op) => {
    let f = opacityHooks.get(op);

    if (!f) {
      f = () => {
        maskMat.uniforms.uOpacity.value = op;
        maskMat.uniformsNeedUpdate = true;
      };
      opacityHooks.set(op, f);
    }

    return f;
  };

  const edgeMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_V, fragmentShader: EDGE_F, depthTest: false, depthWrite: false, toneMapped: false,
    blending: THREE.NoBlending,
    uniforms: {
      tFrame: { value: null }, tMask: { value: mask.texture }, uTexel: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Color() }, uRing: { value: RING_CSS },
    },
  });

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(quadGeo, edgeMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let frame = null;
  const size = new THREE.Vector2();
  const swapped = [];

  return {
    /** Draw the edge over the frame just rendered; false (nothing drawn) when off or no piece is in view. */
    render(scene, camera, { color, focus, pxPerCss = 1 }) {
      if (!color || color.r + color.g + color.b <= 0) return false;

      let any = false;
      swapped.length = 0;

      scene.traverseVisible((o) => {
        if (!o.isMesh || o.userData.standIn) return;   // a stand-in is drawn for its piece's mesh, below

        swapped.push([o, o.material, o.visible, o.onBeforeRender]);

        if (isPiece(o)) {
          const m = o.material;
          const op = m && m.transparent ? Math.round(Math.min(1, Math.max(0, m.opacity)) * 64) / 64 : 1;
          const s = standInOf(o);

          if (s) {
            swapped.push([s, s.material, s.visible, s.onBeforeRender]);
            s.material = maskMat;
            s.onBeforeRender = opacityHook(op);
            s.visible = true;
            o.visible = false;
          } else {
            o.material = maskMat;
            o.onBeforeRender = opacityHook(op);
          }

          any = true;
        } else o.visible = false;
      });

      const restore = () => {
        for (const [o, m, v, hook] of swapped) {
          o.material = m;
          o.visible = v;
          o.onBeforeRender = hook;
        }

        swapped.length = 0;
      };

      if (!any) {
        restore();
        return false;
      }

      renderer.getDrawingBufferSize(size);
      if (mask.width !== size.x || mask.height !== size.y) mask.setSize(size.x, size.y);

      const prev = {
        target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
        color: renderer.getClearColor(new THREE.Color()), shadows: renderer.shadowMap.autoUpdate,
        background: scene.background,
      };

      maskMat.uniforms.uFocus.value = focus;
      scene.background = null;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);

      let drawn = false;

      try {
        renderer.setRenderTarget(mask);
        renderer.render(scene, camera);
        drawn = true;
      } finally {
        // also on a failed draw: pieces and renderer get their state back
        restore();
        scene.background = prev.background;

        if (!drawn) {
          renderer.setRenderTarget(prev.target);
          renderer.autoClear = prev.autoClear;
          renderer.setClearColor(prev.color, prev.alpha);
          renderer.shadowMap.autoUpdate = prev.shadows;
        }
      }

      renderer.setRenderTarget(prev.target);

      if (!frame || frame.image.width !== size.x || frame.image.height !== size.y) {
        if (frame) frame.dispose();
        frame = new THREE.FramebufferTexture(size.x, size.y);
        edgeMat.uniforms.tFrame.value = frame;
      }

      renderer.copyFramebufferToTexture(frame);
      edgeMat.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
      edgeMat.uniforms.uColor.value.copy(color).multiplyScalar(ringWeight(pxPerCss));
      edgeMat.uniforms.uRing.value = ringTexels(pxPerCss);

      renderer.autoClear = false;
      renderer.render(quadScene, quadCamera);

      renderer.autoClear = prev.autoClear;
      renderer.setClearColor(prev.color, prev.alpha);
      renderer.shadowMap.autoUpdate = prev.shadows;

      return true;
    },

    dispose() {
      mask.dispose();
      if (frame) frame.dispose();
      maskMat.dispose();
      edgeMat.dispose();
      quadGeo.dispose();
    },
  };
}
