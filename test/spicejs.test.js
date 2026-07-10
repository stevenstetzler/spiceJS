const test = require('node:test');
const assert = require('node:assert/strict');

const { SpiceJS } = require('../src/index');

const sampleKernel = {
  segments: [
    {
      target: 'MARS',
      observer: 'EARTH',
      frame: 'J2000',
      samples: [
        { et: 0, state: [100, 200, 300, 1, 2, 3] },
        { et: 10, state: [200, 400, 600, 4, 5, 6] },
      ],
    },
  ],
};

test('str2et converts J2000 epoch to zero ET', () => {
  const spice = new SpiceJS();
  assert.equal(spice.str2et('2000-01-01T12:00:00.000Z'), 0);
});

test('spkezr interpolates state vectors from loaded kernel samples', () => {
  const spice = new SpiceJS();
  spice.furnsh(sampleKernel);

  const result = spice.spkezr('MARS', 5, 'J2000', 'NONE', 'EARTH');
  assert.deepEqual(result.state, [150, 300, 450, 2.5, 3.5, 4.5]);
  assert.equal(result.lt, 0);
});

test('generateTrajectory samples states over requested ET range', () => {
  const spice = new SpiceJS();
  spice.furnsh(sampleKernel);

  const trajectory = spice.generateTrajectory({
    target: 'MARS',
    observer: 'EARTH',
    frame: 'J2000',
    startEt: 0,
    stopEt: 10,
    step: 5,
  });

  assert.equal(trajectory.length, 3);
  assert.deepEqual(trajectory.map((point) => point.et), [0, 5, 10]);
  assert.deepEqual(trajectory[0].state, [100, 200, 300, 1, 2, 3]);
  assert.deepEqual(trajectory[2].state, [200, 400, 600, 4, 5, 6]);
});

test('unload and kclear remove loaded state data', () => {
  const spice = new SpiceJS();
  spice.furnsh(sampleKernel);
  spice.unload('MARS', 'EARTH', 'J2000');

  assert.throws(() => spice.spkezr('MARS', 0, 'J2000', 'NONE', 'EARTH'));

  spice.furnsh(sampleKernel);
  spice.kclear();
  assert.throws(() => spice.spkezr('MARS', 0, 'J2000', 'NONE', 'EARTH'));
});
