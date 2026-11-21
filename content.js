/**
 * content.js – Core automation logic for FB Fanpage Auto
 *
 * Injected into Facebook pages.
 *
 * Đảm bảo:
 *  - Chỉ chạy trên DUY NHẤT tab được chỉ định (hỏi background CHECK_SHOULD_RUN khi load).
 *  - Các tab khác giữ trạng thái ngủ hoàn toàn, không can thiệp vào Facebook của người dùng.
 *  - Sử dụng BACKGROUND_SLEEP để giữ đúng nhịp độ ngay cả khi người dùng chuyển tab,
 *    thu nhỏ cửa sổ hoặc ẩn giao diện.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let automationRunning = false;
let isLoopRunning     = false;
let commentText       = '';
let commentTemplates  = [];
let requireExistingComment = false;
let requirePositiveComments = false;
let commentCountDelaySec = 0;
const postCommentChoices = new Map();
const postActionProgress = new Map();
let reloadDelaySec    = 30;
let originalUrl       = '';
let targetIndices     = [0, 1]; // Danh sách các bài cần quét (mặc định: 0, 1)
let cancelTimelineWait = null;
// Đo thời gian theo chu kỳ, ghi vào kênh log riêng (timingLogs).
// Chỉ đo tải trang khi trang này do extension reload, không phải trang mở trước khi bấm Bắt đầu.
let resumedAfterReload = false;
let pageLoadMeasured = false;
let cycleTiming = null;
// Các mốc chỉ ghi performance.now() (không await, không gửi message) nên không làm chậm luồng xử lý.
const scriptInjectedAt = performance.now();
let tabHiddenDuringLoad = !!globalThis.document?.hidden;
globalThis.document?.addEventListener?.('visibilitychange', () => {
  if (document.hidden && !pageLoadMeasured) tabHiddenDuringLoad = true;
});
let shouldRunRepliedAt = null;
let quietHoursConfig = {
  enabled: true,
  startTime: '00:00',
  endTime: '07:00',
  reloadDelaySec: 300,
};

// Cấu hình khung giờ cao điểm (mặc định: 10, 12, 15, 17, 20h)
let peakConfig = {
  enabled: true,
  hours: '10, 12, 15, 17, 20',
  durationMin: 15,
  reloadDelaySec: 15,
  backupDurationMin: 2,
  backupReloadDelaySec: 3,
};

// Cache ID bài đã xử lý; dữ liệu gốc nằm trong chrome.storage.local.
const processedPostLinks = new Set();
const commentedPostLinks = new Set();
let processedHistoryGeneration = 0;
let processedHistoryCacheVersion = 0;
let processedHistoryReady = null;
let peakProgress = null;

function requestPostHistory(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, response => {
      const error = chrome.runtime.lastError?.message || response?.error;
      if (error || !response?.ok) reject(new Error(error || 'Không đọc/ghi được dữ liệu bài đã xử lý.'));
      else resolve(response);
    });
  });
}

function applyProcessedPostHistory(history) {
  if (!history || !Array.isArray(history.keys) || history.generation < processedHistoryGeneration) return;
  if (history.generation !== processedHistoryGeneration) {
    postCommentChoices.clear();
    postActionProgress.clear();
  }
  processedHistoryGeneration = history.generation;
  peakProgress = history.peakProgress || null;
  processedHistoryCacheVersion++;
  processedPostLinks.clear();
  for (const key of history.keys) processedPostLinks.add(key);
  commentedPostLinks.clear();
  for (const key of history.commentedKeys || []) commentedPostLinks.add(key);
}

function loadProcessedPostHistory() {
  if (!processedHistoryReady) {
    const version = processedHistoryCacheVersion;
    processedHistoryReady = requestPostHistory('GET_PROCESSED_POSTS').then(response => {
      // Không để kết quả đọc cũ ghi đè một sự kiện xóa/lưu mới hơn.
      if (version === processedHistoryCacheVersion) applyProcessedPostHistory(response.history);
    }).catch(err => {
      processedHistoryReady = null;
      throw err;
    });
  }
  return processedHistoryReady;
}

async function rememberProcessedPost(key, generation, completedSlot) {
  if (!key) return; // Không lưu chỉ số TimelineFeedUnit: vị trí có thể đổi sau reload.
  const response = await requestPostHistory('MARK_POST_PROCESSED', { key, generation, completedSlot });
  if (response.saved && response.generation === processedHistoryGeneration) {
    processedPostLinks.add(key);
    commentedPostLinks.delete(key);
    peakProgress = response.peakProgress || peakProgress;
    if (completedSlot && peakProgress?.slotId === completedSlot) {
      const target = Math.max(1, parseInt(peakConfig.successPostTarget, 10) || 1);
      logEntry(`✅ Cao điểm: ${peakProgress.keys.length}/${target} bài mới đã like và comment thành công${peakProgress.keys.length >= target ? ' → dùng chu kỳ reload backup.' : '.'}`);
    }
  }
}

// Chỉ dùng ID từ permalink; bỏ tracking/comment_id và sự khác nhau giữa m./www.
function getPostKey(link) {
  try {
    const url = new URL(link, 'https://www.facebook.com');
    if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null;
    const postId = url.searchParams.get('story_fbid') ||
      url.pathname.match(/\/(?:posts|permalink)\/([A-Za-z0-9]+)(?:\/|$)/)?.[1];
    if (postId && /^[A-Za-z0-9]+$/.test(postId)) return `post:${postId}`;
    const videoId = url.pathname.match(/\/(?:videos|reel)\/(?:[^/]+\/)?(\d+)(?:\/|$)/)?.[1] ||
      (/^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') : null);
    if (videoId && /^\d+$/.test(videoId)) return `video:${videoId}`;
    const photoId = url.pathname.includes('/photos/')
      ? url.pathname.match(/\/(\d+)\/?$/)?.[1]
      : /^\/photo(?:\.php)?\/?$/.test(url.pathname) ? url.searchParams.get('fbid') : null;
    if (photoId && /^\d+$/.test(photoId)) return `photo:${photoId}`;
  } catch (_) {}
  return null;
}

// Bỏ tham số theo dõi (__cft__[0], __tn__…) để link trong log ngắn và ổn định.
function cleanPostLink(link) {
  try {
    const url = new URL(link, 'https://www.facebook.com');
    for (const name of [...url.searchParams.keys()]) {
      if (name.startsWith('__')) url.searchParams.delete(name);
    }
    url.hash = '';
    return url.href;
  } catch (_) {
    return link;
  }
}

function formatClock(ms) {
  const d = new Date(ms);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function getCommentForPost(postLink) {
  if (!postCommentChoices.has(postLink)) {
    const choices = commentTemplates.length ? commentTemplates : [commentText];
    postCommentChoices.set(postLink, choices[Math.floor(Math.random() * choices.length)]);
  }
  return postCommentChoices.get(postLink);
}

function parseReloadDelay(value, fallback) {
  const number = Number(value);
  return value != null && String(value).trim() !== '' && Number.isFinite(number)
    ? Math.max(0, number) : fallback;
}

// Giữ Web Lock chỉ trong ca automation. Chrome dùng trạng thái này để tránh
// đóng băng tab khi chạy nền (khác với autoDiscardable của Memory Saver).
let automationLockController = null;

function acquireAutomationLock() {
  if (automationLockController) return;
  if (!navigator.locks) {
    logEntry('⚠ Trình duyệt không hỗ trợ Web Locks; tab vẫn có thể bị đóng băng.');
    return;
  }

  const controller = new AbortController();
  automationLockController = controller;
  navigator.locks.request('fb-fanpage-auto-running', {
    mode: 'shared',
    signal: controller.signal,
  }, async () => {
    if (controller.signal.aborted || !automationRunning) return;
    await new Promise((resolve) => {
      controller.signal.addEventListener('abort', resolve, { once: true });
    });
  }).catch((err) => {
    if (err.name !== 'AbortError') {
      logEntry(`⚠ Không thể giữ Web Lock cho tab chạy nền: ${err.message}`);
    }
  }).finally(() => {
    if (automationLockController === controller) automationLockController = null;
  });
}

function releaseAutomationLock() {
  const controller = automationLockController;
  automationLockController = null;
  if (controller) controller.abort();
}

// ─── Utility: Tính toán thời gian reload theo khung giờ cao điểm ───────────────

/**
 * Chọn lịch theo thứ tự ưu tiên: ít bài, cao điểm, bình thường.
 * Dùng giờ địa phương; khoảng ít bài bao gồm giờ bắt đầu, không bao gồm giờ kết thúc.
 * @returns {{ inQuiet?: boolean, inPeak: boolean, currentDelay: number, currentSlotStr: string, untilTime?: number }}
 */
function parseClockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getReloadScheduleInfo(now = new Date()) {
  const currentMinsOfDay = now.getHours() * 60 + now.getMinutes();
  const start = parseClockMinutes(quietHoursConfig?.startTime);
  const end = parseClockMinutes(quietHoursConfig?.endTime);
  const inQuiet = quietHoursConfig?.enabled && start !== null && end !== null && start !== end &&
    (start < end ? currentMinsOfDay >= start && currentMinsOfDay < end
      : currentMinsOfDay >= start || currentMinsOfDay < end);
  if (inQuiet) {
    const until = new Date(now);
    until.setHours(Math.floor(end / 60), end % 60, 0, 0);
    if (until <= now) until.setDate(until.getDate() + 1);
    return {
      inQuiet: true, inPeak: false,
      currentDelay: parseReloadDelay(quietHoursConfig.reloadDelaySec, 300),
      currentSlotStr: `${quietHoursConfig.startTime} - ${quietHoursConfig.endTime}`,
      untilTime: until.getTime(),
    };
  }

  if (!peakConfig || !peakConfig.enabled) {
    return { inPeak: false, currentDelay: reloadDelaySec, currentSlotStr: '' };
  }

  // Tách danh sách các giờ (ví dụ: '10, 12, 15, 17, 20')
  const hours = (peakConfig.hours || '10, 12, 15, 17, 20')
    .split(/[,;\s]+/)
    .map(h => parseInt(h, 10))
    .filter(h => !isNaN(h) && h >= 0 && h <= 23);

  const durationMin = Math.max(1, parseInt(peakConfig.durationMin, 10) || 15);
  const peakDelay   = parseReloadDelay(peakConfig.reloadDelaySec, 15);

  for (const h of hours) {
    const startMins = h * 60;
    const endMins   = h * 60 + durationMin;

    const elapsedMin = (currentMinsOfDay - startMins + 1440) % 1440;
    if (elapsedMin < durationMin) {
      const slotStart = new Date(now);
      slotStart.setHours(h, 0, 0, 0);
      if (slotStart > now) slotStart.setDate(slotStart.getDate() - 1);
      const slotId = `${originalUrl}|${slotStart.getTime()}`;
      const successTarget = Math.max(1, parseInt(peakConfig.successPostTarget, 10) || 1);
      const useBackup = peakProgress?.slotId === slotId && peakProgress.keys.length >= successTarget;
      const remainingMin = durationMin - elapsedMin;
      const startStr = `${String(h).padStart(2, '0')}:00`;
      const endH = Math.floor(endMins / 60) % 24;
      const endM = endMins % 60;
      const endStr = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
      return {
        inPeak: !useBackup, inBackup: useBackup, slotId,
        currentDelay: useBackup ? parseReloadDelay(peakConfig.backupReloadDelaySec, 3) : peakDelay,
        currentSlotStr: `${startStr} - ${endStr} (còn ${remainingMin} phút)`,
      };
    }
  }

  const backupDuration = Math.max(0, parseInt(peakConfig.backupDurationMin ?? 2, 10) || 0);
  for (const h of hours) {
    const elapsed = (currentMinsOfDay - h * 60 + 1440) % 1440;
    if (elapsed >= durationMin && elapsed < durationMin + backupDuration) {
      const format = minute => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      return {
        inPeak: false, inBackup: true,
        currentDelay: parseReloadDelay(peakConfig.backupReloadDelaySec, 3),
        currentSlotStr: `${format(h * 60 + durationMin)} - ${format(h * 60 + durationMin + backupDuration)}`,
      };
    }
  }
  return { inPeak: false, currentDelay: reloadDelaySec, currentSlotStr: '' };
}

// Chỉ xét các mốc thực sự đổi chế độ/chu kỳ, bỏ qua mốc bị khung ưu tiên che.
function getNextReloadTransition(now = new Date()) {
  const minutes = [];
  if (quietHoursConfig?.enabled) {
    const start = parseClockMinutes(quietHoursConfig.startTime);
    const end = parseClockMinutes(quietHoursConfig.endTime);
    if (start !== null && end !== null && start !== end) minutes.push(start, end);
  }
  if (peakConfig?.enabled) {
    const duration = Math.max(1, parseInt(peakConfig.durationMin, 10) || 15);
    const backup = Math.max(0, parseInt(peakConfig.backupDurationMin ?? 2, 10) || 0);
    for (const value of (peakConfig.hours || '10, 12, 15, 17, 20').split(/[,;\s]+/)) {
      const hour = parseInt(value, 10);
      if (hour >= 0 && hour <= 23) minutes.push(hour * 60, (hour * 60 + duration) % 1440,
        (hour * 60 + duration + backup) % 1440);
    }
  }
  const candidates = [];
  for (let day = 0; day <= 2; day++) {
    for (const minute of minutes) {
      const at = new Date(now);
      at.setDate(at.getDate() + day);
      at.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
      if (at.getTime() > now.getTime()) candidates.push(at.getTime());
    }
  }
  const signature = schedule => `${!!schedule.inQuiet}:${!!schedule.inPeak}:${!!schedule.inBackup}:${schedule.currentDelay}`;
  return candidates.sort((a, b) => a - b).find(at =>
    signature(getReloadScheduleInfo(new Date(at - 1))) !==
    signature(getReloadScheduleInfo(new Date(at)))) ?? Infinity;
}

function getReloadDeadline(now = new Date(), schedule = getReloadScheduleInfo(now)) {
  return Math.min(now.getTime() + schedule.currentDelay * 1000,
    getNextReloadTransition(now), schedule.untilTime ?? Infinity);
}

// ─── Utility: sleep (chạy thông qua background để không bị bóp khi ẩn tab) ────

/**
 * Sleep timer: gửi yêu cầu sang background service worker để chờ.
 * Background service worker không bị Chrome điều tiết/bóp xung nhịp (throttle)
 * khi tab bị ẩn, chuyển tab, hoặc thu nhỏ trình duyệt.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      setTimeout(resolve, ms);
      return;
    }

    let resolved = false;
    const fallback = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, ms + 2500);

    chrome.runtime.sendMessage({ type: 'BACKGROUND_SLEEP', ms }, (response) => {
      // Khi worker khởi động lại làm mất response, dùng timer dự phòng;
      // không coi lỗi kênh nhắn tin là đã chờ xong.
      if (chrome.runtime.lastError || !response?.ok) return;
      if (!resolved) {
        resolved = true;
        clearTimeout(fallback);
        resolve();
      }
    });
  });
}

// ─── Utility: random int in range ────────────────────────────────────────────
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ─── Utility: Log ─────────────────────────────────────────────────────────────

function logEntry(text, key = 'logs') {
  console.log(`[FB Fanpage Auto] ${text}`);
  try {
    chrome.runtime.sendMessage({ type: 'LOG_FROM_CONTENT', text, key });
  } catch (_) {}
}

// Một dòng tổng hợp mỗi chu kỳ: tải trang → quét bài (comment + like) → chờ đến lúc reload.
// Chi tiết từng bài nằm ở Post Log; dòng này chỉ có phần tổng hợp, khung giờ và lý do phục hồi.
function logCycleTiming(scanEndAt, scheduleLabel = 'thường', recoveryReason = '') {
  const timing = cycleTiming;
  cycleTiming = null;
  if (!timing) return;
  const now = performance.now();
  const sec = ms => ms > 0 ? `${(ms / 1000).toFixed(2)}s` : '?';
  const scanStart = timing.timelineReadyAt ?? timing.startedAt;
  const marks = (timing.loadMarks || []).filter(([, ms]) => ms > 0)
    .map(([label, ms]) => `${label} ${sec(ms)}`).join(' → ');
  const parts = [
    timing.loadMs != null
      ? `Tải trang ${sec(timing.loadMs)}${marks ? ` (${marks})` : ''}${timing.tabHidden ? ' | tab ẩn' : ''}`
      : 'Tải trang — (không reload trước chu kỳ này)',
    `Quét ${sec(Math.max(1, scanEndAt - scanStart))}`,
    `Chờ reload ${sec(Math.max(1, now - scanEndAt))} (${scheduleLabel})`,
  ];
  if (recoveryReason) parts.push(`Phục hồi: ${recoveryReason}`);
  const total = timing.loadMs != null ? now : now - timing.startedAt;
  // Tab Thời gian chỉ nhận chu kỳ có bài thực sự được like/comment;
  // chu kỳ chỉ bỏ qua bài cũ (hoặc không có bài) ghi vào tab Chu kỳ & quét bài.
  const acted = timing.posts.some(post => !post.skipped);
  logEntry(`⏱ Chu kỳ ${sec(total)} | ${parts.join(' | ')}`, acted ? 'timingLogs' : 'logs');
}

// ─── Utility: wait for element (dùng sleep background để tránh kẹt) ───────────

/**
 * Chờ một element xuất hiện trong container mà không bị ảnh hưởng bởi timer throttling.
 * @param {Element} root
 * @param {string}  selector
 * @param {number}  timeout
 * @param {number}  interval
 * @returns {Promise<Element|null>}
 */
async function waitForElement(root, selector, timeout = 5000, interval = 200) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (!automationRunning) return null;
    const el = root.querySelector(selector);
    if (el) return el;
    await sleep(interval);
  }
  return null;
}

// ─── Utility: find post link ──────────────────────────────────────────────────

function getPostLink(postEl) {
  const anchors = postEl.querySelectorAll('a[href]');
  let mediaLink = null;
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const isPostLink = href.includes('/posts/') ||
      href.includes('/permalink/') ||
      href.includes('story_fbid=');
    const isMediaLink = href.includes('/videos/') ||
      href.includes('/photos/') ||
      href.includes('/photo.php?') ||
      href.includes('/photo?') ||
      href.includes('/photo/?') ||
      href.includes('/reel/') ||
      href.includes('/watch/?') ||
      href.includes('/watch?');
    if (isPostLink || (isMediaLink && !mediaLink)) {
      let absoluteLink;
      try {
        absoluteLink = new URL(href, 'https://www.facebook.com').href;
      } catch {
        absoluteLink = href;
      }
      // Permalink của bài ổn định hơn link ảnh/video nằm bên trong bài.
      if (isPostLink) return absoluteLink;
      mediaLink = absoluteLink;
    }
  }
  return mediaLink || postEl.getAttribute('data-pagelet') || 'unknown';
}

// ─── Action: Insert text into Lexical editor ──────────────────────────────────

/**
 * Nhập văn bản vào trình soạn thảo Lexical của Facebook mà không bị lặp chữ (duplicate).
 * @param {Element} textbox  Contenteditable div
 * @param {string}  text     Nội dung bình luận
 * @returns {Promise<boolean>}
 */
async function insertTextIntoLexical(textbox, text) {
  try {
    const expected = text.trim();
    if (!expected || !automationRunning || !textbox.isConnected) return false;
    textbox.scrollIntoView({ behavior: 'instant', block: 'center' });

    // Step 1: Click + focus để kích hoạt Lexical editor
    triggerClick(textbox);
    textbox.focus();

    // Step 2: Dispatch focus event tường minh
    textbox.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    if (!await waitUntil(() => textbox.isConnected && document.activeElement === textbox, 800, 50)) return false;

    // Step 3: Xóa sạch nội dung cũ
    if (textbox.textContent.trim()) {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      if (!await waitUntil(() => textbox.isConnected && !textbox.textContent.trim(), 800, 50)) return false;
    }

    // Chỉ chèn một lần. Không paste/chèn thêm khi execCommand trả false
    // hoặc DOM chưa cập nhật, vì Lexical có thể đã nhận nội dung.
    document.execCommand('insertText', false, text);

    if (!await waitUntil(() => textbox.isConnected && textbox.textContent.trim() === expected, 1000, 50)) return false;
    // Nhường một lượt cập nhật để Lexical nhận nội dung trước khi gửi.
    await sleep(50);
    // Nội dung bị lặp hoặc chưa nhập được không được coi là thành công.
    return automationRunning && textbox.isConnected && textbox.textContent.trim() === expected;
  } catch (err) {
    console.error('[FB Fanpage Auto] insertTextIntoLexical error:', err);
    return false;
  }
}

// ─── Action: Submit comment ───────────────────────────────────────────────────

const pendingCommentSubmissions = new WeakMap();
const postCommentGuards = new WeakMap();
const SKIP_ALREADY_LIKED = Symbol('skip-already-liked');
async function submitComment(container, timeout = 6000, textbox = null, onSubmitted = () => {}) {

  function sendEnter(tb) {
    if (!tb) return;
    try {
      tb.focus();
      const eventInit = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        charCode: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      };
      tb.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      tb.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      tb.dispatchEvent(new KeyboardEvent('keyup', eventInit));
      return true;
    } catch (_) { return false; }
  }

  if (!automationRunning) return false;
  let pending = pendingCommentSubmissions.get(container);
  if (!pending) {
    const guard = postCommentGuards.get(container);
    if (guard && !guard()) throw SKIP_ALREADY_LIKED;
    const tb = textbox || findCommentBox(container);
    if (!tb?.isConnected || !tb.textContent.trim()) return false;
    pending = { textbox: tb };
    pendingCommentSubmissions.set(container, pending);
    // Ưu tiên nút gửi rõ nghĩa, tránh bấm nhầm nút mở bình luận.
    const submitRoot = tb.closest?.('form') || container;
    const submitBtn = submitRoot.querySelector(
      '[aria-label*="Đăng bình luận" i][role="button"], ' +
      '[aria-label="Post a comment" i][role="button"], ' +
      '[aria-label="Send" i][role="button"], ' +
      '[aria-label="Gửi" i][role="button"], ' +
      'form button[type="submit"], ' +
      'form [role="button"][type="submit"]'
    );
    if (submitBtn && !submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true') {
      triggerClick(submitBtn);
    } else {
      if (!sendEnter(tb)) {
        pendingCommentSubmissions.delete(container);
        return false;
      }
    }
  }
  // Chỉ mở tác vụ Like sau khi đã kích hoạt gửi, hoặc đang theo dõi lần gửi cũ.
  onSubmitted();
  // Không coi textbox bị tháo khỏi DOM là đã gửi. Timeout giữ trạng thái chờ
  // để lần retry không nhập/gửi lại một comment có thể đang được xử lý.
  const sent = await waitUntil(() => pending.textbox.isConnected &&
    pending.textbox.textContent.trim().length === 0, timeout, 50);
  if (sent) pendingCommentSubmissions.delete(container);
  return sent;
}

// ─── Utility: waitUntil ───────────────────────────────────────────────────────

/**
 * Chờ một điều kiện predicate() trở thành truthy.
 * @param {Function} predicate
 * @param {number}   timeout
 * @param {number}   interval
 * @returns {Promise<boolean>}
 */
async function waitUntil(predicate, timeout = 6000, interval = 200) {
  const startTime = Date.now();
  while (automationRunning) {
    if (predicate()) return true;
    if (Date.now() - startTime >= timeout) return false;
    await sleep(interval);
  }
  return false;
}

// ─── Action: Đóng Popup / Dialog (nếu có mở) ─────────────────────────────────

/**
 * Đóng modal / popup bài viết nếu đang mở để quay lại timeline feed.
 * @param {Element} dialogEl
 */
async function closeDialog(dialogEl) {
  if (!automationRunning) return false;
  if (!dialogEl) return true;
  const closeBtn = dialogEl.querySelector(
    'div[aria-label="Đóng"], div[aria-label="Close"], [aria-label*="Đóng"][role="button"]'
  );
  if (closeBtn) {
    closeBtn.click();
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
  return waitUntil(() => !dialogEl.isConnected, 1200, 50);
}

// ─── Utility: Helpers tìm phần tử & tương tác nâng cao ──────────────────────

/**
 * Click an toàn bằng cách giả lập đầy đủ chuỗi sự kiện chuột/con trỏ.
 * Giúp kích hoạt các synthetic event listener của React 18 trên Facebook.
 * @param {Element} element
 */
function triggerClick(element) {
  if (!element || !automationRunning) return;
  try {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.focus();
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
  } catch (_) {
    try { element.click(); } catch (__) {}
  }
}

/**
 * Cuộn vùng nội dung của popup dialog xuống dưới cùng để Facebook render ô nhập bình luận.
 * @param {Element} dialogEl
 */
function scrollDialogToBottom(dialogEl) {
  if (!dialogEl) return;
  try {
    const divs = dialogEl.querySelectorAll('div');
    for (const d of divs) {
      if (d.scrollHeight > d.clientHeight && d.clientHeight > 150) {
        d.scrollTop = d.scrollHeight;
      }
    }
    dialogEl.scrollTop = dialogEl.scrollHeight;
  } catch (_) {}
}

/**
 * Tìm ô soạn thảo bình luận INLINE chỉ nằm bên trong postEl ngoài timeline.
 * Tuyệt đối không tìm ra ngoài postEl hoặc tìm trong popup dialog.
 * @param {Element} postEl
 * @returns {Element|null}
 */
function findInlineCommentBox(postEl) {
  if (!postEl) return null;

  // 1. Theo chuẩn data-lexical-editor="true" bên trong postEl
  let box = postEl.querySelector('[role="textbox"][data-lexical-editor="true"], [contenteditable="true"][data-lexical-editor="true"], div[data-lexical-editor="true"]');
  if (box) return box;

  // 2. Theo form chứa textbox bên trong postEl
  const formBox = postEl.querySelector('form [role="textbox"], form [contenteditable="true"]');
  if (formBox) return formBox;

  // 3. Theo từ khóa đa ngôn ngữ trong aria-label hoặc aria-placeholder
  const allTbs = postEl.querySelectorAll('[role="textbox"], [contenteditable="true"]');
  for (const tb of allTbs) {
    if (tb.closest('[role="search"]') || tb.getAttribute('aria-label') === 'Tìm kiếm trên Facebook') continue;
    const label = (tb.getAttribute('aria-label') || '').toLowerCase();
    const ph    = (tb.getAttribute('aria-placeholder') || '').toLowerCase();
    if (
      label.includes('bình luận') || label.includes('comment') || label.includes('trả lời') || label.includes('reply') ||
      ph.includes('bình luận') || ph.includes('comment') || ph.includes('trả lời') || ph.includes('reply')
    ) {
      return tb;
    }
  }

  return null;
}

/**
 * Tìm ô soạn thảo bình luận bên trong dialog popup.
 * @param {Element} dialogEl
 * @returns {Element|null}
 */
function findDialogCommentBox(dialogEl) {
  if (!dialogEl) return null;

  // 1. Theo chuẩn data-lexical-editor="true" trong dialog
  let box = dialogEl.querySelector('[role="textbox"][data-lexical-editor="true"], [contenteditable="true"][data-lexical-editor="true"], div[data-lexical-editor="true"]');
  if (box) return box;

  // 2. Theo form chứa textbox trong dialog
  const formBox = dialogEl.querySelector('form [role="textbox"], form [contenteditable="true"], form div[contenteditable]');
  if (formBox) return formBox;

  // 3. Theo từ khóa đa ngôn ngữ trong aria-label hoặc aria-placeholder trong dialog
  const allTbs = dialogEl.querySelectorAll('[role="textbox"], [contenteditable="true"], div[contenteditable="true"]');
  for (const tb of allTbs) {
    if (tb.closest('[role="search"]') || tb.getAttribute('aria-label') === 'Tìm kiếm trên Facebook') continue;
    const label = (tb.getAttribute('aria-label') || '').toLowerCase();
    const ph    = (tb.getAttribute('aria-placeholder') || '').toLowerCase();
    if (
      label.includes('bình luận') || label.includes('comment') || label.includes('trả lời') || label.includes('reply') ||
      ph.includes('bình luận') || ph.includes('comment') || ph.includes('trả lời') || ph.includes('reply')
    ) {
      return tb;
    }
  }

  // 4. Theo class Lexical đặc trưng: notranslate hoặc data-interactable
  const lexicalBox = dialogEl.querySelector('div.notranslate[contenteditable="true"], div[data-interactable*="keydown"][contenteditable="true"]');
  if (lexicalBox && !lexicalBox.closest('[role="search"]')) return lexicalBox;

  // 5. Bất kỳ contenteditable nào trong dialog không phải search
  for (const tb of allTbs) {
    if (
      tb.getAttribute('contenteditable') === 'true' &&
      !tb.closest('[role="search"]') &&
      !tb.closest('[role="complementary"]') &&
      tb.getAttribute('aria-label') !== 'Tìm kiếm trên Facebook'
    ) {
      return tb;
    }
  }

  return null;
}

/**
 * Tìm ô soạn thảo bình luận đa năng bên trong container (tự phân biệt timeline vs popup).
 * @param {Element} container
 * @returns {Element|null}
 */
function findCommentBox(container) {
  if (!container) return null;

  // Nếu container là dialog hoặc nằm trong dialog
  if (container.getAttribute('role') === 'dialog' || container.closest('[role="dialog"]')) {
    const d = container.getAttribute('role') === 'dialog' ? container : container.closest('[role="dialog"]');
    return findDialogCommentBox(d);
  }

  // Ngược lại, đây là bài viết trên timeline
  return findInlineCommentBox(container);
}

/**
 * Tìm nút "Viết bình luận" bên trong bài viết hoặc bên trong popup dialog (để kích hoạt mở ô nhập).
 * @param {Element} container
 * @returns {Element|null}
 */
function findCommentButton(container) {
  if (!container) return null;

  // 1. Ưu tiên thuộc tính chuẩn của Facebook: data-ad-rendering-role="comment_button"
  const commentRole = container.querySelector('[data-ad-rendering-role="comment_button"]');
  if (commentRole) {
    return commentRole.closest('[role="button"]') || commentRole;
  }

  // 2. Theo aria-label chính xác
  const direct = container.querySelector(
    '[aria-label="Viết bình luận"][role="button"], ' +
    '[aria-label="Viết bình luận"], ' +
    '[aria-label="Write a comment"][role="button"], ' +
    '[aria-label*="bình luận" i][role="button"], ' +
    '[aria-label*="comment" i][role="button"]'
  );
  if (direct) return direct;

  return null;
}

// ─── Action: Like ─────────────────────────────────────────────────────────────

/**
 * Click nút Like bên trong một container (post element hoặc popup dialog).
 * @param {Element} container
 * @returns {Promise<number>} Thời gian xác nhận like (ms), hoặc -1 nếu không tìm thấy/chưa xác nhận
 */
async function performLike(container) {
  if (!automationRunning) return -1;
  const t0 = Date.now();

  // 1. Ưu tiên hàng đầu: nút like bài viết theo thuộc tính Facebook data-ad-rendering-role="like_button"
  // (Tránh tuyệt đối việc bấm nhầm nút like của các comment bên dưới bài)
  const likeRole = container.querySelector('[data-ad-rendering-role="like_button"]');
  let btn = null;

  if (likeRole) {
    btn = likeRole.closest('[role="button"]') || likeRole.closest('div[aria-label]') || likeRole;
  }

  // 2. Nút Thích trực tiếp có role="button" và aria-label="Thích" (loại trừ đếm số người và comment reactions)
  if (!btn) {
    const directLikeBtn = container.querySelector('[aria-label="Thích"][role="button"], [aria-label="Like"][role="button"]');
    if (directLikeBtn) btn = directLikeBtn;
  }

  // 3. Quét danh sách nút có aria-label chứa 'Thích'
  if (!btn) {
    const buttons = container.querySelectorAll('[aria-label]');
    for (const el of buttons) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (
        (label === 'thích' || label === 'like' || label === 'gỡ thích' || label === 'remove like') &&
        !label.includes('người') && !label.includes('cảm xúc')
      ) {
        const role = el.getAttribute('role');
        const tag  = el.tagName.toLowerCase();
        if (tag === 'button' || role === 'button' || tag === 'div') {
          btn = el;
          break;
        }
      }
    }
  }

  if (!btn) return -1;

  // Kiểm tra xem chính nút Like bài viết này đã ở trạng thái đã like chưa
  const currentLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
  if (currentLabel.includes('gỡ thích') || currentLabel.includes('remove like') || currentLabel.includes('unlike')) {
    return 0; // Đã like sẵn
  }

  // Kích hoạt click
  triggerClick(btn);

  // Chờ tối đa 1500ms xem nút có chuyển sang Gỡ Thích không
  const confirmed = await waitUntil(() => {
    // React có thể thay nút sau click; đọc lại nút mới thay vì theo dõi node cũ.
    const current = btn.isConnected ? btn :
      container.querySelector('[aria-label="Gỡ Thích"][role="button"], [aria-label="Remove like"][role="button"], [aria-label="Unlike"][role="button"]');
    const lbl = (current?.getAttribute('aria-label') || '').toLowerCase();
    return lbl.includes('gỡ thích') || lbl.includes('remove like') || lbl.includes('unlike');
  }, 1500, 50);
  // Không bấm lần hai khi chưa rõ kết quả, tránh gỡ like vừa thực hiện.
  return confirmed ? Date.now() - t0 : -1;
}

// ─── Action: Comment on specific textbox ──────────────────────────────────────

/**
 * Nhập văn bản vào ô textbox và nhấn nút Đăng bình luận bên trong container.
 * @param {Element} container  post element hoặc dialog element
 * @param {Element} textbox    ô contenteditable Lexical
 * @param {string}  text       nội dung bình luận
 * @returns {Promise<{elapsed: number, success: boolean}>}
 */
async function performCommentOnTextbox(container, textbox, text, onSubmitted = () => {}, timeout = 6000) {
  const t0 = Date.now();
  if (pendingCommentSubmissions.has(container)) {
    const success = await submitComment(container, timeout, null, onSubmitted);
    return { elapsed: Date.now() - t0, success, submitMs: Date.now() - t0 };
  }
  if (!textbox) {
    return { elapsed: Date.now() - t0, success: false };
  }

  const inserted = await insertTextIntoLexical(textbox, text);
  const insertMs = Date.now() - t0;
  if (!inserted) {
    return { elapsed: insertMs, success: false, insertMs, insertFailed: true };
  }

  const submitted = await submitComment(container, timeout, textbox, onSubmitted);
  return { elapsed: Date.now() - t0, success: submitted, insertMs, submitMs: Date.now() - t0 - insertMs };
}

async function commentBeforeLike(container, commentAction, progress, saveComment = () => {}) {
  let likeTask = null;
  const startLike = () => {
    if (!automationRunning || likeTask) return;
    likeTask = progress.likeSuccess ? Promise.resolve(0) : performLike(container);
  };
  let commentResult;
  let commentWrite;
  if (progress.commentSuccess) {
    startLike();
    commentResult = { success: true, elapsed: 0 };
  } else {
    commentResult = await commentAction(startLike);
    if (commentResult.success) {
      progress.commentSuccess = true;
      startLike();
      commentWrite = saveComment();
    }
  }
  const [likeElapsed] = await Promise.all([likeTask ?? -1, commentWrite]);
  if (likeElapsed >= 0) progress.likeSuccess = true;
  return { commentResult, likeElapsed };
}

// ─── Core: Process a single post ─────────────────────────────────────────────

const RELOAD_AFTER_STALE_DIALOG = Symbol('reload-after-stale-dialog');
const WAIT_FOR_COMMENT_COUNT = Symbol('wait-for-comment-count');

function isPostAlreadyLiked(container) {
  const marker = container.querySelector('[data-ad-rendering-role="like_button"]:not([data-commentid] *)');
  if (marker) {
    const button = marker.closest('[role="button"], button') || marker;
    if (container.contains(button)) {
      const label = button.getAttribute('aria-label')?.trim();
      if (label && /(?:gỡ\s+thích|remove\s+like|unlike)/iu.test(label)) return true;
    }
  }
  return !!container.querySelector(
    ':is([aria-label*="Gỡ Thích" i], [aria-label*="Remove like" i], [aria-label*="Unlike" i]):not([data-commentid] *)'
  );
}

function readPostCommentCount(container) {
  const countLabel = /^bình luận về bài viết của .+,\s*(\d+(?:[.,\s]\d+)*)\s+bình luận$/iu;
  let count = null;
  for (const marker of container.querySelectorAll('[data-ad-rendering-role="comment_button"]')) {
    const button = marker.closest('[role="button"], button');
    if (!button || !container.contains(button) || button.closest('[data-commentid]')) continue;
    const label = button.getAttribute('aria-label')?.trim();
    const digits = label?.match(countLabel)?.[1];
    if (!digits) continue;
    const parsed = Number(digits.replace(/\D/g, ''));
    if (parsed > 0) return parsed;
    count = 0;
  }
  return count;
}

async function processPost(postEl, index) {
  const postStart = Date.now();
  const seenPerf = performance.now();
  let postLink = getPostLink(postEl);
  let postKey = getPostKey(postLink);
  // Phải nhận diện bài trước khi tương tác; vị trí feed không ổn định qua reload.
  if (!postKey) {
    await waitUntil(() => {
      if (postEl.isConnected === false) return false;
      postLink = getPostLink(postEl);
      postKey = getPostKey(postLink);
      return !!postKey;
    }, 800, 100);
  }
  if (!automationRunning) return false;
  if (!postKey) {
    logEntry(`⚠ Bài ${index + 1}: chưa có ID ổn định; bỏ qua Like/comment và reload theo lịch.`);
    return false;
  }
  const historyGeneration = processedHistoryGeneration;
  let completed = false;
  let bothActionsSucceeded = false;
  const processingSlot = getReloadScheduleInfo(new Date(Date.now())).slotId;

  if (postKey && processedPostLinks.has(postKey)) return true;

  const skipAlreadyLiked = () => {
    logEntry(`⏭ Bài ${index + 1} đã Like; bỏ qua Like và comment (${postKey}).`);
    cycleTiming?.posts.push({ index, skipped: true });
    return true;
  };
  if (isPostAlreadyLiked(postEl)) return skipAlreadyLiked();
  postCommentGuards.set(postEl, () => !isPostAlreadyLiked(postEl));
  const progressKey = postKey;
  const progress = postActionProgress.get(progressKey) || { commentSuccess: false, likeSuccess: false };
  progress.commentSuccess ||= commentedPostLinks.has(postKey);
  const saveComment = async () => {
    const response = await requestPostHistory('MARK_POST_COMMENTED', { key: postKey, generation: historyGeneration });
    if (response.saved && response.generation === processedHistoryGeneration) commentedPostLinks.add(postKey);
  };
  postActionProgress.set(progressKey, progress);

  // Thời gian cho log timing: -1 = thất bại, 0 = đã có sẵn.
  let likeMs = -1;
  let commentMs = -1;
  // Chi tiết cho Post Log ở tab Thời gian.
  let method = '';
  let failReason = '';
  let commentDetail = null;
  let templateNo = 0;

  {
    // ── B2-2: Xử lý bài chưa được like ────────────────────────────────────
    // Chọn một lần cho mỗi bài; mọi lần retry dùng lại đúng nội dung đã chọn.
    const selectedComment = getCommentForPost(postLink);
    templateNo = commentTemplates.indexOf(selectedComment) + 1;

    // Kiểm tra bài viết có sẵn ô bình luận inline hay không
    const inlineBox = findInlineCommentBox(postEl);
    const waitForCommentCount = () => {
      logEntry(`⏭ Bài ${index + 1}: ${requirePositiveComments ? 'chưa xác nhận số bình luận > 0' : 'bộ đếm hiện 0 bình luận'}; sẽ kiểm tra lại sau reload theo lịch.`);
      return WAIT_FOR_COMMENT_COUNT;
    };
    const checkCommentCount = requirePositiveComments || requireExistingComment || commentCountDelaySec > 0;
    const commentCount = checkCommentCount ? readPostCommentCount(postEl) : null;
    if (commentCount === 0 && commentCountDelaySec === 0) return waitForCommentCount();
    const waitBeforeInteraction = async count => {
      if (!commentCountDelaySec || count > 0 || progress.commentDelayElapsed || progress.commentSuccess) return;
      const reason = count === 0 ? '0 bình luận' : 'không đọc được số bình luận';
      logEntry(`⏳ Bài ${index + 1}: ${reason}; chờ ${commentCountDelaySec}s trước khi tương tác.`);
      const deadline = Date.now() + commentCountDelaySec * 1000;
      while (automationRunning && Date.now() < deadline) {
        await sleep(Math.min(1000, deadline - Date.now()));
      }
      if (automationRunning) progress.commentDelayElapsed = true;
    };

    if (inlineBox) {
      if (requirePositiveComments && !(commentCount > 0)) return waitForCommentCount();
      if (commentCountDelaySec > 0 && !(commentCount > 0) && !progress.commentDelayElapsed && !progress.commentSuccess) {
        await waitBeforeInteraction(commentCount);
        if (!automationRunning || postEl.isConnected === false) return false;
        if (isPostAlreadyLiked(postEl)) return skipAlreadyLiked();
      }
      // Trường hợp 1: Có sẵn ô bình luận inline
      // Gửi comment trước, Like chạy trong lúc chờ xác nhận comment.
      method = 'inline';
      const { likeElapsed, commentResult } = await commentBeforeLike(postEl,
        onSubmitted => performCommentOnTextbox(postEl, inlineBox, selectedComment, onSubmitted), progress, saveComment);

      commentDetail = commentResult;
      likeMs = progress.likeSuccess ? Math.max(0, likeElapsed) : -1;
      commentMs = commentResult.success ? Math.max(1, commentResult.elapsed) : -1;

      if (commentResult.success && progress.likeSuccess) {
        completed = true;
        bothActionsSucceeded = likeElapsed >= 0;
      }
    } else {
      // Trường hợp 2: Không có ô bình luận inline → Phải mở popup
      // QUY TẮC: KHÔNG thực hiện like liền mà thực hiện trong bài viết mở popup!
      // YÊU CẦU: Nếu lần quét thao tác đầu không thành công sẽ thực hiện thêm lại nhiều nhất 5 lần nữa
      // ĐẶC BIỆT: Chạy lại các thao tác like & comment NGAY TRONG POPUP đang mở, không đóng popup hay làm lại từ đầu
      method = 'popup';

      // 1. Mở popup (thử bấm mở tối đa 3 lần nếu chưa mở được)
      let openedDialog = null;
      let popupOpened  = false;

      // Đóng bất kỳ dialog cũ nào đang còn sót lại trên trang
      const staleDialog = document.querySelector('div[role="dialog"]');
      if (staleDialog) {
        if (!await closeDialog(staleDialog)) {
          logEntry(`⚠ Bài ${index + 1}: Chưa đóng được dialog cũ; sẽ reload theo lịch cấu hình để thử lại.`);
          return RELOAD_AFTER_STALE_DIALOG;
        }
      }

      const popupOpenStart = Date.now();
      let popupTries = 0;
      for (let openTry = 1; openTry <= 3; openTry++) {
        if (!automationRunning) break;
        popupTries = openTry;

        const commentOpenBtn = findCommentButton(postEl);
        if (commentOpenBtn) {
          triggerClick(commentOpenBtn);
          const innerChild = commentOpenBtn.querySelector('i, [data-ad-rendering-role="comment_button"]');
          if (innerChild) {
            try { innerChild.click(); } catch (_) {}
          }
        } else {
          const directBtn = postEl.querySelector('[aria-label="Viết bình luận"], [aria-label*="bình luận" i][role="button"]');
          if (directBtn) triggerClick(directBtn);
        }

        // Chờ modal dialog bài viết xuất hiện (có nút Đóng hoặc chứa article)
        popupOpened = await waitUntil(() => {
          const dialogs = document.querySelectorAll('div[role="dialog"]');
          for (const d of dialogs) {
            if (d.querySelector('[aria-label="Đóng"], [aria-label="Close"], [role="article"]')) {
              openedDialog = d;
              return true;
            }
          }
          return false;
        }, 4000, 200);

        if (popupOpened) break;

        if (openTry < 3) {
          postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(800);
        }
      }

      const popupOpenMs = Date.now() - popupOpenStart;
      method = `popup (${popupOpened ? 'mở' : 'không mở được'} sau ${popupOpenMs}ms, bấm ${popupTries} lần)`;
      if (!popupOpened || !openedDialog) {
        failReason = `không mở được popup bài viết sau ${popupTries} lần bấm`;
      } else {
        // 2. Popup đã mở!
        // THỰC HIỆN CÁC THAO TÁC LIKE, COMMENT NGAY TRONG POPUP
        await waitUntil(() => !!findDialogCommentBox(openedDialog) ||
          !!openedDialog.querySelector('[data-ad-rendering-role="like_button"]'), 1200, 50);
        if (isPostAlreadyLiked(openedDialog)) {
          await closeDialog(openedDialog);
          return skipAlreadyLiked();
        }
        postCommentGuards.set(openedDialog, () => !isPostAlreadyLiked(openedDialog));
        const effectiveCount = checkCommentCount && commentCount === null ? readPostCommentCount(openedDialog) : commentCount;
        if (requirePositiveComments && !(effectiveCount > 0)) {
          await closeDialog(openedDialog);
          return waitForCommentCount();
        }
        if (requireExistingComment && commentCountDelaySec === 0 && effectiveCount === 0) {
          await closeDialog(openedDialog);
          return waitForCommentCount();
        }
        if (commentCountDelaySec > 0 && !(effectiveCount > 0) && !progress.commentDelayElapsed && !progress.commentSuccess) {
          await waitBeforeInteraction(effectiveCount);
          if (!automationRunning || openedDialog.isConnected === false) return false;
          if (isPostAlreadyLiked(openedDialog)) {
            await closeDialog(openedDialog);
            return skipAlreadyLiked();
          }
        }

        let targetContainer = openedDialog;
        let likeSuccess      = progress.likeSuccess;
        let likeElapsedMs    = -1;
        let commentSuccess   = progress.commentSuccess;
        let commentElapsedMs = 0;

        const MAX_RETRIES    = 5; // Tối đa 5 lần thử lại thêm
        const TOTAL_ATTEMPTS = 1 + MAX_RETRIES; // Tổng cộng tối đa 6 lượt

        let opAttempts = 0;
        for (let opAttempt = 1; opAttempt <= TOTAL_ATTEMPTS; opAttempt++) {
          if (!automationRunning) break;
          opAttempts = opAttempt;

          const result = await commentBeforeLike(targetContainer, async onSubmitted => {
            const tbStart = Date.now();
            if (pendingCommentSubmissions.has(openedDialog)) {
              const success = await submitComment(openedDialog, 5000, null, onSubmitted);
              return { success, elapsed: Date.now() - tbStart, submitMs: Date.now() - tbStart };
            }

            // Cuộn vùng nội dung dialog xuống dưới đáy để Facebook render ô nhập bình luận
            let targetTextbox = findDialogCommentBox(openedDialog);
            if (!targetTextbox) {
              scrollDialogToBottom(openedDialog);
              await waitUntil(() => !!(targetTextbox = findDialogCommentBox(openedDialog)), 350, 50);
            }

            // Nếu chưa tìm thấy ô textbox, bấm nút "Viết bình luận" bên trong popup để mở / kích hoạt ô nhập
            if (!targetTextbox) {
              const innerCommentBtn = findCommentButton(openedDialog);
              if (innerCommentBtn) {
                triggerClick(innerCommentBtn);
              }
              // Chờ ô comment xuất hiện sau khi click
              await waitUntil(() => {
                scrollDialogToBottom(openedDialog);
                targetTextbox = findDialogCommentBox(openedDialog);
                return !!targetTextbox;
              }, 3000, 50);
            }

            // Nhập nội dung và submit
            if (targetTextbox) {
              return performCommentOnTextbox(openedDialog, targetTextbox, selectedComment, onSubmitted, 5000);
            }
            return { success: false, elapsed: Date.now() - tbStart, noTextbox: true };
          }, progress, saveComment);
          commentSuccess = progress.commentSuccess;
          likeSuccess = progress.likeSuccess;
          if (result.commentResult.elapsed) {
            commentElapsedMs = result.commentResult.elapsed;
            commentDetail = result.commentResult;
          }
          if (result.likeElapsed >= 0) likeElapsedMs = result.likeElapsed;

          // C. Nếu cả Like và Comment đều đã xong -> Hoàn thành!
          if (likeSuccess && commentSuccess) {
            break;
          }

          // D. Nếu chưa thành công -> Chờ 1 giây rồi thử lại TIẾP TỤC TRONG POPUP ĐANG MỞ
          if (opAttempt < TOTAL_ATTEMPTS) {
            await sleep(1000);
          }
        }

        method += ` | thao tác ${opAttempts} lượt (tối đa ${TOTAL_ATTEMPTS})`;
        if (!(likeSuccess && commentSuccess)) failReason = `chưa xong sau ${opAttempts} lượt trong popup`;
        likeMs = likeSuccess ? Math.max(0, likeElapsedMs) : -1;
        commentMs = commentSuccess ? Math.max(1, commentElapsedMs) : -1;

        if (commentSuccess && likeSuccess) {
          completed = true;
          bothActionsSucceeded = likeSuccess;
        }

        // 3. Đóng popup dialog sau khi hoàn tất
        if (openedDialog) {
          await closeDialog(openedDialog);
        }
      }
    }
  }

  if (completed) {
    try {
      await rememberProcessedPost(postKey, historyGeneration, bothActionsSucceeded ? processingSlot : undefined);
    } catch (err) {
      throw new Error(`Không lưu được bài đã xử lý: ${err.message}`);
    }
  }

  const totalElapsed = Date.now() - postStart;
  cycleTiming?.posts.push({ index, likeMs, commentMs, totalMs: totalElapsed });

  // ── Ghi log bài viết ───────────────────────────────────────────────────────
  const commentNotSubmitted = commentDetail?.insertFailed || commentDetail?.noTextbox || !commentDetail;
  const likeText = likeMs === 0 ? 'đã like sẵn'
    : likeMs > 0 ? `chưa like → bấm, xác nhận ${likeMs}ms`
    : commentNotSubmitted && !progress.commentSuccess ? 'chưa thực hiện (chỉ like sau khi comment đã gửi)'
    : 'thất bại (không tìm thấy nút hoặc chưa xác nhận)';
  let commentText;
  if (!commentDetail) commentText = `thất bại: ${failReason || 'chưa thực hiện'}`;
  else if (commentDetail.success && commentDetail.insertMs != null) {
    commentText = `nhập ${commentDetail.insertMs}ms → gửi và xác nhận ${commentDetail.submitMs}ms`;
  } else if (commentDetail.success) {
    commentText = commentDetail.submitMs != null
      ? `xác nhận lần gửi trước ${commentDetail.submitMs}ms` : 'đã gửi ở lượt trước';
  } else if (commentDetail.noTextbox) commentText = 'thất bại: không tìm thấy ô nhập bình luận';
  else if (commentDetail.insertFailed) commentText = `thất bại: nhập chữ không thành công (${commentDetail.insertMs}ms)`;
  else commentText = `thất bại: đã gửi nhưng chưa thấy xác nhận sau ${commentDetail.submitMs ?? commentDetail.elapsed}ms`;

  const shortKey = postKey || 'chưa có ID';
  const sinceReload = cycleTiming?.loadMs != null ? ` (sau ${(seenPerf / 1000).toFixed(2)}s từ lúc reload)` : '';
  const log = [
    `=== Bài ${index + 1} (${shortKey}) — ${completed ? '✅ hoàn tất' : '❌ chưa xong'} ===`,
    `- Link: ${cleanPostLink(postLink)}`,
    `- Thấy bài lúc: ${formatClock(postStart)}${sinceReload}`,
    `- Cách thực hiện: ${method}`,
    `- Like: ${likeText}`,
    `- Comment${templateNo ? ` (mẫu #${templateNo})` : ''}: ${commentText}`,
    `- Tổng: ${totalElapsed}ms | Xong lúc ${formatClock(postStart + totalElapsed)}`,
  ].join('\n');

  // Chi tiết ghi vào tab Thời gian; tab Chu kỳ chỉ nhận một dòng tóm tắt.
  logEntry(log, 'timingLogs');
  logEntry(completed
    ? `✅ Bài ${index + 1}: đã like + comment (${shortKey}) → xem tab Thời gian`
    : `❌ Bài ${index + 1}: chưa xong — ${failReason || 'like/comment chưa thành công'} (${shortKey}) → xem tab Thời gian`);
  return completed;
}

// ─── Core: Tìm bài viết theo index trong Timeline ────────────────────────────

/**
 * Lấy danh sách các bài viết theo đúng thứ tự xuất hiện trong ProfileTimeline:
 * - data-pagelet="TimelineFeedUnit_0" ==> bài viết mới nhất (index 0)
 * - data-pagelet="TimelineFeedUnit_1" ==> bài viết thứ 2 (index 1)
 * - Các bài viết tiếp theo là data-pagelet="TimelineFeedUnit_{n}" nên được đánh theo thứ tự DOM!
 * @param {Element} timeline
 * @returns {Element[]}
 */
function getOrderedTimelinePosts(timeline) {
  // Lấy tất cả các phần tử có data-pagelet bắt đầu bằng TimelineFeedUnit_ theo đúng thứ tự DOM
  const allUnits = Array.from(timeline.querySelectorAll('div[data-pagelet^="TimelineFeedUnit_"], div[data-pagelet*="TimelineFeedUnit"]'));
  return allUnits;
}

/**
 * Tìm post element theo index thứ tự bên trong container ProfileTimeline.
 * Đánh theo thứ tự: 0 là bài mới nhất, 1 là bài thứ 2, 2 là bài thứ 3 (TimelineFeedUnit_{n} đầu tiên)...
 * Hỗ trợ tự cuộn nhẹ nếu bài viết chưa được Facebook render (lazy loading).
 * @param {Element} timeline
 * @param {number}  index
 * @returns {Promise<Element|null>}
 */
async function findPostElement(timeline, index, scrollToPost = true) {
  const readPosts = () => {
    // Facebook có thể thay container khi tải thêm bài.
    if (timeline.isConnected === false) {
      timeline = document.querySelector('div[data-pagelet="ProfileTimeline"]') || timeline;
    }
    return timeline.isConnected === false ? [] : getOrderedTimelinePosts(timeline);
  };
  let posts = readPosts();

  // Nếu số lượng bài chưa đủ đến index, cuộn nhẹ trang xuống để kích hoạt Facebook load thêm feed
  if (posts.length <= index) {
    for (let c = 0; c < 3 && posts.length <= index; c++) {
      if (!automationRunning) return null;
      window.scrollBy({ top: 800, behavior: 'smooth' });
      await waitUntil(() => {
        posts = readPosts();
        return posts.length > index;
      }, 1000, 100);
    }
  }
  if (!automationRunning) return null;

  const postEl = posts[index] || null;

  if (postEl && scrollToPost) {
    // Cuộn bài viết vào giữa màn hình để Facebook mount nội dung DOM
    postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);
  }

  return postEl;
}

// ─── Core: One full scan cycle ────────────────────────────────────────────────

function waitForTimeline(timeout = 10000) {
  const findReady = () => {
    const timeline = document.querySelector('div[data-pagelet="ProfileTimeline"]');
    return timeline && getOrderedTimelinePosts(timeline).length ? timeline : null;
  };
  if (!automationRunning) return Promise.resolve(null);
  const ready = findReady();
  if (ready) return Promise.resolve(ready);

  // Bắt đầu ngay khi timeline có bài, không chờ một khoảng cố định sau reload.
  return new Promise(resolve => {
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      if (cancelTimelineWait === cancel) cancelTimelineWait = null;
      resolve(value);
    };
    const cancel = () => finish(null);
    const observer = new MutationObserver(() => {
      if (!automationRunning) return finish(null);
      const timeline = findReady();
      if (timeline) finish(timeline);
    });
    cancelTimelineWait = cancel;
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['data-pagelet'],
    });
    const timeline = findReady();
    if (timeline) finish(timeline);
    sleep(timeout).then(() => {
      if (!finished) finish(automationRunning ? findReady() : null);
    });
  });
}

async function scanCyclePosts() {
  if (!automationRunning) return;

  try {
    await loadProcessedPostHistory();
  } catch (err) {
    throw new Error(`Chưa đọc được dữ liệu bài đã xử lý: ${err.message}`);
  }
  const historyLoadedAt = performance.now();
  if (!automationRunning) return;

  const timeline = await waitForTimeline();
  if (timeline && cycleTiming) {
    cycleTiming.timelineReadyAt = performance.now();
    if (resumedAfterReload && !pageLoadMeasured) {
      // performance.now() tính từ lúc bắt đầu điều hướng của trang hiện tại.
      const nav = performance.getEntriesByType('navigation')[0];
      cycleTiming.loadMs = cycleTiming.timelineReadyAt;
      cycleTiming.loadMarks = [
        // byte đầu = máy chủ bắt đầu trả lời; byte đầu → HTML = thời gian tải HTML về.
        ['byte đầu', nav?.responseStart], ['HTML', nav?.responseEnd], ['DOM', nav?.domContentLoadedEventEnd], ['script', scriptInjectedAt],
        ['background', shouldRunRepliedAt], ['lịch sử', historyLoadedAt], ['timeline', cycleTiming.timelineReadyAt],
      ];
      cycleTiming.tabHidden = tabHiddenDuringLoad || !!globalThis.document?.hidden;
    }
  }
  pageLoadMeasured = true;
  if (!timeline) {
    if (!automationRunning) return;
    logEntry('⚠ Timeline chưa có bài sẵn sàng; sẽ reload theo lịch cấu hình để thử lại.');
  }

  let allDone = !!timeline;
  let reloadRecoveryReason = timeline ? '' : 'timeline chưa sẵn sàng';

  for (const [position, index] of (timeline ? targetIndices : []).entries()) {
    if (!automationRunning) return;

    const postEl = await findPostElement(timeline, index, false);
    if (!postEl) {
      logEntry(`⚠ Không tìm thấy bài viết ở vị trí thứ ${index + 1} trong ProfileTimeline`);
      allDone = false;
      break;
    }

    const link = getPostLink(postEl);
    const key = getPostKey(link);
    if (key && processedPostLinks.has(key)) {
      logEntry(`⏭ Bài ${index + 1} đã xử lý, bỏ qua (${key})`);
      cycleTiming?.posts.push({ index, skipped: true });
      continue;
    }

    let completed;
    try {
      completed = await processPost(postEl, index);
    } catch (err) {
      if (err !== SKIP_ALREADY_LIKED) throw err;
      logEntry(`⏭ Bài ${index + 1}: đã Like ngay trước khi gửi; hủy gửi comment và bỏ qua.`);
      continue;
    }
    if (completed === WAIT_FOR_COMMENT_COUNT) {
      reloadRecoveryReason = 'bài chưa đạt điều kiện số bình luận';
      break;
    }
    if (completed === RELOAD_AFTER_STALE_DIALOG) {
      reloadRecoveryReason = 'lỗi dialog cũ';
      break;
    }
    if (!completed) {
      allDone = false;
      break;
    }

    if (position < targetIndices.length - 1 && automationRunning) {
      await sleep(randInt(400, 800));
    }
  }

  return reloadRecoveryReason || (allDone ? '' : 'bài chưa xử lý thành công hoặc chưa tìm thấy');
}

function requestScheduledReload() {
  if (!automationRunning) return;
  let navigated = false;
  const navigate = url => {
    if (navigated || !automationRunning) return;
    navigated = true;
    window.location.href = url || originalUrl || window.location.href;
  };
  const fallback = setTimeout(() => navigate(), 1000);
  try {
    chrome.storage.local.get(['originalUrl'], res => {
      clearTimeout(fallback);
      navigate(res?.originalUrl);
    });
  } catch (_) {
    clearTimeout(fallback);
    navigate();
  }
}

async function runCycle() {
  if (!automationRunning) return;
  let reloadRecoveryReason = '';
  cycleTiming = { startedAt: performance.now(), posts: [] };
  try {
    reloadRecoveryReason = await scanCyclePosts();
  } catch (err) {
    reloadRecoveryReason = err.message || String(err);
    logEntry(`❌ ${reloadRecoveryReason}. Sẽ reload theo lịch cấu hình.`);
  }
  const scanEndAt = performance.now();
  try {
  if (automationRunning) {
    const now = new Date(Date.now());
    const sched = getReloadScheduleInfo(now);
    const deadline = getReloadDeadline(now, sched);
    // Khung giờ ghi vào dòng ⏱ lúc reload, thay cho các dòng đếm ngược.
    const scheduleLabel = sched.inQuiet ? `🌙 ít bài ${sched.currentSlotStr}`
      : sched.inBackup ? `🕒 backup cao điểm ${sched.currentSlotStr}`
      : sched.inPeak ? `⚡ cao điểm ${sched.currentSlotStr}`
      : 'thường';

    for (let remainingMs = Math.max(0, deadline - Date.now()); remainingMs > 0 && automationRunning;
      remainingMs = Math.max(0, deadline - Date.now())) {
      const stepMs = Math.min(1000, remainingMs);
      await sleep(stepMs);
    }
    if (automationRunning) {
      logCycleTiming(scanEndAt, scheduleLabel, reloadRecoveryReason);
      requestScheduledReload();
    }
  }
  } catch (err) {
    logEntry(`❌ Lỗi bộ đếm reload: ${err.message || err}. Yêu cầu reload dự phòng.`);
    requestScheduledReload();
  }
}

// ─── Automation Loop ──────────────────────────────────────────────────────────

async function startLoop() {
  if (isLoopRunning) return;
  isLoopRunning = true;

  while (automationRunning) {
    await runCycle();
    if (!automationRunning) break;
    const delay = randInt(3000, 5000);
    await sleep(delay);
  }

  isLoopRunning = false;
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

function startAutomation(config) {
  if (automationRunning) return;
  automationRunning  = true;
  requireExistingComment = config.requireExistingComment === true;
  requirePositiveComments = config.requirePositiveComments === true;
  commentCountDelaySec = parseReloadDelay(config.commentCountDelaySec, 0);
  resumedAfterReload = !!config.resumed;
  acquireAutomationLock();
  commentText        = config.commentText || '';
  commentTemplates   = Array.isArray(config.commentTemplates)
    ? config.commentTemplates.filter(text => typeof text === 'string').map(text => text.trim()).filter(Boolean)
    : [];
  if (!commentTemplates.length && commentText.trim()) commentTemplates = [commentText.trim()];
  postCommentChoices.clear();
  postActionProgress.clear();
  reloadDelaySec     = parseReloadDelay(config.reloadDelaySec, 30);
  originalUrl        = config.originalUrl || window.location.href;
  targetIndices      = Array.isArray(config.targetIndices) && config.targetIndices.length > 0
    ? config.targetIndices
    : [0, 1];

  if (config.peakConfig) {
    peakConfig = config.peakConfig;
  }
  if (config.quietHoursConfig) {
    quietHoursConfig = config.quietHoursConfig;
  }

  // Lưu chắc chắn originalUrl và trạng thái vào storage
  chrome.storage.local.set({ isRunning: true, originalUrl });

  const sched = getReloadScheduleInfo();
  const schedNote = sched.inQuiet
    ? `🌙 Khung giờ ít bài ${sched.currentSlotStr}: ${sched.currentDelay}s`
    : sched.inBackup ? `🕒 Backup cao điểm: ${sched.currentDelay}s (${sched.currentSlotStr})`
    : sched.inPeak ? `⚡ Khung giờ cao điểm: ${sched.currentDelay}s (duy trì ${sched.currentSlotStr})`
      : `Reload thường: ${reloadDelaySec}s`;

  // Cấu hình và URL chỉ ghi đầy đủ khi bấm Bắt đầu; sau mỗi lần reload chỉ ghi một dòng ngắn.
  if (resumedAfterReload) {
    logEntry('🔄 Reload xong');
  } else {
    const targetDesc = targetIndices.map(i => `bài ${i + 1}`).join(', ');
    logEntry(`▶ Bắt đầu tự động hóa: Quét [${targetDesc}] | ${schedNote} | URL: ${originalUrl}`);
  }
  startLoop();
}

function stopAutomation() {
  // Dừng có thể tới từ cả message lẫn storage.onChanged; chỉ ghi log một lần.
  const wasRunning = automationRunning;
  automationRunning = false;
  if (cancelTimelineWait) cancelTimelineWait();
  releaseAutomationLock();
  if (wasRunning) logEntry('⏹ Đã dừng tự động hóa.');
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_AUTOMATION') {
    startAutomation({
      commentText:    message.commentText || '',
      commentTemplates: message.commentTemplates,
      requireExistingComment: message.requireExistingComment,
      requirePositiveComments: message.requirePositiveComments,
      commentCountDelaySec: message.commentCountDelaySec,
      reloadDelaySec: message.reloadDelaySec ?? 30,
      originalUrl:    message.originalUrl,
      targetIndices:  message.targetIndices,
      peakConfig:     message.peakConfig,
      quietHoursConfig: message.quietHoursConfig,
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'STOP_AUTOMATION') {
    stopAutomation();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'PING') {
    sendResponse({ ok: true, running: automationRunning });
    return true;
  }
});

// Dừng bảo vệ ngay cả khi popup đã cập nhật storage nhưng relay bị gián đoạn.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.processedPostHistory) {
    applyProcessedPostHistory(changes.processedPostHistory.newValue);
  }
  if (area === 'local' && changes.isRunning?.newValue === false && automationRunning) {
    stopAutomation();
  }
});

// ─── Tự kiểm tra quyền chạy khi tải trang (Multi-Tab Isolation) ───────────────
// Chỉ resume nếu đúng là tab được chỉ định automation. Các tab khác sẽ không chạy gì.
chrome.runtime.sendMessage({ type: 'CHECK_SHOULD_RUN' }, (resp) => {
  shouldRunRepliedAt = performance.now();
  if (chrome.runtime.lastError) return;
  if (resp?.shouldRun && !automationRunning) {
    startAutomation({
      commentText: resp.commentText,
      commentTemplates: resp.commentTemplates,
      requireExistingComment: resp.requireExistingComment,
      requirePositiveComments: resp.requirePositiveComments,
      commentCountDelaySec: resp.commentCountDelaySec,
      reloadDelaySec: resp.reloadDelaySec,
      originalUrl: resp.originalUrl,
      targetIndices: resp.targetIndices,
      peakConfig: resp.peakConfig,
      quietHoursConfig: resp.quietHoursConfig,
      resumed: true,
    });
  }
});
