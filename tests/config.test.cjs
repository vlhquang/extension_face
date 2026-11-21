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

test('concurrent log writes retain order, cap history, and serialize clear', async () => {
  const { ctx, state } = background();
  await Promise.all(Array.from({ length: 310 }, (_, i) =>
    ctx.queueLogWrite({ timestamp: i, text: `log ${i}` })));
  assert.equal(state.logs.length, 300);
  assert.deepEqual(Array.from(state.logs, entry => entry.timestamp),
    Array.from({ length: 300 }, (_, i) => i + 10));
  await Promise.all([
    ctx.queueLogWrite({ timestamp: 310, text: 'before clear' }),
    ctx.queueLogWrite(null),
    ctx.queueLogWrite({ timestamp: 311, text: 'after clear' }),
  ]);
  assert.deepEqual(Array.from(state.logs, entry => entry.text), ['after clear']);
});

function content(historyServer = null) {
  const math = Object.create(Math);
  math.random = () => 0;
  const chrome = {
    storage: { onChanged: historyServer?.chrome.storage.onChanged || event(), local: {
      set(values) { return historyServer ? historyServer.chrome.storage.local.set(values) : Promise.resolve(); },
      get(keys, cb) { cb({ originalUrl: 'https://www.facebook.com/test' }); },
    } },
    runtime: { onMessage: event(), sendMessage(message, cb) {
      if (/^(GET_PROCESSED_POSTS|MARK_POST_PROCESSED|MARK_POST_COMMENTED|CLEAR_PROCESSED_POSTS)$/.test(message.type)) {
        if (historyServer) historyServer.chrome.runtime.onMessage.listeners[0](message, { tab: { id: 7 } }, cb);
        else cb({ ok: true, history: { generation: 0, keys: [] } });
      } else if (cb) cb({ shouldRun: false });
    } },
  };
  const ctx = vm.createContext({
    chrome, console, Math: math, Date, URL, AbortController, navigator: {},
    window: { location: { href: 'https://www.facebook.com/test' } },
    document: {}, setTimeout, clearTimeout, performance,
  });
  vm.runInContext(read('content.js'), ctx);
  vm.runInContext('startLoop = async () => {}; logEntry = () => {}; quietHoursConfig.enabled = false;', ctx);
  ctx.fakeNow = Date.now();
  ctx.Date = class extends Date { static now() { return ctx.fakeNow; } };
  ctx.advanceClock = ms => { ctx.fakeNow += ms; };
  return ctx;
}

function editorContext({ initial = '', insertDelay = 0, sendDelay = 0, detach = false } = {}) {
  const ctx = content();
  const commands = [], waits = [], scheduled = [];
  let sends = 0;
  const textbox = {
    isConnected: true, textContent: initial, scrollIntoView() {},
    focus() { ctx.document.activeElement = textbox; },
    dispatchEvent(event) { if (event.type === 'keydown' && event.key === 'Enter') send(); },
    closest() { return null; },
  };
  const send = () => {
    sends++;
    if (detach) textbox.isConnected = false;
    else scheduled.push({ at: ctx.fakeNow + sendDelay, action: () => { textbox.textContent = ''; } });
  };
  const flush = () => {
    for (const task of scheduled.splice(0)) {
      if (task.at <= ctx.fakeNow) task.action(); else scheduled.push(task);
    }
  };
  ctx.FocusEvent = ctx.KeyboardEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  ctx.document.execCommand = (command, ui, text) => {
    commands.push(command);
    if (command === 'delete') textbox.textContent = '';
    if (command === 'insertText') scheduled.push({ at: ctx.fakeNow + insertDelay, action: () => { textbox.textContent += text; } });
    flush();
    return false; // Lexical can accept an insertion even if execCommand returns false.
  };
  ctx.triggerClick = el => el.focus();
  ctx.sleep = async ms => { waits.push(ms); ctx.advanceClock(ms); flush(); };
  ctx.findCommentBox = () => textbox.isConnected ? textbox : null;
  vm.runInContext('automationRunning = true', ctx);
  const container = { querySelector() { return null; } };
  return { ctx, textbox, container, commands, waits, sends: () => sends };
}

test('ready empty editor inserts once and sends without the old fixed waits', async () => {
  const { ctx, textbox, container, commands, waits, sends } = editorContext({ sendDelay: 100 });
  const result = await ctx.performCommentOnTextbox(container, textbox, 'Xin chào ❤️');
  assert.equal(result.success, true);
  assert.deepEqual(commands, ['insertText']);
  assert.equal(sends(), 1);
  assert.equal(waits.reduce((a, b) => a + b, 0), 150);
});

test('late Like detection cancels submission before Enter or Like starts', async () => {
  const { ctx, textbox, container, sends } = editorContext({ initial: 'Hello' });
  ctx.testContainer = container;
  vm.runInContext('postCommentGuards.set(testContainer, () => false)', ctx);
  let likes = 0;
  await assert.rejects(ctx.submitComment(container, 100, textbox, () => { likes++; }),
    error => typeof error === 'symbol');
  assert.equal(sends(), 0);
  assert.equal(likes, 0);
});

test('expanded Like labels and a fallback control are recognized', () => {
  const ctx = content();
  for (const label of ['Gỡ thích bài viết', 'Remove like from this post', 'Unlike']) {
    const button = { getAttribute: () => label };
    const marker = { closest: () => button };
    assert.equal(ctx.isPostAlreadyLiked({
      querySelector: () => marker, contains: () => true,
    }), true);
  }
  const button = { getAttribute: () => 'Reactions' };
  const marker = { closest: () => button };
  assert.equal(ctx.isPostAlreadyLiked({
    querySelector: selector => selector.includes('data-ad-rendering-role') ? marker : {},
    contains: () => true,
  }), true);
});

test('slow editor waits for matching Unicode text and never inserts twice', async () => {
  const { ctx, textbox, commands } = editorContext({ initial: 'Nội dung cũ', insertDelay: 200 });
  assert.equal(await ctx.insertTextIntoLexical(textbox, 'Nội dung mới 🎉'), true);
  assert.deepEqual(commands, ['selectAll', 'delete', 'insertText']);
  assert.equal(textbox.textContent, 'Nội dung mới 🎉');
});

test('timed-out send remains pending and retry waits without retyping or resubmitting', async () => {
  const { ctx, textbox, container, commands, sends } = editorContext({ initial: 'Hello', sendDelay: 300 });
  assert.equal(await ctx.submitComment(container, 100, textbox), false);
  const result = await ctx.performCommentOnTextbox(container, textbox, 'Hello');
  assert.equal(result.success, true);
  assert.equal(sends(), 1);
  assert.deepEqual(commands, []);
  assert.ok(result.elapsed >= 200);
});

test('disappearing or initially empty textbox is not a successful comment', async () => {
  const { ctx, textbox, container, sends } = editorContext({ initial: 'Hello', detach: true });
  assert.equal(await ctx.submitComment(container, 100, textbox), false);
  assert.equal(await ctx.submitComment(container, 100, textbox), false);
  assert.equal(sends(), 1);
  const empty = editorContext();
  assert.equal(await empty.ctx.submitComment(empty.container, 100, empty.textbox), false);
  assert.equal(empty.sends(), 0);
});

test('stopping automation prevents editor insertion and comment submission', async () => {
  const { ctx, textbox, container, commands, sends } = editorContext({ initial: 'Hello' });
  vm.runInContext('automationRunning = false', ctx);
  assert.equal(await ctx.insertTextIntoLexical(textbox, 'New text'), false);
  assert.equal(await ctx.submitComment(container, 100, textbox), false);
  assert.deepEqual(commands, []);
  assert.equal(sends(), 0);
});

test('like confirmation follows a replaced button and never clicks twice on timeout', async () => {
  for (const replace of [true, false]) {
    const ctx = content();
    vm.runInContext('automationRunning = true', ctx);
    let clicks = 0;
    const btn = { isConnected: true, getAttribute() { return 'Like'; } };
    const role = { closest() { return btn; } };
    const replacement = { getAttribute() { return 'Remove like'; } };
    const container = { querySelector(selector) {
      return selector === '[data-ad-rendering-role="like_button"]' ? role :
        (replace && !btn.isConnected ? replacement : null);
    } };
    ctx.triggerClick = () => { clicks++; };
    ctx.sleep = async ms => { ctx.advanceClock(ms); if (replace) btn.isConnected = false; };
    const result = await ctx.performLike(container);
    assert.equal(result, replace ? 50 : -1);
    assert.equal(clicks, 1);
  }
});

test('popup sends comment before starting like while comment confirmation is pending', async () => {
  const { ctx, textbox, container, sends } = editorContext({ sendDelay: 200 });
  const events = [];
  const exec = ctx.document.execCommand;
  ctx.document.execCommand = (...args) => {
    if (args[0] === 'insertText') events.push('insert');
    return exec(...args);
  };
  ctx.performLike = async () => {
    events.push('like start');
    assert.equal(sends(), 1);
    assert.equal(textbox.textContent, 'Hello');
    events.push('like done');
    return 50;
  };
  ctx.getPostLink = () => 'https://www.facebook.com/page/posts/999';
  ctx.findInlineCommentBox = () => null;
  ctx.findDialogCommentBox = () => textbox;
  ctx.findCommentButton = () => ({ focus() {}, querySelector() { return null; } });
  ctx.document.querySelector = () => null;
  ctx.document.querySelectorAll = () => [container];
  container.querySelector = selector => selector.includes('[role="article"]') ? {} : null;
  ctx.closeDialog = async () => {};
  vm.runInContext("commentTemplates = ['Hello']; peakConfig.enabled = false", ctx);
  const post = { querySelector() { return null; } };
  assert.equal(await ctx.processPost(post, 0), true);
  assert.deepEqual(events, ['insert', 'like start', 'like done']);
});

test('inline sends before like, and an insertion failure never starts like', async () => {
  for (const failInsertion of [false, true]) {
    const { ctx, textbox, container, sends } = editorContext({ sendDelay: 200 });
    let likes = 0;
    ctx.performLike = async () => {
      likes++;
      assert.equal(sends(), 1);
      assert.equal(textbox.textContent, 'Hello');
      return 50;
    };
    ctx.getPostLink = () => 'https://www.facebook.com/page/posts/999';
    ctx.findInlineCommentBox = () => textbox;
    if (failInsertion) ctx.document.execCommand = () => false;
    vm.runInContext("commentTemplates = ['Hello']; peakConfig.enabled = false", ctx);
    assert.equal(await ctx.processPost(container, 0), !failInsertion);
    assert.equal(likes, failInsertion ? 0 : 1);
    assert.equal(sends(), failInsertion ? 0 : 1);
  }
});

test('completed comment is retained while retrying only the failed like', async () => {
  const ctx = content();
  vm.runInContext('automationRunning = true', ctx);
  let comments = 0, likes = 0;
  ctx.performLike = async () => ++likes === 1 ? -1 : 100;
  const progress = { likeSuccess: false, commentSuccess: false };
  const comment = async onSubmitted => {
    comments++; onSubmitted(); return { success: true, elapsed: 50 };
  };
  const first = await ctx.commentBeforeLike({}, comment, progress);
  assert.equal(first.likeElapsed, -1);
  assert.equal(progress.commentSuccess, true);
  const second = await ctx.commentBeforeLike({}, comment, progress);
  assert.equal(second.likeElapsed, 100);
  assert.equal(progress.likeSuccess, true);
  assert.equal(comments, 1);
  assert.equal(likes, 2);
});

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
  for (const delay of [0, 0.05, 0.1, 0.5, 1.5]) {
    const ctx = content();
    ctx.testDelay = delay;
    vm.runInContext(`
      automationRunning = true; targetIndices = [0]; reloadDelaySec = testDelay;
      peakConfig.enabled = false; processedPostLinks.add('post');
      document.querySelector = () => ({ querySelectorAll: () => [{}] }); findPostElement = async () => ({});
      getPostLink = () => 'post'; processPost = async () => true;
      var delays = []; sleep = async ms => { delays.push(ms); advanceClock(ms); };
    `, ctx);
    await ctx.runCycle();
    const countdown = vm.runInContext('delays', ctx);
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
      advanceClock(ms);
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
    sleep = async ms => { finderWaits.push(ms); advanceClock(ms); };
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

test('finder proceeds after 100ms when the next post appears instead of waiting a full second', async () => {
  const ctx = timelineFinderContext();
  ctx.timelinePosts.pop();
  ctx.sleep = async ms => {
    ctx.finderWaits.push(ms); ctx.advanceClock(ms);
    ctx.timelinePosts.push({ index: 1 });
  };
  const post = await ctx.findPostElement(ctx.fakeTimeline, 1, false);
  assert.equal(post.index, 1);
  assert.deepEqual([...ctx.finderWaits], [100]);
  assert.deepEqual([...ctx.finderScrolls], ['window']);
});

test('finder reacquires a replaced timeline and respects stop and the 3-second limit', async () => {
  const ctx = timelineFinderContext();
  ctx.timelinePosts.pop();
  ctx.sleep = async ms => {
    ctx.advanceClock(ms);
    ctx.fakeTimeline.isConnected = false;
    ctx.document.querySelector = () => ({ isConnected: true, querySelectorAll: () => [{ index: 0 }, { index: 1 }] });
  };
  assert.equal((await ctx.findPostElement(ctx.fakeTimeline, 1, false)).index, 1);
  const stopped = timelineFinderContext();
  stopped.sleep = async ms => { stopped.advanceClock(ms); vm.runInContext('automationRunning = false', stopped); };
  assert.equal(await stopped.findPostElement(stopped.fakeTimeline, 2, false), null);
  assert.deepEqual([...stopped.finderScrolls], ['window']);
  const missing = timelineFinderContext();
  assert.equal(await missing.findPostElement(missing.fakeTimeline, 2, false), null);
  assert.equal(missing.finderWaits.reduce((sum, ms) => sum + ms, 0), 3000);
  assert.equal(missing.finderScrolls.length, 3);
});

test('single-post scan starts reload countdown without a trailing random pause', async () => {
  const ctx = scanCycleContext();
  vm.runInContext('targetIndices = [0]', ctx);
  await ctx.runCycle();
  assert.deepEqual([...ctx.cycleWaits], [1000, 1000]);
  assert.equal(ctx.reloadRequests, 1);
});

test('dialog closing returns as soon as detached and fails when still connected', async () => {
  for (const detach of [true, false]) {
    const { ctx } = editorContext();
    const dialog = { isConnected: true, querySelector() { return { click() {} }; } };
    let elapsed = 0;
    ctx.sleep = async ms => {
      elapsed += ms; ctx.advanceClock(ms);
      if (detach && elapsed >= 100) dialog.isConnected = false;
    };
    assert.equal(await ctx.closeDialog(dialog), detach);
    assert.equal(elapsed, detach ? 100 : 1200);
  }
});

test('scan uses the actual finder to process both visible posts and start countdown', async () => {
  const ctx = timelineFinderContext();
  await ctx.runCycle();
  assert.deepEqual([...ctx.checkedTimelinePosts], [0, 1]);
  assert.equal(ctx.finderReloads, 1);
  assert.equal(ctx.finderScrolls.length, 0);
  assert.deepEqual([...ctx.finderWaits], [400, 1000, 1000]);
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
  assert.deepEqual([...vm.runInContext('cycleWaits', ctx)], [400, 1000, 1000]);
});

test('scan still reloads while a post is missing or has failed', async () => {
  for (const scenario of [{ missing: 0 }, { failed: 0 }, { failed: 1 }]) {
    const ctx = scanCycleContext(scenario);
    await ctx.runCycle();
    assert.equal(vm.runInContext('reloadRequests', ctx), 1);
    assert.equal(vm.runInContext('cycleWaits.includes(1000)', ctx), true);
  }
});

test('stale-dialog failure reloads on normal, peak, backup and quiet schedules without saving the post', async () => {
  for (const [hour, minute, second, expectedWait, stop] of [
    [16, 0, 0, 500, false], [10, 0, 0, 100, false],
    [10, 1, 0, 3000, false], [0, 1, 0, 5000, false],
    [9, 59, 59, 1000, false], [16, 0, 0, 0, true],
  ]) {
    const server = background({ isRunning: true, automationTabId: 7 });
    const ctx = handledPostContext(server);
    const now = localClock(hour, minute); now.setSeconds(second);
    ctx.fakeNow = now.getTime();
    const waits = [];
    ctx.sleep = async ms => {
      waits.push(ms); ctx.advanceClock(ms);
      if (stop) vm.runInContext('automationRunning = false', ctx);
    };
    ctx.findInlineCommentBox = () => null;
    ctx.closeDialog = async () => false;
    const timeline = { querySelectorAll: () => [{}] };
    ctx.document.querySelector = selector => selector.includes('ProfileTimeline') ? timeline : {};
    vm.runInContext(`reloadDelaySec = 0.5;
      peakConfig = { enabled: true, hours: '10', durationMin: 1, reloadDelaySec: 0.1,
        backupDurationMin: 2, backupReloadDelaySec: 3 };
      quietHoursConfig = { enabled: true, startTime: '00:00', endTime: '07:00', reloadDelaySec: 5 };`, ctx);
    if (hour === 9) vm.runInContext('reloadDelaySec = 3600', ctx);
    await ctx.runCycle();
    assert.equal(vm.runInContext('reloadRequests', ctx), stop ? 0 : 1);
    if (!stop) assert.equal(waits.reduce((a, b) => a + b, 0), expectedWait);
    assert.equal(server.state.processedPostHistory, undefined);
    assert.equal(vm.runInContext('likeCalls + commentCalls', ctx), 0);
  }
});

test('unready timeline reloads on its schedule, respects boundaries and Stop, and never processes posts', async () => {
  for (const mode of ['normal', 'peak', 'backup', 'quiet', 'boundary', 'stop', 'cancelWait']) {
    const ctx = scanCycleContext({ stopDuringCountdown: mode === 'stop' });
    ctx.waitForTimeline = async () => {
      if (mode === 'cancelWait') vm.runInContext('automationRunning = false', ctx);
      return null;
    };
    const now = localClock(mode === 'quiet' ? 0 : mode === 'boundary' ? 9 : 10,
      mode === 'backup' ? 1 : mode === 'boundary' ? 59 : 0);
    if (mode === 'boundary') now.setSeconds(59);
    ctx.fakeNow = now.getTime();
    if (['peak', 'backup', 'boundary'].includes(mode)) {
      vm.runInContext(`peakConfig = { enabled: true, hours: '10', durationMin: 1,
        reloadDelaySec: 0.1, backupDurationMin: 2, backupReloadDelaySec: 3 };`, ctx);
    }
    if (mode === 'quiet') vm.runInContext(`quietHoursConfig = {
      enabled: true, startTime: '00:00', endTime: '07:00', reloadDelaySec: 0.5 };`, ctx);
    await ctx.runCycle();
    const stopped = mode === 'stop' || mode === 'cancelWait';
    assert.equal(ctx.reloadRequests, stopped ? 0 : 1);
    assert.equal(ctx.checkedPosts.length, 0);
    assert.equal(vm.runInContext('processedPostLinks.size', ctx), 0);
    if (!stopped) {
      const expected = { normal: 2000, peak: 100, backup: 3000, quiet: 500, boundary: 1000 }[mode];
      assert.equal(ctx.cycleWaits.reduce((sum, ms) => sum + ms, 0), expected);
    }
  }
});

test('unexpected scan exceptions and countdown timer errors cannot prevent reload', async () => {
  for (const failure of ['scan', 'countdown']) {
    const ctx = scanCycleContext();
    if (failure === 'scan') ctx.processPost = async () => { throw Error('DOM changed'); };
    else ctx.sleep = async () => { throw Error('Timer channel failed'); };
    await ctx.runCycle();
    assert.equal(ctx.reloadRequests, 1);
    assert.equal(vm.runInContext('automationRunning', ctx), true);
  }
});

test('first failed post immediately starts configured countdown without a watchdog or remaining posts', async () => {
  for (const stop of [false, true]) {
    const ctx = scanCycleContext({ failed: 0, stopDuringCountdown: stop });
    ctx.setTimeout = (fn, ms) => { assert.equal(ms, 1000); return 1; };
    ctx.clearTimeout = () => {};
    await ctx.runCycle();
    assert.equal(ctx.reloadRequests, stop ? 0 : 1);
    assert.deepEqual([...ctx.checkedPosts], [0]);
    assert.deepEqual([...ctx.cycleWaits], stop ? [1000] : [1000, 1000]);
  }
});

test('navigation falls back to the in-memory URL if storage throws', () => {
  const ctx = scanCycleContext();
  vm.runInContext("originalUrl = 'https://www.facebook.com/page'", ctx);
  ctx.chrome.storage.local.get = () => { throw Error('Storage unavailable'); };
  ctx.requestScheduledReload();
  assert.equal(ctx.window.location.href, 'https://www.facebook.com/page');
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
      querySelector(selector) { return testAlreadyLiked && selector.includes('Remove like') ? {} : null; }
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
    sleep = async ms => { advanceClock(ms); };
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

test('successful post threshold switches to backup and survives reload without counting old posts', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const setup = ctx => {
    ctx.fakeNow = localClock(10, 0).getTime();
    vm.runInContext(`originalUrl = 'https://www.facebook.com/page';
      peakConfig = { enabled: true, hours: '10,12', durationMin: 1, reloadDelaySec: 1,
        backupDurationMin: 2, backupReloadDelaySec: 3, successPostTarget: 2 };`, ctx);
  };
  const ctx = handledPostContext(server);
  setup(ctx);
  await ctx.loadProcessedPostHistory();
  await vm.runInContext('processPost(fakePost, 0)', ctx);
  const schedule = () => ctx.getReloadScheduleInfo(new Date(ctx.fakeNow));
  assert.equal(schedule().inPeak, true);
  assert.equal(server.state.processedPostHistory.peakProgress.keys.length, 1);
  await vm.runInContext('processPost(fakePost, 0)', ctx);
  assert.equal(server.state.processedPostHistory.peakProgress.keys.length, 1);
  ctx.testPostLink = 'https://www.facebook.com/page/posts/456/';
  await vm.runInContext('processPost(fakePost, 0)', ctx);
  assert.equal(schedule().inBackup, true);
  assert.equal(schedule().currentDelay, 3);
  const restarted = handledPostContext(background(server.state));
  setup(restarted);
  await restarted.loadProcessedPostHistory();
  assert.equal(restarted.getReloadScheduleInfo(new Date(restarted.fakeNow)).inBackup, true);
  assert.equal(restarted.getReloadScheduleInfo(localClock(12, 0)).inPeak, true);
  const tomorrow = new Date(restarted.fakeNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(restarted.getReloadScheduleInfo(tomorrow).inPeak, true);
});

test('confirmed comment survives reload and only the failed Like is retried', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const first = handledPostContext(server);
  first.performLike = async () => -1;
  await first.runCycle();
  assert.equal(first.commentCalls, 1);
  assert.deepEqual([...server.state.processedPostHistory.keys], []);
  assert.deepEqual([...server.state.processedPostHistory.commentedKeys], ['post:123']);

  const next = handledPostContext(background(server.state));
  await next.runCycle();
  assert.equal(next.commentCalls, 0);
  assert.equal(next.likeCalls, 1);
});

test('failed comments including already-liked posts do not count toward the peak threshold', async () => {
  for (const options of [{ success: false }, { liked: true, success: false }]) {
    const server = background({ isRunning: true, automationTabId: 7 });
    const ctx = handledPostContext(server, options);
    ctx.fakeNow = localClock(10, 0).getTime();
    vm.runInContext("peakConfig = { enabled: true, hours: '10', durationMin: 1, reloadDelaySec: 1, successPostTarget: 1 }", ctx);
    await ctx.loadProcessedPostHistory();
    await vm.runInContext('processPost(fakePost, 0)', ctx);
    assert.equal(server.state.processedPostHistory?.peakProgress, undefined);
    assert.equal(ctx.getReloadScheduleInfo(new Date(ctx.fakeNow)).inPeak, true);
  }
});

test('failed comments are not saved or treated as finished', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const ctx = handledPostContext(server, { success: false });
  await ctx.runCycle();
  assert.equal(server.state.processedPostHistory, undefined);
  assert.equal(vm.runInContext('reloadRequests', ctx), 1);
});

test('already-liked posts skip both interactions before checking comments', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const ctx = handledPostContext(server, { liked: true });
  vm.runInContext('requireExistingComment = true', ctx);
  ctx.readPostCommentCount = () => { throw new Error('Unexpected comment count check'); };
  ctx.findInlineCommentBox = () => { throw new Error('Unexpected comment box check'); };
  await ctx.runCycle();
  assert.equal(server.state.processedPostHistory, undefined);
  assert.equal(vm.runInContext('commentCalls', ctx), 0);
  assert.equal(vm.runInContext('likeCalls', ctx), 0);
  assert.equal(vm.runInContext('scrollCalls', ctx), 0);
  assert.equal(ctx.reloadRequests, 1);
});

test('a Like detected only in the popup skips comment and closes the dialog', async () => {
  const { ctx, textbox, container, sends } = editorContext();
  const button = { getAttribute: () => 'Remove like' };
  const marker = { closest: () => button };
  container.contains = node => node === button;
  container.querySelector = selector => selector.includes('like_button') ? marker
    : selector.includes('[role="article"]') ? {} : null;
  ctx.getPostLink = () => 'https://www.facebook.com/page/posts/999';
  ctx.findInlineCommentBox = () => null;
  ctx.findDialogCommentBox = () => textbox;
  ctx.findCommentButton = () => ({ focus() {}, querySelector() { return null; } });
  ctx.document.querySelector = () => null;
  ctx.document.querySelectorAll = () => [container];
  let closed = 0;
  ctx.closeDialog = async () => { closed++; };
  ctx.performLike = async () => { throw Error('Unexpected Like'); };
  assert.equal(await ctx.processPost({ querySelector: () => null }, 0), true);
  assert.equal(closed, 1);
  assert.equal(sends(), 0);
});

test('only an explicit zero comment count blocks both interactions when enabled', async () => {
  for (const [enabled, label, marker, expected] of [
    [false, '', false, 1],
    [false, 'Bình luận về bài viết của HDBank, 0 bình luận', true, 1],
    [true, 'Bình luận về bài viết của HDBank, 830 bình luận', true, 1],
    [true, 'Bình luận về bài viết của HDBank, 1.230 bình luận', true, 1],
    [true, 'Bình luận về bài viết của HDBank, 0 bình luận', true, 0],
    [true, '830', true, 1],
    [true, '', false, 1],
    [true, 'Bình luận về bài viết của HDBank, 0 bình luận', false, 1],
  ]) {
    const server = background({ isRunning: true, automationTabId: 7 });
    const ctx = handledPostContext(server);
    ctx.testRequirement = enabled;
    const button = { closest: () => null, getAttribute: () => label };
    ctx.getCommentMarkers = () => marker ? [{ closest: () => button }] : [];
    vm.runInContext(`requireExistingComment = testRequirement;
      fakePost.contains = () => true;
      fakePost.querySelectorAll = getCommentMarkers;`, ctx);
    await ctx.runCycle();
    assert.equal(ctx.commentCalls, expected);
    assert.equal(ctx.likeCalls, expected);
    assert.equal(ctx.reloadRequests, 1);
    assert.equal(!!server.state.processedPostHistory, !!expected);
  }
});

test('configured interaction delay applies to zero and unreadable counts, but not a positive count', async () => {
  for (const [count, stop] of [[0, false], [null, false], [3, false], [0, true]]) {
    const ctx = handledPostContext(background({ isRunning: true, automationTabId: 7 }));
    vm.runInContext('commentCountDelaySec = 1.5; requireExistingComment = true', ctx);
    ctx.readPostCommentCount = () => count;
    const waits = [];
    const sleep = ctx.sleep;
    const performComment = ctx.performCommentOnTextbox;
    ctx.sleep = async ms => {
      waits.push(ms);
      await sleep(ms);
      if (stop) ctx.stopAutomation();
    };
    ctx.performCommentOnTextbox = (...args) => {
      assert.equal(waits.reduce((sum, ms) => sum + ms, 0), count > 0 ? 0 : 1500);
      return performComment(...args);
    };
    await ctx.runCycle();
    assert.equal(ctx.commentCalls, stop ? 0 : 1);
    assert.equal(ctx.likeCalls, stop ? 0 : 1);
    assert.equal(ctx.reloadRequests, stop ? 0 : 1);
  }
});

test('strict positive-comment requirement overrides delay and rejects unknown counts', async () => {
  for (const [count, expected] of [[null, 0], [0, 0], [2, 1]]) {
    const ctx = handledPostContext(background({ isRunning: true, automationTabId: 7 }));
    vm.runInContext('requirePositiveComments = true; requireExistingComment = false; commentCountDelaySec = 5', ctx);
    ctx.readPostCommentCount = () => count;
    const waits = [];
    ctx.sleep = async ms => { waits.push(ms); ctx.advanceClock(ms); };
    await ctx.runCycle();
    assert.equal(ctx.commentCalls, expected);
    assert.equal(ctx.likeCalls, expected);
    assert.equal(ctx.reloadRequests, 1);
    assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 0);
  }
});

test('strict comment setting is forwarded on resume and preserved after updates', async () => {
  const server = background({ isRunning: true, automationTabId: 7, requirePositiveComments: true });
  const response = await new Promise(resolve => server.chrome.runtime.onMessage.listeners[0](
    { type: 'CHECK_SHOULD_RUN' }, { tab: { id: 7 } }, resolve));
  assert.equal(response.requirePositiveComments, true);
  const ctx = content();
  ctx.startAutomation(response);
  assert.equal(vm.runInContext('requirePositiveComments', ctx), true);
  await server.chrome.runtime.onInstalled.listeners[0]();
  assert.equal(server.state.requirePositiveComments, true);
});

test('unidentified posts never receive interactions and still reload', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const ctx = handledPostContext(server, { link: 'TimelineFeedUnit_0' });
  await ctx.runCycle();
  await ctx.runCycle();
  assert.equal(server.state.processedPostHistory, undefined);
  assert.equal(vm.runInContext('commentCalls + likeCalls', ctx), 0);
  assert.equal(vm.runInContext('reloadRequests', ctx), 2);
});

test('a late permalink for an already-processed post prevents duplicate interactions', async () => {
  const server = background({ isRunning: true, automationTabId: 7,
    processedPostHistory: { generation: 0, keys: ['post:123'] } });
  const ctx = handledPostContext(server, { link: 'TimelineFeedUnit_0' });
  const sleep = ctx.sleep;
  ctx.sleep = async ms => {
    ctx.testPostLink = 'https://www.facebook.com/page/posts/123/';
    await sleep(ms);
  };
  await ctx.runCycle();
  assert.equal(vm.runInContext('commentCalls + likeCalls', ctx), 0);
  assert.equal(ctx.reloadRequests, 1);
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

test('history read/write failures still reload without stopping automation', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const unreadable = handledPostContext(server);
  unreadable.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'GET_PROCESSED_POSTS') callback({ error: 'Read failed' });
  };
  await unreadable.runCycle();
  assert.equal(vm.runInContext('commentCalls', unreadable), 0);
  assert.equal(vm.runInContext('reloadRequests', unreadable), 1);

  const unwritable = handledPostContext(server);
  const originalSend = unwritable.chrome.runtime.sendMessage;
  unwritable.chrome.runtime.sendMessage = (message, callback) => {
    if (message.type === 'MARK_POST_PROCESSED') callback({ error: 'Quota exceeded' });
    else originalSend(message, callback);
  };
  await unwritable.runCycle();
  assert.equal(vm.runInContext('automationRunning', unwritable), true);
  assert.equal(vm.runInContext('reloadRequests', unwritable), 1);
  assert.equal(server.state.isRunning, true);
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
      automationRunning: false, logEntry() {}, performance,
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

test('reload deadlines respect every peak and quiet boundary, including next day', () => {
  const ctx = quietScheduleContext({ startTime: '00:00', endTime: '07:00', reloadDelaySec: 1800 });
  vm.runInContext(`reloadDelaySec = 3600;
    peakConfig = { enabled: true, hours: '8,10,12,15,17,20', durationMin: 3, reloadDelaySec: 1 };`, ctx);
  const check = (hour, minute, second, expected) => {
    const now = localClock(hour, minute);
    now.setSeconds(second);
    assert.equal((ctx.getReloadDeadline(now) - now.getTime()) / 1000, expected);
  };
  check(16, 43, 22, 998);
  for (const hour of [8, 10, 12, 15, 17, 20]) {
    check(hour - 1, 59, 50, 10);
    check(hour, 0, 0, 1);
    check(hour, 2, 50, 1);
    check(hour, 2, 59, 1);
    check(hour, 3, 0, 3);
    check(hour, 5, 0, 3600);
  }
  check(23, 50, 0, 600);
  check(0, 0, 0, 1800);
  check(6, 50, 0, 600);
  vm.runInContext("peakConfig = { enabled: true, hours: '6,23', durationMin: 120, reloadDelaySec: 1 };", ctx);
  check(6, 50, 0, 600); // quiet hides the peak start at 06:00
  check(7, 0, 0, 1); // peak remains active after quiet ends
  ctx.testQuiet.enabled = false;
  check(0, 30, 0, 1); // peak continues across midnight
  check(1, 0, 0, 3);
  check(1, 2, 0, 3600);
});

test('peak backup follows each main slot and respects its exact boundaries and priorities', () => {
  const ctx = quietScheduleContext();
  ctx.testQuiet.enabled = false;
  vm.runInContext(`reloadDelaySec = 3600;
    peakConfig = { enabled: true, hours: '8,10,12,15,17,20,23', durationMin: 1,
      reloadDelaySec: 1, backupDurationMin: 2, backupReloadDelaySec: 3 };`, ctx);
  const at = (h, m, s = 0) => { const date = localClock(h, m); date.setSeconds(s); return date; };
  for (const hour of [8,10,12,15,17,20,23]) {
    assert.equal(ctx.getReloadScheduleInfo(at(hour, 0, 59)).currentDelay, 1);
    assert.equal(ctx.getReloadScheduleInfo(at(hour, 1)).inBackup, true);
    assert.equal(ctx.getReloadScheduleInfo(at(hour, 1)).currentDelay, 3);
    assert.equal(ctx.getReloadDeadline(at(hour, 2, 59)) - at(hour, 2, 59).getTime(), 1000);
    assert.equal(ctx.getReloadScheduleInfo(at(hour, 3)).currentDelay, 3600);
  }
  for (const delay of [0.05, 0.1, 0.5]) {
    ctx.testBackupDelay = delay;
    vm.runInContext('peakConfig.backupReloadDelaySec = testBackupDelay', ctx);
    assert.equal(ctx.getReloadScheduleInfo(at(10, 1)).currentDelay, delay);
    assert.equal(ctx.getReloadDeadline(at(10, 1)) - at(10, 1).getTime(), delay * 1000);
  }
  vm.runInContext("peakConfig.backupDurationMin = 0", ctx);
  assert.equal(ctx.getReloadScheduleInfo(at(10, 1)).currentDelay, 3600);
  vm.runInContext("peakConfig.backupDurationMin = 65; peakConfig.hours = '10,11,23';", ctx);
  assert.equal(ctx.getReloadScheduleInfo(at(11, 0)).inPeak, true);
  assert.equal(ctx.getReloadScheduleInfo(at(0, 1)).inBackup, true);
  ctx.testQuiet.enabled = true;
  assert.equal(ctx.getReloadScheduleInfo(at(0, 1)).inQuiet, true);
  vm.runInContext("peakConfig.enabled = false", ctx);
  assert.equal(ctx.getReloadScheduleInfo(at(10, 1)).currentDelay, 3600);
});

test('countdown uses elapsed wall time when a timer wakes late', async () => {
  const ctx = scanCycleContext();
  vm.runInContext(`sleep = async ms => {
    cycleWaits.push(ms);
    advanceClock(ms === 1000 ? 5000 : ms);
  };`, ctx);
  await ctx.runCycle();
  assert.deepEqual([...ctx.cycleWaits], [400, 1000]);
  assert.equal(ctx.reloadRequests, 1);
});

test('quiet countdown is capped at its ending time', async () => {
  const ctx = scanCycleContext();
  ctx.fakeNow = Date.now();
  vm.runInContext(`
    var quietEnd = fakeNow + 2400;
    getReloadScheduleInfo = () => ({ inQuiet: true, currentDelay: 300, untilTime: quietEnd, currentSlotStr: '00:00 - 07:00' });
  `, ctx);
  ctx.Date = class extends Date { static now() { return ctx.fakeNow; } };
  await ctx.runCycle();
  assert.equal(ctx.reloadRequests, 1);
  assert.deepEqual([...ctx.cycleWaits], [400, 1000, 1000]);
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

test('timing logs use their own channel and clearing one channel keeps the other', async () => {
  const { ctx, state } = background();
  await ctx.queueLogWrite({ timestamp: 1, text: 'chu kỳ' });
  await ctx.queueLogWrite({ timestamp: 2, text: '⏱ timing' }, 'timingLogs');
  assert.deepEqual(Array.from(state.logs, entry => entry.text), ['chu kỳ']);
  assert.deepEqual(Array.from(state.timingLogs, entry => entry.text), ['⏱ timing']);
  await ctx.queueLogWrite(null, 'timingLogs');
  assert.equal(state.timingLogs.length, 0);
  assert.equal(state.logs.length, 1);
  assert.equal(vm.runInContext("logKeyOf('unknown')", ctx), 'logs');
});

test('cycle timing goes to the timing tab only when a post was liked/commented', () => {
  const ctx = content();
  const written = [];
  ctx.performance = { now: () => 5000, getEntriesByType: () => [] };
  ctx.captureLog = (text, key) => written.push({ text, key });
  vm.runInContext('logEntry = captureLog', ctx);
  vm.runInContext(`cycleTiming = { startedAt: 1300, timelineReadyAt: 1400, loadMs: 1400,
    loadMarks: [['byte đầu', 900], ['HTML', 1200], ['DOM', 1250], ['script', 1300], ['background', null], ['lịch sử', 1350], ['timeline', 1400]],
    tabHidden: true, posts: [{ index: 0, likeMs: 62, commentMs: 209, totalMs: 211 }, { index: 1, skipped: true }] }`, ctx);
  ctx.logCycleTiming(2000, '⚡ cao điểm 10:00 - 10:15 (còn 12 phút)');
  assert.equal(written.length, 1);
  assert.equal(written[0].key, 'timingLogs');
  // Không còn dòng con: chi tiết từng bài đã có trong Post Log.
  assert.equal(written[0].text, '⏱ Chu kỳ 5.00s | Tải trang 1.40s (byte đầu 0.90s → HTML 1.20s → DOM 1.25s → script 1.30s → lịch sử 1.35s → timeline 1.40s) | tab ẩn | Quét 0.60s | Chờ reload 3.00s (⚡ cao điểm 10:00 - 10:15 (còn 12 phút))');
  assert.equal(vm.runInContext('cycleTiming', ctx), null);

  // Chỉ bỏ qua bài cũ: ghi vào tab Chu kỳ & quét bài, kèm lý do phục hồi nếu có.
  vm.runInContext('cycleTiming = { startedAt: 1300, timelineReadyAt: 1400, loadMs: 1400, loadMarks: [["HTML", 1200]], posts: [{ index: 0, skipped: true }] }', ctx);
  ctx.logCycleTiming(2000, 'thường', 'timeline chưa sẵn sàng');
  assert.equal(written[1].key, 'logs');
  assert.equal(written[1].text, '⏱ Chu kỳ 5.00s | Tải trang 1.40s (HTML 1.20s) | Quét 0.60s | Chờ reload 3.00s (thường) | Phục hồi: timeline chưa sẵn sàng');

  // Chu kỳ không có reload trước đó: không báo thời gian tải trang, tổng tính từ đầu chu kỳ.
  vm.runInContext('cycleTiming = { startedAt: 4000, posts: [] }', ctx);
  ctx.logCycleTiming(4500);
  assert.equal(written[2].key, 'logs');
  assert.equal(written[2].text, '⏱ Chu kỳ 1.00s | Tải trang — (không reload trước chu kỳ này) | Quét 0.50s | Chờ reload 0.50s (thường)');
});

test('post log goes to the timing tab with comment split, clean link and a one-line summary in the cycle tab', async () => {
  const server = background({ isRunning: true, automationTabId: 7 });
  const ctx = handledPostContext(server, {
    link: 'https://www.facebook.com/permalink.php?story_fbid=pfbidABC123&id=777&__cft__[0]=AZtracking&__tn__=%2CO%2CP-R',
  });
  const written = [];
  ctx.captureLog = (text, key) => written.push({ text, key: key || 'logs' });
  vm.runInContext(`
    logEntry = captureLog;
    performLike = async () => { likeCalls++; return 386; };
    performCommentOnTextbox = async (container, textbox, text, onSubmitted) => {
      commentCalls++; onSubmitted();
      return { success: true, elapsed: 223, insertMs: 70, submitMs: 153 };
    };
  `, ctx);
  await ctx.runCycle();
  const postLog = written.find(entry => entry.text.startsWith('=== Bài 1'));
  assert.equal(postLog.key, 'timingLogs');
  const lines = postLog.text.split('\n');
  assert.equal(lines[0], '=== Bài 1 (post:pfbidABC123) — ✅ hoàn tất ===');
  assert.equal(lines[1], '- Link: https://www.facebook.com/permalink.php?story_fbid=pfbidABC123&id=777');
  assert.match(lines[2], /^- Thấy bài lúc: \d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(lines[3], '- Cách thực hiện: inline');
  assert.equal(lines[4], '- Like: chưa like → bấm, xác nhận 386ms');
  assert.equal(lines[5], '- Comment (mẫu #1): nhập 70ms → gửi và xác nhận 153ms');
  assert.match(lines[6], /^- Tổng: \d+ms \| Xong lúc \d{2}:\d{2}:\d{2}\.\d{3}$/);
  const summary = written.filter(entry => entry.key === 'logs').map(entry => entry.text);
  assert.ok(summary.includes('✅ Bài 1: đã like + comment (post:pfbidABC123) → xem tab Thời gian'));
  // Không còn log đếm ngược hay URL reload lặp lại.
  assert.ok(!written.some(entry => /^(⏳|ℹ|🔄 Đang reload)/.test(entry.text)));
});

test('already-liked check ignores case and stop logs only once', () => {
  const ctx = content();
  const written = [];
  ctx.captureLog = text => written.push(text);
  vm.runInContext('logEntry = captureLog; automationRunning = true', ctx);
  ctx.stopAutomation();
  ctx.stopAutomation();
  assert.deepEqual(written, ['⏹ Đã dừng tự động hóa.']);
  assert.match(read('content.js'), /\[aria-label\*="Gỡ Thích" i\]/);
  assert.equal(ctx.cleanPostLink('/page/posts/123/?__cft__[0]=x&__tn__=y#c'), 'https://www.facebook.com/page/posts/123/');
});
