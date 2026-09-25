import * as THREE from 'three';

// One pass through the sequence, in seconds. Feature 3 extends it with the river shots.
export const LOOP_SECONDS = 11;

// Object motion steps at 12 fps ("on twos"), like hand-drawn animation; the camera stays smooth
const TWOS_FPS = 12;
// Shots are composed for 16:9. Narrower (portrait) screens widen the vertical field of view,
// up to this factor, so the board keeps its width instead of being cropped.
const COMPOSED_ASPECT = 16 / 9;
const MAX_FOV_STRETCH = 2.2;

// Moments in the sweep shot, in seconds from its start
const SWEEP = {
  smearStart: 0.25,
  contact: 0.34,
  // Held for two frames of 24 fps film, as a drawn impact frame would be
  impactEnd: 0.34 + 2 / 24,
  shakeEnd: 0.64,
  skidEnd: 0.6,
  speedLinesEnd: 1.4,
  sparkleStart: 0.5,
  sparkleEnd: 1.9,
  flightEnd: 2,
};

/**************************************************************
Helpers
***************************************************************/
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function getProgress(time, start, end) {
  return clamp01((time - start) / (end - start));
}

function easeInOutSine(t) {
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function onTwos(time) {
  return Math.floor(time * TWOS_FPS) / TWOS_FPS;
}

function pose(position, target, fov) {
  return { position, target, fov };
}

export function fitFieldOfView(fov, aspect) {
  if (aspect >= COMPOSED_ASPECT) return fov;
  const stretch = Math.min(COMPOSED_ASPECT / aspect, MAX_FOV_STRETCH);
  const halfAngle = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * stretch);
  return THREE.MathUtils.radToDeg(halfAngle * 2);
}

/**************************************************************
Director
***************************************************************/
// Shots are placed relative to the hero card and the reader, so the camera follows the
// layout in karutaHall.js
export function createDirector({ heroPosition, readerPosition }) {
  const near = (base, x, y, z) => base.clone().add(new THREE.Vector3(x, y, z));
  const hero = heroPosition;

  const shots = [
    {
      // Crane down over the match, the reader kneeling at the side
      name: 'hall',
      start: 0,
      end: 4.5,
      from: pose(new THREE.Vector3(45, 150, 200), new THREE.Vector3(-20, 0, -10), 40),
      to: pose(new THREE.Vector3(30, 70, 125), new THREE.Vector3(-15, 6, -5), 36),
    },
    {
      // The room holds its breath. Feature 2b turns this into the reader close-up insert.
      name: 'breath',
      start: 4.5,
      end: 6,
      from: pose(near(hero, 14, 22, 35), near(hero, 0, 0, -2), 32),
      to: pose(near(hero, 10, 16, 25), near(hero, 0, 0, -2), 32),
    },
    {
      // Feature 2b turns this into the player's eyes insert
      name: 'eyes',
      start: 6,
      end: 7.5,
      from: pose(near(hero, -22, 10, 17), hero.clone(), 30),
      to: pose(near(hero, -16, 9, 13), hero.clone(), 30),
    },
    {
      // Low across the hero card toward the reader as the first syllable sounds
      name: 'syllable',
      start: 7.5,
      end: 9,
      from: pose(near(hero, 22, 7, 6.5), near(readerPosition, 0, 3, 8), 30),
      to: pose(near(hero, 17, 6, 4.5), near(readerPosition, 0, 3, 8), 30),
    },
    {
      // Facing the player's side as the card is swept toward the lens
      name: 'sweep',
      start: 9,
      end: LOOP_SECONDS,
      from: pose(near(hero, 2, 14, 35), near(hero, 0, 5, -1), 34),
      to: pose(near(hero, 1, 12, 31), near(hero, 0, 5, -1), 34),
    },
  ];

  const sweepStart = shots.find((shot) => shot.name === 'sweep').start;
  const syllableStart = shots.find((shot) => shot.name === 'syllable').start;

  // Sounds fire once, as the sequence passes their time
  const cues = [
    { name: 'breath', time: 4.7 },
    { name: 'bell', time: syllableStart + 0.1 },
    { name: 'slap', time: sweepStart + SWEEP.contact },
    { name: 'whoosh', time: sweepStart + SWEEP.contact + 0.02 },
  ];

  const camera = pose(new THREE.Vector3(), new THREE.Vector3(), 35);

  function getFrame(time, { reducedMotion }) {
    const shot = shots.find(({ start, end }) => time >= start && time < end) ?? shots[shots.length - 1];
    const blend = easeInOutSine(getProgress(time, shot.start, shot.end));
    camera.position.lerpVectors(shot.from.position, shot.to.position, blend);
    camera.target.lerpVectors(shot.from.target, shot.to.target, blend);
    camera.fov = THREE.MathUtils.lerp(shot.from.fov, shot.to.fov, blend);

    const drawnTime = onTwos(time);
    const sweepTime = time - sweepStart;
    const drawnSweepTime = drawnTime - sweepStart;
    const isImpact = sweepTime >= SWEEP.contact && sweepTime < SWEEP.impactEnd;
    const shakeProgress = getProgress(sweepTime, SWEEP.contact, SWEEP.shakeEnd);
    const speedProgress = getProgress(sweepTime, SWEEP.contact, SWEEP.speedLinesEnd);
    const hasContact = sweepTime >= SWEEP.contact;

    const fx = {
      // The smear is the one thing animated on ones: it only lasts a few frames
      smear: sweepTime >= SWEEP.smearStart && sweepTime < SWEEP.contact
        ? getProgress(sweepTime, SWEEP.smearStart, SWEEP.contact)
        : 0,
      impact: !reducedMotion && isImpact ? 1 : 0,
      shake: !reducedMotion && hasContact && shakeProgress < 1 ? 1.2 * (1 - shakeProgress) ** 2 : 0,
      speedLines: !reducedMotion && hasContact && speedProgress < 1 ? 1 - speedProgress : 0,
      flight: drawnSweepTime >= SWEEP.contact
        ? easeOutCubic(getProgress(drawnSweepTime, SWEEP.contact, SWEEP.flightEnd))
        : 0,
      skid: easeOutCubic(getProgress(drawnSweepTime, SWEEP.contact, SWEEP.skidEnd)),
      sparkle: getProgress(drawnSweepTime, SWEEP.sparkleStart, SWEEP.sparkleEnd),
      ring: getProgress(drawnTime, syllableStart + 0.1, syllableStart + 1.5),
      syllable: time >= syllableStart + 0.1 && time < syllableStart + 1.4,
      musicDucked: time >= 4.4,
    };

    return { shot, camera, fx, drawnTime };
  }

  // Names of cues passed between two times; the second time may have wrapped past the loop end
  function getCues(previousTime, time) {
    const hasWrapped = time < previousTime;
    return cues
      .filter((cue) =>
        hasWrapped ? cue.time > previousTime || cue.time <= time : cue.time > previousTime && cue.time <= time
      )
      .map((cue) => cue.name);
  }

  return { getFrame, getCues };
}
