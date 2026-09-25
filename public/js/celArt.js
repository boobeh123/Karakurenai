import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import playerEyesSvg from '../art/playerEyes.svg?raw';
import readerBreathSvg from '../art/readerBreath.svg?raw';
import { createReadingCardTexture } from './materials.js';
import { HERO_READING_LINES } from './poems.js';

// Character art is drawn in SVG and turned into flat meshes, one per fill and per stroke,
// layered in document order: anime cels composited over the 3D room.

// Each shape sits a hair in front of the one before (in SVG units), so depth testing layers
// the drawing in document order and a cutout hides what is behind it like a solid object.
// Shapes inside <g data-layer="front"> jump further forward, so a textured plane (the
// reading card) can sit between the art's back and front.
const Z_STEP = 0.02;
const FRONT_Z = 40;
const CURVE_SEGMENTS = 16;

// Insert shots are drawn on a 1600 x 900 (16:9) sheet. Each has a focus band (in sheet x) that
// narrow screens crop down to before any space above or below the sheet shows.
const SHEET = { width: 1600, height: 900 };
const FOCUS = {
  // The reader's mouth, the breath and the card
  readerBreath: { left: 420, right: 1250 },
  // Both eyes: the strip letterboxes on black instead of cropping
  playerEyes: { left: 0, right: 1600 },
};
const READING_CARD = { x: 1080, y: 520, width: 250, height: 430, tilt: THREE.MathUtils.degToRad(5) };

const svgLoader = new SVGLoader();

/**************************************************************
Helpers
***************************************************************/
// The name of the nearest enclosing <g data-layer="…">, if any
function findLayerName(node) {
  let current = node;
  while (current && current.getAttribute) {
    const layer = current.getAttribute('data-layer');
    if (layer) return layer;
    current = current.parentNode;
  }
  return null;
}

/**************************************************************
SVG to meshes
***************************************************************/
// Cutouts stay on the default layer, so the normal pass sees them as solid: the edge
// detector then never inks the floor's lines through a character.
export function createCelArt(svgMarkup, { castShadow = false } = {}) {
  const { paths } = svgLoader.parse(svgMarkup);
  const group = new THREE.Group();
  const layers = new Map();
  let order = 0;

  function addShape(geometry, color, opacity, layerName) {
    // Unlit and flat like a painted cel. Only see-through shapes skip depth writes.
    const isTranslucent = opacity < 1;
    const material = new THREE.MeshBasicMaterial({
      color,
      opacity,
      transparent: isTranslucent,
      depthWrite: !isTranslucent,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = order * Z_STEP + (layerName === 'front' ? FRONT_Z : 0);
    mesh.castShadow = castShadow;
    order += 1;
    group.add(mesh);

    if (layerName) {
      layers.set(layerName, [...(layers.get(layerName) ?? []), mesh]);
    }
  }

  paths.forEach((path) => {
    const { style, node } = path.userData;
    const layerName = findLayerName(node);
    const opacity = style.opacity ?? 1;

    if (style.fill && style.fill !== 'none') {
      path.toShapes().forEach((shape) => {
        addShape(new THREE.ShapeGeometry(shape, CURVE_SEGMENTS), path.color, style.fillOpacity * opacity, layerName);
      });
    }
    if (style.stroke && style.stroke !== 'none') {
      const strokeColor = new THREE.Color().setStyle(style.stroke);
      path.subPaths.forEach((subPath) => {
        const geometry = SVGLoader.pointsToStroke(subPath.getPoints(CURVE_SEGMENTS), style);
        if (geometry) {
          addShape(geometry, strokeColor, style.strokeOpacity * opacity, layerName);
        }
      });
    }
  });

  function setLayerVisible(name, visible) {
    (layers.get(name) ?? []).forEach((mesh) => {
      mesh.visible = visible;
    });
  }

  return { group, setLayerVisible };
}

// A cutout that stands in the 3D room: SVG y runs down, so the art is flipped, and the anchor
// point of the drawing (in SVG units) lands on the group's origin
export function createCutout(svgMarkup, { anchor, scale, mirror = false, castShadow = false }) {
  const art = createCelArt(svgMarkup, { castShadow });
  const direction = mirror ? -1 : 1;
  art.group.scale.set(scale * direction, -scale, scale);
  art.group.position.set(-anchor[0] * scale * direction, anchor[1] * scale, 0);
  const cutout = new THREE.Group();
  cutout.add(art.group);
  return cutout;
}

/**************************************************************
Insert shots
***************************************************************/
function createInsert(svgMarkup, background) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  const art = createCelArt(svgMarkup);
  art.group.scale.y = -1;
  scene.add(art.group);
  // Far enough back to see the front layer, which sits FRONT_Z units forward
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  camera.position.z = 100;
  return { scene, camera, art };
}

// Full-screen 2D cuts: the reader drawing breath, and the player's eyes opening
export async function createInsertShots({ maxAnisotropy }) {
  const inserts = {
    readerBreath: createInsert(readerBreathSvg, '#efe3c8'),
    playerEyes: createInsert(playerEyesSvg, '#120c0e'),
  };

  // The reading card is a textured plane layered between the drawing's back and front
  const cardTexture = await createReadingCardTexture({
    lines: HERO_READING_LINES,
    width: 500,
    height: 860,
    maxAnisotropy,
  });
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(READING_CARD.width, READING_CARD.height),
    new THREE.MeshBasicMaterial({ map: cardTexture })
  );
  card.position.set(READING_CARD.x, -READING_CARD.y, FRONT_Z - Z_STEP / 2);
  card.rotation.z = READING_CARD.tilt;
  inserts.readerBreath.scene.add(card);

  // Wide screens show the sheet's full height. Narrower screens crop the sides, keeping the
  // focus band in view; once only the focus band is left, the view grows taller instead
  // (the art bleeds, or the background colour fills). Then the shot's zoom and pan apply.
  function frameSheet(camera, { zoom, panX, panY }, aspect, focus) {
    const fullHeightWidth = SHEET.height * aspect;
    const visibleWidth = Math.max(fullHeightWidth, Math.min(SHEET.width, focus.right - focus.left));
    const halfWidth = visibleWidth / 2 / zoom;
    const halfHeight = halfWidth / aspect;

    // Centre on the sheet where possible, shifting just enough to keep the focus band and
    // the sheet's sides in view
    const lowest = Math.max(focus.right - visibleWidth / 2, visibleWidth / 2);
    const highest = Math.min(focus.left + visibleWidth / 2, SHEET.width - visibleWidth / 2);
    const centerX = visibleWidth >= SHEET.width ? SHEET.width / 2 : THREE.MathUtils.clamp(SHEET.width / 2, lowest, highest);

    Object.assign(camera, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight });
    camera.position.set(centerX + panX, -SHEET.height / 2 - panY, 100);
    camera.updateProjectionMatrix();
  }

  function showDrawings({ fx }) {
    inserts.readerBreath.art.setLayerVisible('breath', fx.breathWisps);
    ['closed', 'half', 'open'].forEach((state) => {
      inserts.playerEyes.art.setLayerVisible(state, fx.eyes === state);
    });
    inserts.playerEyes.art.setLayerVisible('glint', fx.eyes === 'open' && fx.glint);
  }

  // The view postPass renders for an insert frame. Flat art carries its own ink lines, so
  // the edge-detection pass is skipped.
  function getView(frame, aspect) {
    const insert = inserts[frame.insert.name];
    frameSheet(insert.camera, frame.insert, aspect, FOCUS[frame.insert.name]);
    showDrawings(frame);
    return { scene: insert.scene, camera: insert.camera, ink: false };
  }

  return { getView };
}
