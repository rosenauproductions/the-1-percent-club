/**
 * Public Google Drive pack import (no OAuth).
 * Supports: Drive zip file, single JSON file, or folder (folder needs API key).
 */
import fs from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';

const MAX_ZIP_BYTES = 80 * 1024 * 1024; // 80 MB
const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB per file
const MAX_FILES = 120;
const FETCH_TIMEOUT_MS = 60_000;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const PREFERRED_JSON = ['questions.json', 'pack.json'];

const DRIVE_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'www.googleapis.com',
]);

export class DriveImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DriveImportError';
    this.status = status;
  }
}

function apiKey() {
  return (
    process.env.GOOGLE_API_KEY ||
    process.env.DRIVE_API_KEY ||
    process.env.GOOGLE_DRIVE_API_KEY ||
    ''
  ).trim();
}

function assertDriveUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    throw new DriveImportError('Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new DriveImportError('URL must be http(s)');
  }
  const host = u.hostname.toLowerCase();
  if (!DRIVE_HOSTS.has(host) && !host.endsWith('.googleusercontent.com')) {
    throw new DriveImportError(
      'Only public Google Drive / Docs links are allowed (drive.google.com)',
    );
  }
  return u;
}

/**
 * @returns {{ kind: 'file'|'folder', id: string } | null}
 */
export function parseDriveUrl(rawUrl) {
  const u = assertDriveUrl(rawUrl);
  const pathStr = u.pathname;

  let m = pathStr.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: 'folder', id: m[1] };

  m = pathStr.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: 'file', id: m[1] };

  m = pathStr.match(/\/open\/?/);
  if (m && u.searchParams.get('id')) {
    // open?id= can be file or folder — treat as file download first
    return { kind: 'file', id: u.searchParams.get('id') };
  }

  const id = u.searchParams.get('id');
  if (id) {
    if (pathStr.includes('/folders') || u.searchParams.get('usp') === 'sharing') {
      // ambiguous; if path has folders it's folder
    }
    if (/\/folders\//.test(pathStr)) return { kind: 'folder', id };
    return { kind: 'file', id };
  }

  // uc?export=download&id=
  if (u.searchParams.get('export') === 'download' && id) {
    return { kind: 'file', id };
  }

  throw new DriveImportError(
    'Could not find a Drive file or folder ID in that URL. Use a share link to a folder, zip, or JSON file.',
  );
}

function slugify(name) {
  const base = String(name || 'drive-pack')
    .toLowerCase()
    .replace(/\.json$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return base || 'drive-pack';
}

function sanitizeRelPath(p) {
  const cleaned = String(p || '')
    .replace(/\\/g, '/')
    .replace(/\0/g, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  if (!cleaned || cleaned.includes('..')) {
    throw new DriveImportError(`Unsafe filename: ${p}`);
  }
  return cleaned;
}

function looksLikePackJson(data) {
  if (Array.isArray(data)) return data.length > 0 && typeof data[0] === 'object';
  if (data && typeof data === 'object' && Array.isArray(data.questions)) return true;
  return false;
}

function pickPackJsonEntry(entries) {
  const jsonEntries = entries.filter((e) => e.name.toLowerCase().endsWith('.json'));
  if (!jsonEntries.length) {
    throw new DriveImportError('No JSON pack file found in the download');
  }
  for (const preferred of PREFERRED_JSON) {
    const hit = jsonEntries.find(
      (e) => path.basename(e.name).toLowerCase() === preferred,
    );
    if (hit) return hit;
  }
  // Prefer a JSON that parses as a pack
  for (const e of jsonEntries) {
    try {
      const data = JSON.parse(e.buffer.toString('utf8'));
      if (looksLikePackJson(data)) return e;
    } catch {
      // continue
    }
  }
  return jsonEntries[0];
}

function collectImageRefs(questions) {
  const refs = new Set();
  for (const q of questions) {
    for (const key of ['image', 'solutionImage']) {
      const v = q?.[key];
      if (!v || typeof v !== 'string') continue;
      const s = v.trim();
      if (!s || /^https?:\/\//i.test(s)) continue;
      refs.add(s.replace(/\\/g, '/').replace(/^\/+/, ''));
    }
  }
  return refs;
}

function rewriteQuestionImages(questions, packId, downloadedNames) {
  const nameSet = new Set(downloadedNames.map((n) => n.replace(/\\/g, '/')));
  const byBase = new Map();
  for (const n of nameSet) {
    byBase.set(path.basename(n).toLowerCase(), n);
  }

  return questions.map((q) => {
    const next = { ...q };
    for (const key of ['image', 'solutionImage']) {
      const v = next[key];
      if (!v || typeof v !== 'string') continue;
      const s = v.trim();
      if (!s) {
        next[key] = '';
        continue;
      }
      if (/^https?:\/\//i.test(s)) {
        // Keep absolute URLs (already hosted)
        continue;
      }
      let rel = s.replace(/\\/g, '/').replace(/^\/+/, '');
      // Strip leading images/questions/<anything>/ if present
      const m = rel.match(/^images\/questions\/[^/]+\/(.+)$/i);
      if (m) rel = m[1];
      if (rel.startsWith('images/questions/')) {
        rel = path.basename(rel);
      }
      if (nameSet.has(rel)) {
        next[key] = rel;
      } else if (byBase.has(path.basename(rel).toLowerCase())) {
        next[key] = byBase.get(path.basename(rel).toLowerCase());
      } else {
        // leave relative basename so resolveQuestionImage can still try
        next[key] = path.basename(rel) || rel;
      }
    }
    return next;
  });
}

async function fetchWithLimit(url, { maxBytes = MAX_FILE_BYTES } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'The1PercentClub/1.0 (pack-import)',
      },
    });

    // Drive large-file virus-scan interstitial
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('text/html')) {
      const html = await res.text();
      const confirm =
        html.match(/confirm=([0-9A-Za-z_-]+)/)?.[1] ||
        html.match(/name="confirm"\s+value="([^"]+)"/)?.[1];
      const idMatch = String(url).match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (confirm && idMatch) {
        const retryUrl = `https://drive.google.com/uc?export=download&id=${idMatch[1]}&confirm=${confirm}`;
        res = await fetch(retryUrl, {
          signal: ctrl.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'The1PercentClub/1.0 (pack-import)' },
        });
      } else if (/accounts\.google\.com|Sign in|must be signed in/i.test(html)) {
        throw new DriveImportError(
          'That Drive link is not public. Set sharing to “Anyone with the link”.',
        );
      } else {
        throw new DriveImportError(
          'Drive returned a webpage instead of a file. Use a public zip/JSON file link, or a folder with an API key.',
        );
      }
    }

    if (!res.ok) {
      throw new DriveImportError(
        `Download failed (${res.status}). Check that the link is public.`,
        res.status === 404 ? 404 : 400,
      );
    }

    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) {
      throw new DriveImportError(`File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new DriveImportError(`File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }
    return { buffer: buf, contentType: res.headers.get('content-type') || '' };
  } catch (err) {
    if (err instanceof DriveImportError) throw err;
    if (err?.name === 'AbortError') {
      throw new DriveImportError('Download timed out');
    }
    throw new DriveImportError(err.message || 'Download failed');
  } finally {
    clearTimeout(timer);
  }
}

function ucDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

function mediaDownloadUrl(fileId, key) {
  if (key) {
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(key)}`;
  }
  return ucDownloadUrl(fileId);
}

async function listFolderFiles(folderId, key) {
  if (!key) {
    throw new DriveImportError(
      'Folder import needs an API key (set GOOGLE_API_KEY or DRIVE_API_KEY), or upload a public zip of the pack + images instead.',
    );
  }
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const fields = encodeURIComponent('files(id,name,mimeType,size)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=200&key=${encodeURIComponent(key)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `Drive API error (${res.status})`;
      throw new DriveImportError(
        `${msg}. Use a free API key restricted to Drive read, or import a zip instead.`,
      );
    }
    const files = Array.isArray(data.files) ? data.files : [];
    if (!files.length) {
      throw new DriveImportError(
        'Folder is empty or not publicly accessible. Share the folder as “Anyone with the link”.',
      );
    }
    return files;
  } catch (err) {
    if (err instanceof DriveImportError) throw err;
    throw new DriveImportError(err.message || 'Could not list Drive folder');
  } finally {
    clearTimeout(timer);
  }
}

function isZipBuffer(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function isProbablyJson(buf, contentType = '') {
  if (/json/i.test(contentType)) return true;
  const head = buf.slice(0, 64).toString('utf8').trimStart();
  return head.startsWith('{') || head.startsWith('[');
}

/**
 * @returns {Promise<{ name: string, buffer: Buffer }[]>}
 */
async function materializeEntriesFromZip(buffer) {
  if (buffer.length > MAX_ZIP_BYTES) {
    throw new DriveImportError(`Zip too large (max ${MAX_ZIP_BYTES / 1024 / 1024} MB)`);
  }
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new DriveImportError('Could not read zip archive');
  }
  const entries = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = sanitizeRelPath(entry.entryName);
    if (name.startsWith('__MACOSX/') || path.basename(name).startsWith('.')) continue;
    const data = entry.getData();
    if (data.length > MAX_FILE_BYTES) {
      throw new DriveImportError(`Zip entry too large: ${name}`);
    }
    entries.push({ name, buffer: data });
    if (entries.length > MAX_FILES) {
      throw new DriveImportError(`Too many files in zip (max ${MAX_FILES})`);
    }
  }
  if (!entries.length) throw new DriveImportError('Zip archive is empty');
  return entries;
}

async function materializeEntriesFromFolder(folderId, key) {
  const files = await listFolderFiles(folderId, key);
  const entries = [];
  for (const f of files) {
    if (f.mimeType === 'application/vnd.google-apps.folder') continue;
    // Skip Google Docs native types
    if (f.mimeType?.startsWith('application/vnd.google-apps.')) continue;
    const name = sanitizeRelPath(f.name);
    const size = Number(f.size || 0);
    if (size > MAX_FILE_BYTES) {
      throw new DriveImportError(`File too large in folder: ${name}`);
    }
    const { buffer } = await fetchWithLimit(mediaDownloadUrl(f.id, key), {
      maxBytes: MAX_FILE_BYTES,
    });
    entries.push({ name, buffer });
    if (entries.length > MAX_FILES) {
      throw new DriveImportError(`Too many files in folder (max ${MAX_FILES})`);
    }
  }
  return entries;
}

function normalizePackData(raw, fallbackName) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new DriveImportError('Pack JSON is invalid');
  }
  if (!looksLikePackJson(data)) {
    throw new DriveImportError(
      'JSON must be a questions array or { name, questions: [...] }',
    );
  }
  const list = Array.isArray(data) ? data : data.questions;
  if (!list.length) throw new DriveImportError('Pack has no questions');

  const name = Array.isArray(data)
    ? fallbackName
    : String(data.name || fallbackName || 'Drive pack').trim() || 'Drive pack';

  const settings =
    !Array.isArray(data) && data.settings && typeof data.settings === 'object'
      ? { ...data.settings }
      : {};

  return {
    name,
    settings,
    questions: list,
    packObject: Array.isArray(data)
      ? { name, settings, questions: list }
      : { ...data, name, questions: list, settings: { ...settings, ...(data.settings || {}) } },
  };
}

async function writePackToDisk({
  questionsDir,
  publicDir,
  packObject,
  packId,
  imageEntries,
  importsManifestPath,
  sourceUrl,
}) {
  const imagesDir = path.join(publicDir, 'images', 'questions', packId);
  await fs.mkdir(imagesDir, { recursive: true });
  await fs.mkdir(questionsDir, { recursive: true });

  const writtenImages = [];
  for (const entry of imageEntries) {
    const rel = sanitizeRelPath(entry.name);
    const dest = path.join(imagesDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, entry.buffer);
    writtenImages.push(rel);
  }

  const questions = rewriteQuestionImages(
    packObject.questions,
    packId,
    writtenImages,
  );
  const out = {
    ...packObject,
    questions,
  };

  const jsonPath = path.join(questionsDir, `${packId}.json`);
  await fs.writeFile(jsonPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  await recordImport(importsManifestPath, {
    packId,
    file: `${packId}.json`,
    name: out.name,
    sourceUrl,
    importedAt: new Date().toISOString(),
    imageCount: writtenImages.length,
    questionCount: questions.length,
  });

  return {
    file: `${packId}.json`,
    packId,
    name: out.name,
    questionCount: questions.length,
    imageCount: writtenImages.length,
  };
}

async function recordImport(manifestPath, entry) {
  let list = [];
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    list = JSON.parse(raw);
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list = list.filter((x) => x.packId !== entry.packId);
  list.push(entry);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

export async function listDriveImports(manifestPath) {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function clearDriveImport({
  packId,
  questionsDir,
  publicDir,
  importsManifestPath,
}) {
  const safe = path.basename(String(packId || '').replace(/\.json$/i, ''));
  if (!safe) throw new DriveImportError('packId required');

  const imports = await listDriveImports(importsManifestPath);
  const hit = imports.find((x) => x.packId === safe);
  if (!hit) {
    throw new DriveImportError(
      'That pack was not imported from Drive (only Drive imports can be cleared this way).',
    );
  }

  const jsonPath = path.join(questionsDir, `${safe}.json`);
  const imagesDir = path.join(publicDir, 'images', 'questions', safe);
  await fs.rm(jsonPath, { force: true });
  await fs.rm(imagesDir, { recursive: true, force: true });

  const next = imports.filter((x) => x.packId !== safe);
  await fs.writeFile(importsManifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { cleared: safe, file: `${safe}.json` };
}

function imageEntriesFromBundle(entries, packJsonName) {
  const images = [];
  for (const e of entries) {
    if (e.name === packJsonName) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    // Drop leading folder that is only "images" wrapper if pack refs bare filenames —
    // keep path as-is; rewrite will match basename.
    let name = e.name;
    // Common zip layout: images/90a.png or pack-name/90a.png
    const parts = name.split('/');
    if (parts.length > 1 && parts[0].toLowerCase() === 'images') {
      name = parts.slice(1).join('/');
    } else if (parts.length === 2 && !IMAGE_EXT.has(path.extname(parts[0]))) {
      // single nesting folder → use basename path inside
      name = parts[1];
    }
    images.push({ name: sanitizeRelPath(name), buffer: e.buffer });
  }
  return images;
}

async function uniquePackId(questionsDir, desired) {
  let id = slugify(desired);
  let n = 0;
  while (true) {
    const candidate = n === 0 ? id : `${id}-${n}`;
    try {
      await fs.access(path.join(questionsDir, `${candidate}.json`));
      n += 1;
      if (n > 50) throw new DriveImportError('Could not allocate pack id');
    } catch (err) {
      if (err instanceof DriveImportError) throw err;
      // missing → free (unless we are overwriting same drive import — caller may force)
      return candidate;
    }
  }
}

/**
 * Import a public Drive URL into local pack storage.
 */
export async function importDrivePack({
  url,
  questionsDir,
  publicDir,
  importsManifestPath,
  overwritePackId = null,
}) {
  assertDriveUrl(url);
  const parsed = parseDriveUrl(url);
  const key = apiKey();

  let entries;

  if (parsed.kind === 'folder') {
    entries = await materializeEntriesFromFolder(parsed.id, key);
  } else {
    const { buffer, contentType } = await fetchWithLimit(ucDownloadUrl(parsed.id), {
      maxBytes: MAX_ZIP_BYTES,
    });

    if (isZipBuffer(buffer) || /zip|octet-stream/i.test(contentType)) {
      // octet-stream might be json — check magic
      if (isZipBuffer(buffer)) {
        entries = await materializeEntriesFromZip(buffer);
      } else if (isProbablyJson(buffer, contentType)) {
        entries = [{ name: 'questions.json', buffer }];
      } else {
        // try zip then json
        try {
          entries = await materializeEntriesFromZip(buffer);
        } catch {
          if (isProbablyJson(buffer, '')) {
            entries = [{ name: 'questions.json', buffer }];
          } else {
            throw new DriveImportError(
              'Downloaded file is neither a zip nor JSON. For a folder of JSON+images, use a folder link with GOOGLE_API_KEY, or zip the pack.',
            );
          }
        }
      }
    } else if (isProbablyJson(buffer, contentType)) {
      entries = [{ name: 'questions.json', buffer }];
    } else if (isZipBuffer(buffer)) {
      entries = await materializeEntriesFromZip(buffer);
    } else {
      throw new DriveImportError(
        'Expected a public zip (JSON + images) or a JSON file. Folder links need GOOGLE_API_KEY.',
      );
    }
  }

  const packEntry = pickPackJsonEntry(entries);
  const normalized = normalizePackData(
    packEntry.buffer.toString('utf8'),
    path.basename(packEntry.name, '.json'),
  );

  // If only JSON and relative images referenced, require those images in the bundle
  const relRefs = collectImageRefs(normalized.questions);
  const imageEntries = imageEntriesFromBundle(entries, packEntry.name);
  const have = new Set(imageEntries.map((e) => e.name));
  const haveBase = new Set([...have].map((n) => path.basename(n).toLowerCase()));

  const missing = [];
  for (const ref of relRefs) {
    const base = path.basename(ref).toLowerCase();
    if (have.has(ref) || haveBase.has(base)) continue;
    // Also ok if path ends with images/...
    if ([...have].some((h) => h.endsWith(`/${ref}`) || path.basename(h) === path.basename(ref))) {
      continue;
    }
    missing.push(ref);
  }
  if (missing.length && imageEntries.length === 0) {
    throw new DriveImportError(
      `Pack references relative images (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}) but none were in the download. Use a zip/folder that includes the image files, or host images as https URLs.`,
    );
  }

  let packId;
  if (overwritePackId) {
    packId = path.basename(String(overwritePackId).replace(/\.json$/i, ''));
  } else {
    // Prefer stable slug from pack name; overwrite if already a drive import with same slug
    const desired = slugify(normalized.name);
    const imports = await listDriveImports(importsManifestPath);
    const existingImport = imports.find((x) => x.packId === desired);
    if (existingImport) {
      packId = desired; // overwrite previous drive import
      // wipe old images dir for clean replace
      await fs.rm(path.join(publicDir, 'images', 'questions', packId), {
        recursive: true,
        force: true,
      });
    } else {
      // Don't clobber bundled packs like split-decision.json
      try {
        await fs.access(path.join(questionsDir, `${desired}.json`));
        const isImport = imports.some((x) => x.packId === desired);
        packId = isImport ? desired : await uniquePackId(questionsDir, `${desired}-drive`);
        if (isImport) {
          await fs.rm(path.join(publicDir, 'images', 'questions', packId), {
            recursive: true,
            force: true,
          });
        }
      } catch {
        packId = desired;
      }
    }
  }

  const result = await writePackToDisk({
    questionsDir,
    publicDir,
    packObject: normalized.packObject,
    packId,
    imageEntries,
    importsManifestPath,
    sourceUrl: String(url).trim(),
  });

  return {
    ...result,
    kind: parsed.kind,
    source: parsed.kind === 'folder' ? 'folder' : entries.length > 1 ? 'zip-or-folder' : 'json',
  };
}
