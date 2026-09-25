import * as THREE from 'three';
import { createDirector, fitFieldOfView, LOOP_SECONDS } from './director.js';
import { createKarutaHall } from './karutaHall.js';
import { createPostPass } from './postPass.js';
import { createSoundscape } from './soundscape.js';

/**************************************************************
DOM selectors
***************************************************************/
const sceneCanvas = document.querySelector('.sceneCanvas');
const sceneError = document.querySelector('.sceneError');
const syllableCue = document.querySelector('.syllableCue');
const motionToggle = document.querySelector('.motionToggle');
const motionToggleLabel = document.querySelector('.motionToggleLabel');
const soundToggle = document.querySelector('.soundToggle');
const soundToggleState = document.querySelector('.soundToggleState');

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const MAX_PIXEL_RATIO = 2;
// Caps the time step after a stall so the scene never jumps ahead
const MAX_FRAME_SECONDS = 0.1;

let renderer = null;
let scene = null;
let camera = null;
let hall = null;
let director = null;
let postPass = null;
let isPlaying = !reducedMotionQuery.matches;
let sceneTime = 0;
let previousLoopTime = 0;
let lastFrameTime = null;
const soundscape = createSoundscape();
const drawingBufferSize = new THREE.Vector2();
const shakeOffset = new THREE.Vector3();
const speedCenter = new THREE.Vector3();

/**************************************************************
Helpers
***************************************************************/
function showError(message) {
  sceneError.textContent = message;
  sceneError.hidden = false;
  motionToggle.hidden = true;
  soundToggle.hidden = true;
}

// The renderer exists before the fonts load; the scene is only ready once setup finishes
function isSceneReady() {
  return renderer !== null && postPass !== null;
}

function updateMotionToggle() {
  motionToggleLabel.textContent = isPlaying ? 'Pause' : 'Play';
}

function updateSoundToggle() {
  const isOn = soundscape.isEnabled();
  soundToggle.setAttribute('aria-pressed', String(isOn));
  soundToggleState.textContent = isOn ? 'on' : 'off';
}

// Sound follows the scene: it stops with Pause and while the tab is hidden
async function syncSound() {
  try {
    await soundscape.setRunning(isPlaying && !document.hidden);
  } catch (error) {
    console.warn('Sound could not follow the scene state.', error);
  }
}

// Dev server only: ?t=8 opens the sequence paused at 8 seconds, to inspect that moment.
// Vite removes this branch from production builds.
function getRequestedStartTime() {
  if (!import.meta.env.DEV) return null;
  const param = new URLSearchParams(window.location.search).get('t');
  const requested = Number(param);
  return param !== null && Number.isFinite(requested) ? requested : null;
}

function updateCamera({ camera: shot, fx }) {
  camera.position.copy(shot.position);
  if (fx.shake > 0) {
    shakeOffset.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    camera.position.addScaledVector(shakeOffset, fx.shake * 2);
  }
  camera.lookAt(shot.target);

  const fov = fitFieldOfView(shot.fov, camera.aspect);
  if (camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

// Converts a size in centimetres to pixels at 1 cm from the camera, for point sprites
function getPointScale() {
  renderer.getDrawingBufferSize(drawingBufferSize);
  return drawingBufferSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

function updateEffects({ fx }) {
  const { uniforms } = postPass;
  uniforms.impact.value = fx.impact;
  uniforms.speedLines.value = fx.speedLines;
  if (fx.speedLines > 0) {
    // Lines radiate from wherever the flying card is on screen
    speedCenter.copy(hall.heroCard.mesh.position).project(camera);
    uniforms.speedCenter.value.set(speedCenter.x * 0.5 + 0.5, speedCenter.y * 0.5 + 0.5);
  }
  syllableCue.classList.toggle('isVisible', fx.syllable);
}

function updateSound({ fx }, loopTime) {
  soundscape.setMusicDucked(fx.musicDucked);
  director.getCues(previousLoopTime, loopTime).forEach((cue) => soundscape.playCue(cue));
}

/**************************************************************
Main logic
***************************************************************/
function renderFrame() {
  const loopTime = sceneTime % LOOP_SECONDS;
  const frame = director.getFrame(loopTime, { reducedMotion: reducedMotionQuery.matches });

  updateCamera(frame);
  hall.update({ time: sceneTime, drawnTime: frame.drawnTime, fx: frame.fx, pointScale: getPointScale() });
  updateEffects(frame);
  updateSound(frame, loopTime);
  previousLoopTime = loopTime;
  postPass.render(sceneTime);
}

function animate(now) {
  if (lastFrameTime === null) {
    lastFrameTime = now;
  }
  sceneTime += Math.min((now - lastFrameTime) / 1000, MAX_FRAME_SECONDS);
  lastFrameTime = now;
  renderFrame();
}

function startLoop() {
  lastFrameTime = null;
  renderer.setAnimationLoop(animate);
}

function stopLoop() {
  renderer.setAnimationLoop(null);
}

function play() {
  isPlaying = true;
  updateMotionToggle();
  if (!document.hidden) {
    startLoop();
  }
  syncSound();
}

function pause() {
  isPlaying = false;
  updateMotionToggle();
  stopLoop();
  syncSound();
}

function toggleMotion() {
  if (!isSceneReady()) return;
  if (isPlaying) {
    pause();
  } else {
    play();
  }
}

function resizeScene() {
  if (!isSceneReady()) return;
  const width = sceneCanvas.clientWidth;
  const height = sceneCanvas.clientHeight;
  const pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);

  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  postPass.setSize(Math.round(width * pixelRatio), Math.round(height * pixelRatio), pixelRatio);

  // A paused scene still needs to redraw at the new size
  if (!isPlaying) {
    renderFrame();
  }
}

function handleVisibilityChange() {
  if (!isSceneReady()) return;
  if (document.hidden) {
    stopLoop();
  } else if (isPlaying) {
    startLoop();
  }
  syncSound();
}

// Browsers only let audio start from a click, so the soundscape is built here
async function toggleSound() {
  try {
    await soundscape.setEnabled(!soundscape.isEnabled());
    updateSoundToggle();
  } catch (error) {
    console.error(error);
    soundToggle.disabled = true;
    soundToggleState.textContent = 'unavailable';
  }
}

function handleReducedMotionChange(event) {
  if (event.matches && isPlaying) {
    pause();
  }
}

async function init() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
    hall = await createKarutaHall({ maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });
    scene.add(hall.group);
    scene.background = hall.background;
    director = createDirector({ heroPosition: hall.heroRestPosition, readerPosition: hall.readerPosition });
    postPass = createPostPass(renderer, scene, camera);
    const requestedStartTime = getRequestedStartTime();
    if (requestedStartTime !== null) {
      sceneTime = requestedStartTime;
      isPlaying = false;
    }
    previousLoopTime = sceneTime % LOOP_SECONDS;

    resizeScene();
    renderFrame();
    updateMotionToggle();
    soundToggle.hidden = !soundscape.isSupported;
    if (isPlaying) {
      play();
    }
  } catch (error) {
    console.error(error);
    renderer = null;
    showError("The scene couldn't start. It needs a browser with WebGL 2 turned on.");
  }
}

/**************************************************************
Event listeners
***************************************************************/
motionToggle.addEventListener('click', toggleMotion);
soundToggle.addEventListener('click', toggleSound);
window.addEventListener('resize', resizeScene);
document.addEventListener('visibilitychange', handleVisibilityChange);
reducedMotionQuery.addEventListener('change', handleReducedMotionChange);

init();
