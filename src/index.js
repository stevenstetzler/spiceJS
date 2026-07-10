const fs = require('node:fs');

const J2000_EPOCH_MS = Date.UTC(2000, 0, 1, 12, 0, 0, 0);

class SpiceJS {
  constructor() {
    this.kclear();
  }

  furnsh(kernelInput) {
    const kernel = typeof kernelInput === 'string'
      ? JSON.parse(fs.readFileSync(kernelInput, 'utf8'))
      : kernelInput;

    if (!kernel || !Array.isArray(kernel.segments)) {
      throw new Error('Kernel must define a segments array.');
    }

    for (const segment of kernel.segments) {
      this._validateSegment(segment);
      const key = this._segmentKey(segment.target, segment.observer, segment.frame);
      const samples = [...segment.samples].sort((a, b) => a.et - b.et);
      this.segments.set(key, {
        ...segment,
        samples,
      });
    }
  }

  unload(target, observer = 'SOLAR SYSTEM BARYCENTER', frame = 'J2000') {
    this.segments.delete(this._segmentKey(target, observer, frame));
  }

  kclear() {
    this.segments = new Map();
  }

  str2et(timeString) {
    const timestamp = Date.parse(timeString);
    if (Number.isNaN(timestamp)) {
      throw new Error(`Invalid time string: ${timeString}`);
    }

    return (timestamp - J2000_EPOCH_MS) / 1000;
  }

  spkezr(target, et, frame = 'J2000', abcorr = 'NONE', observer = 'SOLAR SYSTEM BARYCENTER') {
    if (abcorr !== 'NONE') {
      throw new Error('Only abcorr="NONE" is currently supported.');
    }

    const segment = this._getSegment(target, observer, frame);
    const state = interpolateSamples(segment.samples, et);
    return {
      state,
      lt: 0,
      target,
      observer,
      frame,
      et,
    };
  }

  generateTrajectory({
    target,
    observer = 'SOLAR SYSTEM BARYCENTER',
    frame = 'J2000',
    abcorr = 'NONE',
    startEt,
    stopEt,
    step,
  }) {
    if (!Number.isFinite(startEt) || !Number.isFinite(stopEt) || !Number.isFinite(step) || step <= 0) {
      throw new Error('startEt, stopEt, and step must be finite numbers and step must be > 0.');
    }

    if (stopEt < startEt) {
      throw new Error('stopEt must be >= startEt.');
    }

    const trajectory = [];
    for (let et = startEt; et <= stopEt + step * 1e-9; et += step) {
      const clampedEt = et > stopEt ? stopEt : et;
      trajectory.push(this.spkezr(target, clampedEt, frame, abcorr, observer));
      if (clampedEt === stopEt) {
        break;
      }
    }

    return trajectory;
  }

  _segmentKey(target, observer, frame) {
    return `${target}|${observer}|${frame}`;
  }

  _validateSegment(segment) {
    if (!segment || typeof segment !== 'object') {
      throw new Error('Segment must be an object.');
    }

    const { target, observer, frame, samples } = segment;
    if (!target || !observer || !frame) {
      throw new Error('Segment must include target, observer, and frame.');
    }

    if (!Array.isArray(samples) || samples.length < 1) {
      throw new Error('Segment must include at least one sample.');
    }

    for (const sample of samples) {
      if (!Number.isFinite(sample.et)) {
        throw new Error('Each sample must include a finite et value.');
      }

      if (!Array.isArray(sample.state) || sample.state.length !== 6 || sample.state.some((value) => !Number.isFinite(value))) {
        throw new Error('Each sample state must be an array of 6 finite numbers.');
      }
    }
  }

  _getSegment(target, observer, frame) {
    const segment = this.segments.get(this._segmentKey(target, observer, frame));
    if (!segment) {
      throw new Error(`No loaded segment for target=${target}, observer=${observer}, frame=${frame}.`);
    }

    return segment;
  }
}

function interpolateSamples(samples, et) {
  if (samples.length === 1) {
    return [...samples[0].state];
  }

  if (et <= samples[0].et) {
    return [...samples[0].state];
  }

  if (et >= samples[samples.length - 1].et) {
    return [...samples[samples.length - 1].state];
  }

  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];

    if (et >= a.et && et <= b.et) {
      const fraction = (et - a.et) / (b.et - a.et);
      return a.state.map((value, index) => value + fraction * (b.state[index] - value));
    }
  }

  return [...samples[samples.length - 1].state];
}

module.exports = {
  SpiceJS,
  J2000_EPOCH_MS,
};
