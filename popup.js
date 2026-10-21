/**
 * popup.js – Popup UI controller for FB Fanpage Auto v1.1
 *
 * - Load / save settings (commentText, reloadDelaySec) từ chrome.storage.local
 * - Toggle automation start/stop bằng cách relay message tới content script
 * - Render log entries dạng div có color-coding thay vì plain textarea
 * - Hỗ trợ xem log đầy đủ qua modal
 */

'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const commentList      = document.getElementById('comment-list');
const addCommentBtn    = document.getElementById('add-comment-btn');
const emojiGrid        = document.getElementById('emoji-grid');
const blockImagesEl    = document.getElementById('block-images');
const blockVideosEl    = document.getElementById('block-videos');
const reloadDelayEl    = document.getElementById('reload-delay');
const modeLimitRadio   = document.getElementById('mode-limit');
const modeCustomRadio  = document.getElementById('mode-custom');
const postLimitEl      = document.getElementById('post-limit');
const customPostsEl    = document.getElementById('custom-posts');
const peakEnableEl     = document.getElementById('peak-enable');
const peakHoursEl      = document.getElementById('peak-hours');
const peakDurationEl   = document.getElementById('peak-duration');
const peakReloadDelayEl= document.getElementById('peak-reload-delay');
const peakSettingsBox  = document.getElementById('peak-settings-box');
const toggleBtn        = document.getElementById('toggle-btn');
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const logArea          = document.getElementById('log-area');
const clearLogBtn      = document.getElementById('clear-log-btn');
const expandLogBtn     = document.getElementById('expand-log-btn');
const logModal         = document.getElementById('log-modal');
const logModalArea     = document.getElementById('log-modal-area');
const closeModalBtn    = document.getElementById('close-modal-btn');
const modalClearBtn    = document.getElementById('modal-clear-btn');
const modalCopyBtn     = document.getElementById('modal-copy-btn');

// ─── State ────────────────────────────────────────────────────────────────────
let isRunning       = false;
let logPollTimer    = null;
let lastLogCount    = 0;
let allLogs         = [];
let automationTabId = null;   // tabId đang chạy automation
let activeCommentInput = null;
let nextCommentId = 0;

function getCommentTemplates() {
  return Array.from(commentList.querySelectorAll('textarea'), input => input.value.trim()).filter(Boolean);
}

function saveComments() {
  const drafts = Array.from(commentList.querySelectorAll('textarea'), input => input.value);
  return chrome.storage.local.set({ commentTemplates: drafts, commentText: getCommentTemplates()[0] || '' });
}

function updateCommentLabels() {
  const cards = commentList.querySelectorAll('.comment-card');
  cards.forEach((card, index) => {
    card.querySelector('label').textContent = `Bình luận ${index + 1}`;
    const remove = card.querySelector('button');
    remove.disabled = cards.length === 1;
    remove.setAttribute('aria-label', `Xóa bình luận ${index + 1}`);
  });
}

function addCommentInput(value = '', focus = false) {
  const card = document.createElement('div');
  card.className = 'comment-card';
  const header = document.createElement('div');
  header.className = 'comment-card-header';
  const input = document.createElement('textarea');
  input.id = `comment-template-${++nextCommentId}`;
  input.rows = 2;
  input.placeholder = 'Nhập nội dung, có thể xuống dòng và dùng emoji…';
  input.value = value;
  const label = document.createElement('label');
  label.htmlFor = input.id;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-icon-text remove-comment';
  remove.textContent = 'Xóa';
  remove.addEventListener('click', () => {
    card.remove();
    if (activeCommentInput === input) {
      activeCommentInput = commentList.querySelector('textarea');
      activeCommentInput?.focus();
    }
    updateCommentLabels();
    saveComments();
  });
  input.addEventListener('focus', () => { activeCommentInput = input; });
  input.addEventListener('input', saveComments);
  header.append(label, remove);
  card.append(header, input);
  commentList.appendChild(card);
  if (!activeCommentInput) activeCommentInput = input;
  updateCommentLabels();
  if (focus) input.focus();
}

function initEmojiPicker() {
  const emojis = [
    ['😀', 'Vui vẻ'], ['😃', 'Cười tươi'], ['😄', 'Cười rạng rỡ'], ['😁', 'Cười toe'],
    ['😆', 'Cười lớn'], ['😅', 'Cười ngượng'], ['😂', 'Cười ra nước mắt'], ['🤣', 'Cười lăn'],
    ['😊', 'Mỉm cười'], ['🥰', 'Yêu thương'], ['😍', 'Mắt trái tim'], ['😘', 'Gửi nụ hôn'],
    ['😉', 'Nháy mắt'], ['😎', 'Kính râm'], ['🤩', 'Ngưỡng mộ'], ['🥳', 'Ăn mừng'],
    ['🥹', 'Xúc động'], ['😢', 'Buồn'], ['😭', 'Khóc'], ['😮', 'Ngạc nhiên'],
    ['😡', 'Giận'], ['🤔', 'Suy nghĩ'], ['👍', 'Thích'], ['👎', 'Không thích'],
    ['👏', 'Vỗ tay'], ['🙌', 'Hoan hô'], ['🙏', 'Cảm ơn'], ['💪', 'Cố lên'],
    ['❤️', 'Trái tim'], ['💖', 'Trái tim lấp lánh'], ['💕', 'Hai trái tim'], ['🔥', 'Lửa'],
    ['🎉', 'Chúc mừng'], ['🎁', 'Quà tặng'], ['🌹', 'Hoa hồng'], ['✨', 'Lấp lánh'],
    ['⭐', 'Ngôi sao'], ['💯', 'Một trăm điểm'], ['✅', 'Đồng ý'], ['🍀', 'May mắn'],
    ['🤝', 'Bắt tay'], ['🫶', 'Tay trái tim'],
  ];
  for (const [emoji, name] of emojis) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emoji-button';
    button.textContent = emoji;
    button.title = name;
    button.setAttribute('aria-label', `Chèn ${name}`);
    button.addEventListener('click', () => {
      const input = activeCommentInput?.isConnected ? activeCommentInput : commentList.querySelector('textarea');
      if (!input) return;
      input.setRangeText(emoji, input.selectionStart, input.selectionEnd, 'end');
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    emojiGrid.appendChild(button);
  }
}

function parseReloadDelay(value, fallback) {
  const number = Number(value);
  return String(value).trim() !== '' && Number.isFinite(number) ? Math.max(0, number) : fallback;
}

// ─── Log utilities ────────────────────────────────────────────────────────────

/**
 * Xác định "cấp" log dựa trên nội dung text để color-code.
 * @param {string} text
 * @returns {string} CSS class suffix
 */
function detectLogLevel(text) {
  if (text.startsWith('⚠') || text.startsWith('⏳') )   return 'warn';
  if (text.startsWith('✅') || text.startsWith('▶'))     return 'ok';
  if (text.startsWith('⏹') || text.startsWith('🔄'))    return 'reload';
  if (text.startsWith('ℹ') || text.startsWith('=== Post')) return 'sep';
  if (text.startsWith('❌') || text.includes('thất bại')) return 'error';
  return 'info';
}

/**
 * Tạo một DOM element log entry.
 * @param {{ timestamp: number, text: string }} entry
 * @returns {HTMLElement}
 */
function createLogEntry(entry) {
  const level = detectLogLevel(entry.text);
  const ts    = new Date(entry.timestamp).toLocaleTimeString('vi-VN', { hour12: false });

  const row  = document.createElement('div');
  row.className = `log-entry log-${level}`;

  const tsEl = document.createElement('span');
  tsEl.className = 'log-ts';
  tsEl.textContent = ts;

  const txtEl = document.createElement('span');
  txtEl.className = 'log-text';
  txtEl.textContent = entry.text;

  row.appendChild(tsEl);
  row.appendChild(txtEl);
  return row;
}

/**
 * Append một log entry vào container, auto-scroll xuống cuối.
 * @param {HTMLElement} container
 * @param {{ timestamp: number, text: string }} entry
 */
function appendEntry(container, entry) {
  const el = createLogEntry(entry);
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

/**
 * Render toàn bộ log entries vào một container (xóa cũ trước).
 * @param {HTMLElement} container
 * @param {Array} entries
 */
function renderAllLogs(container, entries) {
  container.innerHTML = '';
  entries.forEach((e) => appendEntry(container, e));
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setRunningUI(running, tabInfo) {
  isRunning = running;
  if (running) {
    toggleBtn.textContent  = '⏹ Dừng lại';
    toggleBtn.className    = 'btn btn-stop';
    statusDot.className    = 'status-dot running';
    // Hiển thị tab đang automation (nếu có thông tin)
    statusText.textContent = tabInfo
      ? `Đang chạy – Tab #${tabInfo.id}${tabInfo.title ? ': ' + tabInfo.title.slice(0,25) : ''}`
      : 'Đang chạy…';
  } else {
    toggleBtn.textContent  = '▶ Bắt đầu';
    toggleBtn.className    = 'btn btn-start';
    statusDot.className    = 'status-dot stopped';
    statusText.textContent = 'Đã dừng';
    automationTabId        = null;
  }
}

/**
 * Thêm 1 entry log vào UI (cả popup lẫn modal nếu đang mở).
 */
function pushEntryToUI(entry) {
  allLogs.push(entry);
  appendEntry(logArea, entry);
  // Nếu modal đang mở → cũng append vào đó
  if (!logModal.classList.contains('hidden')) {
    appendEntry(logModalArea, entry);
  }
}

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendToContent(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });
}

// ─── Log polling ──────────────────────────────────────────────────────────────

function pollLogs() {
  chrome.storage.local.get(['logs'], (result) => {
    const logs = result.logs || [];
    if (logs.length > lastLogCount) {
      const newEntries = logs.slice(lastLogCount);
      newEntries.forEach((entry) => pushEntryToUI(entry));
      lastLogCount = logs.length;
    }
  });
}

function startLogPolling() {
  if (logPollTimer) return;
  logPollTimer = setInterval(pollLogs, 1200);
}

function stopLogPolling() {
  if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
}

/**
 * Tính toán danh sách index bài viết cần xử lý dựa trên cấu hình người dùng.
 * @returns {number[]} Mảng các số nguyên đại diện cho thứ tự bài (0 = bài 1, 1 = bài 2...)
 */
function getTargetIndices() {
  const isLimit = modeLimitRadio.checked;
  if (isLimit) {
    const limit = Math.max(1, parseInt(postLimitEl.value, 10) || 2);
    return Array.from({ length: limit }, (_, i) => i);
  } else {
    const str = customPostsEl.value.trim();
    if (!str) return [0];
    const parts = str.split(/[,;\s]+/);
    const indices = [];
    for (const part of parts) {
      if (!part) continue;
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(x => parseInt(x, 10));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
            if (i >= 0 && !indices.includes(i)) indices.push(i);
          }
        }
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n) && n >= 0 && !indices.includes(n)) {
          indices.push(n);
        }
      }
    }
    return indices.length > 0 ? indices : [0];
  }
}

// ─── Helpers: Khung giờ cao điểm ──────────────────────────────────────────────

function updatePeakUI(enabled) {
  peakEnableEl.checked = enabled;
  if (enabled) {
    peakSettingsBox.classList.remove('disabled');
  } else {
    peakSettingsBox.classList.add('disabled');
  }
}

function getPeakConfig() {
  return {
    enabled: peakEnableEl.checked,
    hours: peakHoursEl.value.trim() || '10, 12, 15, 17, 20',
    durationMin: Math.max(1, parseInt(peakDurationEl.value, 10) || 15),
    reloadDelaySec: parseReloadDelay(peakReloadDelayEl.value, 15),
  };
}

function savePeakConfig() {
  chrome.storage.local.set({ peakConfig: getPeakConfig() });
}

// ─── Initialization ───────────────────────────────────────────────────────────

function init() {
  chrome.storage.local.get([
    'commentText', 'commentTemplates', 'reloadDelaySec', 'targetMode', 'postLimit', 'customPosts',
    'peakConfig', 'isRunning', 'automationTabId', 'logs', 'blockImages', 'blockVideos'
  ], async (result) => {
    // Restore settings
    const templates = Array.isArray(result.commentTemplates) && result.commentTemplates.length
      ? result.commentTemplates.filter(text => typeof text === 'string') : [result.commentText || ''];
    (templates.length ? templates : ['']).forEach(text => addCommentInput(text));
    blockImagesEl.checked = result.blockImages !== false;
    blockVideosEl.checked = result.blockVideos !== false;
    if (result.reloadDelaySec != null) reloadDelayEl.value = result.reloadDelaySec;
    if (result.postLimit != null)      postLimitEl.value   = result.postLimit;
    if (result.customPosts != null)    customPostsEl.value = result.customPosts;

    if (result.targetMode === 'custom') {
      modeCustomRadio.checked = true;
    } else {
      modeLimitRadio.checked  = true;
    }

    // Restore Peak Hours settings
    const peakConfig  = result.peakConfig || {};
    const peakEnabled = peakConfig.enabled !== false;
    updatePeakUI(peakEnabled);
    if (peakConfig.hours)              peakHoursEl.value       = peakConfig.hours;
    if (peakConfig.durationMin != null) peakDurationEl.value   = peakConfig.durationMin;
    if (peakConfig.reloadDelaySec != null) peakReloadDelayEl.value = peakConfig.reloadDelaySec;

    // Restore all logs
    const logs = result.logs || [];
    lastLogCount = logs.length;
    allLogs      = [...logs];
    renderAllLogs(logArea, logs);

    // Kiểm tra tab automation còn tồn tại không
    let tabInfo = null;
    if (result.isRunning && result.automationTabId) {
      try {
        tabInfo = await chrome.tabs.get(result.automationTabId);
        automationTabId = result.automationTabId;
      } catch (_) {
        // Tab đã bị đóng → dọn state
        await chrome.storage.local.set({ isRunning: false, automationTabId: null });
        result.isRunning = false;
      }
    }

    setRunningUI(!!result.isRunning, tabInfo);
    if (result.isRunning) startLogPolling();
  });
}

// ─── Events ───────────────────────────────────────────────────────────────────

// Save settings on change
addCommentBtn.addEventListener('click', () => {
  addCommentInput('', true);
  saveComments();
});

[blockImagesEl, blockVideosEl].forEach(input => input.addEventListener('change', () => {
  chrome.storage.local.set({ blockImages: blockImagesEl.checked, blockVideos: blockVideosEl.checked });
}));

reloadDelayEl.addEventListener('change', () => {
  const val = parseReloadDelay(reloadDelayEl.value, 30);
  reloadDelayEl.value = val;
  chrome.storage.local.set({ reloadDelaySec: val });
});

postLimitEl.addEventListener('change', () => {
  const val = Math.max(1, parseInt(postLimitEl.value, 10) || 2);
  postLimitEl.value = val;
  modeLimitRadio.checked = true;
  chrome.storage.local.set({ postLimit: val, targetMode: 'limit' });
});

postLimitEl.addEventListener('focus', () => {
  modeLimitRadio.checked = true;
  chrome.storage.local.set({ targetMode: 'limit' });
});

customPostsEl.addEventListener('input', () => {
  modeCustomRadio.checked = true;
  chrome.storage.local.set({ customPosts: customPostsEl.value, targetMode: 'custom' });
});

customPostsEl.addEventListener('focus', () => {
  modeCustomRadio.checked = true;
  chrome.storage.local.set({ targetMode: 'custom' });
});

modeLimitRadio.addEventListener('change', () => {
  if (modeLimitRadio.checked) chrome.storage.local.set({ targetMode: 'limit' });
});

modeCustomRadio.addEventListener('change', () => {
  if (modeCustomRadio.checked) chrome.storage.local.set({ targetMode: 'custom' });
});

peakEnableEl.addEventListener('change', () => {
  updatePeakUI(peakEnableEl.checked);
  savePeakConfig();
});

[peakHoursEl, peakDurationEl, peakReloadDelayEl].forEach(el => {
  el.addEventListener('change', savePeakConfig);
});

// Start / Stop toggle
toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;

  const commentTemplates = getCommentTemplates();
  const commentTextVal  = commentTemplates[0] || '';
  const reloadDelaySec  = parseReloadDelay(reloadDelayEl.value, 30);
  const targetMode      = modeCustomRadio.checked ? 'custom' : 'limit';
  const postLimit       = Math.max(1, parseInt(postLimitEl.value, 10) || 2);
  const customPosts     = customPostsEl.value.trim();
  const targetIndices   = getTargetIndices();
  const peakConfig      = getPeakConfig();

  if (!isRunning) {
    if (!commentTextVal) {
      alert('Vui lòng nhập nội dung bình luận trước khi bắt đầu.');
      toggleBtn.disabled = false;
      return;
    }

    await chrome.storage.local.set({
      commentText: commentTextVal,
      commentTemplates,
      blockImages: blockImagesEl.checked,
      blockVideos: blockVideosEl.checked,
      reloadDelaySec,
      targetMode,
      postLimit,
      customPosts,
      targetIndices,
      peakConfig,
      isRunning: true
    });

    const resp = await sendToContent({
      type: 'START_AUTOMATION',
      commentText: commentTextVal,
      commentTemplates,
      reloadDelaySec,
      targetIndices,
      peakConfig,
    });
    if (resp && resp.error) {
      pushEntryToUI({ timestamp: Date.now(), text: `⚠ Lỗi: ${resp.error}` });
      await chrome.storage.local.set({ isRunning: false, automationTabId: null });
      toggleBtn.disabled = false;
      return;
    }

    // Lấy thông tin tab vừa được ghim để cập nhật UI
    chrome.storage.local.get(['automationTabId'], async (st) => {
      let tabInfo = null;
      if (st.automationTabId) {
        try { tabInfo = await chrome.tabs.get(st.automationTabId); } catch (_) {}
      }
      setRunningUI(true, tabInfo);
    });

    startLogPolling();
    pushEntryToUI({ timestamp: Date.now(), text: '▶ Đã bắt đầu tự động hóa.' });
  } else {
    await chrome.storage.local.set({ isRunning: false });
    const resp = await sendToContent({ type: 'STOP_AUTOMATION' });
    if (resp && resp.error) {
      pushEntryToUI({ timestamp: Date.now(), text: `⚠ Lỗi khi dừng: ${resp.error}` });
    }
    setRunningUI(false);
    stopLogPolling();
    pushEntryToUI({ timestamp: Date.now(), text: '⏹ Đã dừng tự động hóa.' });
  }

  toggleBtn.disabled = false;
});

// Clear log
function clearAllLogs() {
  allLogs = [];
  lastLogCount = 0;
  logArea.innerHTML      = '';
  logModalArea.innerHTML = '';
  chrome.storage.local.set({ logs: [] });
}

clearLogBtn.addEventListener('click', clearAllLogs);
modalClearBtn.addEventListener('click', clearAllLogs);

// Expand log modal
expandLogBtn.addEventListener('click', () => {
  renderAllLogs(logModalArea, allLogs);
  logModal.classList.remove('hidden');
});

closeModalBtn.addEventListener('click', () => {
  logModal.classList.add('hidden');
});

// Close modal on overlay click
logModal.addEventListener('click', (e) => {
  if (e.target === logModal) logModal.classList.add('hidden');
});

// Copy log in modal
modalCopyBtn.addEventListener('click', () => {
  const text = allLogs.map((e) => {
    const ts = new Date(e.timestamp).toLocaleTimeString('vi-VN', { hour12: false });
    return `[${ts}] ${e.text}`;
  }).join('\n');

  navigator.clipboard.writeText(text).then(() => {
    modalCopyBtn.textContent = '✅ Đã copy!';
    setTimeout(() => { modalCopyBtn.innerHTML = '📋 Copy tất cả'; }, 2000);
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
initEmojiPicker();
init();
