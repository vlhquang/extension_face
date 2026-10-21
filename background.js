/**
 * background.js - Service Worker for FB Fanpage Auto Extension
 *
 * Trách nhiệm:
 *  - Relay message giữa popup và content script của đúng tab đang automation.
 *  - Ghim tabId ngay khi nhấn "Bắt đầu" → mọi thao tác chỉ tác dụng trên DUY NHẤT tab đó.
 *  - Giữ tab không bị Chrome discard/đóng băng khi người dùng chuyển sang tab khác (autoDiscardable: false).
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
async function enableTabBlockRules(tabId) {
  if (!tabId) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: BLOCK_RULE_IDS,
      addRules: [
        {
          id: 101, priority: 1,
          action: { type: 'block' },
          condition: {
            urlFilter: '*.fbcdn.net/*',
            resourceTypes: ['media'],
            tabIds: [tabId],
          },
        },
        {
          id: 102, priority: 1,
          action: { type: 'block' },
          condition: {
            urlFilter: 'scontent*.fbcdn.net/*',
            resourceTypes: ['image'],
            tabIds: [tabId],
          },
        },
        {
          id: 103, priority: 1,
          action: { type: 'block' },
          condition: {
            urlFilter: '||fonts.gstatic.com^',
            resourceTypes: ['font'],
            tabIds: [tabId],
          },
        },
        {
          id: 104, priority: 1,
          action: { type: 'block' },
          condition: {
            urlFilter: '*/tr?*',
            resourceTypes: ['ping', 'image'],
            tabIds: [tabId],
          },
        },
        {
          id: 105, priority: 1,
          action: { type: 'block' },
          condition: {
            urlFilter: 'static.xx.fbcdn.net/rsrc.php/*',
            resourceTypes: ['image'],
            tabIds: [tabId],
          },
        },
      ],
    });
  } catch (err) {
    console.warn('[FB Auto] Failed to update dynamic rules:', err);
  }
}

/**
 * Xóa toàn bộ quy tắc chặn tài nguyên.
 */
async function disableTabBlockRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: BLOCK_RULE_IDS,
    });
  } catch (_) {}
}

// ─── Storage Helpers ──────────────────────────────────────────────────────────

function getStoredState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'automationTabId', 'isRunning', 'commentText', 'reloadDelaySec',
        'originalUrl', 'targetIndices', 'peakConfig'
      ],
      (res) => resolve(res || {})
    );
  });
}

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
        reloadDelaySec: state.reloadDelaySec || 30,
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
        await enableTabBlockRules(targetTabId);

        // Ngăn chặn Chrome tự động đóng băng/discard tab này khi người dùng chuyển sang tab khác
        try {
          await chrome.tabs.update(targetTabId, { autoDiscardable: false });
        } catch (_) {}

      } else {
        // Với STOP_AUTOMATION hoặc các lệnh khác: gửi đến đúng tab automation đã lưu
        const state = await getStoredState();
        targetTabId = state.automationTabId;

        if (!targetTabId) {
          sendResponse({ error: 'Không tìm thấy tab automation nào đang hoạt động.' });
          return;
        }

        if (payload.type === 'STOP_AUTOMATION') {
          await disableTabBlockRules();
          await chrome.storage.local.set({ isRunning: false, automationTabId: null });
        }
      }

      // Kiểm tra tab còn tồn tại không
      let tab;
      try { tab = await chrome.tabs.get(targetTabId); } catch (_) { tab = null; }
      if (!tab) {
        await disableTabBlockRules();
        await chrome.storage.local.set({ isRunning: false, automationTabId: null });
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
    await disableTabBlockRules();
    await chrome.storage.local.set({ isRunning: false, automationTabId: null });
  }
});

// ─── Install Handler ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await disableTabBlockRules();
  chrome.storage.local.set({
    commentText: '',
    reloadDelaySec: 30,
    isRunning: false,
    automationTabId: null,
    originalUrl: '',
    logs: [],
  });
  console.log('[FB Fanpage Auto] Đã cài đặt extension thành công.');
});
