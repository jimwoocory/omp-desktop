import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveNativeAgentDirectory } from '../dist-electron/electron/config-paths.js';

const home = path.resolve('test-home');
const cwd = path.resolve('test-workspace');

test('default profile aliases and explicit empty OMP selector do not inherit a legacy named profile', () => {
  const expected = path.join(home, '.omp', 'agent');
  assert.equal(resolveNativeAgentDirectory(home, { OMP_PROFILE: ' default ', PI_PROFILE: 'legacy' }, cwd), expected);
  assert.equal(resolveNativeAgentDirectory(home, { OMP_PROFILE: '', PI_PROFILE: 'legacy' }, cwd), expected);
  assert.equal(resolveNativeAgentDirectory(home, { PI_PROFILE: 'legacy' }, cwd), path.join(home, '.omp', 'profiles', 'legacy', 'agent'));
});

test('native config dirname remains under home and named profiles ignore agent overrides', () => {
  assert.equal(resolveNativeAgentDirectory(home, { PI_CONFIG_DIR: '.omp-test' }, cwd), path.join(home, '.omp-test', 'agent'));
  assert.equal(resolveNativeAgentDirectory(home, { OMP_PROFILE: ' project-a ', PI_CONFIG_DIR: '.omp-test', PI_CODING_AGENT_DIR: 'other' }, cwd), path.join(home, '.omp-test', 'profiles', 'project-a', 'agent'));
  assert.equal(resolveNativeAgentDirectory(home, { PI_CODING_AGENT_DIR: 'custom-agent' }, cwd), path.join(cwd, 'custom-agent'));
});

test('invalid profile names fail instead of silently selecting a different directory', () => {
  for (const name of ['../outside', 'with/path', '.', '..', 'name.', 'con', 'nul.txt', 'MixedCase']) {
    assert.throws(() => resolveNativeAgentDirectory(home, { OMP_PROFILE: name }, cwd));
  }
});
