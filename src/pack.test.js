const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDriveModFiles, parseDriveRevision } = require('./pack');

const rootId = '1Q8xr_oCzV0q8il_i3JMUAciDi3o8NPMb';
const modsId = '1Sa9DkMiTY6m68Qa7698g4SqiSjUaeACb';
const configId = '1Zjz27Bq5_klv75RBWYNF3aysQO_2hl6H';

function createDriveListing(entries) {
  const serialized = JSON.stringify([entries]);
  return `<script>window['_DRIVE_ivd'] = '${serialized}';</script>`;
}

function createEntry(id, name, mimeType, modified, size) {
  const entry = [];
  entry[0] = id;
  entry[1] = [rootId];
  entry[2] = name;
  entry[3] = mimeType;
  entry[9] = modified;
  entry[13] = size;
  return entry;
}

test('reads mod folder and config archive revisions from Drive metadata', () => {
  const html = createDriveListing([
    createEntry(modsId, 'mods', 'application/vnd.google-apps.folder', 1234, null),
    createEntry(configId, 'config.zip', 'application/x-zip-compressed', 5678, 218281009)
  ]);

  assert.deepEqual(parseDriveRevision(html), {
    mods: { modified: 1234, size: null },
    config: { modified: 5678, size: 218281009 }
  });
});

test('rejects a Drive folder without the expected pack files', () => {
  const html = createDriveListing([
    createEntry(modsId, 'mods', 'application/vnd.google-apps.folder', 1234, null)
  ]);

  assert.throws(() => parseDriveRevision(html), /не найдены папка mods и архив config\.zip/);
});

test('keeps unique JAR files from the Drive folder listing', () => {
  assert.deepEqual(parseDriveModFiles([
    { id: 'mod-1', name: 'example.jar' },
    { id: 'readme', name: 'readme.txt' },
    { id: 'mod-1', name: 'duplicate-id.jar' },
    { id: 'mod-2', name: 'example.jar' }
  ]), [
    { id: 'mod-1', name: 'example.jar' },
    { id: 'mod-2', name: 'example-mod-2.jar' }
  ]);
});

test('rejects a Drive folder listing without JAR files', () => {
  assert.throws(() => parseDriveModFiles([{ id: 'notes', name: 'readme.txt' }]), /не найдено ни одного файла \.jar/);
});
