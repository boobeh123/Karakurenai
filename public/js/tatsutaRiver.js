import * as THREE from 'three';
import { createSeededRandom, createToonMaterial } from './materials.js';

// The poem's image made literal: the Tatsuta River in autumn, its water dyed crimson around
// the card. World units are centimetres; the water surface is y = 0 and flows toward +x.

const WATER_SIZE = { width: 1400, depth: 700 };
const FLOW = new THREE.Vector2(3, 0.6); // centimetres per second
const LANDING_POINT = new THREE.Vector3(0, 0, 0);
const FALL_START = new THREE.Vector3(-18, 80, -14);
const FLOAT_HEIGHT = 0.12;
const DYE_MAX_RADIUS = 170;
const BANK_Z = -300;
// Maples stand back from the bank's edge; each crown is a cluster of small faceted clumps
const TREE_ROW_Z = -390;
const CROWN_CLUMPS = { min: 7, extra: 4, radius: 14, radiusRange: 12, spread: 55, height: 40 };

const LEAF_COUNTS = { falling: 150, floating: 130 };
const FALL_AREA = { minX: -300, maxX: 300, minZ: -220, maxZ: 140, top: 170 };
const FLOAT_AREA = { minX: -450, maxX: 450, minZ: -260, maxZ: 160 };

const COLORS = {
  sky: '#f3ecd6',
  skyHorizon: '#f7dcc0',
  skyTop: '#c9d3ef',
  waterDeep: '#2c5d78',
  waterMid: '#4f8ea6',
  waterLight: '#8cc2cc',
  glint: '#ffffff',
  dye: '#b3122e',
  dyeDeep: '#7a0d20',
  bank: '#6b4a33',
  trunk: '#3f2a22',
  sun: '#ffe2b8',
  skyFill: '#b9c3f0',
  groundFill: '#e2c9a0',
};
// Crimson through orange to gold, weighted toward the poem's karakurenai
const LEAF_COLORS = ['#b3122e', '#b3122e', '#c8261c', '#9e1b2e', '#d9481c', '#e0701e', '#e8a33a'];

/**************************************************************
Helpers
***************************************************************/
function polar(radius, degrees) {
  const radians = THREE.MathUtils.degToRad(degrees);
  return new THREE.Vector2(radius * Math.cos(radians), radius * Math.sin(radians));
}

function wrap(value, min, max) {
  const span = max - min;
  return ((((value - min) % span) + span) % span) + min;
}

function pickFrom(items, random) {
  return items[Math.floor(random() * items.length)];
}

// A Japanese maple leaf: seven pointed lobes with deep cuts between them, and a short stem.
// One unit is the length of the top lobe.
function createLeafShape() {
  const lobes = [
    { angle: -25, length: 0.45 },
    { angle: 12, length: 0.72 },
    { angle: 50, length: 0.9 },
    { angle: 90, length: 1 },
    { angle: 130, length: 0.9 },
    { angle: 168, length: 0.72 },
    { angle: 205, length: 0.45 },
  ];
  const outline = lobes.flatMap((lobe, index) => {
    const next = lobes[index + 1];
    const tip = [polar(lobe.length * 0.62, lobe.angle - 9), polar(lobe.length, lobe.angle), polar(lobe.length * 0.62, lobe.angle + 9)];
    return next ? [...tip, polar(0.28, (lobe.angle + next.angle) / 2)] : tip;
  });
  const stem = [new THREE.Vector2(-0.05, -0.12), new THREE.Vector2(-0.03, -0.5), new THREE.Vector2(0.03, -0.5), new THREE.Vector2(0.05, -0.12)];
  return new THREE.Shape([...outline, ...stem]);
}

/**************************************************************
Water and sky
***************************************************************/
const noiseChunk = /* glsl */ `
  float hash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    vec2 smoothed = local * local * (3.0 - 2.0 * local);
    return mix(
      mix(hash(cell), hash(cell + vec2(1.0, 0.0)), smoothed.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), smoothed.x),
      smoothed.y
    );
  }
`;

// Cel-shaded water: three flat tones, white glints drifting with the current, ripple rings
// where the card lands, and crimson dye spreading out around the card
function createWater() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      flow: { value: FLOW },
      dyeCenter: { value: new THREE.Vector2() },
      dyeRadius: { value: 0 },
      rippleCenter: { value: new THREE.Vector2(LANDING_POINT.x, LANDING_POINT.z) },
      ripple: { value: 0 },
      deepColor: { value: new THREE.Color(COLORS.waterDeep) },
      midColor: { value: new THREE.Color(COLORS.waterMid) },
      lightColor: { value: new THREE.Color(COLORS.waterLight) },
      glintColor: { value: new THREE.Color(COLORS.glint) },
      dyeColor: { value: new THREE.Color(COLORS.dye) },
      dyeDeepColor: { value: new THREE.Color(COLORS.dyeDeep) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform vec2 flow;
      uniform vec2 dyeCenter;
      uniform float dyeRadius;
      uniform vec2 rippleCenter;
      uniform float ripple;
      uniform vec3 deepColor;
      uniform vec3 midColor;
      uniform vec3 lightColor;
      uniform vec3 glintColor;
      uniform vec3 dyeColor;
      uniform vec3 dyeDeepColor;

      varying vec3 vWorldPosition;

      ${noiseChunk}

      void main() {
        vec2 point = vWorldPosition.xz;
        vec2 drifted = point - flow * time;

        // Three flat tones; the water lightens toward the far bank, where it mirrors the sky
        float tone = smoothstep(120.0, -260.0, point.y) + (noise(drifted * 0.015) - 0.5) * 0.35;
        vec3 color = tone < 0.4 ? deepColor : (tone < 0.75 ? midColor : lightColor);

        // Crimson dye around the card, stretched along the current, with a ragged edge. Inside
        // it, streaks of crimson and deep red run with the current, like tie-dye: the poem's
        // "kukuru". No radius, no dye (the ragged edge alone would otherwise leave a stain).
        vec2 fromDye = (point - dyeCenter) * vec2(0.65, 1.0);
        float ragged = (noise(drifted * 0.05) - 0.5) * 28.0;
        float dye = smoothstep(dyeRadius + 4.0, dyeRadius - 4.0, length(fromDye) + ragged) * step(0.5, dyeRadius);
        float tieDye = step(0.5, noise(vec2(drifted.x * 0.02, drifted.y * 0.12)));
        color = mix(color, mix(dyeColor, dyeDeepColor, tieDye * 0.8), dye * 0.88);

        // Glints: noise stretched along the current, cut into white dashes
        float streak = noise(vec2(drifted.x * 0.035, drifted.y * 0.3));
        color = mix(color, glintColor, step(0.8, streak) * (1.0 - dye * 0.25) * 0.85);

        // Two ripple rings spreading from where the card landed
        float fromLanding = length(point - rippleCenter);
        float rings = 0.0;
        for (int index = 0; index < 2; index++) {
          float radius = ripple * (60.0 - float(index) * 22.0);
          rings += 1.0 - smoothstep(0.0, 1.6, abs(fromLanding - radius));
        }
        color = mix(color, glintColor, clamp(rings, 0.0, 1.0) * (1.0 - ripple) * step(0.001, ripple) * 0.9);

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });

  const water = new THREE.Mesh(new THREE.PlaneGeometry(WATER_SIZE.width, WATER_SIZE.depth), material);
  water.rotation.x = -Math.PI / 2;
  water.position.z = (BANK_Z + WATER_SIZE.depth / 2) - 20;
  return water;
}

// A flat backdrop of sky in three hard bands, the way anime backgrounds paint it
function createSky() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      horizonColor: { value: new THREE.Color(COLORS.skyHorizon) },
      middleColor: { value: new THREE.Color(COLORS.sky) },
      topColor: { value: new THREE.Color(COLORS.skyTop) },
    },
    vertexShader: /* glsl */ `
      varying float vHeight;

      void main() {
        vHeight = (modelMatrix * vec4(position, 1.0)).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 horizonColor;
      uniform vec3 middleColor;
      uniform vec3 topColor;
      varying float vHeight;

      void main() {
        vec3 color = vHeight < 140.0 ? horizonColor : (vHeight < 330.0 ? middleColor : topColor);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(4000, 1600), material);
  sky.position.set(0, 500, BANK_Z - 400);
  return sky;
}

/**************************************************************
Far bank
***************************************************************/
// An earth bank topped with red maples, seen as the camera rises at the end
function createFarBank(random) {
  const group = new THREE.Group();
  const bankDepth = TREE_ROW_Z - BANK_Z - 40;
  const bank = new THREE.Mesh(new THREE.BoxGeometry(2400, 20, -bankDepth), createToonMaterial({ color: COLORS.bank }));
  bank.position.set(0, 5, BANK_Z + bankDepth / 2);
  group.add(bank);

  const trunkMaterial = createToonMaterial({ color: COLORS.trunk });
  const trunkGeometry = new THREE.CylinderGeometry(2.5, 4, 70, 8);
  const clumpGeometry = new THREE.IcosahedronGeometry(1, 1);
  const clumpMaterials = LEAF_COLORS.map((color) => createToonMaterial({ color }));

  Array.from({ length: 14 }).forEach((_, index) => {
    const x = -800 + index * 120 + (random() - 0.5) * 50;
    const z = TREE_ROW_Z - random() * 50;
    const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
    trunk.position.set(x, 50, z);
    group.add(trunk);

    // A rough dome of clumps, mostly one colour with a neighbour or two mixed in
    const baseColor = Math.floor(random() * clumpMaterials.length);
    const clumpCount = CROWN_CLUMPS.min + Math.floor(random() * CROWN_CLUMPS.extra);
    Array.from({ length: clumpCount }).forEach(() => {
      const angle = random() * Math.PI * 2;
      const reach = Math.sqrt(random()) * CROWN_CLUMPS.spread;
      const clump = new THREE.Mesh(
        clumpGeometry,
        clumpMaterials[(baseColor + Math.floor(random() * 2)) % clumpMaterials.length]
      );
      clump.scale.setScalar(CROWN_CLUMPS.radius + random() * CROWN_CLUMPS.radiusRange);
      clump.position.set(
        x + Math.cos(angle) * reach,
        95 + random() * CROWN_CLUMPS.height - (reach / CROWN_CLUMPS.spread) * 15,
        z + Math.sin(angle) * reach * 0.4
      );
      group.add(clump);
    });
  });

  return group;
}

/**************************************************************
Leaves
***************************************************************/
// Every leaf in one instanced mesh: some flutter down, some drift on the current
function createLeaves(random) {
  const count = LEAF_COUNTS.falling + LEAF_COUNTS.floating;
  const leaves = new THREE.InstancedMesh(
    new THREE.ShapeGeometry(createLeafShape()),
    createToonMaterial({ side: THREE.DoubleSide }),
    count
  );

  const settings = Array.from({ length: count }, (_, index) => {
    const isFalling = index < LEAF_COUNTS.falling;
    leaves.setColorAt(index, new THREE.Color(pickFrom(LEAF_COLORS, random)));
    return {
      isFalling,
      x: isFalling
        ? THREE.MathUtils.lerp(FALL_AREA.minX, FALL_AREA.maxX, random())
        : THREE.MathUtils.lerp(FLOAT_AREA.minX, FLOAT_AREA.maxX, random()),
      z: isFalling
        ? THREE.MathUtils.lerp(FALL_AREA.minZ, FALL_AREA.maxZ, random())
        : THREE.MathUtils.lerp(FLOAT_AREA.minZ, FLOAT_AREA.maxZ, random()),
      phase: random(),
      speed: 8 + random() * 6,
      sway: 6 + random() * 9,
      swayRate: 0.8 + random() * 0.8,
      spin: (random() - 0.5) * 3,
      size: 2.6 + random() * 1.2,
    };
  });
  leaves.instanceColor.needsUpdate = true;

  const placer = new THREE.Object3D();
  function update(time) {
    settings.forEach((leaf, index) => {
      const turn = leaf.phase * Math.PI * 2;
      if (leaf.isFalling) {
        const fallen = (leaf.speed * time + leaf.phase * FALL_AREA.top) % FALL_AREA.top;
        placer.position.set(
          wrap(leaf.x + Math.sin(time * leaf.swayRate + turn) * leaf.sway + FLOW.x * time * 0.3, FALL_AREA.minX, FALL_AREA.maxX),
          FALL_AREA.top - fallen,
          leaf.z + Math.cos(time * leaf.swayRate * 0.7 + turn) * leaf.sway * 0.5
        );
        placer.rotation.set(Math.sin(time * 2.2 + turn) * 1.1, turn + time * 0.4, time * leaf.spin + turn);
      } else {
        placer.position.set(
          wrap(leaf.x + FLOW.x * time, FLOAT_AREA.minX, FLOAT_AREA.maxX),
          0.25 + Math.sin(time * 1.5 + turn) * 0.05,
          wrap(leaf.z + FLOW.y * time, FLOAT_AREA.minZ, FLOAT_AREA.maxZ)
        );
        // Lying flat on the water, turning slowly
        placer.rotation.set(-Math.PI / 2 + Math.sin(time * 1.2 + turn) * 0.06, 0, turn + time * 0.08 * leaf.spin);
      }
      placer.scale.setScalar(leaf.size);
      placer.updateMatrix();
      leaves.setMatrixAt(index, placer.matrix);
    });
    leaves.instanceMatrix.needsUpdate = true;
  }

  return { leaves, update };
}

/**************************************************************
River
***************************************************************/
function createLights() {
  const group = new THREE.Group();
  const sun = new THREE.DirectionalLight(COLORS.sun, 2.4);
  sun.position.set(-200, 300, 150);
  const fill = new THREE.HemisphereLight(COLORS.skyFill, COLORS.groundFill, 1.8);
  group.add(sun, fill);
  return group;
}

// The card sits where it would be `seconds` after landing, carried by the current
function getCardPositionAfter(seconds) {
  return LANDING_POINT.clone().add(new THREE.Vector3(FLOW.x * seconds, 0, FLOW.y * seconds));
}

export function createTatsutaRiver({ heroCard }) {
  const random = createSeededRandom(69);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.sky);

  const water = createWater();
  const { leaves, update: updateLeaves } = createLeaves(random);
  // The same card as in the hall, sharing its geometry and face texture
  const card = new THREE.Mesh(heroCard.mesh.geometry, heroCard.mesh.material);
  scene.add(createLights(), createSky(), createFarBank(random), water, leaves, card);

  function updateCard({ cardFall, floatSeconds }) {
    if (floatSeconds <= 0) {
      // Tumbling down on twos, landing face up: the tumble counts are whole turns
      const fall = cardFall * cardFall;
      card.position.lerpVectors(FALL_START, LANDING_POINT, fall);
      card.position.y = THREE.MathUtils.lerp(FALL_START.y, FLOAT_HEIGHT, fall);
      card.rotation.set((1 - cardFall) * Math.PI * 4, cardFall * 0.5, (1 - cardFall) * Math.PI * 2);
      return;
    }
    card.position.copy(getCardPositionAfter(floatSeconds));
    card.position.y = FLOAT_HEIGHT + Math.sin(floatSeconds * 2) * 0.08;
    card.rotation.set(Math.sin(floatSeconds * 1.3) * 0.03, 0.5 + floatSeconds * 0.05, Math.sin(floatSeconds * 1.7) * 0.03);
  }

  function update({ drawnTime, fx }) {
    updateCard(fx);
    updateLeaves(drawnTime);

    const { uniforms } = water.material;
    uniforms.time.value = drawnTime;
    uniforms.ripple.value = fx.ripple;
    uniforms.dyeRadius.value = fx.dye * DYE_MAX_RADIUS;
    // The dye leans downstream of the card
    uniforms.dyeCenter.value.set(card.position.x + uniforms.dyeRadius.value * 0.25, card.position.z);
  }

  return { scene, update, getCardPositionAfter };
}
