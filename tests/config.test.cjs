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

function content(historyServer = null) {
  const math = Object.create(Math);
  math.random = () => 0;
  const chrome = {
    storage: { onChanged: historyServer?.chrome.storage.onChanged || event(), local: {
      set(values) { return historyServer ? historyServer.chrome.storage.local.set(values) : Promise.resolve(); },
      get(keys, cb) { cb({ originalUrl: 'https://www.facebook.com/test' }); },
    } },
    runtime: { onMessage: event(), sendMessage(message, cb) {
      if (/^(GET_PROCESSED_POSTS|MARK_POST_PROCESSED|CLEAR_PROCESSED_POSTS)$/.test(message.type)) {
        if (historyServer) historyServer.chrome.runtime.onMessage.listeners[0](message, { tab: { id: 7 } }, cb);
        else cb({ ok: true, history: { generation: 0, keys: [] } });
      } else if (cb) cb({ shouldRun: false });
    } },
  };
  const ctx = vm.createContext({
    chrome, console, Math: math, Date, URL, AbortController, navigator: {},
    window: { location: { href: 'https://www.facebook.com/test' } },
    document: {}, setTimeout, clearTimeout,
  });
  vm.runInContext(read('content.js'), ctx);
  vm.runInContext('startLoop = async () => {}; logEntry = () => {}; quietHoursConfig.enabled = false;', ctx);
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
      document.querySelector = () => ({ querySelectorAll: () => [{}] }); findPostElement = async () => ({});
      getPostLink = () => 'post'; processPost = async () => true;
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
    document.querySelector = () => ({ querySelectorAll: () => [{}] });
    findPostElement = async (timeline, index) => scenario.missing === index ? null : { index };
    getPostLink = post => 'post-' + post.index;
    processPost = async (post, index) => {
      checkedPosts.push(index);
      if (scenario.failed === index) return false;
      processedPostLinks.add(getPostLink(post));
      return true;
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

function timelineFinderContext(historyServer = null) {
  const ctx = content(historyServer);
  vm.runInContext(`
    automationRunning = true; targetIndices = [0, 1]; reloadDelaySec = 2;
    peakConfig.enabled = false;
    var finderScrolls = [], finderWaits = [], checkedTimelinePosts = [], finderReloads = 0;
    var timelinePosts = [0, 1].map(index => ({
      index,
      scrollIntoView() { finderScrolls.push(index); }
    }));
    var fakeTimeline = { querySelectorAll: () => timelinePosts };
    document.querySelector = () => fakeTimeline;
    window.scrollBy = () => { finderScrolls.push('window'); };
    sleep = async ms => { finderWaits.push(ms); };
    getPostLink = post => 'https://www.facebook.com/page/posts/' + (100 + post.index) + '/';
    processPost = async (post, index) => { checkedTimelinePosts.push(index); return true; };
    chrome.storage.local.get = (keys, callback) => { finderReloads++; callback({}); };
  `, ctx);
  return ctx;
}

test('actual finder returns the second visible post when scrolling is disabled', async () => {
  const ctx = timelineFinderContext();
  const found = await ctx.findPostElement(ctx.fakeTimeline, 1, false);
  assert.equal(found, ctx.timelinePosts[1]);
  assert.equal(ctx.finderScrolls.length, 0);
  assert.equal(ctx.finderWaits.length, 0);
});

test('actual finder still scrolls on request and returns null for a missing post', async () => {
  const ctx = timelineFinderContext();
  assert.equal(await ctx.findPostElement(ctx.fakeTimeline, 1, true), ctx.timelinePosts[1]);
  assert.deepEqual([...ctx.finderScrolls], [1]);
  assert.deepEqual([...ctx.finderWaits], [400]);
  assert.equal(await ctx.findPostElement(ctx.fakeTimeline, 2, false), null);
  assert.deepEqual([...ctx.finderScrolls], [1, 'window', 'window', 'window']);
});

test('scan uses the actual finder to process both visible posts and start countdown', async () => {
  const ctx = timelineFinderContext();
  await ctx.runCycle();
  assert.deepEqual([...ctx.checkedTimelinePosts], [0, 1]);
  assert.equal(ctx.finderReloads, 1);
  assert.equal(ctx.finderScrolls.length, 0);
  assert.deepEqual([...ctx.finderWaits], [400, 400, 1000, 1000]);
});

test('actual finder permits skipping stored visible posts without processing or scrolling', async () => {
  const server = background({ isRunning: true, automationTabId: 7,
    processedPostHistory: { generation: 0, keys: ['post:100', 'post:101'] } });
  const ctx = timelineFinderContext(server);
  await ctx.runCycle();
  assert.equal(ctx.checkedTimelinePosts.length, 0);
  assert.equal(ctx.finderScrolls.length, 0);
  assert.equal(ctx.finderReloads, 1);
  assert.deepEqual([...ctx.finderWaits], [1000, 1000]);
});

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

function handledPostContext(server, { link = 'https://www.facebook.com/page/posts/123/', success = true, liked = false } = {}) {
  const ctx = content(server);
  ctx.testPostLink = link;
  ctx.testCommentSuccess = success;
  ctx.testAlreadyLiked = liked;
  ctx.console = { ...console, log() {} };
  vm.runInContext(`
    automationRunning = true; targetIndices = [0]; reloadDelaySec = 0;
    commentTemplates = ['Nội dung thử ❤️']; peakConfig.enabled = false;
    var likeCalls = 0, commentCalls = 0, scrollCalls = 0, reloadRequests = 0;
    var fakePost = {
      scrollIntoView() { scrollCalls++; },
      querySelector() { return testAlreadyLiked ? {} : null; }
    };
    document.querySelector = () => ({ querySelectorAll: () => [{}] });
    findPostElement = async (timeline, index, shouldScroll) => {
      if (shouldScroll !== false) throw new Error('Cached lookup should not scroll');
      return fakePost;
    };
    getPostLink = () => testPostLink;
    findInlineCommentBox = () => ({});
    performLike = async () => { likeCalls++; return 0; };
    performCommentOnTextbox = async () => {
      commentCalls++;
      return { success: testCommentSuccess, elapsed: 1 };
    };
    sleep = async () => {};
    chrome.storage.local.get = (keys, callback) => { reloadRequests++; callback({}); };
  `, ctx);
  return ctx;
}

test('post keys normalize permalink variants and never use a feed position as identity', () => {
  const ctx = content();
  for (const link of [
    'https://www.facebook.com/page/posts/123/?comment_id=9&__cft__=tracking#anchor',
    'https://m.facebook.com/permalink.php?story_fbid=123&id=777',
    '/page/permalink/123/',
  ]) assert.equal(ctx.getPostKey(link), 'post:123');
  assert.equal(ctx.getPostKey('https://www.facebook.com/page/posts/pfbidABC123/'), 'post:pfbidABC123');
  assert.equal(ctx.getPostKey('https://www.facebook.com/page/videos/555/'), 'video:555');
  assert.equal(ctx.getPostKey('https://www.facebook.com/watch/?v=555'), 'video:555');
  assert.equal(ctx.getPostKey('https://www.facebook.com/photo.php?fbid=456&set=test'), 'photo:456');
  assert.equal(ctx.getPostKey('https://www.facebook.com/page/photos/a.123/456/?tracking=x'), 'photo:456');
  for (const link of ['TimelineFeedUnit_0', 'unknown', '/page/photos/a.123/', 'https://example.com/page/posts/123/']) {
    assert.equal(ctx.getPostKey(link), null);
  }
});

test('a post permalink takes precedence over embedded media links regardless of order', () => {
  const ctx = content();
  const photo = '/page/photos/a.111/456/';
  const permalink = '/page/posts/123/?comment_id=9';
  const post = links => ({
    querySelectorAll: () => links.map(href => ({ getAttribute: () => href })),
    getAttribute: () => 'TimelineFeedUnit_0',
  });
  assert.equal(ctx.getPostKey(ctx.getPostLink(post([photo, permalink]))), 'post:123');
  assert.equal(ctx.getPostKey(ctx.getPostLink(post([permalink, photo]))), 'post:123');
  assert.equal(ctx.getPostKey(ctx.getPostLink(post([photo]))), 'photo:456');
  assert.equal(ctx.getPostKey(ctx.getPostLink(post([]))), null);
});

test('successful processing persists and a new page/worker skips without clicking or scrolling', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const first = handledPostContext(server);
  await first.runCycle();
  assert.deepEqual([...server.state.processedPostHistory.keys], ['post:123']);
  assert.equal(vm.runInContext('commentCalls', first), 1);
  assert.equal(vm.runInContext('reloadRequests', first), 1);

  const restarted = background(server.state);
  const next = handledPostContext(restarted, { link: 'https://m.facebook.com/page/posts/123/?comment_id=99' });
  await next.runCycle();
  assert.equal(vm.runInContext('likeCalls', next), 0);
  assert.equal(vm.runInContext('commentCalls', next), 0);
  assert.equal(vm.runInContext('scrollCalls', next), 0);
  assert.equal(vm.runInContext('reloadRequests', next), 1);
});

test('failed comments are not saved or treated as finished', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const ctx = handledPostContext(server, { success: false });
  await ctx.runCycle();
  assert.equal(server.state.processedPostHistory, undefined);
  assert.equal(vm.runInContext('reloadRequests', ctx), 0);
});

test('already-liked posts keep the existing skip behavior and are remembered', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const ctx = handledPostContext(server, { liked: true });
  await ctx.runCycle();
  assert.deepEqual([...server.state.processedPostHistory.keys], ['post:123']);
  assert.equal(vm.runInContext('commentCalls', ctx), 0);
  assert.equal(vm.runInContext('scrollCalls', ctx), 0);
});

test('unidentified posts can finish the cycle but never persist a positional fallback', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const ctx = handledPostContext(server, { link: 'TimelineFeedUnit_0' });
  await ctx.runCycle();
  await ctx.runCycle();
  assert.equal(server.state.processedPostHistory, undefined);
  assert.equal(vm.runInContext('commentCalls', ctx), 2);
  assert.equal(vm.runInContext('reloadRequests', ctx), 2);
});

test('concurrent history writes do not lose IDs and invalid/non-target records are rejected', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  await Promise.all([
    server.ctx.markPostProcessed('post:111', 0, 7),
    server.ctx.markPostProcessed('post:222', 0, 7),
    server.ctx.markPostProcessed('post:111', 0, 7),
  ]);
  assert.deepEqual([...server.state.processedPostHistory.keys], ['post:111', 'post:222']);
  assert.equal((await server.ctx.markPostProcessed('post:333', 0, 8)).saved, false);
  await assert.rejects(server.ctx.markPostProcessed('TimelineFeedUnit_0', 0, 7));
});

test('clear empties active caches and permits subsequent processing without changing settings/logs', async () => {
  const server = background({ isRunning: true, automationTabId: 7,
    commentTemplates: ['Giữ nội dung ❤️'], reloadDelaySec: 0, logs: [{ text: 'Giữ log' }] });
  const ctx = handledPostContext(server);
  await ctx.runCycle();
  await ctx.runCycle();
  assert.equal(vm.runInContext('commentCalls', ctx), 1);
  await server.ctx.clearProcessedPostHistory();
  assert.equal(vm.runInContext('processedPostLinks.size', ctx), 0);
  assert.equal(server.state.processedPostHistory.generation, 1);
  assert.equal(server.state.processedPostHistory.keys.length, 0);
  assert.deepEqual(server.state.commentTemplates, ['Giữ nội dung ❤️']);
  assert.equal(server.state.logs[0].text, 'Giữ log');
  await ctx.runCycle();
  assert.equal(vm.runInContext('commentCalls', ctx), 2);
  assert.deepEqual([...server.state.processedPostHistory.keys], ['post:123']);
});

test('clear wins over a stale completion or delayed history load', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  await server.ctx.markPostProcessed('post:111', 0, 7);
  const ctx = content(server);
  const originalSend = ctx.chrome.runtime.sendMessage;
  let delayed;
  ctx.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'GET_PROCESSED_POSTS') delayed = callback;
    else originalSend(message, callback);
  };
  const load = ctx.loadProcessedPostHistory();
  await server.ctx.clearProcessedPostHistory();
  delayed({ ok: true, history: { generation: 0, keys: ['post:111'] } });
  await load;
  assert.equal(vm.runInContext('processedPostLinks.size', ctx), 0);
  assert.equal((await server.ctx.markPostProcessed('post:222', 0, 7)).saved, false);
  assert.equal(server.state.processedPostHistory.keys.length, 0);
});

test('failure to read history prevents interactions; failure to save stops automation', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const unreadable = handledPostContext(server);
  unreadable.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'GET_PROCESSED_POSTS') callback({ error: 'Read failed' });
  };
  await unreadable.runCycle();
  assert.equal(vm.runInContext('commentCalls', unreadable), 0);

  const unwritable = handledPostContext(server);
  const originalSend = unwritable.chrome.runtime.sendMessage;
  unwritable.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'MARK_POST_PROCESSED') callback({ error: 'Quota exceeded' });
    else originalSend(message, callback);
  };
  await unwritable.runCycle();
  assert.equal(vm.runInContext('automationRunning', unwritable), false);
  assert.equal(vm.runInContext('reloadRequests', unwritable), 0);
  assert.equal(server.state.isRunning, false);
});

test('extension update preserves stored post history', async () => {
  const server = background({ processedPostHistory: { generation: 3, keys: ['post:111'] } });
  await server.chrome.runtime.onInstalled.listeners[0]();
  assert.equal(server.state.processedPostHistory.generation, 3);
  assert.deepEqual(server.state.processedPostHistory.keys, ['post:111']);
});

function waitingTimelineContext() {
  const ctx = content();
  const observers = [], timeouts = [];
  ctx.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(root, options) { this.root = root; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  ctx.document.documentElement = {};
  ctx.timelineNode = null;
  ctx.document.querySelector = () => ctx.timelineNode;
  ctx.sleep = ms => new Promise(resolve => timeouts.push({ ms, resolve }));
  vm.runInContext('automationRunning = true', ctx);
  return { ctx, observers, timeouts };
}

test('ready timeline starts immediately with no fixed startup timer', async () => {
  const { ctx, observers, timeouts } = waitingTimelineContext();
  const timeline = { querySelectorAll: () => [{}] };
  ctx.timelineNode = timeline;
  assert.equal(await ctx.waitForTimeline(), timeline);
  assert.equal(observers.length, 0);
  assert.equal(timeouts.length, 0);
});

test('timeline wait resolves when the first post mounts and disconnects its observer', async () => {
  const { ctx, observers, timeouts } = waitingTimelineContext();
  let posts = [];
  const timeline = { querySelectorAll: () => posts };
  ctx.timelineNode = timeline;
  const waiting = ctx.waitForTimeline();
  assert.equal(observers.length, 1);
  assert.equal(timeouts[0].ms, 10000);
  assert.equal(observers[0].disconnected, false);
  posts = [{}];
  observers[0].callback();
  assert.equal(await waiting, timeline);
  assert.equal(observers[0].disconnected, true);
  // An old timeout must not inspect the DOM after resolution.
  ctx.document.querySelector = () => { throw Error('Late timeout queried DOM'); };
  timeouts[0].resolve();
  await Promise.resolve();
});

test('stop or timeout cancels a pending timeline wait', async () => {
  for (const stop of [true, false]) {
    const { ctx, observers, timeouts } = waitingTimelineContext();
    const waiting = ctx.waitForTimeline();
    if (stop) ctx.stopAutomation();
    else timeouts[0].resolve();
    assert.equal(await waiting, null);
    assert.equal(observers[0].disconnected, true);
    assert.equal(vm.runInContext('cancelTimelineWait', ctx), null);
  }
});

test('resume bootstrap forwards settings immediately and respects stored Stop', () => {
  const source = read('content.js');
  const bootstrap = source.slice(source.indexOf('// ─── Tự kiểm tra quyền chạy'));
  for (const shouldRun of [true, false]) {
    const calls = [];
    const quietHoursConfig = { enabled: true, startTime: '00:00', endTime: '07:00', reloadDelaySec: 600 };
    const ctx = vm.createContext({
      automationRunning: false, logEntry() {},
      sleep() { throw Error('Resume should not sleep'); },
      startAutomation(config) { calls.push(config); },
      chrome: { runtime: { sendMessage(message, callback) { callback({ shouldRun, quietHoursConfig }); } } },
    });
    vm.runInContext(bootstrap, ctx);
    assert.equal(calls.length, shouldRun ? 1 : 0);
    if (shouldRun) assert.equal(calls[0].quietHoursConfig.reloadDelaySec, 600);
  }
});

function quietScheduleContext(config = {}) {
  const ctx = content();
  ctx.testQuiet = { enabled: true, startTime: '00:00', endTime: '07:00', reloadDelaySec: 300, ...config };
  vm.runInContext(`
    quietHoursConfig = testQuiet; reloadDelaySec = 30;
    peakConfig = { enabled: false };
  `, ctx);
  return ctx;
}
const localClock = (hour, minute = 0, second = 0) => new Date(2026, 9, 21, hour, minute, second);

test('quiet schedule includes midnight, excludes 07:00, and falls back to normal', () => {
  const ctx = quietScheduleContext();
  for (const [hour, minute] of [[0, 0], [0, 1], [6, 59]]) {
    const schedule = ctx.getReloadScheduleInfo(localClock(hour, minute));
    assert.equal(schedule.inQuiet, true);
    assert.equal(schedule.currentDelay, 300);
    assert.equal(new Date(schedule.untilTime).getHours(), 7);
  }
  for (const hour of [7, 12, 23]) assert.equal(ctx.getReloadScheduleInfo(localClock(hour)).currentDelay, 30);
});

test('quiet schedule takes priority over peak hours and supports overnight/custom/zero delays', () => {
  const ctx = quietScheduleContext({ startTime: '22:00', endTime: '07:30', reloadDelaySec: 0 });
  vm.runInContext("peakConfig = { enabled: true, hours: '0, 7, 22', durationMin: 60, reloadDelaySec: 5 }", ctx);
  for (const hour of [0, 7, 22, 23]) {
    const schedule = ctx.getReloadScheduleInfo(localClock(hour));
    assert.equal(schedule.inQuiet, true);
    assert.equal(schedule.currentDelay, 0);
    assert.equal(new Date(schedule.untilTime).getMinutes(), 30);
  }
  assert.equal(ctx.getReloadScheduleInfo(localClock(7, 30)).inPeak, true);
  ctx.testQuiet.reloadDelaySec = 0.5;
  assert.equal(ctx.getReloadScheduleInfo(localClock(23)).currentDelay, 0.5);
  ctx.testQuiet.enabled = false;
  assert.equal(ctx.getReloadScheduleInfo(localClock(22)).currentDelay, 5);
  ctx.testQuiet.enabled = true;
  ctx.testQuiet.startTime = ctx.testQuiet.endTime;
  assert.equal(ctx.getReloadScheduleInfo(localClock(22)).currentDelay, 5);
});

test('quiet countdown is capped at its ending time', async () => {
  const ctx = scanCycleContext();
  ctx.fakeNow = Date.now();
  vm.runInContext(`
    getReloadScheduleInfo = () => ({ inQuiet: true, currentDelay: 300, untilTime: fakeNow + 2000, currentSlotStr: '00:00 - 07:00' });
  `, ctx);
  ctx.Date = class extends Date { static now() { return ctx.fakeNow; } };
  await ctx.runCycle();
  assert.equal(ctx.reloadRequests, 1);
  assert.deepEqual([...ctx.cycleWaits], [400, 400, 1000, 1000]);
});

test('quiet settings survive stored resume, extension updates, and content start messages', async () => {
  const quietHoursConfig = { enabled: true, startTime: '23:00', endTime: '06:30', reloadDelaySec: 600 };
  const server = background({ isRunning: true, automationTabId: 7, quietHoursConfig });
  const response = await new Promise(resolve => server.chrome.runtime.onMessage.listeners[0](
    { type: 'CHECK_SHOULD_RUN' }, { tab: { id: 7 } }, resolve));
  assert.deepEqual(response.quietHoursConfig, quietHoursConfig);
  const ctx = content();
  ctx.chrome.runtime.onMessage.listeners[0]({ type: 'START_AUTOMATION', quietHoursConfig }, {}, () => {});
  assert.equal(ctx.getReloadScheduleInfo(localClock(23)).currentDelay, 600);
  await server.chrome.runtime.onInstalled.listeners[0]();
  assert.deepEqual(server.state.quietHoursConfig, quietHoursConfig);
  const fresh = background();
  await fresh.chrome.runtime.onInstalled.listeners[0]();
  assert.equal(fresh.state.quietHoursConfig.startTime, '00:00');
  assert.equal(fresh.state.quietHoursConfig.endTime, '07:00');
  assert.equal(fresh.state.quietHoursConfig.reloadDelaySec, 300);
});
