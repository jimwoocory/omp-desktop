const fs = require('node:fs');
const path = require('node:path');
const configuration = require('./package.json').build;
const runtime = process.env.OMP_RUNTIME_PATH;
if (!runtime || !fs.existsSync(runtime)) throw new Error('Set OMP_RUNTIME_PATH to the OMP standalone executable before packaging.');
module.exports = {
  ...configuration,
  extraResources: [{ from: path.resolve(runtime), to: 'omp/omp.exe' }],
};
