import * as THREE from 'three';

// Real grab cards are 5.2 cm x 7.3 cm
const CARD_ASPECT = 7.3 / 5.2;
const CARD_FONT_FAMILY = '"Yuji Syuku", "Yu Mincho", serif';
const CARD_BORDER_COLOR = '#3f7a4c';
const CARD_PAPER_COLOR = '#f8f2e2';
const CARD_INK_COLOR = '#1c1410';
// Combining voiced and semi-voiced marks, split off by NFD normalization
const DAKUTEN_MARKS = ['゙', '゚'];

const TATAMI_BASE_COLOR = '#d5d29a';
const TATAMI_HERI_COLOR = '#353a33';

let toonGradient = null;

/**************************************************************
Helpers
***************************************************************/
function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function createCanvasTexture(canvas, maxAnisotropy) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  return texture;
}

// Splits card text into vertical columns, giving extra characters to the first
// (right-hand) columns: 14 characters become 5, 5, 4
function splitIntoColumns(characters, columnCount) {
  const baseLength = Math.floor(characters.length / columnCount);
  const extra = characters.length % columnCount;
  const lengths = Array.from({ length: columnCount }, (_, index) => baseLength + (index < extra ? 1 : 0));

  return lengths.map((length, index) => {
    const start = lengths.slice(0, index).reduce((sum, value) => sum + value, 0);
    return characters.slice(start, start + length);
  });
}

// Small deterministic PRNG (mulberry32) so layouts look hand-placed but identical on every load
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**************************************************************
Toon shading
***************************************************************/
// Three hard bands (shadow side, terminator, lit). Nearest filtering keeps the steps crisp.
function getToonGradient() {
  if (!toonGradient) {
    toonGradient = new THREE.DataTexture(new Uint8Array([0, 150, 255]), 3, 1, THREE.RedFormat);
    toonGradient.minFilter = THREE.NearestFilter;
    toonGradient.magFilter = THREE.NearestFilter;
    toonGradient.generateMipmaps = false;
    toonGradient.needsUpdate = true;
  }
  return toonGradient;
}

export function createToonMaterial(options) {
  return new THREE.MeshToonMaterial({ gradientMap: getToonGradient(), ...options });
}

/**************************************************************
Karuta cards
***************************************************************/
// Grab cards are printed without spaces or dakuten: が → か, づ → つ
export function getTorifudaText(lowerVerse) {
  return [...lowerVerse.normalize('NFD')]
    .filter((character) => character !== ' ' && !DAKUTEN_MARKS.includes(character))
    .join('')
    .normalize('NFC');
}

export async function loadCardFont(sampleText) {
  try {
    // Passing the text makes the browser fetch the unicode-range subsets those kana need
    await document.fonts.load(`64px ${CARD_FONT_FAMILY}`, sampleText);
  } catch (error) {
    console.warn('Card font failed to load; cards will use a fallback serif.', error);
  }
}

export function createCardFaceTexture({ lowerVerse, width, maxAnisotropy }) {
  const height = Math.round(width * CARD_ASPECT);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const border = width * 0.035;
  const innerHeight = height - border * 2;

  // The green backing paper folds over the edges and frames the face
  context.fillStyle = CARD_BORDER_COLOR;
  context.fillRect(0, 0, width, height);
  context.fillStyle = CARD_PAPER_COLOR;
  context.fillRect(border, border, width - border * 2, innerHeight);

  // Faint paper fibres
  context.fillStyle = 'rgba(120, 100, 60, 0.06)';
  Array.from({ length: width }).forEach(() => {
    const x = border + Math.random() * (width - border * 2);
    const y = border + Math.random() * innerHeight;
    context.fillRect(x, y, 1 + Math.random() * width * 0.01, 1);
  });

  // Three vertical columns, read right to left; later columns start a little lower,
  // like hand-lettered cards
  const columns = splitIntoColumns([...getTorifudaText(lowerVerse)], 3);
  const longestColumn = Math.max(...columns.map((column) => column.length));
  const fontSize = Math.min((innerHeight * 0.78) / longestColumn, width * 0.23);
  const columnX = [0.77, 0.5, 0.23].map((fraction) => fraction * width);
  const top = border + innerHeight * 0.06 + fontSize / 2;

  context.font = `${fontSize}px ${CARD_FONT_FAMILY}`;
  context.fillStyle = CARD_INK_COLOR;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  columns.forEach((column, columnIndex) => {
    const columnTop = top + columnIndex * fontSize * 0.25;
    column.forEach((character, characterIndex) => {
      context.fillText(character, columnX[columnIndex], columnTop + characterIndex * fontSize);
    });
  });

  return createCanvasTexture(canvas, maxAnisotropy);
}

/**************************************************************
Tatami
***************************************************************/
// One mat, long axis along the canvas width. Rush strands run across the short side,
// and the cloth border (heri) runs along both long edges.
export function createTatamiTexture(maxAnisotropy) {
  const width = 1024;
  const height = 512;
  const heriHeight = height * 0.028;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  context.fillStyle = TATAMI_BASE_COLOR;
  context.fillRect(0, 0, width, height);

  // Rush strands: faint alternating stripes that read as texture, not as lines
  for (let x = 0; x < width; x += 4) {
    context.fillStyle = x % 8 === 0 ? 'rgba(96, 100, 40, 0.06)' : 'rgba(255, 250, 215, 0.06)';
    context.fillRect(x, 0, 2, height);
  }

  // Two warp threads along the length
  context.fillStyle = 'rgba(80, 78, 40, 0.10)';
  [0.34, 0.66].forEach((fraction) => context.fillRect(0, height * fraction, width, 2));

  // Heri, with a thin highlight thread
  context.fillStyle = TATAMI_HERI_COLOR;
  context.fillRect(0, 0, width, heriHeight);
  context.fillRect(0, height - heriHeight, width, heriHeight);
  context.fillStyle = 'rgba(255, 255, 255, 0.12)';
  context.fillRect(0, heriHeight * 0.45, width, 2);
  context.fillRect(0, height - heriHeight * 0.55, width, 2);

  return createCanvasTexture(canvas, maxAnisotropy);
}
