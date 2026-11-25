const hostInput = document.getElementById('host');
const portInput = document.getElementById('port');
const accountSelect = document.getElementById('account');
const memoryInput = document.getElementById('memory');
const nicknameInput = document.getElementById('nickname');
const launchButton = document.getElementById('launch');
const statusLabel = document.getElementById('status');
const statusDot = document.getElementById('status-dot');
const progressRow = document.getElementById('progress-row');
const progressTrack = document.getElementById('progress-track');
const progressFill = document.getElementById('progress-fill');
const progressValue = document.getElementById('progress-value');

let accounts = [];
let lastTransferSample = null;

function updateLaunchProgress(progress) {
  if (!launchButton.disabled) {
    progressRow.hidden = true;
    lastTransferSample = null;
    return;
  }
  progressRow.hidden = false;
  if (progress === null) lastTransferSample = null;
  const receivedBytes = progress && Number.isFinite(progress.receivedBytes)
    ? progress.receivedBytes
    : null;
  const totalBytes = progress && Number.isFinite(progress.totalBytes) && progress.totalBytes > 0
    ? progress.totalBytes
    : null;
  let percent = progress && Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(100, Math.round(progress.percent)))
    : null;

  if (receivedBytes !== null && totalBytes !== null) {
    percent = Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100)));
  }
  if (percent === null) {
    progressFill.classList.add('indeterminate');
    progressFill.style.removeProperty('width');
    progressTrack.removeAttribute('aria-valuenow');
  } else {
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = `${percent}%`;
    progressTrack.setAttribute('aria-valuenow', String(percent));
  }

  if (receivedBytes !== null) {
    const now = performance.now();
    const transferId = progress.transferId || 'current-transfer';
    let speed = null;
    if (lastTransferSample && lastTransferSample.transferId === transferId) {
      const elapsed = (now - lastTransferSample.time) / 1000;
      const delta = receivedBytes - lastTransferSample.receivedBytes;
      if (delta < 0) {
        lastTransferSample = null;
      } else if (elapsed >= 0.5) {
        const instantSpeed = delta / elapsed;
        speed = lastTransferSample.speed === null
          ? instantSpeed
          : lastTransferSample.speed * 0.65 + instantSpeed * 0.35;
        lastTransferSample = { transferId, receivedBytes, time: now, speed };
      } else {
        speed = lastTransferSample.speed;
      }
    } else {
      lastTransferSample = { transferId, receivedBytes, time: now, speed: null };
    }

    const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
    const total = totalBytes === null ? '—' : megabytes(totalBytes);
    const rate = speed === null ? '…' : `${(speed / (1024 * 1024)).toFixed(2)} МБ/с`;
    progressValue.textContent = `${percent === null ? '' : `${percent}% · `}${megabytes(receivedBytes)} из ${total} · ${rate}`;
  } else if (percent !== null) {
    progressValue.textContent = `${percent}% · этап загрузки`;
  } else {
    progressValue.textContent = '…';
  }
}

function showStatus(message, kind = 'info') {
  statusLabel.textContent = message;
  statusDot.className = `status-dot${kind === 'success' ? ' success' : kind === 'error' ? ' error' : ''}`;
}

function renderAccounts(selectedId = '') {
  accountSelect.replaceChildren();
  if (!accounts.length) {
    accountSelect.add(new Option('Сначала добавь едока в меню', ''));
  } else {
    for (const account of accounts) {
      const label = account.type === 'offline' ? `${account.name} · ДОМАШНИЙ` : `${account.name} · MICROSOFT`;
      accountSelect.add(new Option(label, account.id));
    }
    accountSelect.value = selectedId || accounts[0].id;
  }
  document.getElementById('remove-account').disabled = !accountSelect.value;
}

function getFormSettings() {
  return {
    host: hostInput.value,
    port: portInput.value,
    version: '1.21.1',
    memory: memoryInput.value,
    selectedAccountId: accountSelect.value
  };
}

async function saveForm() {
  const saved = await window.launcher.saveSettings(getFormSettings());
  return saved;
}

document.getElementById('create-local').addEventListener('click', async () => {
  const button = document.getElementById('create-local');
  button.disabled = true;
  try {
    const result = await window.launcher.createLocalAccount(nicknameInput.value);
    accounts = result.accounts;
    renderAccounts(result.settings.selectedAccountId);
    nicknameInput.value = '';
    showStatus(`${accountSelect.selectedOptions[0].text.split(' · ')[0]} занял место за столом.`, 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

nicknameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('create-local').click();
});

document.getElementById('add-account').addEventListener('click', async () => {
  const button = document.getElementById('add-account');
  button.disabled = true;
  showStatus('Ждём подтверждение у входа в Microsoft…');
  try {
    const result = await window.launcher.loginMicrosoft();
    accounts = result.accounts;
    renderAccounts(result.settings.selectedAccountId);
    showStatus(`Едок допущен: ${accountSelect.selectedOptions[0].text}`, 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('remove-account').addEventListener('click', async () => {
  if (!accountSelect.value) return;
  const result = await window.launcher.removeAccount(accountSelect.value);
  accounts = result.accounts;
  renderAccounts(result.settings.selectedAccountId);
  showStatus('Едок убран из меню.');
});

accountSelect.addEventListener('change', () => {
  document.getElementById('remove-account').disabled = !accountSelect.value;
  saveForm().catch((error) => showStatus(error.message, 'error'));
});

memoryInput.addEventListener('change', () => saveForm().catch((error) => showStatus(error.message, 'error')));

launchButton.addEventListener('click', async () => {
  launchButton.disabled = true;
  updateLaunchProgress(null);
  showStatus('Наливаем бульон и варим сборку…');
  try {
    await window.launcher.launchGame(getFormSettings());
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    launchButton.disabled = false;
    updateLaunchProgress();
  }
});

window.launcher.onStatus(({ message, kind, progress }) => {
  showStatus(message, kind);
  if (progress !== undefined) updateLaunchProgress(progress);
});

async function initialize() {
  try {
    const saved = await window.launcher.loadSettings();
    const settings = saved.settings;
    hostInput.value = settings.host;
    portInput.value = settings.port;
    memoryInput.value = settings.memory || 4;
    accounts = saved.accounts;
    renderAccounts(settings.selectedAccountId);
    const java = await window.launcher.checkJava();
    if (!java.available || java.version === null || java.version < 21) {
      showStatus('Java 21 будет автоматически приготовлена при запуске.', 'info');
    } else {
      showStatus('Кастрюля готова. Сервер закреплён — выбери едока.', 'success');
    }
  } catch (error) {
    showStatus(`Рецепт не загрузился: ${error.message}`, 'error');
    launchButton.disabled = true;
  }
}

initialize();
