import * as THREE from 'three';

// Effect meshes (light beams, dust, sparkles) live on this layer. The normal pass skips it,
// so effects never get ink outlines.
export const FX_LAYER = 1;

const COLOR_SAMPLES = 4;
const LINE_WIDTH = 1;
const INK_COLOR = '#3b2418';
const PAPER_COLOR = '#fbf4e4';
const ACCENT_COLOR = '#b3122e';

/**************************************************************
Shaders
***************************************************************/
const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #include <packing>

  uniform sampler2D tColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float lineWidth;
  uniform vec3 inkColor;
  uniform float inkStrength;
  uniform float time;
  uniform float grainAmount;
  uniform float vignetteAmount;
  uniform vec3 paperColor;
  uniform vec3 accentColor;
  uniform float impact;
  uniform float speedLines;
  uniform vec2 speedCenter;

  varying vec2 vUv;

  // 1 / distance changes linearly across a flat surface in screen space, so its
  // Laplacian stays near zero on planes and spikes only where geometry steps
  float readInverseDistance(vec2 uv) {
    float viewZ = perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
    return 1.0 / -viewZ;
  }

  vec3 readNormal(vec2 uv) {
    return texture2D(tNormal, uv).xyz * 2.0 - 1.0;
  }

  float hash(vec2 point) {
    point = fract(point * vec2(123.34, 456.21));
    point += dot(point, point + 45.32);
    return fract(point.x * point.y);
  }

  void main() {
    vec2 texel = lineWidth / resolution;
    vec2 offsetX = vec2(texel.x, 0.0);
    vec2 offsetY = vec2(0.0, texel.y);

    // Ink lines from depth steps (silhouettes) and normal changes (creases)
    float centerDepth = readInverseDistance(vUv);
    float depthLaplacian = readInverseDistance(vUv + offsetX) + readInverseDistance(vUv - offsetX)
      + readInverseDistance(vUv + offsetY) + readInverseDistance(vUv - offsetY) - 4.0 * centerDepth;
    float depthEdge = smoothstep(0.004, 0.012, abs(depthLaplacian) / centerDepth);

    vec3 centerNormal = readNormal(vUv);
    float normalDelta = distance(readNormal(vUv + offsetX), centerNormal)
      + distance(readNormal(vUv - offsetX), centerNormal)
      + distance(readNormal(vUv + offsetY), centerNormal)
      + distance(readNormal(vUv - offsetY), centerNormal);
    float normalEdge = smoothstep(0.6, 1.0, normalDelta);

    float ink = max(depthEdge, normalEdge) * inkStrength;
    vec3 color = mix(texture2D(tColor, vUv).rgb, inkColor, ink);

    // Impact frame: for an instant the picture collapses to paper and ink, lines in crimson
    if (impact > 0.5) {
      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(luminance > 0.3 ? paperColor : inkColor, accentColor, ink);
    }

    // Speed lines radiate from the action and are redrawn 12 times a second
    if (speedLines > 0.0) {
      vec2 fromCenter = (vUv - speedCenter) * vec2(resolution.x / resolution.y, 1.0);
      float lane = floor((atan(fromCenter.y, fromCenter.x) / 6.28318 + 0.5) * 520.0);
      float isLine = step(0.86, hash(vec2(lane, floor(time * 12.0))));
      float reach = smoothstep(0.1, 0.5, length(fromCenter));
      color = mix(color, paperColor, isLine * reach * speedLines * 0.8);
    }

    vec2 centered = (vUv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
    color *= 1.0 - vignetteAmount * smoothstep(0.35, 1.0, length(centered));

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>

    // Grain is re-rolled 12 times a second, in step with animation on twos
    float grain = hash(gl_FragCoord.xy + floor(time * 12.0) * 17.0) - 0.5;
    gl_FragColor.rgb += grain * grainAmount;
  }
`;

/**************************************************************
Post pass
***************************************************************/
export function createPostPass(renderer, scene, camera) {
  const colorTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples: COLOR_SAMPLES,
  });
  const normalTarget = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture: new THREE.DepthTexture(1, 1),
  });
  const normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });

  const uniforms = {
    tColor: { value: colorTarget.texture },
    tNormal: { value: normalTarget.texture },
    tDepth: { value: normalTarget.depthTexture },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: camera.near },
    cameraFar: { value: camera.far },
    lineWidth: { value: LINE_WIDTH },
    inkColor: { value: new THREE.Color(INK_COLOR) },
    inkStrength: { value: 0.85 },
    time: { value: 0 },
    grainAmount: { value: 0.035 },
    vignetteAmount: { value: 0.22 },
    paperColor: { value: new THREE.Color(PAPER_COLOR) },
    accentColor: { value: new THREE.Color(ACCENT_COLOR) },
    impact: { value: 0 },
    speedLines: { value: 0 },
    speedCenter: { value: new THREE.Vector2(0.5, 0.5) },
  };

  const compositeMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMaterial);
  compositeQuad.frustumCulled = false;
  const compositeScene = new THREE.Scene();
  compositeScene.add(compositeQuad);
  const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Shadows are refreshed once per frame by the color pass instead of again by the normal pass
  renderer.shadowMap.autoUpdate = false;
  camera.layers.enable(FX_LAYER);

  function setSize(width, height, pixelRatio) {
    colorTarget.setSize(width, height);
    normalTarget.setSize(width, height);
    uniforms.resolution.value.set(width, height);
    uniforms.lineWidth.value = LINE_WIDTH * pixelRatio;
  }

  function render(time) {
    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(colorTarget);
    renderer.render(scene, camera);

    camera.layers.disable(FX_LAYER);
    scene.overrideMaterial = normalMaterial;
    renderer.setRenderTarget(normalTarget);
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    camera.layers.enable(FX_LAYER);

    uniforms.time.value = time;
    uniforms.cameraNear.value = camera.near;
    uniforms.cameraFar.value = camera.far;
    renderer.setRenderTarget(null);
    renderer.render(compositeScene, compositeCamera);
  }

  return { uniforms, setSize, render };
}
