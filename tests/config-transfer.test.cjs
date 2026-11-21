const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../config-transfer.js'), 'utf8'), ctx);
const file = () => ({
  format: 'fb-fanpage-auto-settings', version: 1,
  settings: {
    commentTemplates: ['Xin chào ❤️\nDòng 2', 'Mẫu 🎉'], requireExistingComment: true,
    requirePositiveComments: false, blockImages: false, blockVideos: true,
    reloadDelaySec: 0.1, commentCountDelaySec: 1.5, postLimit: 2,
    targetMode: 'custom', customPosts: '0,1-3',
    peakConfig: { enabled: true, hours: '8, 10,12', durationMin: 1, reloadDelaySec: 0.05,
      backupDurationMin: 2, backupReloadDelaySec: 3, successPostTarget: 1 },
    quietHoursConfig: { enabled: true, startTime: '22:00', endTime: '07:00', reloadDelaySec: 1800 },
  },
});
test('settings round trip preserves all options, fractions and Unicode', () => {
  const source = file();
  const result = ctx.validateConfigFile(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ...source.settings, commentText: source.settings.commentTemplates[0] });
});
test('runtime and history fields cannot be imported', () => {
  const source = file();
  Object.assign(source.settings, { isRunning: true, automationTabId: 4, logs: ['x'], processedPostHistory: {} });
  const result = ctx.validateConfigFile(source);
  for (const key of ['isRunning', 'automationTabId', 'logs', 'processedPostHistory']) assert.equal(key in result, false);
});
test('invalid files are rejected before applying settings', () => {
  for (const mutate of [
    x => x.version = 2, x => x.settings.reloadDelaySec = -1,
    x => x.settings.blockImages = 'true', x => x.settings.quietHoursConfig.startTime = '25:00',
    x => x.settings.peakConfig.hours = '24', x => x.settings.commentTemplates = [123],
  ]) { const source = file(); mutate(source); assert.throws(() => ctx.validateConfigFile(source)); }
});
