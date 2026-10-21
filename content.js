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
const postCommentChoices = new Map();
let reloadDelaySec    = 30;
let originalUrl       = '';
let targetIndices     = [0, 1]; // Danh sách các bài cần quét (mặc định: 0, 1)

// Cấu hình khung giờ cao điểm (mặc định: 10, 12, 15, 17, 20h)
let peakConfig = {
  enabled: true,
  hours: '10, 12, 15, 17, 20',
  durationMin: 15,
  reloadDelaySec: 15,
};

// Track post IDs (link) đã xử lý xong trong phiên này
const processedPostLinks = new Set();

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
 * Kiểm tra xem thời điểm hiện tại có đang nằm trong khung giờ cao điểm hay không.
 * Các khung giờ cố định mặc định: 10h, 12h, 15h, 17h, 20h.
 * Mỗi khung giờ duy trì trong peakConfig.durationMin phút (mặc định 15 phút).
 * @returns {{ inPeak: boolean, currentDelay: number, currentSlotStr: string }}
 */
function getReloadScheduleInfo() {
  if (!peakConfig || !peakConfig.enabled) {
    return { inPeak: false, currentDelay: reloadDelaySec, currentSlotStr: '' };
  }

  const now = new Date();
  const currentMinsOfDay = now.getHours() * 60 + now.getMinutes();

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

    if (currentMinsOfDay >= startMins && currentMinsOfDay < endMins) {
      const remainingMin = endMins - currentMinsOfDay;
      const startStr = `${String(h).padStart(2, '0')}:00`;
      const endH = Math.floor(endMins / 60) % 24;
      const endM = endMins % 60;
      const endStr = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
      return {
        inPeak: true,
        currentDelay: peakDelay,
        currentSlotStr: `${startStr} - ${endStr} (còn ${remainingMin} phút)`,
      };
    }
  }

  return { inPeak: false, currentDelay: reloadDelaySec, currentSlotStr: '' };
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

function logEntry(text) {
  console.log(`[FB Fanpage Auto] ${text}`);
  try {
    chrome.runtime.sendMessage({ type: 'LOG_FROM_CONTENT', text });
  } catch (_) {}
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
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (
      href.includes('/posts/') ||
      href.includes('/permalink/') ||
      href.includes('/videos/') ||
      href.includes('/photos/') ||
      href.includes('story_fbid=')
    ) {
      try {
        return new URL(href, 'https://www.facebook.com').href;
      } catch {
        return href;
      }
    }
  }
  return postEl.getAttribute('data-pagelet') || 'unknown';
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
    textbox.scrollIntoView({ behavior: 'instant', block: 'center' });
    await sleep(100);

    // Step 1: Click + focus để kích hoạt Lexical editor
    triggerClick(textbox);
    textbox.focus();
    await sleep(200);

    // Step 2: Dispatch focus event tường minh
    textbox.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sleep(100);

    // Step 3: Xóa sạch nội dung cũ
    document.execCommand('selectAll', false, null);
    await sleep(60);
    document.execCommand('delete', false, null);
    await sleep(60);

    // Chỉ chèn một lần. Không paste/chèn thêm khi execCommand trả false
    // hoặc DOM chưa cập nhật, vì Lexical có thể đã nhận nội dung.
    document.execCommand('insertText', false, text);

    await sleep(250);
    // Nội dung bị lặp hoặc chưa nhập được không được coi là thành công.
    const expected = text.trim();
    return expected.length > 0 && textbox.textContent.trim() === expected;
  } catch (err) {
    console.error('[FB Fanpage Auto] insertTextIntoLexical error:', err);
    return false;
  }
}

// ─── Action: Submit comment ───────────────────────────────────────────────────

async function submitComment(container, timeout = 6000) {
  const startTime = Date.now();

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
    } catch (_) {}
  }

  // Thử gửi Enter lần đầu nếu ô comment đã có text
  const initialTb = findCommentBox(container);
  if (initialTb && initialTb.textContent.trim().length > 0) {
    sendEnter(initialTb);
    await sleep(400);
  }

  while (Date.now() - startTime < timeout) {
    if (!automationRunning) return false;

    const tb = findCommentBox(container);
    // Nếu ô comment đã trống -> gửi thành công!
    if (!tb || tb.textContent.trim().length === 0) {
      return true;
    }

    // 1. Tìm nút gửi bình luận
    const submitBtn = container.querySelector(
      'div[aria-label="Đăng bình luận"], ' +
      'div[aria-label="Bình luận"][role="button"], ' +
      '[aria-label*="Đăng bình luận" i][role="button"], ' +
      '[aria-label*="Comment" i][role="button"], ' +
      '[aria-label*="Send" i][role="button"], ' +
      '[aria-label*="Gửi" i][role="button"], ' +
      'form button[type="submit"], ' +
      'form [role="button"][type="submit"]'
    );
    if (submitBtn && submitBtn.getAttribute('aria-disabled') !== 'true') {
      triggerClick(submitBtn);
      await sleep(500);
      const afterTb = findCommentBox(container);
      if (!afterTb || afterTb.textContent.trim().length === 0) {
        return true;
      }
    }

    // 2. Dispatch phím Enter
    if (tb && tb.textContent.trim().length > 0) {
      sendEnter(tb);
      await sleep(600);
      if (tb.textContent.trim().length === 0) {
        return true;
      }
    }

    await sleep(300);
  }

  const finalTb = findCommentBox(container);
  return !finalTb || finalTb.textContent.trim().length === 0;
}

// ─── Utility: waitUntil ───────────────────────────────────────────────────────

/**
 * Chờ một điều kiện predicate() trở thành truthy.
 * @param {Function} predicate
 * @param {number}   timeout
 * @param {number}   interval
 * @returns {Promise<boolean>}
 */
function waitUntil(predicate, timeout = 6000, interval = 200) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const check = async () => {
      if (!automationRunning) { resolve(false); return; }
      if (predicate()) { resolve(true); return; }
      if (Date.now() - startTime >= timeout) { resolve(false); return; }
      await sleep(interval);
      check();
    };
    check();
  });
}

// ─── Action: Đóng Popup / Dialog (nếu có mở) ─────────────────────────────────

/**
 * Đóng modal / popup bài viết nếu đang mở để quay lại timeline feed.
 * @param {Element} dialogEl
 */
async function closeDialog(dialogEl) {
  if (!dialogEl) return;
  const closeBtn = dialogEl.querySelector(
    'div[aria-label="Đóng"], div[aria-label="Close"], [aria-label*="Đóng"][role="button"]'
  );
  if (closeBtn) {
    closeBtn.click();
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
  await sleep(600);
}

// ─── Utility: Helpers tìm phần tử & tương tác nâng cao ──────────────────────

/**
 * Click an toàn bằng cách giả lập đầy đủ chuỗi sự kiện chuột/con trỏ.
 * Giúp kích hoạt các synthetic event listener của React 18 trên Facebook.
 * @param {Element} element
 */
function triggerClick(element) {
  if (!element) return;
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
 * @returns {Promise<number>} Thời gian xử lý nút like (ms), hoặc -1 nếu không tìm thấy
 */
async function performLike(container) {
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
    const lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
    return lbl.includes('gỡ thích') || lbl.includes('remove like') || lbl.includes('unlike');
  }, 1500, 150);

  if (!confirmed) {
    // Thử click trực tiếp thêm 1 lần
    try { btn.click(); } catch (_) {}
    await sleep(250);
  }

  return Date.now() - t0;
}

// ─── Action: Comment on specific textbox ──────────────────────────────────────

/**
 * Nhập văn bản vào ô textbox và nhấn nút Đăng bình luận bên trong container.
 * @param {Element} container  post element hoặc dialog element
 * @param {Element} textbox    ô contenteditable Lexical
 * @param {string}  text       nội dung bình luận
 * @returns {Promise<{elapsed: number, success: boolean}>}
 */
async function performCommentOnTextbox(container, textbox, text) {
  const t0 = Date.now();
  if (!textbox) {
    return { elapsed: Date.now() - t0, success: false };
  }

  const inserted = await insertTextIntoLexical(textbox, text);
  if (!inserted) {
    return { elapsed: Date.now() - t0, success: false };
  }

  const submitted = await submitComment(container);
  return { elapsed: Date.now() - t0, success: submitted };
}

// ─── Core: Process a single post ─────────────────────────────────────────────

async function processPost(postEl, index) {
  const postStart = Date.now();
  const postLink  = getPostLink(postEl);

  // Cuộn bài viết vào giữa màn hình để Facebook mount DOM và hiển thị đầy đủ
  try {
    postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);
  } catch (_) {}

  // ── B2-1: Nếu bài đã được like → bỏ qua cả like lẫn comment ─────────────
  const unlikeBtn    = postEl.querySelector('[aria-label="Gỡ Thích"], [aria-label="Remove like"]');
  const alreadyLiked = !!unlikeBtn;

  let likeStatus    = alreadyLiked ? 'đã like' : 'chưa like';
  let likeAction    = '';
  let commentStatus = '';
  let commentAction = '';

  if (alreadyLiked) {
    // Đã like → skip toàn bộ, không comment
    likeAction    = 'skip like';
    commentAction = 'skip comment (bài đã được like)';
    commentStatus = 'N/A';
    processedPostLinks.add(postLink);
  } else {
    // ── B2-2: Xử lý bài chưa được like ────────────────────────────────────
    // Chọn một lần cho mỗi bài; mọi lần retry dùng lại đúng nội dung đã chọn.
    const selectedComment = getCommentForPost(postLink);

    // Kiểm tra bài viết có sẵn ô bình luận inline hay không
    const inlineBox = findInlineCommentBox(postEl);

    if (inlineBox) {
      // Trường hợp 1: Có sẵn ô bình luận inline
      // Thực hiện LIKE và COMMENT song song ngay trên bài viết
      commentStatus = 'inline';
      const [likeElapsed, commentResult] = await Promise.all([
        performLike(postEl),
        performCommentOnTextbox(postEl, inlineBox, selectedComment)
      ]);

      likeAction = (likeElapsed === -1)
        ? 'không tìm thấy nút like'
        : `Tổng thời gian: ${likeElapsed}ms`;

      commentAction = `Tổng thời gian: ${commentResult.elapsed}ms${commentResult.success ? '' : ' (thất bại)'}`;

      if (commentResult.success) {
        processedPostLinks.add(postLink);
      }
    } else {
      // Trường hợp 2: Không có ô bình luận inline → Phải mở popup
      // QUY TẮC: KHÔNG thực hiện like liền mà thực hiện trong bài viết mở popup!
      // YÊU CẦU: Nếu lần quét thao tác đầu không thành công sẽ thực hiện thêm lại nhiều nhất 5 lần nữa
      // ĐẶC BIỆT: Chạy lại các thao tác like & comment NGAY TRONG POPUP đang mở, không đóng popup hay làm lại từ đầu
      commentStatus = 'bình luận qua popup';

      // 1. Mở popup (thử bấm mở tối đa 3 lần nếu chưa mở được)
      let openedDialog = null;
      let popupOpened  = false;

      // Đóng bất kỳ dialog cũ nào đang còn sót lại trên trang
      const staleDialog = document.querySelector('div[role="dialog"]');
      if (staleDialog) {
        await closeDialog(staleDialog);
        await sleep(400);
      }

      logEntry(`🔍 [Bài ${index}] Không có ô bình luận inline → Bấm nút mở popup…`);

      for (let openTry = 1; openTry <= 3; openTry++) {
        if (!automationRunning) break;

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

        if (popupOpened) {
          logEntry(`✅ [Bài ${index}] Popup bài viết đã mở thành công!`);
          break;
        }

        if (openTry < 3) {
          logEntry(`⏳ [Bài ${index}] Chưa thấy popup mở, cuộn lại và thử bấm lại lần ${openTry + 1}…`);
          postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(800);
        }
      }

      if (!popupOpened || !openedDialog) {
        logEntry(`❌ [Bài ${index}] Thất bại: Không mở được popup bài viết sau 3 lần thử.`);
        likeAction    = 'thất bại (không mở được popup bài viết)';
        commentAction = 'thất bại (không mở được popup bài viết)';
      } else {
        // 2. Popup đã mở!
        // THỰC HIỆN CÁC THAO TÁC LIKE, COMMENT NGAY TRONG POPUP
        await sleep(600);

        let targetContainer = openedDialog;
        let likeSuccess      = false;
        let likeElapsedMs    = -1;
        let commentSuccess   = false;
        let commentElapsedMs = 0;

        // Kiểm tra xem trong popup đã like sẵn chưa
        const checkLikeInPopup = () => {
          const lRole = targetContainer.querySelector('[data-ad-rendering-role="like_button"]');
          const lBtn  = lRole ? (lRole.closest('[role="button"]') || lRole.closest('div[aria-label]')) : null;
          if (lBtn) {
            const lbl = (lBtn.getAttribute('aria-label') || '').toLowerCase();
            return lbl.includes('gỡ thích') || lbl.includes('remove like') || lbl.includes('unlike');
          }
          return false;
        };

        if (checkLikeInPopup()) {
          likeSuccess   = true;
          likeElapsedMs = 0;
        }

        const MAX_RETRIES    = 5; // Tối đa 5 lần thử lại thêm
        const TOTAL_ATTEMPTS = 1 + MAX_RETRIES; // Tổng cộng tối đa 6 lượt

        for (let opAttempt = 1; opAttempt <= TOTAL_ATTEMPTS; opAttempt++) {
          if (!automationRunning) break;

          if (opAttempt > 1) {
            logEntry(`🔄 [Bài ${index} - Trong popup] Thử lại thao tác like/comment lần ${opAttempt - 1}/${MAX_RETRIES}…`);
          }

          // A. Thao tác Like (nếu chưa like thành công)
          if (!likeSuccess) {
            const res = await performLike(targetContainer);
            if (res >= 0 && checkLikeInPopup()) {
              likeSuccess   = true;
              likeElapsedMs = res;
            } else if (res >= 0) {
              // Fallback nếu trong dialog chưa ăn, thử like ngay trên postEl ở timeline
              const fbRes = await performLike(postEl);
              if (fbRes >= 0) {
                likeSuccess   = true;
                likeElapsedMs = fbRes;
              }
            }
          }

          // B. Thao tác Comment (nếu chưa comment thành công)
          if (!commentSuccess) {
            const tbStart = Date.now();

            // Cuộn vùng nội dung dialog xuống dưới đáy để Facebook render ô nhập bình luận
            scrollDialogToBottom(openedDialog);
            await sleep(350);

            let targetTextbox = findDialogCommentBox(openedDialog);

            // Nếu chưa tìm thấy ô textbox, bấm nút "Viết bình luận" bên trong popup để mở / kích hoạt ô nhập
            if (!targetTextbox) {
              const innerCommentBtn = findCommentButton(openedDialog);
              if (innerCommentBtn) {
                triggerClick(innerCommentBtn);
                await sleep(500);
              }
              // Chờ ô comment xuất hiện sau khi click
              await waitUntil(() => {
                scrollDialogToBottom(openedDialog);
                targetTextbox = findDialogCommentBox(openedDialog);
                return !!targetTextbox;
              }, 3000, 300);
            }

            // Nhập nội dung và submit
            if (targetTextbox) {
              targetTextbox.scrollIntoView({ behavior: 'instant', block: 'center' });
              await sleep(150);

              const inserted = await insertTextIntoLexical(targetTextbox, selectedComment);
              if (inserted) {
                await sleep(300);
                const submitted = await submitComment(openedDialog, 5000);
                if (submitted) {
                  commentSuccess   = true;
                  commentElapsedMs = Date.now() - tbStart;
                }
              }
            }
          }

          // C. Nếu cả Like và Comment đều đã xong -> Hoàn thành!
          if (likeSuccess && commentSuccess) {
            break;
          }

          // D. Nếu chưa thành công -> Chờ 1 giây rồi thử lại TIẾP TỤC TRONG POPUP ĐANG MỞ
          if (opAttempt < TOTAL_ATTEMPTS) {
            await sleep(1000);
          }
        }

        likeAction = likeSuccess
          ? (likeElapsedMs === 0 ? 'đã like sẵn' : `Tổng thời gian: ${likeElapsedMs}ms`)
          : `thất bại sau ${MAX_RETRIES} lần thử lại trong popup`;

        commentAction = commentSuccess
          ? `Tổng thời gian: ${commentElapsedMs}ms`
          : `thất bại sau ${MAX_RETRIES} lần thử lại trong popup`;

        if (commentSuccess) {
          processedPostLinks.add(postLink);
        }

        // 3. Đóng popup dialog sau khi hoàn tất
        if (openedDialog) {
          await sleep(600);
          await closeDialog(openedDialog);
        }
      }
    }
  }

  const totalElapsed = Date.now() - postStart;

  // ── Ghi log bài viết ───────────────────────────────────────────────────────
  const log = [
    `=== Post Log [${index}] ===`,
    `- Link bài viết: ${postLink}`,
    `- Hiện trạng like: ${likeStatus}`,
    `- Thao tác like: ${likeAction}`,
    `- Hiện trạng comment: ${commentStatus}`,
    `- Thao tác bình luận: ${commentAction}`,
    `- Tổng thời gian xử lý bài: ${totalElapsed}ms`
  ].join('\n');

  console.log(log);
  logEntry(log);
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
async function findPostElement(timeline, index) {
  let posts = getOrderedTimelinePosts(timeline);

  // Nếu số lượng bài chưa đủ đến index, cuộn nhẹ trang xuống để kích hoạt Facebook load thêm feed
  if (posts.length <= index) {
    for (let c = 0; c < 3 && posts.length <= index; c++) {
      window.scrollBy({ top: 800, behavior: 'smooth' });
      await sleep(1000);
      posts = getOrderedTimelinePosts(timeline);
    }
  }

  const postEl = posts[index] || null;

  if (postEl) {
    // Cuộn bài viết vào giữa màn hình để Facebook mount nội dung DOM
    postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);
    return postEl;
  }

  return null;
}

// ─── Core: One full scan cycle ────────────────────────────────────────────────

async function runCycle() {
  if (!automationRunning) return;

  const timeline = document.querySelector('div[data-pagelet="ProfileTimeline"]');
  if (!timeline) {
    logEntry('⚠ Không tìm thấy ProfileTimeline – đang ở đúng trang fanpage chưa?');
    return;
  }

  let allDone = true;

  for (const index of targetIndices) {
    if (!automationRunning) return;

    const postEl = await findPostElement(timeline, index);
    if (!postEl) {
      logEntry(`⚠ Không tìm thấy bài viết ở vị trí thứ ${index + 1} trong ProfileTimeline`);
      allDone = false;
      continue;
    }

    const link = getPostLink(postEl);
    await processPost(postEl, index);
    // Đánh giá sau khi xử lý để bài vừa hoàn tất được tính ngay trong lượt này.
    if (!processedPostLinks.has(link)) {
      allDone = false;
    }

    await sleep(randInt(400, 800));
  }

  // Nếu tất cả bài trong danh sách chỉ định đã like + comment xong → reload về URL gốc
  if (allDone && automationRunning) {
    const sched = getReloadScheduleInfo();
    const effectiveDelay = sched.currentDelay;

    if (sched.inPeak) {
      logEntry(`⚡ [KHUNG GIỜ CAO ĐIỂM ${sched.currentSlotStr}] Dùng thời gian reload riêng: ${effectiveDelay}s`);
    } else {
      logEntry(`ℹ Tất cả bài chỉ định đã xong. Reload sau ${effectiveDelay} giây…`);
    }

    for (let remainingMs = Math.round(effectiveDelay * 1000); remainingMs > 0 && automationRunning;) {
      logEntry(`⏳ Reload sau ${remainingMs / 1000}s…`);
      const stepMs = Math.min(1000, remainingMs);
      await sleep(stepMs);
      remainingMs -= stepMs;
    }
    if (automationRunning) {
      logEntry(`🔄 Đang reload về đúng URL trang ban đầu: ${originalUrl}`);
      chrome.storage.local.get(['originalUrl'], (res) => {
        const targetUrl = res.originalUrl || originalUrl || window.location.href;
        window.location.href = targetUrl;
      });
    }
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
  acquireAutomationLock();
  commentText        = config.commentText || '';
  commentTemplates   = Array.isArray(config.commentTemplates)
    ? config.commentTemplates.filter(text => typeof text === 'string').map(text => text.trim()).filter(Boolean)
    : [];
  if (!commentTemplates.length && commentText.trim()) commentTemplates = [commentText.trim()];
  postCommentChoices.clear();
  reloadDelaySec     = parseReloadDelay(config.reloadDelaySec, 30);
  originalUrl        = config.originalUrl || window.location.href;
  targetIndices      = Array.isArray(config.targetIndices) && config.targetIndices.length > 0
    ? config.targetIndices
    : [0, 1];

  if (config.peakConfig) {
    peakConfig = config.peakConfig;
  }

  // Lưu chắc chắn originalUrl và trạng thái vào storage
  chrome.storage.local.set({ isRunning: true, originalUrl });

  const sched = getReloadScheduleInfo();
  const schedNote = sched.inPeak
    ? `⚡ Khung giờ cao điểm: ${sched.currentDelay}s (duy trì ${sched.currentSlotStr})`
    : `Reload thường: ${reloadDelaySec}s`;

  const targetDesc = targetIndices.map(i => `${i} (bài ${i + 1})`).join(', ');
  logEntry(`▶ Bắt đầu tự động hóa: Quét bài [${targetDesc}] | ${schedNote}`);
  startLoop();
}

function stopAutomation() {
  automationRunning = false;
  releaseAutomationLock();
  logEntry('⏹ Đã dừng tự động hóa.');
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_AUTOMATION') {
    startAutomation({
      commentText:    message.commentText || '',
      commentTemplates: message.commentTemplates,
      reloadDelaySec: message.reloadDelaySec ?? 30,
      originalUrl:    message.originalUrl,
      targetIndices:  message.targetIndices,
      peakConfig:     message.peakConfig,
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
  if (area === 'local' && changes.isRunning?.newValue === false && automationRunning) {
    stopAutomation();
  }
});

// ─── Tự kiểm tra quyền chạy khi tải trang (Multi-Tab Isolation) ───────────────
// Chỉ resume nếu đúng là tab được chỉ định automation. Các tab khác sẽ không chạy gì.
chrome.runtime.sendMessage({ type: 'CHECK_SHOULD_RUN' }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp && resp.shouldRun) {
    sleep(2500).then(() => {
      // Đọc lại trạng thái: người dùng có thể đã bấm Dừng trong lúc chờ.
      chrome.runtime.sendMessage({ type: 'CHECK_SHOULD_RUN' }, (current) => {
        if (chrome.runtime.lastError || !current?.shouldRun || automationRunning) return;
        logEntry('🔄 Tiếp tục tự động hóa sau khi tải lại trang.');
        startAutomation({
          commentText:    current.commentText,
          commentTemplates: current.commentTemplates,
          reloadDelaySec: current.reloadDelaySec,
          originalUrl:    current.originalUrl,
          targetIndices:  current.targetIndices,
          peakConfig:     current.peakConfig,
        });
      });
    });
  }
});
