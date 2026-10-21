'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const event = () => {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
};

function background(initial = {}) {
  const state = { ...initial };
  const sessionRules = new Map();
  const intervals = new Map();
  const alarms = new Map();
  const onChanged = event();
  const tabs = new Map([[7, { id: 7, autoDiscardable: true }], [8, { id: 8, autoDiscardable: true }]]);
  const chrome = {
    storage: { onChanged, local: {
      get(keys, callback) {
        const result = Object.fromEntries(keys.filter(key => key in state).map(key => [key, state[key]]));
        if (callback) callback(result);
        return Promise.resolve(result);
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          const oldValue = state[key]; state[key] = value;
          if (oldValue !== value) changes[key] = { oldValue, newValue: value };
        }
        onChanged.emit(changes, 'local');
      },
      async remove(key) { delete state[key]; },
    } },
    declarativeNetRequest: {
      async updateDynamicRules(options) { assert.equal(options.addRules, undefined, 'tab rules must not use dynamic rules'); },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        for (const id of removeRuleIds) sessionRules.delete(id);
        for (const rule of addRules) sessionRules.set(rule.id, rule);
      },
    },
    tabs: {
      onRemoved: event(),
      async get(id) { if (!tabs.has(id)) throw Error('No tab'); return { ...tabs.get(id) }; },
      async update(id, values) { if (!tabs.has(id)) throw Error('No tab'); Object.assign(tabs.get(id), values); },
    },
    alarms: {
      onAlarm: event(), async get(name) { return alarms.get(name); },
      async create(name, options) { alarms.set(name, options); }, async clear(name) { alarms.delete(name); },
    },
    runtime: { onMessage: event(), onInstalled: event() },
  };
  let timerId = 0;
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout,
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
  });
  vm.runInContext(read('background.js'), ctx);
  const sync = async () => {
    await ctx.syncResourceBlocking(); await ctx.syncBackgroundGuard();
    await ctx.syncResourceBlocking(); await ctx.syncBackgroundGuard();
  };
  return { ctx, chrome, state, sessionRules, tabs, intervals, alarms, sync };
}

function content() {
  const math = Object.create(Math);
  math.random = () => 0;
  const chrome = {
    storage: { onChanged: event(), local: { set() {}, get(keys, cb) { cb({ originalUrl: 'https://www.facebook.com/test' }); } } },
    runtime: { onMessage: event(), sendMessage(message, cb) { if (cb) cb({ shouldRun: false }); } },
  };
  const ctx = vm.createContext({
    chrome, console, Math: math, Date, AbortController, navigator: {},
    window: { location: { href: 'https://www.facebook.com/test' } },
    document: {}, setTimeout, clearTimeout,
  });
  vm.runInContext(read('content.js'), ctx);
  vm.runInContext('startLoop = async () => {}; logEntry = () => {};', ctx);
  return ctx;
}

function matches(rule, { url, type, tabId = 7 }) {
  const condition = rule.condition;
  const host = new URL(url).hostname;
  const inDomains = domains => domains.some(domain => host === domain || host.endsWith('.' + domain));
  return condition.tabIds.includes(tabId) && condition.resourceTypes.includes(type) &&
    (!condition.requestDomains || inDomains(condition.requestDomains)) &&
    (!condition.excludedRequestDomains || !inDomains(condition.excludedRequestDomains)) &&
    (!condition.regexFilter || new RegExp(condition.regexFilter, 'i').test(url));
}

test('random templates preserve Unicode and remain the same for retries of a post', () => {
  const ctx = content();
  ctx.startAutomation({ commentTemplates: ['  Xin chào ❤️ ', '', 'Chúc mừng 🎉\nCố lên 💪'], reloadDelaySec: 0 });
  assert.equal(ctx.getCommentForPost('post-1'), 'Xin chào ❤️');
  ctx.Math.random = () => 0.999;
  assert.equal(ctx.getCommentForPost('post-1'), 'Xin chào ❤️');
  assert.equal(ctx.getCommentForPost('post-2'), 'Chúc mừng 🎉\nCố lên 💪');
  assert.equal(vm.runInContext('reloadDelaySec', ctx), 0);
});

test('legacy single comment survives migration and a new run resets random choices', () => {
  const ctx = content();
  ctx.startAutomation({ commentText: 'Nội dung cũ 🥰\nDòng thứ hai' });
  assert.equal(ctx.getCommentForPost('post-1'), 'Nội dung cũ 🥰\nDòng thứ hai');
  ctx.stopAutomation();
  ctx.startAutomation({ commentTemplates: ['Nội dung mới 👍'] });
  assert.equal(ctx.getCommentForPost('post-1'), 'Nội dung mới 👍');
});

test('zero and fractional delays survive content start messages and peak scheduling', () => {
  const ctx = content();
  const listener = ctx.chrome.runtime.onMessage.listeners[0];
  listener({ type: 'START_AUTOMATION', commentTemplates: ['A', 'B'], reloadDelaySec: 0,
    peakConfig: { enabled: true, hours: String(new Date().getHours()), durationMin: 60, reloadDelaySec: 0.5 } }, {}, () => {});
  assert.equal(vm.runInContext('reloadDelaySec', ctx), 0);
  assert.equal(ctx.getReloadScheduleInfo().currentDelay, 0.5);
  vm.runInContext('peakConfig.reloadDelaySec = 0', ctx);
  assert.equal(ctx.getReloadScheduleInfo().currentDelay, 0);
  for (const [value, expected] of [[0, 0], ['0', 0], ['0.5', 0.5], [1, 1], [4, 4], [-1, 0], ['', 30], [undefined, 30], ['oops', 30]]) {
    assert.equal(ctx.parseReloadDelay(value, 30), expected);
  }
});

test('countdown respects a fractional delay and allows zero without adding a second', async () => {
  for (const delay of [0, 0.5, 1.5]) {
    const ctx = content();
    ctx.testDelay = delay;
    vm.runInContext(`
      automationRunning = true; targetIndices = [0]; reloadDelaySec = testDelay;
      peakConfig.enabled = false; processedPostLinks.add('post');
      document.querySelector = () => ({}); findPostElement = async () => ({});
      getPostLink = () => 'post'; processPost = async () => {};
      var delays = []; sleep = async ms => { delays.push(ms); };
    `, ctx);
    await ctx.runCycle();
    const countdown = vm.runInContext('delays.slice(1)', ctx); // first wait is existing pause between posts
    assert.equal([...countdown].reduce((a, b) => a + b, 0), delay * 1000);
    assert.equal(ctx.window.location.href, 'https://www.facebook.com/test');
  }
});

function scanCycleContext(scenario = {}) {
  const ctx = content();
  ctx.scenario = scenario;
  vm.runInContext(`
    automationRunning = true; targetIndices = [0, 1]; reloadDelaySec = 2;
    peakConfig.enabled = false;
    var checkedPosts = [], cycleWaits = [], reloadRequests = 0;
    document.querySelector = () => ({});
    findPostElement = async (timeline, index) => scenario.missing === index ? null : { index };
    getPostLink = post => 'post-' + post.index;
    processPost = async (post, index) => {
      checkedPosts.push(index);
      if (scenario.failed !== index) processedPostLinks.add(getPostLink(post));
    };
    sleep = async ms => {
      cycleWaits.push(ms);
      if (scenario.stopDuringCountdown && ms === 1000) automationRunning = false;
    };
    chrome.storage.local.get = (keys, callback) => {
      reloadRequests++;
      callback({ originalUrl: 'https://www.facebook.com/test' });
    };
  `, ctx);
  return ctx;
}

test('first scan of two newly completed posts starts reload countdown immediately', async () => {
  const ctx = scanCycleContext();
  await ctx.runCycle();
  assert.deepEqual([...vm.runInContext('checkedPosts', ctx)], [0, 1]);
  assert.equal(vm.runInContext('reloadRequests', ctx), 1);
  assert.deepEqual([...vm.runInContext('cycleWaits', ctx)], [400, 400, 1000, 1000]);
});

test('scan does not reload while a post is missing or has failed', async () => {
  for (const scenario of [{ missing: 0 }, { failed: 0 }, { failed: 1 }]) {
    const ctx = scanCycleContext(scenario);
    await ctx.runCycle();
    assert.equal(vm.runInContext('reloadRequests', ctx), 0);
    assert.equal(vm.runInContext('cycleWaits.includes(1000)', ctx), false);
  }
});

test('stop during countdown after the first scan prevents reload', async () => {
  const ctx = scanCycleContext({ stopDuringCountdown: true });
  await ctx.runCycle();
  assert.equal(vm.runInContext('automationRunning', ctx), false);
  assert.equal(vm.runInContext('reloadRequests', ctx), 0);
});

test('all image/video toggle combinations only affect the automation tab', async () => {
  const b = background(); await b.sync();
  for (const blockImages of [true, false]) for (const blockVideos of [true, false]) {
    await b.chrome.storage.local.set({ isRunning: true, automationTabId: 7, blockImages, blockVideos });
    await b.sync();
    const blocked = request => [...b.sessionRules.values()].some(rule => matches(rule, request));
    assert.equal(blocked({ url: 'https://scontent.fsgn.fbcdn.net/v/photo.jpg', type: 'image' }), blockImages);
    assert.equal(blocked({ url: 'https://video.fsgn.fbcdn.net/v/clip.mp4', type: 'media' }), blockVideos);
    assert.equal(blocked({ url: 'https://video.fsgn.fbcdn.net/o1/clip?token=test', type: 'xmlhttprequest' }), blockVideos);
    assert.equal(blocked({ url: 'https://scontent.fsgn.fbcdn.net/clip.mp4?token=test', type: 'xmlhttprequest' }), blockVideos);
    assert.equal(blocked({ url: 'https://static.xx.fbcdn.net/images/emoji.png', type: 'image' }), false);
    assert.equal(blocked({ url: 'https://www.facebook.com/api/graphql/', type: 'xmlhttprequest' }), false);
    assert.equal(blocked({ url: 'https://scontent.fsgn.fbcdn.net/photo.jpg', type: 'image', tabId: 8 }), false);
  }
  await b.chrome.storage.local.set({ isRunning: false, automationTabId: null }); await b.sync();
  assert.equal(b.sessionRules.size, 0);
  assert.equal(b.intervals.size, 0);
  assert.equal(b.tabs.get(7).autoDiscardable, true);
});

test('worker initialization restores session rules and existing background protection', async () => {
  const b = background({ isRunning: true, automationTabId: 7, blockImages: false, blockVideos: true });
  await b.sync();
  assert.equal(b.sessionRules.size, 2);
  assert.equal(b.sessionRules.has(102), false);
  assert.equal(b.tabs.get(7).autoDiscardable, false);
  assert.equal(b.tabs.get(8).autoDiscardable, true);
  assert.equal(b.intervals.size, 1);
  assert.equal(b.alarms.size, 1);
});

test('background resume response preserves templates, emoji, and zero delay', async () => {
  const templates = ['Một 🥰', 'Hai 👍'];
  const b = background({ isRunning: true, automationTabId: 7, commentTemplates: templates, reloadDelaySec: 0 });
  await b.sync();
  const response = await new Promise(resolve => b.chrome.runtime.onMessage.listeners[0]({ type: 'CHECK_SHOULD_RUN' }, { tab: { id: 7 } }, resolve));
  assert.equal(response.shouldRun, true);
  assert.deepEqual(response.commentTemplates, templates);
  assert.equal(response.reloadDelaySec, 0);
});

test('updating extension preserves settings and migrates a legacy multiline comment as one template', async () => {
  const b = background({ commentText: 'Bình luận cũ ❤️\nDòng hai', reloadDelaySec: 0, blockImages: false });
  await b.chrome.runtime.onInstalled.listeners[0](); await b.sync();
  assert.equal(b.state.commentText, 'Bình luận cũ ❤️\nDòng hai');
  assert.deepEqual([...b.state.commentTemplates], ['Bình luận cũ ❤️\nDòng hai']);
  assert.equal(b.state.reloadDelaySec, 0);
  assert.equal(b.state.blockImages, false);
  assert.equal(b.state.blockVideos, true);
});
