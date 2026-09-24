import * as THREE from './lib/three.js';
import { createKarutaHall } from './karutaHall.js';
import { createPostPass } from './postPass.js';

/**************************************************************
DOM selectors
***************************************************************/
const sceneCanvas = document.querySelector('.sceneCanvas');
const sceneError = document.querySelector('.sceneError');
const motionToggle = document.querySelector('.motionToggle');
const motionToggleLabel = document.querySelector('.motionToggleLabel');

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const MAX_PIXEL_RATIO = 2;
// Caps the time step after a stall so the scene never jumps ahead
const MAX_FRAME_SECONDS = 0.1;
// The camera eases between a wide shot into the window light and a close view of the cards
const DRIFT_SECONDS = 32;
const DRIFT_POSES = {
  wide: { position: new THREE.Vector3(16, 64, 150), target: new THREE.Vector3(-4, 8, -60) },
  close: { position: new THREE.Vector3(10, 30, 46), target: new THREE.Vector3(-3, 0, -2) },
};
const driftTarget = new THREE.Vector3();

let renderer = null;
let scene = null;
let camera = null;
let hall = null;
let postPass = null;
let isPlaying = !reducedMotionQuery.matches;
let sceneTime = 0;
let lastFrameTime = null;

/**************************************************************
Helpers
***************************************************************/
function showError(message) {
  sceneError.textContent = message;
  sceneError.hidden = false;
  motionToggle.hidden = true;
}

function updateMotionToggle() {
  motionToggleLabel.textContent = isPlaying ? 'Pause' : 'Play';
}

// Slow dolly from the player's side, wide to close and back
function updateCamera(time) {
  const blend = 0.5 - 0.5 * Math.cos((time / DRIFT_SECONDS) * Math.PI * 2);
  camera.position.lerpVectors(DRIFT_POSES.wide.position, DRIFT_POSES.close.position, blend);
  driftTarget.lerpVectors(DRIFT_POSES.wide.target, DRIFT_POSES.close.target, blend);
  camera.lookAt(driftTarget);
}

/**************************************************************
Main logic
***************************************************************/
function renderFrame() {
  hall.update(sceneTime);
  updateCamera(sceneTime);
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
}

function pause() {
  isPlaying = false;
  updateMotionToggle();
  stopLoop();
}

function toggleMotion() {
  if (!renderer) return;
  if (isPlaying) {
    pause();
  } else {
    play();
  }
}

function resizeScene() {
  if (!renderer) return;
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
  if (!renderer) return;
  if (document.hidden) {
    stopLoop();
  } else if (isPlaying) {
    startLoop();
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
    postPass = createPostPass(renderer, scene, camera);

    resizeScene();
    renderFrame();
    updateMotionToggle();
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
window.addEventListener('resize', resizeScene);
document.addEventListener('visibilitychange', handleVisibilityChange);
reducedMotionQuery.addEventListener('change', handleReducedMotionChange);

init();
