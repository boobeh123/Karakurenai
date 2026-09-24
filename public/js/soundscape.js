// All sound is synthesized in the browser with the Web Audio API; there are no audio files.
// Music: sparse koto-like plucks in the miyako-bushi scale over a soft drone.
// Ambience: faint room air and bell crickets (suzumushi), a sound of Japanese autumn.

// Semitone steps of the miyako-bushi (in) scale
const MIYAKO_BUSHI_STEPS = [0, 1, 5, 7, 8];
const NOTES_PER_OCTAVE = MIYAKO_BUSHI_STEPS.length;
const ROOT_MIDI = 62; // D4
const MELODY_RANGE = { low: 55, high: 81 }; // G3 to A5
// Phrases come to rest on D or A (pitch classes 2 and 9)
const RESTING_PITCH_CLASSES = [2, 9];
// Weighted moves along the scale: mostly neighbours, some skips, the odd octave leap
const MELODY_MOVES = [-5, -2, -2, -1, -1, -1, 0, 1, 1, 1, 2, 2, 5];
// Note lengths in eighth notes
const NOTE_LENGTHS = [1, 2, 2, 2, 3, 4];

const STEP_SECONDS = 60 / 66 / 2; // eighth notes at 66 bpm
const SWEEP_NOTE_SECONDS = 0.05;
const PLUCK_SECONDS = 2.8;
const PLUCK_RING_SECONDS = 2.4; // time for a pluck to fall by 60 dB
const REVERB_SECONDS = 2.8;

const LEVELS = { master: 1, reverb: 0.35, drone: 0.045, air: 0.02, cricket: 0.012 };
const FADE_IN_SECONDS = 2;
const FADE_OUT_SECONDS = 0.35;
const SCHEDULE_AHEAD_SECONDS = 0.6;
const SCHEDULER_INTERVAL_MS = 150;

/**************************************************************
Helpers
***************************************************************/
function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildScaleNotes() {
  return [-1, 0, 1]
    .flatMap((octave) => MIYAKO_BUSHI_STEPS.map((step) => ROOT_MIDI + octave * 12 + step))
    .filter((midi) => midi >= MELODY_RANGE.low && midi <= MELODY_RANGE.high);
}

// Karplus-Strong plucked string: a burst of noise circulates through a delay line one
// period long, and averaging neighbouring samples each pass makes it ring at that pitch
// and mellow as it fades, much like a real string
function renderPluck(context, frequency) {
  const { sampleRate } = context;
  const buffer = context.createBuffer(1, Math.floor(sampleRate * PLUCK_SECONDS), sampleRate);
  const output = buffer.getChannelData(0);

  // One trip around the loop must last exactly one period. The delay line supplies whole
  // samples, the averaging adds half a sample, and a first-order allpass supplies the
  // remaining fraction (kept between 0.1 and 1.1 samples, where the allpass is most accurate).
  const loopDelay = sampleRate / frequency;
  const lineLength = Math.max(2, Math.floor(loopDelay - 0.6));
  const fraction = loopDelay - 0.5 - lineLength;
  const allpassCoefficient = (1 - fraction) / (1 + fraction);
  // Per-pass loss that gives every string the same ring time
  const decay = 0.001 ** (1 / (PLUCK_RING_SECONDS * frequency));

  // Excite the string with softened noise; a one-pole low-pass rounds off the pick
  let smoothed = 0;
  const burst = Array.from({ length: lineLength }, () => {
    smoothed += 0.55 * (Math.random() * 2 - 1 - smoothed);
    return smoothed;
  });
  const mean = burst.reduce((sum, value) => sum + value, 0) / lineLength;
  const line = Float32Array.from(burst, (value) => value - mean);
  // Normalise so every string plays at the same loudness
  const scale = 0.6 / line.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);

  let position = 0;
  let previousSample = 0;
  let allpassInput = 0;
  let allpassOutput = 0;
  for (let n = 0; n < output.length; n += 1) {
    const sample = line[position];
    output[n] = sample * scale;

    const averaged = decay * 0.5 * (sample + previousSample);
    previousSample = sample;
    allpassOutput = allpassCoefficient * averaged + allpassInput - allpassCoefficient * allpassOutput;
    allpassInput = averaged;

    line[position] = allpassOutput;
    position = position + 1 === lineLength ? 0 : position + 1;
  }

  return buffer;
}

// Decaying stereo noise: convolving with it sounds like a wooden room
function createImpulseResponse(context) {
  const { sampleRate } = context;
  const length = Math.floor(sampleRate * REVERB_SECONDS);
  const impulse = context.createBuffer(2, length, sampleRate);

  [0, 1].forEach((channel) => {
    const data = impulse.getChannelData(channel);
    for (let n = 0; n < length; n += 1) {
      data[n] = (Math.random() * 2 - 1) * (1 - n / length) ** 3;
    }
  });

  return impulse;
}

// White noise loops without an audible seam, unlike filtered noise
function createNoiseBuffer(context, seconds) {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let n = 0; n < data.length; n += 1) {
    data[n] = Math.random() * 2 - 1;
  }
  return buffer;
}

/**************************************************************
Soundscape
***************************************************************/
const SCALE_NOTES = buildScaleNotes();
const RESTING_POSITIONS = SCALE_NOTES.flatMap((midi, index) =>
  RESTING_PITCH_CLASSES.includes(midi % 12) ? [index] : []
);

export function createSoundscape() {
  const isSupported = 'AudioContext' in window;
  let context = null;
  let master = null;
  let reverb = null;
  let pluckBuffers = null;
  let enabled = false;
  let running = false;
  let melodyPosition = SCALE_NOTES.indexOf(ROOT_MIDI);
  let nextPhraseTime = 0;
  let nextCricketTime = 0;
  let schedulerTimer = null;
  let suspendTimer = null;

  // Every voice goes to the master bus dry, plus a share to the reverb
  function connectToMix(node, reverbSend) {
    const send = context.createGain();
    send.gain.value = reverbSend;
    node.connect(master);
    node.connect(send).connect(reverb);
  }

  function fadeTo(level, seconds) {
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(level, now + seconds);
  }

  // D2 and D3 with a quiet A3: a hollow fifth under the melody that slowly swells
  function startDrone() {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 0.4;
    const level = context.createGain();
    level.gain.value = LEVELS.drone;

    [
      { midi: 38, gain: 1 },
      { midi: 50, gain: 0.5 },
      { midi: 57, gain: 0.25 },
    ].forEach(({ midi, gain }) => {
      const oscillator = context.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.value = midiToFrequency(midi);
      const voice = context.createGain();
      voice.gain.value = gain;
      oscillator.connect(voice).connect(filter);
      oscillator.start();
    });

    const swell = context.createOscillator();
    swell.frequency.value = 0.06;
    const swellDepth = context.createGain();
    swellDepth.gain.value = LEVELS.drone * 0.4;
    swell.connect(swellDepth).connect(level.gain);
    swell.start();

    filter.connect(level);
    connectToMix(level, 0.6);
  }

  function startAir() {
    const source = context.createBufferSource();
    source.buffer = createNoiseBuffer(context, 2);
    source.loop = true;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 450;
    const level = context.createGain();
    level.gain.value = LEVELS.air;
    source.connect(lowpass).connect(level).connect(master);
    source.start();
  }

  function playPluck({ midi, velocity, bend }, time) {
    const source = context.createBufferSource();
    source.buffer = pluckBuffers.get(midi);
    const level = context.createGain();
    level.gain.value = velocity;
    // Low strings sit left and high strings right, as if seated at the koto
    const panner = context.createStereoPanner();
    panner.pan.value = ((midi - 68) / 14) * 0.5;

    // Oshide: the player presses the string behind the bridge to lift the pitch a
    // semitone, then lets it fall back
    if (bend) {
      source.detune.setValueAtTime(0, time + 0.25);
      source.detune.linearRampToValueAtTime(100, time + 0.45);
      source.detune.setValueAtTime(100, time + 0.9);
      source.detune.linearRampToValueAtTime(0, time + 1.1);
    }

    source.connect(level).connect(panner);
    connectToMix(panner, 1);
    source.start(time);
  }

  // Bell cricket: a high "riiin", a pure tone pulsed quickly by a trill
  function playCricket(time) {
    const duration = 0.3 + Math.random() * 0.5;
    const tone = context.createOscillator();
    tone.frequency.value = 4200 + Math.random() * 500;
    const trill = context.createOscillator();
    trill.type = 'triangle';
    trill.frequency.value = 36 + Math.random() * 12;
    const trillDepth = context.createGain();
    trillDepth.gain.value = 0.5;
    const pulse = context.createGain();
    pulse.gain.value = 0.5;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(LEVELS.cricket, time + 0.04);
    envelope.gain.setValueAtTime(LEVELS.cricket, time + duration - 0.1);
    envelope.gain.linearRampToValueAtTime(0, time + duration);
    const panner = context.createStereoPanner();
    panner.pan.value = Math.random() * 1.6 - 0.8;

    trill.connect(trillDepth).connect(pulse.gain);
    tone.connect(pulse).connect(envelope).connect(panner);
    connectToMix(panner, 0.8);
    tone.start(time);
    trill.start(time);
    tone.stop(time + duration + 0.05);
    trill.stop(time + duration + 0.05);
  }

  function stepMelody(position) {
    const move = pick(MELODY_MOVES);
    const target = position + move;
    // Bounce off the ends of the range instead of sticking there
    const bounced = target < 0 || target >= SCALE_NOTES.length ? position - move : target;
    return clamp(bounced, 0, SCALE_NOTES.length - 1);
  }

  function findRestingPosition(position) {
    return RESTING_POSITIONS.reduce((best, candidate) =>
      Math.abs(candidate - position) < Math.abs(best - position) ? candidate : best
    );
  }

  function composePhrase() {
    const notes = [];
    let offset = 0;

    // Sometimes open with a sararin: a quick sweep up the strings into the first note
    if (Math.random() < 0.25) {
      const sweepStart = Math.max(0, melodyPosition - 4);
      SCALE_NOTES.slice(sweepStart, melodyPosition + 1).forEach((midi, index) => {
        notes.push({ midi, offset: index * SWEEP_NOTE_SECONDS, velocity: 0.12 + index * 0.03, bend: false });
      });
      offset = (melodyPosition - sweepStart) * SWEEP_NOTE_SECONDS + STEP_SECONDS * 2;
    }

    const noteCount = 3 + Math.floor(Math.random() * 4);
    Array.from({ length: noteCount }).forEach((_, index) => {
      const isLast = index === noteCount - 1;
      const nextPosition = stepMelody(melodyPosition);
      melodyPosition = isLast ? findRestingPosition(nextPosition) : nextPosition;
      // Slightly loose timing, like a player rather than a sequencer
      const noteOffset = offset + (Math.random() - 0.5) * 0.03;

      notes.push({
        midi: SCALE_NOTES[melodyPosition],
        offset: noteOffset,
        velocity: 0.28 + Math.random() * 0.12,
        bend: !isLast && Math.random() < 0.12,
      });
      // Koto players often double a note an octave below
      if (Math.random() < 0.15 && melodyPosition >= NOTES_PER_OCTAVE) {
        notes.push({
          midi: SCALE_NOTES[melodyPosition - NOTES_PER_OCTAVE],
          offset: noteOffset,
          velocity: 0.18,
          bend: false,
        });
      }

      const length = isLast ? 4 + Math.floor(Math.random() * 3) : pick(NOTE_LENGTHS);
      offset += length * STEP_SECONDS;
    });

    // Ma: the silence between phrases matters as much as the notes
    const rest = (4 + Math.floor(Math.random() * 7)) * STEP_SECONDS;
    return { notes, duration: offset + rest };
  }

  // Schedules whole phrases and cricket calls slightly ahead of the audio clock.
  // While the context is suspended its clock stops, so nothing piles up.
  function runScheduler() {
    const horizon = context.currentTime + SCHEDULE_AHEAD_SECONDS;

    while (nextPhraseTime < horizon) {
      const phrase = composePhrase();
      phrase.notes.forEach((note) => playPluck(note, nextPhraseTime + note.offset));
      nextPhraseTime += phrase.duration;
    }

    while (nextCricketTime < horizon) {
      playCricket(nextCricketTime);
      nextCricketTime += 1.2 + Math.random() * 4.5;
    }
  }

  // Must run inside a click handler: browsers only allow audio to start from a user gesture
  function build() {
    // Lets iPhone play this sound even when the ring/silent switch is on silent
    if (navigator.audioSession) {
      navigator.audioSession.type = 'playback';
    }

    context = new AudioContext();
    master = context.createGain();
    master.gain.value = 0;
    // A gentle limiter so stacked notes can never clip
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter).connect(context.destination);

    reverb = context.createConvolver();
    reverb.buffer = createImpulseResponse(context);
    const reverbReturn = context.createGain();
    reverbReturn.gain.value = LEVELS.reverb;
    reverb.connect(reverbReturn).connect(master);

    pluckBuffers = new Map(SCALE_NOTES.map((midi) => [midi, renderPluck(context, midiToFrequency(midi))]));
    startDrone();
    startAir();
    nextPhraseTime = context.currentTime + 0.8;
    nextCricketTime = context.currentTime + 3;
  }

  async function suspendAfterFade() {
    try {
      await context.suspend();
    } catch (error) {
      console.warn('Sound could not be suspended.', error);
    }
  }

  async function applyState() {
    if (!context) return enabled;
    window.clearTimeout(suspendTimer);

    if (!enabled || !running) {
      fadeTo(0, FADE_OUT_SECONDS);
      window.clearInterval(schedulerTimer);
      schedulerTimer = null;
      suspendTimer = window.setTimeout(suspendAfterFade, FADE_OUT_SECONDS * 1000 + 50);
      return enabled;
    }

    await context.resume();
    // The state may have changed while the context was waking up
    if (enabled && running) {
      fadeTo(LEVELS.master, FADE_IN_SECONDS);
      runScheduler();
      schedulerTimer = schedulerTimer ?? window.setInterval(runScheduler, SCHEDULER_INTERVAL_MS);
    }
    return enabled;
  }

  function setEnabled(value) {
    enabled = value;
    if (enabled && !context) {
      build();
    }
    return applyState();
  }

  // Follows the scene: sound plays only while the animation runs and the tab is visible
  function setRunning(value) {
    running = value;
    return applyState();
  }

  return {
    isSupported,
    isEnabled: () => enabled,
    setEnabled,
    setRunning,
  };
}
