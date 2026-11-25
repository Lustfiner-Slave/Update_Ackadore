const { BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const extractZip = require('extract-zip');

const DRIVE_ROOT_ID = '1Q8xr_oCzV0q8il_i3JMUAciDi3o8NPMb';
const DRIVE_MODS_ID = '1Sa9DkMiTY6m68Qa7698g4SqiSjUaeACb';
const DRIVE_CONFIG_ID = '1Zjz27Bq5_klv75RBWYNF3aysQO_2hl6H';

function decodeDriveString(value) {
  return value
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(.)/gs, (_match, character) => ({
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t'
    }[character] || character));
}

function parseDriveRevision(html) {
  const match = html.match(/window\['_DRIVE_ivd'\]\s*=\s*'((?:\\.|[^'\\])*)';/);
  if (!match) throw new Error('Не удалось прочитать список сборки Google Drive.');

  const entries = JSON.parse(decodeDriveString(match[1]))[0];
  const mods = entries.find((entry) => entry[2] === 'mods' && entry[0] === DRIVE_MODS_ID);
  const config = entries.find((entry) => entry[2] === 'config.zip' && entry[0] === DRIVE_CONFIG_ID);
  if (!mods || !config || !Number.isFinite(mods[9]) || !Number.isFinite(config[9]) || !Number.isFinite(config[13])) {
    throw new Error('В папке Google Drive не найдены папка mods и архив config.zip.');
  }

  return {
    mods: { modified: mods[9], size: mods[13] || null },
    config: { modified: config[9], size: config[13] }
  };
}

function parseDriveModFiles(entries) {
  if (!Array.isArray(entries)) throw new Error('Google Drive не вернул список файлов mods.');

  const files = [];
  const ids = new Set();
  const names = new Set();
  for (const entry of entries) {
    const id = String(entry && entry.id || '').trim();
    const originalName = String(entry && entry.name || '').trim();
    if (!id || !originalName.toLowerCase().endsWith('.jar') || ids.has(id)) continue;

    let name = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) {
      const extension = path.extname(name);
      name = `${path.basename(name, extension)}-${id.slice(0, 8)}${extension}`;
    }

    ids.add(id);
    names.add(name.toLowerCase());
    files.push({ id, name });
  }
  if (files.length === 0) throw new Error('В папке Google Drive не найдено ни одного файла .jar.');
  return files;
}

async function getDriveRevision() {
  const url = `https://drive.google.com/drive/folders/${DRIVE_ROOT_ID}?usp=sharing&hl=ru&t=${Date.now()}`;
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Google Drive не ответил (HTTP ${response.status}).`);
  return parseDriveRevision(await response.text());
}

function getDriveModFiles() {
  return new Promise((resolve, reject) => {
    const listingWindow = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    let settled = false;
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      listingWindow.webContents.removeListener('did-finish-load', onDidFinishLoad);
      listingWindow.webContents.removeListener('did-fail-load', onDidFailLoad);
      if (!listingWindow.isDestroyed()) listingWindow.destroy();
    };
    const finish = (error, files) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(files);
    };
    const collect = async () => {
      if (settled || listingWindow.isDestroyed()) return;
      try {
        const entries = await listingWindow.webContents.executeJavaScript(`(async () => {
          const selector = '[role="row"][data-id]';
          const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          const files = new Map();
          let firstRow = null;
          for (let attempt = 0; attempt < 60; attempt++) {
            firstRow = document.querySelector(selector);
            if (firstRow && firstRow.innerText.trim()) break;
            await pause(250);
          }
          if (!firstRow) throw new Error('В таблице Google Drive нет файлов.');

          let scroller = firstRow;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 20
            && getComputedStyle(scroller).overflowY !== 'visible')) {
            scroller = scroller.parentElement;
          }

          const collectVisibleFiles = () => {
            for (const row of document.querySelectorAll(selector)) {
              const id = row.getAttribute('data-id');
              const name = row.innerText.trim().match(/^[^\\r\\n]+/)?.[0]?.trim();
              if (id && name) files.set(id, { id, name });
            }
          };

          if (scroller) {
            scroller.scrollTop = 0;
            await pause(250);
          }
          let stableBottom = 0;
          let reachedBottom = !scroller;
          let previousScrollHeight = scroller ? scroller.scrollHeight : 0;
          for (let step = 0; scroller && step < 200; step++) {
            collectVisibleFiles();
            const before = scroller.scrollTop;
            const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            scroller.scrollTop = Math.min(before + Math.max(300, scroller.clientHeight * 0.8), maxScroll);
            await pause(1000);
            const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
            if (atBottom && scroller.scrollTop === before && scroller.scrollHeight === previousScrollHeight) stableBottom++;
            else stableBottom = 0;
            previousScrollHeight = scroller.scrollHeight;
            if (atBottom && stableBottom >= 3) {
              reachedBottom = true;
              break;
            }
          }
          collectVisibleFiles();
          if (!reachedBottom) throw new Error('Не удалось дочитать список файлов Google Drive до конца.');
          return [...files.values()];
        })()`, true);
        finish(null, parseDriveModFiles(entries));
      } catch (error) {
        finish(new Error(`Не удалось прочитать папку mods Google Drive: ${error.message}`));
      }
    };
    const onDidFinishLoad = () => { void collect(); };
    const onDidFailLoad = (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        finish(new Error(`Не удалось загрузить список mods из Google Drive: ${errorDescription} (${errorCode}).`));
      }
    };

    listingWindow.webContents.on('did-finish-load', onDidFinishLoad);
    listingWindow.webContents.on('did-fail-load', onDidFailLoad);
    timeout = setTimeout(() => {
      finish(new Error('Google Drive не открыл список mods за 2 минуты.'));
    }, 2 * 60 * 1000);
    listingWindow.loadURL(`https://drive.google.com/drive/folders/${DRIVE_MODS_ID}?usp=sharing&hl=ru`)
      .catch((error) => finish(new Error(`Не удалось открыть список mods Google Drive: ${error.message}`)));
  });
}

function extractDownloadForm(html) {
  const formMatch = html.match(/<form\b[^>]*id="download-form"[^>]*action="([^"]+)"/i);
  if (!formMatch) return null;

  const action = formMatch[1].replace(/&amp;/g, '&');
  const form = new URL(action);
  if (!['drive.google.com', 'drive.usercontent.google.com'].includes(form.hostname)) {
    throw new Error('Google Drive вернул неизвестный адрес загрузки.');
  }
  const inputTags = html.match(/<input\b[^>]*>/gi) || [];
  for (const tag of inputTags) {
    const type = tag.match(/\btype="([^"]+)"/i)?.[1];
    if (type !== 'hidden') continue;
    const name = tag.match(/\bname="([^"]+)"/i)?.[1];
    const value = tag.match(/\bvalue="([^"]*)"/i)?.[1];
    if (name) form.searchParams.set(name, value || '');
  }
  return form;
}

async function downloadDriveFile(fileId, targetPath, expectedSize, onProgress, displayName = 'config.zip') {
  const url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const transferId = randomUUID();
  let response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Google Drive не отдал ${displayName} (HTTP ${response.status}).`);

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const downloadForm = extractDownloadForm(await response.text());
    if (!downloadForm) throw new Error(`Google Drive не разрешил скачать ${displayName}.`);
    response = await fetch(downloadForm, { signal });
  }
  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать ${displayName} (HTTP ${response.status}).`);
  }
  if ((response.headers.get('content-type') || '').includes('text/html')) {
    throw new Error(`Google Drive вернул страницу вместо ${displayName}.`);
  }

  const contentLength = Number(response.headers.get('content-length')) || expectedSize || 0;
  let received = 0;
  let lastProgressAt = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const now = Date.now();
      if (now - lastProgressAt >= 500 || received === contentLength) {
        lastProgressAt = now;
        onProgress(received, contentLength || null, transferId);
      }
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), progress, fs.createWriteStream(targetPath));
  if (expectedSize && received !== expectedSize) {
    throw new Error(`Размер ${displayName} не совпал: ожидалось ${expectedSize} байт, получено ${received}.`);
  }
  return received;
}

async function getDriveFileSize(file) {
  const url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(file.id)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      if (attempt === 2) {
        throw new Error(`Не удалось проверить размер ${file.name}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      continue;
    }

    if (response.status === 405) return null;
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
        continue;
      }
      throw new Error(`Не удалось определить размер ${file.name} (HTTP ${response.status}).`);
    }
    if ((response.headers.get('content-type') || '').includes('text/html')) return null;
    const size = Number(response.headers.get('content-length'));
    return Number.isSafeInteger(size) && size > 0 ? size : null;
  }
  throw new Error(`Не удалось определить размер ${file.name} после повторных запросов.`);
}

async function getDriveModFileSizes(files, onStatus) {
  const sizedFiles = new Array(files.length);
  let nextIndex = 0;
  let completed = 0;
  let sizingError = null;
  const workerCount = Math.min(4, files.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!sizingError) {
      const index = nextIndex++;
      if (index >= files.length) return;
      try {
        const size = await getDriveFileSize(files[index]);
        sizedFiles[index] = { ...files[index], size };
        completed++;
        if (completed % 10 === 0 || completed === files.length) {
          onStatus(`Проверяем размеры модов: ${completed}/${files.length}…`, 'info', null);
        }
      } catch (error) {
        sizingError = error;
      }
    }
  }));
  if (sizingError) throw sizingError;
  return sizedFiles;
}

async function countFiles(directory, extension) {
  let count = 0;
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) count += await countFiles(entryPath, extension);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) count++;
  }
  return count;
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function replaceDirectories(replacements, updateDirectory) {
  const completed = [];
  try {
    for (const [name, source, target] of replacements) {
      const backup = path.join(updateDirectory, `${name}-previous`);
      const hadTarget = await exists(target);
      if (hadTarget) await fs.promises.rename(target, backup);
      try {
        await fs.promises.rename(source, target);
      } catch (error) {
        if (hadTarget) await fs.promises.rename(backup, target);
        throw error;
      }
      completed.push({ target, backup, hadTarget });
    }
  } catch (error) {
    for (const item of completed.reverse()) {
      await fs.promises.rm(item.target, { recursive: true, force: true });
      if (item.hadTarget) await fs.promises.rename(item.backup, item.target);
    }
    throw error;
  }
}

async function syncDrivePack(gameDirectory, previousRevision, onStatus) {
  const revision = await getDriveRevision();
  const modsDirectory = path.join(gameDirectory, 'mods');
  const configDirectory = path.join(gameDirectory, 'config');
  const modsExist = await exists(modsDirectory);
  const localModsCount = modsExist ? await countFiles(modsDirectory, '.jar') : 0;
  const previousModsCount = Number.isSafeInteger(previousRevision && previousRevision.modsCount)
    ? previousRevision.modsCount
    : null;
  const updateMods = !previousRevision
    || previousModsCount === null
    || previousModsCount < 1
    || previousRevision.mods !== revision.mods.modified
    || localModsCount !== previousModsCount
    || !modsExist;
  const updateConfig = !previousRevision
    || previousRevision.config !== revision.config.modified
    || !(await exists(configDirectory));

  if (!updateMods && !updateConfig) {
    onStatus('Сборка свежая — суп уже готов.');
    return { mods: revision.mods.modified, modsCount: previousModsCount, config: revision.config.modified };
  }

  await fs.promises.mkdir(gameDirectory, { recursive: true });
  const updateDirectory = path.join(gameDirectory, `.launcher-update-${randomUUID()}`);
  await fs.promises.mkdir(updateDirectory, { recursive: true });
  try {
    const replacements = [];
    let modsCount = previousModsCount || 0;
    if (updateMods) {
      onStatus('Читаем список модов из Google Drive…', 'info', null);
      const files = await getDriveModFiles();
      modsCount = files.length;
      onStatus(`В сборке ${files.length} файлов модов. Определяем их размер…`, 'info', null);
      const sizedFiles = await getDriveModFileSizes(files, onStatus);
      const totalBytes = sizedFiles.every((file) => file.size !== null)
        ? sizedFiles.reduce((sum, file) => sum + file.size, 0)
        : null;
      const transferId = totalBytes === null ? null : randomUUID();
      let completedBytes = 0;
      const sourceModsDirectory = path.join(updateDirectory, 'mods');
      await fs.promises.mkdir(sourceModsDirectory, { recursive: true });

      const activeBytes = new Array(sizedFiles.length).fill(0);
      let nextFileIndex = 0;
      let downloadError = null;
      const workerCount = Math.min(4, sizedFiles.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (!downloadError) {
          const index = nextFileIndex++;
          if (index >= sizedFiles.length) return;

          const file = sizedFiles[index];
          const bytesInProgress = activeBytes.reduce((sum, bytes) => sum + bytes, 0);
          const receivedAtStart = completedBytes + bytesInProgress;
          const startPercent = totalBytes
            ? Math.floor((receivedAtStart / totalBytes) * 100)
            : null;
          onStatus(
            `Скачиваем мод ${index + 1}/${sizedFiles.length}: ${file.name}`,
            'info',
            totalBytes === null ? null : {
              transferId,
              receivedBytes: receivedAtStart,
              totalBytes,
              percent: startPercent
            }
          );
          try {
            const downloadedBytes = await downloadDriveFile(
              file.id,
              path.join(sourceModsDirectory, file.name),
              file.size,
              (fileReceivedBytes, fileTotalBytes, fileTransferId) => {
                activeBytes[index] = fileReceivedBytes;
                const receivedBytes = totalBytes === null
                  ? fileReceivedBytes
                  : completedBytes + activeBytes.reduce((sum, bytes) => sum + bytes, 0);
                const progressTotalBytes = totalBytes === null ? fileTotalBytes : totalBytes;
                const percent = progressTotalBytes
                  ? Math.min(100, Math.floor((receivedBytes / progressTotalBytes) * 100))
                  : null;
                const progressMessage = percent === null
                  ? `Моды: ${index + 1}/${sizedFiles.length}`
                  : `Моды: ${percent}% (${index + 1}/${sizedFiles.length})`;
                onStatus(progressMessage, 'info', {
                  transferId: transferId || fileTransferId,
                  receivedBytes,
                  totalBytes: progressTotalBytes,
                  percent
                });
              },
              file.name
            );
            completedBytes += downloadedBytes;
            activeBytes[index] = 0;
          } catch (error) {
            downloadError = error;
          }
        }
      }));
      if (downloadError) throw downloadError;

      const downloadedCount = await countFiles(sourceModsDirectory, '.jar');
      if (downloadedCount !== files.length) {
        throw new Error(`Скачалось ${downloadedCount} из ${files.length} файлов модов.`);
      }
      replacements.push(['mods', sourceModsDirectory, modsDirectory]);
    }

    if (updateConfig) {
      const archivePath = path.join(updateDirectory, 'config.zip');
      onStatus('Скачиваем конфигурации сборки…', 'info', null);
      await downloadDriveFile(DRIVE_CONFIG_ID, archivePath, revision.config.size, (receivedBytes, totalBytes, transferId) => {
        const percent = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : null;
        onStatus(
          percent === null ? 'Конфигурации в пути…' : `Конфигурации в пути: ${percent}%`,
          'info',
          { transferId, receivedBytes, totalBytes, percent }
        );
      });
      const extractedDirectory = path.join(updateDirectory, 'config-extracted');
      await extractZip(archivePath, { dir: extractedDirectory });
      if ((await fs.promises.readdir(extractedDirectory)).length === 0) {
        throw new Error('Архив config.zip пуст.');
      }
      replacements.push(['config', extractedDirectory, configDirectory]);
    }

    onStatus('Раскладываем ингредиенты по папкам…', 'info', null);
    await replaceDirectories(replacements, updateDirectory);
    onStatus('Моды и конфигурации обновлены.');
    return { mods: revision.mods.modified, modsCount, config: revision.config.modified };
  } finally {
    await fs.promises.rm(updateDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  parseDriveRevision,
  parseDriveModFiles,
  syncDrivePack
};
