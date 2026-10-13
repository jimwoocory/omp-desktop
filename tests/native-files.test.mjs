import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { confinedPath, loadAttachment, previewFile } from '../dist-electron/electron/native-files.js';

async function fixture(run) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'omp-native-files-'));
  try { await run(temporary); } finally { await rm(temporary, { recursive: true, force: true }); }
}

test('preview rejects a sibling outside the authorized workspace', async () => fixture(async directory => {
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const outside = path.join(directory, 'secret.txt');
  await writeFile(outside, 'outside');
  await assert.rejects(confinedPath(root, outside), /工作区之外/);
}));

test('text preview is bounded and marks truncation without executing markup', async () => fixture(async directory => {
  const file = path.join(directory, 'page.html');
  const source = '<script>throw new Error("must remain text")</script>\n' + 'x'.repeat(2 * 1024 * 1024);
  await writeFile(file, source);
  const result = await previewFile(directory, file);
  assert.equal(result.kind, 'text');
  assert.equal(result.truncated, true);
  assert.equal(result.content, source.slice(0, 2 * 1024 * 1024));
}));

test('attachments reject nonimages and images above the RPC input budget', async () => fixture(async directory => {
  const textFile = path.join(directory, 'notes.txt');
  const largeImage = path.join(directory, 'large.png');
  await writeFile(textFile, 'do not silently send as image');
  await writeFile(largeImage, Buffer.alloc(600 * 1024 + 1));
  await assert.rejects(loadAttachment(textFile), /支持 PNG/);
  await assert.rejects(loadAttachment(largeImage), /600 KiB/);
}));
