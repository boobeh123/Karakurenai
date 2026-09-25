import * as THREE from 'three';
import {
  createCardFaceTexture,
  createSeededRandom,
  createTatamiTexture,
  createToonMaterial,
  getTorifudaText,
  loadCardFont,
} from './materials.js';
import { HERO_POEM_NUMBER, POEMS } from './poems.js';
import { FX_LAYER } from './postPass.js';

// World units are centimetres
const CARD_WIDTH = 5.2;
const CARD_LENGTH = 7.3;
const CARD_THICKNESS = 0.2;
const CARD_TEXTURE_WIDTH = 360;
const HERO_CARD_TEXTURE_WIDTH = 720;
const CENTER_GAP = 3;
const ROW_GAP = 1;

const MAT_LENGTH = 182;
const MAT_WIDTH = 91;
const MAT_THICKNESS = 5;
const MAT_ROW_COUNT = 7;

// The window is in the wall behind the opponent, so the player's view looks into the light.
// The sill height puts the lattice's horizontal shadows just outside the board's rows
// (z ≈ -25 and +26), so every card sits in the light.
const ROOM = { minX: -250, maxX: 250, minZ: -200, maxZ: 260, height: 270, wallThickness: 12 };
const WINDOW = { bottom: 48, top: 200, centerX: -60, halfWidth: 120 };
const LATTICE = { columnSpacing: 30, rowSpacing: 32, barSize: 2.4, barDepth: 3 };
const LATTICE_Z = ROOM.minZ - ROOM.wallThickness / 2;

// Points toward a low afternoon sun, about 30 degrees above the horizon
const SUN_DIRECTION = new THREE.Vector3(-0.3, 0.62, -1).normalize();

const COLORS = {
  exterior: '#fff4dc',
  wall: '#efe2c6',
  wood: '#7a5238',
  underlay: '#c9c690',
  cardBack: '#3f7a4c',
  sun: '#ffdcaa',
  skyFill: '#aa9cf0',
  groundFill: '#e6cda8',
  beam: '#ffe6b8',
};

// Mid-match: 12 cards left in each territory, 3 rows per side, grouped left and right
// the way players arrange them. Values are x positions of card centres.
const TERRITORY_ROWS = {
  player: [
    [-38.5, -33, -14, 22, 38.5],
    [-38.5, -8, 33, 38.5],
    [-38.5, -33, 38.5],
  ],
  opponent: [
    [-38.5, -20, 16, 33, 38.5],
    [-38.5, -33, 0, 38.5],
    [-38.5, 30, 38.5],
  ],
};
const HERO_SLOT = { side: 'player', rowIndex: 1, index: 1 };

// The reader kneels beside the board on the centre line, facing it
const READER_POSITION = new THREE.Vector3(-80, 0, 0);

// The swept card arcs up toward the camera and tumbles end over end
const FLIGHT_CONTROL = new THREE.Vector3(1, 15, 4);
const FLIGHT_END = new THREE.Vector3(4, 10, 11);
const FLIGHT_TUMBLES = 2.5;
// Cards this close to the hero card skid when it is swept away
const SKID_RADIUS = 14;

const DUST_COUNT = 220;
const SPARKLE_COUNT = 6;
const FX_COLORS = {
  dust: '#fff1d6',
  ring: '#ece6ff',
  smear: '#fff6ec',
  sparkle: '#fff4c8',
};

/**************************************************************
Helpers
***************************************************************/
function shuffle(items, random) {
  return items
    .map((item) => ({ item, order: random() }))
    .sort((a, b) => a.order - b.order)
    .map(({ item }) => item);
}

function addBox(group, material, size, position, { castShadow = false } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

// Distance from the centre line to the middle of a territory row
function getRowOffset(rowIndex) {
  return CENTER_GAP / 2 + CARD_LENGTH / 2 + rowIndex * (CARD_LENGTH + ROW_GAP);
}

/**************************************************************
Floor and room
***************************************************************/
// Mats laid in offset rows so four corners never meet. The middle row puts one whole
// mat under the board.
function createFloor(maxAnisotropy) {
  const group = new THREE.Group();
  const texture = createTatamiTexture(maxAnisotropy);
  const materials = [
    createToonMaterial({ map: texture }),
    createToonMaterial({ map: texture, color: '#f1ead4' }),
  ];

  Array.from({ length: MAT_ROW_COUNT }).forEach((_, row) => {
    const z = (row - (MAT_ROW_COUNT - 1) / 2) * MAT_WIDTH;
    const xPositions = row % 2 === 1 ? [-182, 0, 182] : [-273, -91, 91, 273];
    xPositions.forEach((x, column) => {
      const material = materials[(row + column) % materials.length];
      addBox(group, material, [MAT_LENGTH, MAT_THICKNESS, MAT_WIDTH], [x, -MAT_THICKNESS / 2, z]);
    });
  });

  // A tatami-coloured underlay just below the mats fills any hairline gaps between them
  const underlay = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), createToonMaterial({ color: COLORS.underlay }));
  underlay.rotation.x = -Math.PI / 2;
  underlay.position.y = -0.05;
  underlay.receiveShadow = true;
  group.add(underlay);

  return group;
}

function createWindowWall() {
  const group = new THREE.Group();
  const wallMaterial = createToonMaterial({ color: COLORS.wall });
  const woodMaterial = createToonMaterial({ color: COLORS.wood });
  const width = ROOM.maxX - ROOM.minX;
  const openingLeft = WINDOW.centerX - WINDOW.halfWidth;
  const openingRight = WINDOW.centerX + WINDOW.halfWidth;
  const openingHeight = WINDOW.top - WINDOW.bottom;
  const openingMiddle = (WINDOW.top + WINDOW.bottom) / 2;
  const shadowCaster = { castShadow: true };
  const thickness = ROOM.wallThickness;

  // Wall around the opening
  addBox(group, wallMaterial, [width, WINDOW.bottom, thickness], [0, WINDOW.bottom / 2, LATTICE_Z], shadowCaster);
  addBox(
    group,
    wallMaterial,
    [width, ROOM.height - WINDOW.top, thickness],
    [0, (WINDOW.top + ROOM.height) / 2, LATTICE_Z],
    shadowCaster
  );
  // The side pieces overlap the pieces above and below by 1 cm and stand 1 cm proud of
  // them, so no crack or edge-on face shows where they meet (the edge detector would ink it)
  [
    [ROOM.minX, openingLeft],
    [openingRight, ROOM.maxX],
  ].forEach(([left, right]) => {
    addBox(
      group,
      wallMaterial,
      [right - left, openingHeight + 2, thickness + 1],
      [(left + right) / 2, openingMiddle, LATTICE_Z + 0.5],
      shadowCaster
    );
  });

  // Wooden frame: sill, lintel and jambs
  const frameSize = 6;
  const frameZ = ROOM.minZ + 1;
  const frameWidth = WINDOW.halfWidth * 2 + frameSize * 2;
  [WINDOW.bottom, WINDOW.top].forEach((y) => {
    addBox(group, woodMaterial, [frameWidth, frameSize, frameSize], [WINDOW.centerX, y, frameZ], shadowCaster);
  });
  [openingLeft, openingRight].forEach((x) => {
    addBox(group, woodMaterial, [frameSize, openingHeight, frameSize], [x, openingMiddle, frameZ], shadowCaster);
  });

  // Lattice bars: their shadows lay a grid of light across the tatami
  const columnCount = Math.floor(WINDOW.halfWidth / LATTICE.columnSpacing);
  Array.from({ length: columnCount * 2 - 1 }).forEach((_, index) => {
    const x = WINDOW.centerX + (index - (columnCount - 1)) * LATTICE.columnSpacing;
    addBox(
      group,
      woodMaterial,
      [LATTICE.barSize, openingHeight, LATTICE.barDepth],
      [x, openingMiddle, LATTICE_Z],
      shadowCaster
    );
  });
  const rowCount = Math.round(openingHeight / LATTICE.rowSpacing);
  Array.from({ length: rowCount - 1 }).forEach((_, index) => {
    const y = WINDOW.bottom + (index + 1) * LATTICE.rowSpacing;
    addBox(
      group,
      woodMaterial,
      [WINDOW.halfWidth * 2, LATTICE.barSize, LATTICE.barDepth],
      [WINDOW.centerX, y, LATTICE_Z],
      shadowCaster
    );
  });

  return group;
}

function createSideWalls() {
  const group = new THREE.Group();
  const wallMaterial = createToonMaterial({ color: COLORS.wall });
  const thickness = ROOM.wallThickness;
  const depth = ROOM.maxZ - ROOM.minZ;
  const centerZ = (ROOM.minZ + ROOM.maxZ) / 2;

  [ROOM.minX - thickness / 2, ROOM.maxX + thickness / 2].forEach((x) => {
    addBox(group, wallMaterial, [thickness, ROOM.height, depth], [x, ROOM.height / 2, centerZ]);
  });

  return group;
}

/**************************************************************
Light
***************************************************************/
function createLights() {
  const group = new THREE.Group();

  // Lavender fill keeps shadows soft and coloured instead of black
  const fill = new THREE.HemisphereLight(COLORS.skyFill, COLORS.groundFill, 2.1);

  const sun = new THREE.DirectionalLight(COLORS.sun, 2.2);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(500);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.3;
  Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 50, far: 1000 });
  sun.shadow.camera.updateProjectionMatrix();

  group.add(fill, sun, sun.target);
  return group;
}

// Translucent shafts from the window to the floor. Each point traces back toward the sun
// to the lattice plane, so the shafts break into bands where the bars block the light.
function createSunBeams() {
  const openingLeft = WINDOW.centerX - WINDOW.halfWidth;
  const openingRight = WINDOW.centerX + WINDOW.halfWidth;
  const windowCorners = [
    new THREE.Vector3(openingLeft, WINDOW.top, ROOM.minZ),
    new THREE.Vector3(openingRight, WINDOW.top, ROOM.minZ),
    new THREE.Vector3(openingRight, WINDOW.bottom, ROOM.minZ),
    new THREE.Vector3(openingLeft, WINDOW.bottom, ROOM.minZ),
  ];
  const floorCorners = windowCorners.map((corner) =>
    corner.clone().addScaledVector(SUN_DIRECTION, -corner.y / SUN_DIRECTION.y)
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setFromPoints([...windowCorners, ...floorCorners]);
  // Top, bottom and both sides of the prism; the window and floor ends stay open
  geometry.setIndex([0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      beamColor: { value: new THREE.Color(COLORS.beam) },
      opacity: { value: 0.12 },
      sunDirection: { value: SUN_DIRECTION },
      latticeZ: { value: LATTICE_Z },
      latticeOrigin: { value: new THREE.Vector2(WINDOW.centerX, WINDOW.bottom) },
      paneSize: { value: new THREE.Vector2(LATTICE.columnSpacing, LATTICE.rowSpacing) },
      barSize: { value: LATTICE.barSize },
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
      uniform vec3 beamColor;
      uniform float opacity;
      uniform vec3 sunDirection;
      uniform float latticeZ;
      uniform vec2 latticeOrigin;
      uniform vec2 paneSize;
      uniform float barSize;

      varying vec3 vWorldPosition;

      void main() {
        float travel = (latticeZ - vWorldPosition.z) / sunDirection.z;
        vec3 onLattice = vWorldPosition + sunDirection * travel;
        vec2 paneCoord = (onLattice.xy - latticeOrigin) / paneSize;
        vec2 barDistance = abs(fract(paneCoord + 0.5) - 0.5) * paneSize;
        float open = smoothstep(barSize * 0.5, barSize * 0.5 + 1.5, min(barDistance.x, barDistance.y));
        float fromFloor = smoothstep(0.0, 160.0, vWorldPosition.y);
        gl_FragColor = vec4(beamColor, opacity * open * mix(0.25, 1.0, fromFloor));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const beams = new THREE.Mesh(geometry, material);
  beams.layers.set(FX_LAYER);
  return beams;
}

/**************************************************************
Effects
***************************************************************/
// Dust motes drifting inside the sun beams. Each mote sits somewhere along a ray between
// the window and the floor, and wanders around that spot in the vertex shader.
function createDust(random) {
  const openingLeft = WINDOW.centerX - WINDOW.halfWidth;
  const positions = new Float32Array(DUST_COUNT * 3);
  const seeds = new Float32Array(DUST_COUNT);

  Array.from({ length: DUST_COUNT }).forEach((_, index) => {
    const mote = new THREE.Vector3(
      openingLeft + random() * WINDOW.halfWidth * 2,
      WINDOW.bottom + random() * (WINDOW.top - WINDOW.bottom),
      ROOM.minZ
    );
    const rayLength = mote.y / SUN_DIRECTION.y;
    mote.addScaledVector(SUN_DIRECTION, -(0.15 + random() * 0.8) * rayLength);
    positions.set([mote.x, mote.y, mote.z], index * 3);
    seeds[index] = random();
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      pointScale: { value: 1 },
      color: { value: new THREE.Color(FX_COLORS.dust) },
    },
    vertexShader: /* glsl */ `
      attribute float seed;
      uniform float time;
      uniform float pointScale;
      varying float vAlpha;

      void main() {
        float phase = seed * 6.2831;
        vec3 drift = vec3(
          sin(time * 0.23 + phase) * 4.0,
          sin(time * 0.31 + phase * 1.7) * 3.0,
          cos(time * 0.19 + phase * 2.3) * 4.0
        );
        vec4 viewPosition = modelViewMatrix * vec4(position + drift, 1.0);
        gl_PointSize = (0.35 + seed * 0.5) * pointScale / -viewPosition.z;
        vAlpha = 0.45 + 0.35 * sin(time * 1.3 + phase * 3.0);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying float vAlpha;

      void main() {
        float softness = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
        gl_FragColor = vec4(color, softness * vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const dust = new THREE.Points(geometry, material);
  dust.layers.set(FX_LAYER);
  return dust;
}

// The reader's voice, drawn as rings that spread out across the tatami. Normal blending,
// because an additive pale ring vanishes against the sunlit mats.
function createSoundRings() {
  const geometry = new THREE.RingGeometry(0.93, 1, 128);
  geometry.rotateX(-Math.PI / 2);

  return [0, 0.22].map((delay) => {
    const material = new THREE.MeshBasicMaterial({
      color: FX_COLORS.ring,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(READER_POSITION.x, 0.4, READER_POSITION.z);
    mesh.layers.set(FX_LAYER);
    mesh.visible = false;
    return { mesh, delay };
  });
}

// Smear frame: the sweeping hand stretched into a streaked ribbon along its path.
// Feature 2b draws the hand itself at the ribbon's head.
function createSmear() {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(16, 2.5, 24),
    new THREE.Vector3(-2, 4, 18),
    new THREE.Vector3(-26, 3, 8)
  );
  const segments = 40;
  const positions = [];
  const uvs = [];
  const indices = [];

  Array.from({ length: segments + 1 }).forEach((_, index) => {
    const along = index / segments;
    const point = curve.getPoint(along);
    const tangent = curve.getTangent(along);
    // Widens toward the head, the way a smear trails off behind the hand
    const halfWidth = 2.6 * (0.35 + 0.65 * along);
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize().multiplyScalar(halfWidth);
    positions.push(...point.clone().sub(side).toArray(), ...point.clone().add(side).toArray());
    uvs.push(along, 0, along, 1);
    if (index < segments) {
      const first = index * 2;
      indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      progress: { value: 0 },
      color: { value: new THREE.Color(FX_COLORS.smear) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float progress;
      uniform vec3 color;
      varying vec2 vUv;

      void main() {
        float trail = smoothstep(progress - 0.55, progress, vUv.x) * step(vUv.x, progress);
        float streaks = 0.6 + 0.4 * step(0.5, fract(vUv.y * 6.0));
        float edges = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
        gl_FragColor = vec4(color, trail * streaks * edges * 0.95);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const smear = new THREE.Mesh(geometry, material);
  smear.layers.set(FX_LAYER);
  smear.visible = false;
  return smear;
}

// Four-pointed sparkles that pop around the flying card
function createSparkles(random) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKLE_COUNT * 3), 3));
  geometry.setAttribute('life', new THREE.BufferAttribute(new Float32Array(SPARKLE_COUNT), 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      pointScale: { value: 1 },
      color: { value: new THREE.Color(FX_COLORS.sparkle) },
    },
    vertexShader: /* glsl */ `
      attribute float life;
      uniform float pointScale;
      varying float vLife;

      void main() {
        vLife = life;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 4.0 * sin(life * 3.14159) * pointScale / -viewPosition.z;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying float vLife;

      void main() {
        vec2 point = gl_PointCoord * 2.0 - 1.0;
        float arms = max(
          1.0 - abs(point.x) * 9.0 - abs(point.y),
          1.0 - abs(point.y) * 9.0 - abs(point.x)
        );
        float glow = 1.0 - length(point) * 2.5;
        float star = clamp(max(arms, glow), 0.0, 1.0);
        gl_FragColor = vec4(color, star * sin(vLife * 3.14159));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const sparkles = new THREE.Points(geometry, material);
  sparkles.layers.set(FX_LAYER);
  sparkles.frustumCulled = false;
  const offsets = Array.from(
    { length: SPARKLE_COUNT },
    () => new THREE.Vector3((random() - 0.5) * 12, (random() - 0.3) * 8, (random() - 0.5) * 10)
  );
  return { sparkles, offsets };
}

/**************************************************************
Cards
***************************************************************/
function createCards(maxAnisotropy, random) {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(CARD_WIDTH, CARD_THICKNESS, CARD_LENGTH);
  const edgeMaterial = createToonMaterial({ color: COLORS.cardBack });
  const heroPoem = POEMS.find((poem) => poem.number === HERO_POEM_NUMBER);
  const otherPoems = shuffle(
    POEMS.filter((poem) => poem.number !== HERO_POEM_NUMBER),
    random
  );

  const slots = Object.entries(TERRITORY_ROWS).flatMap(([side, rows]) =>
    rows.flatMap((row, rowIndex) => row.map((x, index) => ({ side, rowIndex, index, x })))
  );

  const cards = slots.map((slot) => {
    const isHero =
      slot.side === HERO_SLOT.side && slot.rowIndex === HERO_SLOT.rowIndex && slot.index === HERO_SLOT.index;
    const poem = isHero ? heroPoem : otherPoems.pop();
    const faceMaterial = createToonMaterial({
      map: createCardFaceTexture({
        lowerVerse: poem.lower,
        width: isHero ? HERO_CARD_TEXTURE_WIDTH : CARD_TEXTURE_WIDTH,
        maxAnisotropy,
      }),
    });

    // BoxGeometry face order: +x, -x, +y (the face), -y, +z, -z
    const mesh = new THREE.Mesh(geometry, [
      edgeMaterial,
      edgeMaterial,
      faceMaterial,
      edgeMaterial,
      edgeMaterial,
      edgeMaterial,
    ]);
    const sideSign = slot.side === 'player' ? 1 : -1;
    // Small offsets so the layout looks placed by hand
    mesh.position.set(
      slot.x + (random() - 0.5) * 0.8,
      CARD_THICKNESS / 2,
      sideSign * getRowOffset(slot.rowIndex) + (random() - 0.5) * 0.5
    );
    // Opponent cards face the opponent, so their text reads upside down from here
    mesh.rotation.y = (slot.side === 'player' ? 0 : Math.PI) + (random() - 0.5) * 0.04;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    return { mesh, poem, isHero };
  });

  return { group, cards };
}

/**************************************************************
Hall
***************************************************************/
export async function createKarutaHall({ maxAnisotropy }) {
  const random = createSeededRandom(17);
  await loadCardFont(POEMS.map((poem) => getTorifudaText(poem.lower)).join(''));

  const group = new THREE.Group();
  const { group: cardGroup, cards } = createCards(maxAnisotropy, random);
  const beams = createSunBeams();
  const baseBeamOpacity = beams.material.uniforms.opacity.value;
  const dust = createDust(random);
  const rings = createSoundRings();
  const smear = createSmear();
  const { sparkles, offsets: sparkleOffsets } = createSparkles(random);

  group.add(
    createFloor(maxAnisotropy),
    createWindowWall(),
    createSideWalls(),
    createLights(),
    cardGroup,
    beams,
    dust,
    smear,
    sparkles,
    ...rings.map(({ mesh }) => mesh)
  );

  // Resting places, so every loop starts from the same layout
  const heroCard = cards.find((card) => card.isHero);
  const heroRest = { position: heroCard.mesh.position.clone(), rotation: heroCard.mesh.rotation.clone() };
  const flightCurve = new THREE.QuadraticBezierCurve3(
    heroRest.position.clone(),
    heroRest.position.clone().add(FLIGHT_CONTROL),
    heroRest.position.clone().add(FLIGHT_END)
  );
  const neighbours = cards
    .filter((card) => !card.isHero && card.mesh.position.distanceTo(heroRest.position) < SKID_RADIUS)
    .map(({ mesh }) => {
      const away = mesh.position.clone().sub(heroRest.position).setY(0);
      const falloff = 1 - away.length() / SKID_RADIUS;
      return {
        mesh,
        restPosition: mesh.position.clone(),
        restAngle: mesh.rotation.y,
        push: away.normalize().multiplyScalar(2.2 * falloff),
        spin: (random() - 0.5) * 0.3 * falloff,
      };
    });

  function updateCards(fx) {
    if (fx.flight > 0) {
      heroCard.mesh.position.copy(flightCurve.getPoint(fx.flight));
      heroCard.mesh.rotation.set(
        heroRest.rotation.x - fx.flight * FLIGHT_TUMBLES * Math.PI * 2,
        heroRest.rotation.y + fx.flight * 0.6,
        heroRest.rotation.z + fx.flight * Math.PI * 1.5
      );
    } else {
      heroCard.mesh.position.copy(heroRest.position);
      heroCard.mesh.rotation.copy(heroRest.rotation);
    }

    neighbours.forEach(({ mesh, restPosition, restAngle, push, spin }) => {
      mesh.position.copy(restPosition).addScaledVector(push, fx.skid);
      mesh.rotation.y = restAngle + spin * fx.skid;
    });
  }

  function updateEffects(fx, drawnTime, pointScale) {
    dust.material.uniforms.time.value = drawnTime;
    dust.material.uniforms.pointScale.value = pointScale;

    rings.forEach(({ mesh, delay }) => {
      const progress = Math.min(1, Math.max(0, (fx.ring - delay) / (1 - delay)));
      mesh.visible = progress > 0 && progress < 1;
      mesh.scale.setScalar(5 + progress * 150);
      mesh.material.opacity = 0.8 * (1 - progress) ** 1.2;
    });

    smear.visible = fx.smear > 0;
    smear.material.uniforms.progress.value = fx.smear * 1.2;

    const positions = sparkles.geometry.attributes.position;
    const lives = sparkles.geometry.attributes.life;
    sparkleOffsets.forEach((offset, index) => {
      const spawn = (index / SPARKLE_COUNT) * 0.7;
      lives.setX(index, Math.min(1, Math.max(0, (fx.sparkle - spawn) / 0.3)));
      positions.setXYZ(index, ...heroCard.mesh.position.clone().add(offset).toArray());
    });
    positions.needsUpdate = true;
    lives.needsUpdate = true;
    sparkles.material.uniforms.pointScale.value = pointScale;
  }

  // time drives smooth light changes; drawnTime (stepped on twos) drives drawn motion
  function update({ time, drawnTime, fx, pointScale }) {
    // A slow breath in the light, as if thin clouds pass the sun
    beams.material.uniforms.opacity.value = baseBeamOpacity * (0.85 + 0.15 * Math.sin(time * 0.6));
    updateCards(fx);
    updateEffects(fx, drawnTime, pointScale);
  }

  return {
    group,
    cards,
    heroCard,
    heroRestPosition: heroRest.position.clone(),
    readerPosition: READER_POSITION.clone(),
    background: new THREE.Color(COLORS.exterior),
    update,
  };
}
