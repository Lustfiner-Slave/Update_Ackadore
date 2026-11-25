const { app, BrowserWindow, ipcMain, net, safeStorage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const extractZip = require('extract-zip');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');
const { syncDrivePack } = require('./pack');

const MINECRAFT_VERSION = '1.21.1';
const NEOFORGE_VERSION = '21.1.266';
const SERVER_HOST = '144.31.4.154';
const SERVER_PORT = 25566;
const NEOFORGE_PROFILE = `neoforge-${NEOFORGE_VERSION}`;
const NEOFORGE_INSTALLER_URL = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-installer.jar`;
const TEMURIN_API_URL = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse';
const execFileAsync = promisify(execFile);
const store = new Store({
  defaults: {
    settings: {
      host: SERVER_HOST,
      port: SERVER_PORT,
      version: MINECRAFT_VERSION,
      memory: 4,
      selectedAccountId: ''
    },
    accounts: [],
    packRevision: null
  }
});

let mainWindow;
let gameProcess;
let launchInProgress = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 560,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    title: 'WWDIS — Солянка Minecraft',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function sendStatus(message, kind = 'info', progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const status = { message, kind };
    if (progress !== undefined) status.progress = progress;
    mainWindow.webContents.send('launcher:status', status);
  }
}

function configureAutoUpdates() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => {
    sendStatus('Проверяем обновления лаунчера…');
  });
  autoUpdater.on('update-available', (info) => {
    sendStatus(`Найдено обновление ${info.version}. Скачиваем…`);
  });
  autoUpdater.on('update-not-available', () => {
    sendStatus('Лаунчер обновлён до последней версии.');
  });
  autoUpdater.on('download-progress', (progress) => {
    sendStatus(`Обновление лаунчера: ${Math.floor(progress.percent)}%`);
  });
  autoUpdater.on('update-downloaded', () => {
    sendStatus('Обновление загружено и установится после закрытия лаунчера.', 'success');
  });
  const reportError = (error) => {
    sendStatus(`Не удалось обновить лаунчер: ${error.message}`, 'error');
  };
  autoUpdater.on('error', reportError);
  autoUpdater.checkForUpdates().catch(reportError);
}

function getAccounts() {
  return store.get('accounts', []).map(({ id, name, type }) => ({ id, name, type: type || 'microsoft' }));
}

function saveSettings(settings) {
  const { memory, selectedAccountId } = settings || {};
  const normalizedMemory = Number(memory);

  if (!Number.isInteger(normalizedMemory) || normalizedMemory < 2 || normalizedMemory > 32) {
    throw new Error('Кастрюля должна получить от 2 до 32 ГБ подливки.');
  }
  const next = {
    host: SERVER_HOST,
    port: SERVER_PORT,
    version: MINECRAFT_VERSION,
    memory: normalizedMemory,
    selectedAccountId: String(selectedAccountId || '')
  };
  store.set('settings', next);
  return next;
}

function createOfflineAuthorization(name) {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return {
    access_token: uuid,
    client_token: uuid,
    uuid,
    name,
    user_properties: '{}',
    meta: { type: 'mojang' }
  };
}

function createLocalAccount(name) {
  const normalizedName = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(normalizedName)) {
    throw new Error('Имя едока должно содержать 3–16 латинских букв, цифр или символов _.');
  }
  const accounts = store.get('accounts', []);
  if (accounts.some((account) => account.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error('Едок с таким именем уже сидит за столом.');
  }
  const account = { id: `local:${randomUUID()}`, name: normalizedName, type: 'offline' };
  accounts.push(account);
  store.set('accounts', accounts);
  const settings = store.get('settings');
  settings.selectedAccountId = account.id;
  store.set('settings', settings);
  return { accounts: getAccounts(), settings };
}

async function ensureNeoForge(gameDir, javaPath) {
  const profileJson = path.join(gameDir, 'versions', NEOFORGE_PROFILE, `${NEOFORGE_PROFILE}.json`);
  if (fs.existsSync(profileJson)) return;

  const installerDirectory = path.join(gameDir, 'installers');
  const installerPath = path.join(installerDirectory, `neoforge-${NEOFORGE_VERSION}-installer.jar`);
  const checksumResponse = await fetch(`${NEOFORGE_INSTALLER_URL}.sha1`, {
    signal: AbortSignal.timeout(30000)
  });
  if (!checksumResponse.ok) {
    throw new Error(`Не удалось получить контрольную приправу NeoForge (HTTP ${checksumResponse.status}).`);
  }
  const expectedSha1 = (await checksumResponse.text()).trim().match(/^[a-f0-9]{40}/i)?.[0].toLowerCase();
  if (!expectedSha1) throw new Error('Официальный Maven вернул неверную контрольную сумму NeoForge.');

  await fs.promises.mkdir(installerDirectory, { recursive: true });
  const currentSha1 = fs.existsSync(installerPath)
    ? createHash('sha1').update(fs.readFileSync(installerPath)).digest('hex')
    : '';
  if (currentSha1 !== expectedSha1) {
    sendStatus(`Скачиваем NeoForge ${NEOFORGE_VERSION}…`, 'info', null);
    const response = await fetch(NEOFORGE_INSTALLER_URL, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) {
      throw new Error(`NeoForge не доставили с официальной кухни (HTTP ${response.status}).`);
    }
    const temporaryPath = `${installerPath}.download`;
    try {
      const total = Number(response.headers.get('content-length')) || 0;
      const transferId = randomUUID();
      let received = 0;
      let lastPercent = -1;
      let lastProgressAt = 0;
      const progressStream = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null;
          const now = Date.now();
          if (percent !== lastPercent || now - lastProgressAt >= 500) {
            lastPercent = percent;
            lastProgressAt = now;
            sendStatus(
              percent === null ? `NeoForge: ${received} байт` : `NeoForge: ${percent}%`,
              'info',
              { transferId, receivedBytes: received, totalBytes: total || null, percent }
            );
          }
          callback(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(temporaryPath));
      const downloadedSha1 = createHash('sha1').update(fs.readFileSync(temporaryPath)).digest('hex');
      if (downloadedSha1 !== expectedSha1) {
        throw new Error('Контрольная сумма установщика NeoForge не совпала. Повтори доставку.');
      }
      await fs.promises.rename(temporaryPath, installerPath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  sendStatus(`Ставим NeoForge ${NEOFORGE_VERSION} в кастрюлю…`, 'info', null);
  try {
    const launcherProfilesPath = path.join(gameDir, 'launcher_profiles.json');
    const microsoftLauncherProfilesPath = path.join(gameDir, 'launcher_profiles_microsoft_store.json');
    if (!fs.existsSync(launcherProfilesPath) && !fs.existsSync(microsoftLauncherProfilesPath)) {
      await fs.promises.writeFile(
        launcherProfilesPath,
        JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2)
      );
    }

    await execFileAsync(javaPath, ['-jar', installerPath, '--installClient', gameDir], {
      windowsHide: true,
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    const details = output || error.message;
    const exitCode = typeof error.code === 'number' ? ` (код ${error.code})` : '';
    throw new Error(`Не удалось установить NeoForge${exitCode}: ${details.slice(-6000)}`);
  }
  if (!fs.existsSync(profileJson)) {
    throw new Error(`NeoForge не создал профиль ${NEOFORGE_PROFILE}. Проверь Java и повтори установку.`);
  }
}

function getNeoForgeJvmArguments(gameDir) {
  const profilePath = path.join(gameDir, 'versions', NEOFORGE_PROFILE, `${NEOFORGE_PROFILE}.json`);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const jvmArguments = profile.arguments && profile.arguments.jvm;
  if (!Array.isArray(jvmArguments) || jvmArguments.length === 0) {
    throw new Error('В профиле NeoForge отсутствуют параметры запуска Java.');
  }

  const placeholders = {
    library_directory: path.join(gameDir, 'libraries'),
    classpath_separator: path.delimiter,
    version_name: NEOFORGE_PROFILE
  };
  return jvmArguments.map((argument) => {
    if (typeof argument !== 'string') {
      throw new Error('Профиль NeoForge содержит неверный параметр запуска Java.');
    }
    return argument.replace(/\$\{([^}]+)\}/g, (placeholder, name) => {
      if (!Object.prototype.hasOwnProperty.call(placeholders, name)) {
        throw new Error(`Неизвестный параметр профиля NeoForge: ${placeholder}`);
      }
      return placeholders[name];
    });
  });
}

async function loginMicrosoft() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows спрятал кухонный шкафчик. Перезапусти лаунчер в обычном режиме.');
  }
  sendStatus('Ждём официанта из Microsoft…');
  const xbox = await new Auth('select_account').launch('raw');
  const minecraft = await xbox.getMinecraft();
  if (!minecraft || !minecraft.profile || !minecraft.profile.id || !minecraft.profile.name) {
    throw new Error('У этого аккаунта нет тарелки Minecraft Java Edition.');
  }

  const account = {
    id: minecraft.profile.id,
    name: minecraft.profile.name,
    encryptedToken: safeStorage.encryptString(xbox.save()).toString('base64')
  };
  const accounts = store.get('accounts', []);
  const existingIndex = accounts.findIndex((entry) => entry.id === account.id);
  if (existingIndex >= 0) accounts[existingIndex] = account;
  else accounts.push(account);
  store.set('accounts', accounts);

  const settings = store.get('settings');
  settings.selectedAccountId = account.id;
  store.set('settings', settings);
  return { accounts: getAccounts(), settings };
}

async function inspectJava(executable) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['-version'], { windowsHide: true });
    const output = `${stderr || ''}${stdout || ''}`;
    const match = output.match(/version "(?:1\.)?(\d+)/i);
    return { available: true, version: match ? Number(match[1]) : null };
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, version: null };
    throw new Error(`Не удалось проверить кастрюлю Java: ${error.message}`);
  }
}

async function detectJava() {
  return inspectJava('java');
}

async function findJavaExecutable(directory, depth = 0) {
  const executable = path.join(directory, 'bin', 'java.exe');
  if (fs.existsSync(executable)) return executable;
  if (depth >= 2) return null;

  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findJavaExecutable(path.join(directory, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function ensureJava(gameDir) {
  const systemJava = await detectJava();
  if (systemJava.available && systemJava.version !== null && systemJava.version >= 21) return 'java';
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Автоматическая подготовка Java 21 доступна для Windows x64.');
  }

  const runtimeDirectory = path.join(gameDir, 'runtime', 'temurin-21');
  const managedJavaPath = path.join(runtimeDirectory, 'bin', 'java.exe');
  const managedJava = await inspectJava(managedJavaPath);
  if (managedJava.available && managedJava.version !== null && managedJava.version >= 21) {
    return managedJavaPath;
  }

  sendStatus('Готовим Java 21 для Minecraft — скачиваем официальный Temurin…', 'info', null);
  const metadataResponse = await net.fetch(TEMURIN_API_URL, { signal: AbortSignal.timeout(30000) });
  if (!metadataResponse.ok) {
    throw new Error(`Не удалось получить Java 21 с Adoptium (HTTP ${metadataResponse.status}).`);
  }
  const assets = await metadataResponse.json();
  const javaPackage = Array.isArray(assets) ? assets[0]?.binary?.package : null;
  if (!javaPackage || !/^[a-f0-9]{64}$/i.test(javaPackage.checksum || '') || !javaPackage.link || !javaPackage.name) {
    throw new Error('Adoptium вернул неполные данные дистрибутива Java 21.');
  }

  const downloadUrl = new URL(javaPackage.link);
  if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'github.com') {
    throw new Error('Adoptium вернул небезопасную ссылку на дистрибутив Java 21.');
  }

  const runtimeParent = path.dirname(runtimeDirectory);
  const stagingDirectory = path.join(runtimeParent, `.temurin-21-${randomUUID()}`);
  const extractionDirectory = path.join(stagingDirectory, 'extracted');
  const archivePath = path.join(stagingDirectory, path.basename(javaPackage.name));
  await fs.promises.mkdir(extractionDirectory, { recursive: true });

  try {
    const downloadResponse = await net.fetch(downloadUrl, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!downloadResponse.ok || !downloadResponse.body) {
      throw new Error(`Не удалось скачать Java 21 (HTTP ${downloadResponse.status}).`);
    }

    const checksum = createHash('sha256');
    const total = Number(downloadResponse.headers.get('content-length')) || javaPackage.size || 0;
    const transferId = randomUUID();
    let received = 0;
    let lastPercent = -1;
    const checksumStream = new Transform({
      transform(chunk, _encoding, callback) {
        checksum.update(chunk);
        received += chunk.length;
        if (total > 0) {
          const percent = Math.min(100, Math.floor((received / total) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            sendStatus(`Java 21 загружается: ${percent}%`, 'info', {
              transferId,
              receivedBytes: received,
              totalBytes: total,
              percent
            });
          }
        }
        callback(null, chunk);
      }
    });
    await pipeline(
      Readable.fromWeb(downloadResponse.body),
      checksumStream,
      fs.createWriteStream(archivePath)
    );
    if (checksum.digest('hex') !== javaPackage.checksum.toLowerCase()) {
      throw new Error('Контрольная сумма Java 21 не совпала. Повтори загрузку.');
    }

    sendStatus('Распаковываем Java 21…', 'info', null);
    await extractZip(archivePath, { dir: extractionDirectory });
    const extractedJavaPath = await findJavaExecutable(extractionDirectory);
    if (!extractedJavaPath) throw new Error('В архиве Java 21 не найден java.exe.');

    await fs.promises.rm(runtimeDirectory, { recursive: true, force: true });
    await fs.promises.rename(extractionDirectory, runtimeDirectory);
    const installedJavaPath = path.join(runtimeDirectory, path.relative(extractionDirectory, extractedJavaPath));
    const installedJava = await inspectJava(installedJavaPath);
    if (!installedJava.available || installedJava.version === null || installedJava.version < 21) {
      throw new Error('Установленная Java не прошла проверку версии 21.');
    }
    sendStatus('Java 21 готова к подаче.', 'success');
    return installedJavaPath;
  } finally {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function launchGame(settings) {
  if (launchInProgress || gameProcess) throw new Error('Кастрюля уже кипит — суп уже идёт.');
  launchInProgress = true;
  try {
    const saved = saveSettings(settings);
    const accounts = store.get('accounts', []);
    const account = accounts.find((entry) => entry.id === saved.selectedAccountId);
    if (!account) throw new Error('Добавь имя едока за столом и выбери его перед запуском.');

    const totalMemoryGb = Math.floor(os.totalmem() / (1024 ** 3));
    const memoryLimit = totalMemoryGb - 1;
    if (saved.memory > memoryLimit) {
      throw new Error(`Для спокойной кухни выдели не больше ${Math.max(0, memoryLimit)} ГБ из ${totalMemoryGb} ГБ.`);
    }

    const gameDir = path.join(app.getPath('userData'), 'minecraft');
    const javaPath = await ensureJava(gameDir);
    sendStatus('Нарезаем ингредиенты и готовим файлы игры…', 'info', null);
    let authorization;
    if (account.type === 'offline') {
      authorization = createOfflineAuthorization(account.name);
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Не удалось открыть кухонный шкафчик аккаунта Windows.');
      }
      const token = safeStorage.decryptString(Buffer.from(account.encryptedToken, 'base64'));
      const xbox = await new Auth('select_account').refresh(token);
      account.encryptedToken = safeStorage.encryptString(xbox.save()).toString('base64');
      const accountIndex = accounts.findIndex((entry) => entry.id === account.id);
      if (accountIndex >= 0) {
        accounts[accountIndex] = account;
        store.set('accounts', accounts);
      }
      authorization = (await xbox.getMinecraft()).mclc();
    }
    const launcher = new Client();
    const launchTransferId = randomUUID();

    launcher.on('debug', (message) => sendStatus(String(message).slice(-500)));
    launcher.on('data', (message) => sendStatus(String(message).slice(-500)));
    launcher.on('progress', (progress) => {
      const percent = progress.total ? Math.round((progress.task / progress.total) * 100) : 0;
      sendStatus(`Подлива загружается: ${percent}%`, 'info', { percent });
    });
    launcher.on('download-status', ({ name, current, total }) => {
      if (total > 0) {
        const percent = Math.round((current / total) * 100);
        sendStatus(`Наливаем ${name}: ${percent}%`, 'info', {
          transferId: `${launchTransferId}:${name}`,
          receivedBytes: current,
          totalBytes: total,
          percent
        });
      }
    });

    const packRevision = await syncDrivePack(gameDir, store.get('packRevision'), sendStatus);
    store.set('packRevision', packRevision);
    await ensureNeoForge(gameDir, javaPath);
    const neoForgeJvmArguments = getNeoForgeJvmArguments(gameDir);
    gameProcess = await launcher.launch({
      authorization,
      root: gameDir,
      version: { number: MINECRAFT_VERSION, type: 'release', custom: NEOFORGE_PROFILE },
      memory: { min: '1G', max: `${saved.memory}G` },
      javaPath,
      customArgs: neoForgeJvmArguments,
      quickPlay: { type: 'multiplayer', identifier: `${saved.host}:${saved.port}` }
    });
    if (!gameProcess) {
      throw new Error('Суп не закипел. Проверь интернет и записи повара.');
    }
    gameProcess.once('exit', (code) => {
      gameProcess = null;
      sendStatus(code === 0 ? 'Кастрюля закрыта.' : `Суп выключен с кодом ${code}.`, code === 0 ? 'info' : 'error');
    });
    sendStatus('Солянка готова. Прыгаем к серверу…', 'success');
  } catch (error) {
    gameProcess = null;
    throw error;
  } finally {
    launchInProgress = false;
  }
}

function registerHandlers() {
  ipcMain.handle('settings:load', () => ({
    settings: saveSettings(store.get('settings')),
    accounts: getAccounts()
  }));
  ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings));
  ipcMain.handle('account:login', loginMicrosoft);
  ipcMain.handle('account:create-local', (_event, name) => createLocalAccount(name));
  ipcMain.handle('game:launch', (_event, settings) => launchGame(settings));
  ipcMain.handle('java:check', detectJava);
  ipcMain.handle('account:remove', (_event, id) => {
    const accounts = store.get('accounts', []).filter((entry) => entry.id !== id);
    store.set('accounts', accounts);
    const settings = store.get('settings');
    if (settings.selectedAccountId === id) settings.selectedAccountId = '';
    store.set('settings', settings);
    return { accounts: getAccounts(), settings };
  });
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  configureAutoUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
