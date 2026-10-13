import { realpath, readdir, stat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment, FileEntry, FilePreview } from '../shared/contracts.js';

const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const textExtensions: Record<string, true> = {
  '.ts': true, '.tsx': true, '.js': true, '.jsx': true, '.mjs': true, '.cjs': true,
  '.json': true, '.jsonl': true, '.md': true, '.txt': true, '.log': true, '.html': true,
  '.css': true, '.svg': true, '.yaml': true, '.yml': true, '.toml': true, '.xml': true,
  '.py': true, '.rs': true, '.go': true, '.sh': true, '.ps1': true, '.bat': true,
  '.ini': true, '.conf': true, '.sql': true, '.csv': true,
};

export async function confinedPath(root: string, requested: string): Promise<string> {
  if (!path.isAbsolute(root) || !path.isAbsolute(requested)) throw new Error('文件路径必须是绝对路径');
  if (/^(\\\\[?.]\\)/.test(root) || /^(\\\\[?.]\\)/.test(requested)) throw new Error('不允许 Windows 设备路径');
  const [base, target] = await Promise.all([realpath(root), realpath(requested)]);
  const relative = path.relative(base, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('文件位于当前工作区之外');
  return target;
}

export async function listFiles(root: string, requested = root): Promise<FileEntry[]> {
  const directory = await confinedPath(root, requested);
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(entries.filter(entry => !entry.isSymbolicLink()).map(async entry => {
    const entryPath = path.join(directory, entry.name);
    const info = await stat(entryPath);
    return { name: entry.name, path: entryPath, directory: info.isDirectory(), size: info.size };
  }));
  return results.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export async function previewFile(root: string, requested: string): Promise<FilePreview> {
  const file = await confinedPath(root, requested);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('请选择文件');
  const extension = path.extname(file).toLowerCase();
  const imageType = imageTypes[extension];
  if (imageType) {
    if (info.size > 12 * 1024 * 1024) throw new Error('图片预览最大为 12 MiB');
    const bytes = await readFile(file);
    return { path: file, kind: 'image', content: `data:${imageType};base64,${bytes.toString('base64')}`, truncated: false };
  }
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(info.size, 2 * 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (!textExtensions[extension] && bytes.includes(0)) return { path: file, kind: 'binary', content: `${info.size.toLocaleString()} bytes · 二进制文件`, truncated: false };
    return { path: file, kind: 'text', content: bytes.toString('utf8'), truncated: info.size > bytesRead };
  } finally { await handle.close(); }
}

export async function loadAttachment(file: string): Promise<Attachment> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('附件必须是文件');
  const mimeType = imageTypes[path.extname(file).toLowerCase()];
  if (!mimeType) throw new Error('图片附件支持 PNG、JPEG、WebP 和 GIF；其他文件请在消息中引用工作区路径');
  if (info.size > 600 * 1024) throw new Error('OMP 输入帧限制为 1 MiB；请将图片压缩到 600 KiB 以下再附加');
  return { name: path.basename(file), mimeType, data: (await readFile(file)).toString('base64'), path: file };
}
