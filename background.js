/**
 * background.js - Service Worker for FB Fanpage Auto Extension
 *
 * Trách nhiệm:
 *  - Relay message giữa popup và content script của đúng tab đang automation.
 *  - Ghim tabId ngay khi nhấn "Bắt đầu" → mọi thao tác chỉ tác dụng trên DUY NHẤT tab đó.
 *  - Ngăn discard tab đang chạy; content script giữ Web Lock để bảo vệ khỏi freezing.
 *  - Heartbeat khi automation hoạt động, alarm khôi phục khi service worker khởi động lại.
 *  - Cung cấp BACKGROUND_SLEEP để content script duy trì chạy đúng tốc độ ngay cả khi tab bị ẩn hoặc thu nhỏ.
 *  - Chặn media/ảnh CHỈ trên tab automation thông qua declarativeNetRequest tabIds, các tab khác load bình thường.
 *  - Quản lý vòng đời tab: tự dọn dẹp khi tab automation bị đóng.
 */

'use strict';

// ─── Resource Blocking (Chỉ áp dụng cho tab automation) ───────────────────────

const BLOCK_RULE_IDS = [101, 102, 103, 104, 105];

/**
 * Bật quy tắc chặn media/ảnh nặng CHỈ trên tab được chỉ định.
 * Các tab Facebook khác hoàn toàn không bị ảnh hưởng.
 * @param {number} tabId
 */
async function enableTabBlockRules(tabId, settings = {}) {
  const addRules = [];
  if (settings.blockImages !== false) {
    addRules.push({
      id: 102, priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: ['facebook.com', 'fbcdn.net'],
        // Giữ ảnh giao diện và emoji, chỉ chặn ảnh nội dung/avatar/tracking.
        excludedRequestDomains: ['static.xx.fbcdn.net'],
        resourceTypes: ['image'],
        tabIds: [tabId],
      },
    });
  }
  if (settings.blockVideos !== false) {
    addRules.push({
      id: 101, priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: ['facebook.com', 'fbcdn.net'],
        resourceTypes: ['media'],
        tabIds: [tabId],
      },
    }, {
      id: 103, priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: ['fbcdn.net'],
        // Video qua fetch/XHR rồi phát bằng blob không có resourceType media.
        regexFilter: '^https://(video[^/]*\\.fbcdn\\.net/|[^/]*\\.fbcdn\\.net/[^?]*\\.(mp4|webm|m4v|m3u8|mpd)(\\?|$))',
        resourceTypes: ['xmlhttprequest'],
        tabIds: [tabId],
      },
    });
  }
  // tabIds chỉ được Chrome hỗ trợ trong session rules.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: BLOCK_RULE_IDS, addRules });
}

async function disableTabBlockRules() {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: BLOCK_RULE_IDS });
}

let resourceRulesSync = Promise.resolve();
function syncResourceBlocking() {
  resourceRulesSync = resourceRulesSync.then(async () => {
    const state = await getStoredState();
    // Dọn các dynamic rules của phiên bản cũ trước khi dùng session rules.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: BLOCK_RULE_IDS });
    if (state.isRunning && Number.isInteger(state.automationTabId)) {
      await enableTabBlockRules(state.automationTabId, state);
    } else {
      await disableTabBlockRules();
    }
  }).catch(err => console.warn('[FB Auto] Không thể áp dụng chặn ảnh/video:', err));
  return resourceRulesSync;
}

// ─── Storage Helpers ──────────────────────────────────────────────────────────

function getStoredState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'automationTabId', 'isRunning', 'commentText', 'commentTemplates', 'reloadDelaySec',
        'originalUrl', 'targetIndices', 'peakConfig', 'backgroundGuardTab', 'blockImages', 'blockVideos'
      ],
      (res) => resolve(res || {})
    );
  });
}

// ─── Background Execution Guard ──────────────────────────────────────────────

const BACKGROUND_GUARD_ALARM = 'automation-background-guard';
let backgroundHeartbeat = null;
let backgroundGuardSync = Promise.resolve();

// Tuần tự hóa để một lượt kiểm tra cũ không bật lại bảo vệ sau khi đã dừng.
function syncBackgroundGuard() {
  backgroundGuardSync = backgroundGuardSync.then(async () => {
    const state = await getStoredState();
    const running = state.isRunning && Number.isInteger(state.automationTabId);
    let previous = state.backgroundGuardTab;

    if (previous && (!running || previous.id !== state.automationTabId)) {
      try {
        await chrome.tabs.update(previous.id, { autoDiscardable: previous.autoDiscardable });
      } catch (_) { /* Tab có thể đã đóng. */ }
      await chrome.storage.local.remove('backgroundGuardTab');
      previous = null;
    }

    if (!running) {
      clearInterval(backgroundHeartbeat);
      backgroundHeartbeat = null;
      await chrome.alarms.clear(BACKGROUND_GUARD_ALARM);
      return;
    }

    // Tạo lịch phục hồi trước khi gọi tabs API để lỗi tạm thời vẫn được thử lại.
    if (!await chrome.alarms.get(BACKGROUND_GUARD_ALARM)) {
      await chrome.alarms.create(BACKGROUND_GUARD_ALARM, { periodInMinutes: 0.5 });
    }
    // Các lời gọi extension API mỗi 20s giữ worker hoạt động trong ca automation.
    if (backgroundHeartbeat === null) {
      backgroundHeartbeat = setInterval(syncBackgroundGuard, 20000);
    }

    let tab;
    try { tab = await chrome.tabs.get(state.automationTabId); } catch (_) {}
    if (!tab) {
      clearInterval(backgroundHeartbeat);
      backgroundHeartbeat = null;
      await chrome.alarms.clear(BACKGROUND_GUARD_ALARM);
      await chrome.storage.local.remove('backgroundGuardTab');
      await chrome.storage.local.set({ isRunning: false, automationTabId: null });
      return;
    }

    if (!previous) {
      await chrome.storage.local.set({
        backgroundGuardTab: { id: tab.id, autoDiscardable: tab.autoDiscardable },
      });
    }
    await chrome.tabs.update(tab.id, { autoDiscardable: false });

  }).catch((err) => console.warn('[FB Auto] Background guard:', err));
  return backgroundGuardSync;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKGROUND_GUARD_ALARM) syncBackgroundGuard();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.isRunning || changes.automationTabId)) {
    syncBackgroundGuard();
  }
  if (area === 'local' && (changes.isRunning || changes.automationTabId || changes.blockImages || changes.blockVideos)) {
    syncResourceBlocking();
  }
});

// Chạy mỗi lần worker được đánh thức, không phụ thuộc popup còn mở hay không.
syncBackgroundGuard();
syncResourceBlocking();

/**
 * Gửi message đến content script của tab cụ thể.
 * Tự động inject content.js nếu script chưa có mặt.
 */
async function sendToTab(tabId, payload) {
  const trySend = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ __error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || {});
      }
    });
  });

  let resp = await trySend();

  if (resp && resp.__error) {
    const isConnErr = resp.__error.includes('Receiving end does not exist') ||
                      resp.__error.includes('Could not establish connection') ||
                      resp.__error.includes('No tab with id');
    if (isConnErr) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        await new Promise((r) => setTimeout(r, 600));
        resp = await trySend();
      } catch (e) {
        return { error: `Không thể inject content script: ${e.message}` };
      }
    }
    if (resp && resp.__error) return { error: resp.__error };
  }

  return resp;
}

// ─── Runtime Messaging ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // 1. Content script hỏi xem tab hiện tại có phải tab được phân công chạy không
  if (message.type === 'CHECK_SHOULD_RUN') {
    getStoredState().then((state) => {
      const senderTabId = sender.tab ? sender.tab.id : null;
      const isTargetTab = (senderTabId && senderTabId === state.automationTabId);
      const shouldRun   = Boolean(isTargetTab && state.isRunning);

      sendResponse({
        shouldRun,
        commentText:    state.commentText || '',
        commentTemplates: state.commentTemplates,
        reloadDelaySec: state.reloadDelaySec ?? 30,
        originalUrl:    state.originalUrl || '',
        targetIndices:  state.targetIndices || [0, 1],
        peakConfig:     state.peakConfig || null,
      });
    });
    return true;
  }

  // 2. Chế độ sleep từ background: chạy timer không bị Chrome bóp khi ẩn tab
  if (message.type === 'BACKGROUND_SLEEP') {
    const delay = Math.max(0, Number(message.ms) || 0);
    setTimeout(() => {
      sendResponse({ ok: true });
    }, delay);
    return true;
  }

  // 3. Popup lấy thông tin tab đang active
  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse(tabs && tabs[0]
        ? { tabId: tabs[0].id, url: tabs[0].url, title: tabs[0].title }
        : { tabId: null, url: null });
    });
    return true;
  }

  // 4. Relay command từ Popup tới Content script của tab automation
  if (message.type === 'RELAY_TO_CONTENT') {
    (async () => {
      const payload = message.payload;
      let targetTabId = null;

      if (payload.type === 'START_AUTOMATION') {
        // Lấy tab đang active tại thời điểm nhấn Bắt đầu
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.url || !activeTab.url.includes('facebook.com')) {
          sendResponse({ error: 'Vui lòng đang ở tab Facebook fanpage khi nhấn Bắt đầu.' });
          return;
        }

        targetTabId = activeTab.id;
        const pageUrl = activeTab.url;

        // Lưu thông tin tab automation và chính xác URL ban đầu vào storage
        await chrome.storage.local.set({
          automationTabId: targetTabId,
          isRunning: true,
          originalUrl: pageUrl,
        });

        // Gắn originalUrl vào payload gửi sang content script
        payload.originalUrl = pageUrl;

        // Bật chặn tài nguyên chỉ cho riêng tab này
        await syncResourceBlocking();

        await syncBackgroundGuard();

      } else {
        // Với STOP_AUTOMATION hoặc các lệnh khác: gửi đến đúng tab automation đã lưu
        const state = await getStoredState();
        targetTabId = state.automationTabId;

        if (!targetTabId) {
          sendResponse({ error: 'Không tìm thấy tab automation nào đang hoạt động.' });
          return;
        }

        if (payload.type === 'STOP_AUTOMATION') {
          await chrome.storage.local.set({ isRunning: false, automationTabId: null });
          await syncResourceBlocking();
          await syncBackgroundGuard();
        }
      }

      // Kiểm tra tab còn tồn tại không
      let tab;
      try { tab = await chrome.tabs.get(targetTabId); } catch (_) { tab = null; }
      if (!tab) {
        await chrome.storage.local.set({ isRunning: false, automationTabId: null });
        await syncResourceBlocking();
        sendResponse({ error: 'Tab automation không còn tồn tại hoặc đã bị đóng.' });
        return;
      }

      const resp = await sendToTab(targetTabId, payload);
      sendResponse(resp);
    })();
    return true;
  }

  // 5. Lưu log từ content script vào storage
  if (message.type === 'LOG_FROM_CONTENT') {
    chrome.storage.local.get(['logs'], (result) => {
      const logs = result.logs || [];
      logs.push({ timestamp: Date.now(), text: message.text });
      chrome.storage.local.set({ logs: logs.slice(-300) });
    });
  }
});

// ─── Tab Lifecycle Management ─────────────────────────────────────────────────

// Khi tab bị đóng: nếu đúng là tab automation thì dọn dẹp state và bỏ chặn
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  const state = await getStoredState();
  if (closedTabId === state.automationTabId) {
    console.log('[FB Auto] Tab automation đã đóng. Đang dọn dẹp trạng thái…');
    await chrome.storage.local.set({ isRunning: false, automationTabId: null });
    await syncResourceBlocking();
  }
});

// ─── Install Handler ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    commentText: '',
    commentTemplates: [],
    reloadDelaySec: 30,
    blockImages: true,
    blockVideos: true,
    originalUrl: '',
    logs: [],
  };
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => stored[key] === undefined));
  if (stored.commentTemplates === undefined && stored.commentText?.trim()) {
    missing.commentTemplates = [stored.commentText];
  }
  await chrome.storage.local.set({
    ...missing,
    isRunning: false,
    automationTabId: null,
  });
  await syncResourceBlocking();
  console.log('[FB Fanpage Auto] Đã cài đặt extension thành công.');
});
