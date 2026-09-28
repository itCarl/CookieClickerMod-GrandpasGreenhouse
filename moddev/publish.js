// Workshop publish for Cookie Clicker mods, bypassing the broken in-game flow.
//
// The in-game publish (start.js 'publish mod') fails for every mod with
// "Error on sharing file on Steam cloud.": the Steam Cloud entry `thumbnail.png`
// is unshareable, and every mod's publish writes its thumbnail under that same
// cloud name. This script uploads the thumbnail under a per-mod cloud name
// instead, then runs the exact same greenworks update call the game uses
// (start.js:339, ugcPublishUpdate with empty title/description - page text is
// never touched by an update, edit it by hand on the Workshop page).
//
// Usage (PowerShell):
//   $env:ELECTRON_RUN_AS_NODE='1'
//   Start-Process -FilePath "C:\Program Files (x86)\Steam\steamapps\common\Cookie Clicker\Cookie Clicker.exe" `
//     -ArgumentList '"<this file>" <ModFolder> <WorkshopItemId>' `
//     -WorkingDirectory "C:\Program Files (x86)\Steam\steamapps\common\Cookie Clicker\resources\app\greenworks" `
//     -RedirectStandardOutput out.txt -RedirectStandardError err.txt -Wait -NoNewWindow
//
// Must run through the game's own Electron binary (ELECTRON_RUN_AS_NODE=1) so
// greenworks-win64.node loads with the right ABI, and with the greenworks folder
// as working directory so steam_appid.txt (1454400) is found. Steam must be
// running. Works while the game is open.
//
// Known item ids: GrandpasGreenhouse 3792850996, QuantBroker 3786776073.

const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = 'C:/Program Files (x86)/Steam/steamapps/common/Cookie Clicker/resources/app';
const modName = process.argv[2];
const itemId = process.argv[3]; // numeric id = update existing item, 'new' = first publish
const isNew = itemId === 'new';
if (!modName || (!isNew && !/^\d+$/.test(itemId || ''))) {
  console.error('usage: publish.js <ModFolderName under mods/local> <WorkshopItemId|new>');
  process.exit(1);
}

const MOD_PATH = APP + '/mods/local/' + modName;
if (!fs.existsSync(MOD_PATH + '/info.txt')) {
  console.error('no info.txt at', MOD_PATH);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpub-'));
const ZIP_PATH = path.join(tmp, modName + '_upload.zip');
const THUMB = path.join(tmp, modName + '_thumbnail.png'); // per-mod cloud name, never 'thumbnail.png'

const AdmZip = require(APP + '/node_modules/adm-zip');
let greenworks = require(APP + '/greenworks/greenworks');
if (!greenworks.init()) { console.error('FATAL: greenworks.init() failed - is Steam running?'); process.exit(1); }
console.log('Steam connected, user:', greenworks.getSteamId().steamId);

const zip = new AdmZip();
zip.addLocalFolder(MOD_PATH);
zip.writeZip(ZIP_PATH);
console.log('zipped', MOD_PATH, '->', fs.statSync(ZIP_PATH).size, 'bytes');

let hasThumb = false;
const srcThumb = MOD_PATH + '/thumbnail.png';
if (fs.existsSync(srcThumb) && fs.statSync(srcThumb).size / (1024 * 1024) < 1) {
  fs.copyFileSync(srcThumb, THUMB);
  hasThumb = true;
} else {
  console.log('no usable thumbnail (missing or >= 1 MB) - updating file only');
}

const bail = setTimeout(() => { console.error('TIMEOUT after 180s'); process.exit(2); }, 180000);
const fail = (step) => (err) => {
  clearTimeout(bail);
  console.error('FAIL at', step, ':', err && err.message ? err.message : err);
  process.exit(1);
};
const update = () => {
  if (isNew) {
    const info = JSON.parse(fs.readFileSync(MOD_PATH + '/info.txt', 'utf8'));
    greenworks.publishWorkshopFile(ZIP_PATH, hasThumb ? THUMB : '', info.Name, info.Description,
      (publishedId) => { clearTimeout(bail); console.log('FIRST PUBLISH: SUCCESS, new item id: ' + publishedId); process.exit(0); },
      fail('publishWorkshopFile'));
    return;
  }
  greenworks.updatePublishedWorkshopFile(itemId, ZIP_PATH, hasThumb ? THUMB : '', '', '',
    () => { clearTimeout(bail); console.log('UPDATE PUBLISHED: SUCCESS (item ' + itemId + ')'); process.exit(0); },
    fail('updatePublishedWorkshopFile'));
};

const files = hasThumb ? [ZIP_PATH, THUMB] : [ZIP_PATH];
greenworks.saveFilesToCloud(files, () => {
  console.log('cloud save OK');
  greenworks.fileShare(ZIP_PATH, () => {
    console.log('zip shared');
    if (!hasThumb) return update();
    greenworks.fileShare(THUMB, () => { console.log('thumbnail shared'); update(); }, fail('fileShare thumbnail'));
  }, fail('fileShare zip'));
}, fail('saveFilesToCloud'));
