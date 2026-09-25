// All sound is synthesized in the browser with the Web Audio API; there are no audio files.
// Music: sparse koto-like plucks in the miyako-bushi scale over a soft drone.
// Ambience: faint room air and higurashi, the evening cicadas of late summer.

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

const LEVELS = { master: 1, reverb: 0.35, drone: 0.045, air: 0.02, cicada: 0.014 };
const CUE_LEVELS = { breath: 0.05, bell: 0.08, slap: 0.5, whoosh: 0.12 };
const FADE_IN_SECONDS = 2;
const FADE_OUT_SECONDS = 0.35;
// The music falls silent before the first syllable. When it returns, a phrase re-enters on cue
// with a sweep up the strings, just after a short fade-in, so every loop audibly breathes back in.
const MUSIC_DUCK_SECONDS = 1.2;
const MUSIC_RETURN_SECONDS = 0.4;
const MUSIC_REENTRY_DELAY = 0.3;
const REENTRY_MIDI = 74; // D5: the re-entry sweep climbs Eb4, G4, A4, Bb4 into it
// Partials of a small struck bowl bell (rin), as multiples of its fundamental
const BELL_PARTIALS = [1, 2.76, 5.4, 8.93];
const BELL_FREQUENCY = 660;
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
  let nextCicadaTime = 0;
  let opensWithSweep = false;
  let schedulerTimer = null;
  let suspendTimer = null;
  let noiseBuffer = null;
  // Music runs through its own dry and reverb buses so it can fall silent under the scene
  let musicBus = null;
  let isMusicDucked = false;

  // Every voice goes to a bus dry, plus a share to that bus's reverb
  function connectToMix(node, reverbSend, bus = { dry: master, wet: reverb }) {
    const send = context.createGain();
    send.gain.value = reverbSend;
    node.connect(bus.dry);
    node.connect(send).connect(bus.wet);
  }

  function rampTo(param, level, seconds) {
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(level, now + seconds);
  }

  function fadeTo(level, seconds) {
    rampTo(master.gain, level, seconds);
  }

  // Filtered noise with a gain envelope: the raw material of breath, whoosh and slap
  function createNoiseVoice(time, duration) {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.start(time, Math.random() * (noiseBuffer.duration - duration));
    source.stop(time + duration);
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    source.connect(filter).connect(envelope);
    return { filter, envelope };
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
    connectToMix(level, 0.6, musicBus);
  }

  function startAir() {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
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
    connectToMix(panner, 1, musicBus);
    source.start(time);
  }

  // Higurashi, the evening cicada: a "kana-kana-kana" of short pulses that each dip in pitch,
  // while the whole call swells, then sinks and fades
  function playCicada(time) {
    const pulses = 10 + Math.floor(Math.random() * 7);
    const pulseSeconds = 0.155 + Math.random() * 0.03;
    const duration = pulses * pulseSeconds;
    const startFrequency = 4300 + Math.random() * 500;

    const tone = context.createOscillator();
    // A fast wobble in loudness gives the call its rasp
    const rasp = context.createOscillator();
    rasp.type = 'triangle';
    rasp.frequency.value = 170 + Math.random() * 40;
    const raspDepth = context.createGain();
    raspDepth.gain.value = 0.45;
    const texture = context.createGain();
    texture.gain.value = 0.55;
    rasp.connect(raspDepth).connect(texture.gain);

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    Array.from({ length: pulses }).forEach((_, index) => {
      const start = time + index * pulseSeconds;
      const swell = Math.min(1, (index + 1) / 3) * (1 - index / pulses) ** 0.7;
      const pitch = startFrequency * (1 - 0.12 * (index / pulses));
      tone.frequency.setValueAtTime(pitch, start);
      tone.frequency.exponentialRampToValueAtTime(pitch * 0.9, start + pulseSeconds * 0.8);
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(LEVELS.cicada * swell, start + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + pulseSeconds * 0.8);
    });

    // Somewhere outside the window, to one side
    const panner = context.createStereoPanner();
    panner.pan.value = Math.random() * 1.4 - 0.7;
    tone.connect(texture).connect(envelope).connect(panner);
    connectToMix(panner, 0.9);
    tone.start(time);
    rasp.start(time);
    tone.stop(time + duration + 0.05);
    rasp.stop(time + duration + 0.05);
  }

  // An in-breath before the reader speaks: soft noise rising in pitch
  function playBreath(time) {
    const duration = 0.9;
    const { filter, envelope } = createNoiseVoice(time, duration);
    filter.type = 'bandpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(900, time);
    filter.frequency.linearRampToValueAtTime(1500, time + duration);
    envelope.gain.linearRampToValueAtTime(CUE_LEVELS.breath, time + 0.6);
    envelope.gain.linearRampToValueAtTime(0, time + duration);
    // The reader kneels to the left of the board
    const panner = context.createStereoPanner();
    panner.pan.value = -0.3;
    envelope.connect(panner);
    connectToMix(panner, 0.5);
  }

  // A small bowl bell (rin) marks the first syllable; each partial rings and fades on its own
  function playBell(time) {
    const bell = context.createGain();
    BELL_PARTIALS.forEach((ratio, index) => {
      const partial = context.createOscillator();
      partial.frequency.value = BELL_FREQUENCY * ratio;
      const envelope = context.createGain();
      const ringSeconds = 4 / (index + 1);
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(CUE_LEVELS.bell / (index + 1), time + 0.005);
      envelope.gain.exponentialRampToValueAtTime(0.0001, time + ringSeconds);
      partial.connect(envelope).connect(bell);
      partial.start(time);
      partial.stop(time + ringSeconds);
    });
    connectToMix(bell, 1);
  }

  // The card slap: a sharp crack, a brush of noise, and a low thump from the tatami
  function playSlap(time) {
    const slap = context.createGain();

    const crack = createNoiseVoice(time, 0.12);
    crack.filter.type = 'bandpass';
    crack.filter.frequency.value = 2200;
    crack.filter.Q.value = 0.9;
    crack.envelope.gain.linearRampToValueAtTime(CUE_LEVELS.slap, time + 0.002);
    crack.envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
    crack.envelope.connect(slap);

    const brush = createNoiseVoice(time, 0.25);
    brush.filter.type = 'lowpass';
    brush.filter.frequency.value = 900;
    brush.envelope.gain.linearRampToValueAtTime(CUE_LEVELS.slap * 0.3, time + 0.005);
    brush.envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
    brush.envelope.connect(slap);

    const thump = context.createOscillator();
    thump.frequency.setValueAtTime(110, time);
    thump.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    const thumpEnvelope = context.createGain();
    thumpEnvelope.gain.setValueAtTime(0, time);
    thumpEnvelope.gain.linearRampToValueAtTime(CUE_LEVELS.slap, time + 0.004);
    thumpEnvelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
    thump.connect(thumpEnvelope).connect(slap);
    thump.start(time);
    thump.stop(time + 0.22);

    connectToMix(slap, 0.35);
  }

  // The card cutting the air: a band of noise sweeping up and back down, panning across
  function playWhoosh(time) {
    const duration = 0.95;
    const { filter, envelope } = createNoiseVoice(time, duration);
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(300, time);
    filter.frequency.exponentialRampToValueAtTime(2400, time + 0.35);
    filter.frequency.exponentialRampToValueAtTime(500, time + duration);
    envelope.gain.linearRampToValueAtTime(CUE_LEVELS.whoosh, time + 0.3);
    envelope.gain.linearRampToValueAtTime(0, time + duration);
    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(-0.4, time);
    panner.pan.linearRampToValueAtTime(0.5, time + duration);
    envelope.connect(panner);
    connectToMix(panner, 0.6);
  }

  const cuePlayers = { breath: playBreath, bell: playBell, slap: playSlap, whoosh: playWhoosh };

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

    // Sometimes open with a sararin: a quick sweep up the strings into the first note.
    // The phrase that re-enters after the silence always does.
    if (opensWithSweep || Math.random() < 0.25) {
      opensWithSweep = false;
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

  // Schedules whole phrases and cicada calls slightly ahead of the audio clock.
  // While the context is suspended its clock stops, so nothing piles up.
  function runScheduler() {
    const horizon = context.currentTime + SCHEDULE_AHEAD_SECONDS;

    // While the music is ducked the koto rests; its next phrase waits for the return
    if (isMusicDucked) {
      nextPhraseTime = Math.max(nextPhraseTime, horizon);
    }
    while (nextPhraseTime < horizon) {
      const phrase = composePhrase();
      phrase.notes.forEach((note) => playPluck(note, nextPhraseTime + note.offset));
      nextPhraseTime += phrase.duration;
    }

    while (nextCicadaTime < horizon) {
      playCicada(nextCicadaTime);
      nextCicadaTime += 5 + Math.random() * 9;
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

    noiseBuffer = createNoiseBuffer(context, 2);
    musicBus = { dry: context.createGain(), wet: context.createGain() };
    musicBus.dry.connect(master);
    musicBus.wet.connect(reverb);
    [musicBus.dry.gain, musicBus.wet.gain].forEach((param) => {
      param.value = isMusicDucked ? 0 : 1;
    });

    pluckBuffers = new Map(SCALE_NOTES.map((midi) => [midi, renderPluck(context, midiToFrequency(midi))]));
    startDrone();
    startAir();
    nextPhraseTime = context.currentTime + 0.8;
    nextCicadaTime = context.currentTime + 2;
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

  // Called every frame by the scene; only a change of state starts a fade
  function setMusicDucked(value) {
    if (value === isMusicDucked) return;
    isMusicDucked = value;
    if (!context) return;
    const level = value ? 0 : 1;
    const seconds = value ? MUSIC_DUCK_SECONDS : MUSIC_RETURN_SECONDS;
    [musicBus.dry.gain, musicBus.wet.gain].forEach((param) => rampTo(param, level, seconds));

    // Re-enter on cue: the next phrase starts almost at once, sweeping up into D5
    if (!value) {
      nextPhraseTime = context.currentTime + MUSIC_REENTRY_DELAY;
      melodyPosition = SCALE_NOTES.indexOf(REENTRY_MIDI);
      opensWithSweep = true;
    }
  }

  // One-shot sound effects, fired as the sequence passes them
  function playCue(name) {
    if (!context || !enabled || !running || context.state !== 'running') return;
    cuePlayers[name]?.(context.currentTime + 0.01);
  }

  return {
    isSupported,
    isEnabled: () => enabled,
    setEnabled,
    setRunning,
    setMusicDucked,
    playCue,
  };
}
