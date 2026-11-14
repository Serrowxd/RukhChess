import * as THREE from 'three';

/** Strength and shape. Emission below `threshold` (linear, before exposure) does not glow; `knee` softens that. */
export const GLOW = { threshold: 0.25, knee: 0.2, near: 0.2, wide: 0.16 };

const QUAD_V = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';

// quarter-size downsample (four bilinear taps = a 4x4 box) with the soft threshold
const PICK_F = [
  'uniform sampler2D tMap; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3 c = 0.25 * ( texture2D( tMap, vUv + uTexel * vec2( -1.0, -1.0 ) ).rgb + texture2D( tMap, vUv + uTexel * vec2( 1.0, -1.0 ) ).rgb',
  '    + texture2D( tMap, vUv + uTexel * vec2( -1.0, 1.0 ) ).rgb + texture2D( tMap, vUv + uTexel * vec2( 1.0, 1.0 ) ).rgb );',
  '  float b = max( c.r, max( c.g, c.b ) );',
  '  float soft = clamp( b - uThreshold + uKnee, 0.0, 2.0 * uKnee );',
  '  soft = soft * soft / ( 4.0 * uKnee + 1e-5 );',
  '  gl_FragColor = vec4( c * max( soft, b - uThreshold ) / max( b, 1e-5 ), 1.0 );',
  '}',
].join('\n');

// 9-tap gaussian in 5 bilinear fetches along uDir (one texel step)
const BLUR_F = [
  'uniform sampler2D tMap; uniform vec2 uDir;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3 c = texture2D( tMap, vUv ).rgb * 0.2270270270;',
  '  c += ( texture2D( tMap, vUv + uDir * 1.3846153846 ).rgb + texture2D( tMap, vUv - uDir * 1.3846153846 ).rgb ) * 0.3162162162;',
  '  c += ( texture2D( tMap, vUv + uDir * 3.2307692308 ).rgb + texture2D( tMap, vUv - uDir * 3.2307692308 ).rgb ) * 0.0702702703;',
  '  gl_FragColor = vec4( c, 1.0 );',
  '}',
].join('\n');

// the two blurs, exposed like the frame, added to the frame in linear light, dithered
const ADD_F = [
  'uniform sampler2D tFrame; uniform sampler2D tNear; uniform sampler2D tWide;',
  'uniform float uNear; uniform float uWide; uniform float uExposure;',
  'varying vec2 vUv;',
  'highp float glowDither( const in vec2 uv ) {',
  '  highp float dt = dot( uv, vec2( 12.9898, 78.233 ) );',
  '  return fract( sin( mod( dt, 3.141592653589793 ) ) * 43758.5453 );',
  '}',
  'vec3 toLight( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) ); }',
  'vec3 toDisplay( vec3 c ) { return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) ); }',
  'void main() {',
  '  vec4 f = texture2D( tFrame, vUv );',
  '  vec3 g = ( texture2D( tNear, vUv ).rgb * uNear + texture2D( tWide, vUv ).rgb * uWide ) * uExposure;',
  '  g = g / ( 1.0 + g );',                                              // a soft shoulder: a glow never clips
  '  vec3 c = toDisplay( min( toLight( f.rgb ) + g, vec3( 1.0 ) ) );',
  '  c += ( glowDither( gl_FragCoord.xy ) - 0.5 ) / 255.0;',
  '  gl_FragColor = vec4( c, max( f.a, max( c.r, max( c.g, c.b ) ) ) );',
  '}',
].join('\n');

/** Does this material give off light? The unlit look parks its colour in `emissive` and does not count. */
export function emitsLight(m) {
  if (!m || !m.emissive || (m.userData && m.userData.litBackup) || m.visible === false) return false;

  const k = m.emissiveIntensity ?? 1;

  return k > 0 && m.emissive.r + m.emissive.g + m.emissive.b > 0;
}

export function createGlow(renderer) {
  const target = (depth) => new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: depth, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });

  const rtEmit = target(true);                  // the emission, at half size, multisampled: a small far window
  rtEmit.samples = 4;                           // would otherwise alias into glitter in the blurred glow
  const q1 = target(false), q2 = target(false);  // quarter size: pick + blur ping-pong
  const e1 = target(false), e2 = target(false);  // eighth size
  const targets = [rtEmit, q1, q2, e1, e2];

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  const pass = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({
    vertexShader: QUAD_V, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra,
  });

  const pick = pass(PICK_F, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: GLOW.threshold }, uKnee: { value: GLOW.knee } });
  const blur = pass(BLUR_F, { tMap: { value: null }, uDir: { value: new THREE.Vector2() } });
  let frame = null;   // the canvas, copied (a FramebufferTexture has a fixed size: rebuilt when the canvas changes)

  const add = pass(ADD_F, {
    tFrame: { value: null }, tNear: { value: q1.texture }, tWide: { value: e1.texture },
    uNear: { value: GLOW.near }, uWide: { value: GLOW.wide }, uExposure: { value: 1 },
  }, { blending: THREE.NoBlending });

  const quad = new THREE.Mesh(quadGeo, pick);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const emitMats = new WeakMap();   // source material -> its bare emission (kept in step every frame)

  function emitFor(m) {
    let e = emitMats.get(m);

    if (!e) {
      e = new THREE.MeshBasicMaterial({ toneMapped: false });
      emitMats.set(m, e);
    }

    e.color.copy(m.emissive).multiplyScalar(m.emissiveIntensity ?? 1);

    if (e.map !== (m.emissiveMap || null)) {
      e.map = m.emissiveMap || null;
      e.needsUpdate = true;
    }

    e.side = m.side;

    return e;
  }

  const size = new THREE.Vector2();

  function fit() {
    renderer.getDrawingBufferSize(size);

    const w = Math.max(1, size.x), h = Math.max(1, size.y);
    const dims = [[w / 2, h / 2], [w / 4, h / 4], [w / 4, h / 4], [w / 8, h / 8], [w / 8, h / 8]];

    targets.forEach((t, i) => {
      const tw = Math.max(1, Math.round(dims[i][0])), th = Math.max(1, Math.round(dims[i][1]));
      if (t.width !== tw || t.height !== th) t.setSize(tw, th);
    });
  }

  function run(material, src, dst) {
    quad.material = material;
    if (material.uniforms.tMap) material.uniforms.tMap.value = src;
    renderer.setRenderTarget(dst);
    renderer.render(quadScene, camera);
  }

  function blurInto(a, b, scale) {   // a -> b (horizontal) -> a (vertical)
    blur.uniforms.uDir.value.set(scale / a.width, 0);
    run(blur, a.texture, b);

    blur.uniforms.uDir.value.set(0, scale / a.height);
    run(blur, b.texture, a);
  }

  const swapped = [];   // [mesh, material, visible] for the emission pass

  return {
    /** Add the glow over the frame just drawn; false (and nothing drawn) when nothing in `scene` emits. */
    render(scene, sceneCamera, scale = 1) {
      let any = false;
      swapped.length = 0;

      scene.traverseVisible((o) => {
        if (!o.isMesh) return;

        const m = o.material;

        if (Array.isArray(m) || !m) {
          swapped.push([o, m, o.visible]);
          o.visible = false;
          return;
        }

        const glows = emitsLight(m);
        any = any || glows;
        swapped.push([o, m, o.visible]);

        if (glows) o.material = emitFor(m);
        else if (m.transparent) o.visible = false;
        else o.material = black;
      });

      if (!any) {
        for (const [o, m, v] of swapped) {
          o.material = m;
          o.visible = v;
        }

        swapped.length = 0;
        return false;
      }

      fit();

      const prev = {
        target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
        color: renderer.getClearColor(new THREE.Color()), shadows: renderer.shadowMap.autoUpdate,
        background: scene.background, exposure: renderer.toneMappingExposure,
      };

      scene.background = null;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(rtEmit);
      renderer.render(scene, sceneCamera);

      for (const [o, m, v] of swapped) {
        o.material = m;
        o.visible = v;
      }

      swapped.length = 0;
      scene.background = prev.background;

      pick.uniforms.uTexel.value.set(0.5 / rtEmit.width, 0.5 / rtEmit.height);
      run(pick, rtEmit.texture, q1);
      blurInto(q1, q2, scale);

      pick.uniforms.uTexel.value.set(0.5 / q1.width, 0.5 / q1.height);
      pick.uniforms.uThreshold.value = 0;   // q1 is already thresholded
      pick.uniforms.uKnee.value = 1e-3;
      run(pick, q1.texture, e1);

      pick.uniforms.uThreshold.value = GLOW.threshold;
      pick.uniforms.uKnee.value = GLOW.knee;
      blurInto(e1, e2, scale);
      blurInto(e1, e2, scale);

      renderer.setRenderTarget(prev.target);

      if (!frame || frame.image.width !== size.x || frame.image.height !== size.y) {
        if (frame) frame.dispose();
        frame = new THREE.FramebufferTexture(size.x, size.y);
        add.uniforms.tFrame.value = frame;
      }

      renderer.copyFramebufferToTexture(frame);
      add.uniforms.uExposure.value = prev.exposure;

      renderer.autoClear = false;
      quad.material = add;
      renderer.render(quadScene, camera);

      renderer.autoClear = prev.autoClear;
      renderer.setClearColor(prev.color, prev.alpha);
      renderer.shadowMap.autoUpdate = prev.shadows;

      return true;
    },

    dispose() {
      for (const t of targets) t.dispose();
      if (frame) frame.dispose();
      for (const m of [pick, blur, add, black]) m.dispose();
      quadGeo.dispose();
    },
  };
}
