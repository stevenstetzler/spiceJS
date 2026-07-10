# spiceJS

A lightweight JavaScript library inspired by NAIF SPICE tutorials and the high-level SpiceyPy API style.

## Implemented API

- `furnsh(kernel)` load a JSON SPICE-like kernel with state samples
- `unload(target, observer, frame)` remove loaded segment data
- `kclear()` clear all loaded kernels
- `str2et(utcString)` convert UTC strings to ephemeris time seconds from J2000
- `spkezr(target, et, frame, abcorr, observer)` return interpolated state vector
- `generateTrajectory({ target, observer, frame, startEt, stopEt, step })` sample a trajectory

## Kernel format

```json
{
  "segments": [
    {
      "target": "MARS",
      "observer": "EARTH",
      "frame": "J2000",
      "samples": [
        { "et": 0, "state": [100, 200, 300, 1, 2, 3] },
        { "et": 10, "state": [200, 400, 600, 4, 5, 6] }
      ]
    }
  ]
}
```

## Usage

```js
const { SpiceJS } = require('spicejs');

const spice = new SpiceJS();
spice.furnsh({
  segments: [
    {
      target: 'MARS',
      observer: 'EARTH',
      frame: 'J2000',
      samples: [
        { et: 0, state: [100, 200, 300, 1, 2, 3] },
        { et: 10, state: [200, 400, 600, 4, 5, 6] }
      ]
    }
  ]
});

const state = spice.spkezr('MARS', 5, 'J2000', 'NONE', 'EARTH');
const trajectory = spice.generateTrajectory({
  target: 'MARS',
  observer: 'EARTH',
  frame: 'J2000',
  startEt: 0,
  stopEt: 10,
  step: 5
});
```
