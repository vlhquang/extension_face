'use strict';

function validateConfigFile(data) {
  if (data?.format !== 'fb-fanpage-auto-settings' || data.version !== 1 || !data.settings ||
      typeof data.settings !== 'object' || Array.isArray(data.settings)) throw Error('File cấu hình không đúng định dạng hoặc phiên bản.');
  const source = data.settings;
  const settings = {};
  const number = (value, min = 0, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) throw Error('Giá trị số không hợp lệ.');
    return value;
  };
  const boolean = value => {
    if (typeof value !== 'boolean') throw Error('Giá trị bật/tắt không hợp lệ.');
    return value;
  };
  for (const key of ['requireExistingComment', 'requirePositiveComments', 'blockImages', 'blockVideos']) {
    settings[key] = boolean(source[key]);
  }
  for (const key of ['reloadDelaySec', 'commentCountDelaySec']) settings[key] = number(source[key]);
  settings.postLimit = number(source.postLimit, 1, true);
  if (!['limit', 'custom'].includes(source.targetMode)) throw Error('Chế độ chọn bài không hợp lệ.');
  settings.targetMode = source.targetMode;
  if (typeof source.customPosts !== 'string' || (source.customPosts.trim() && !/^\d+(?:-\d+)?(?:[,;\s]+\d+(?:-\d+)?)*$/.test(source.customPosts.trim()))) throw Error('Danh sách bài không hợp lệ.');
  settings.customPosts = source.customPosts;
  if (!Array.isArray(source.commentTemplates) || source.commentTemplates.some(text => typeof text !== 'string')) throw Error('Danh sách bình luận không hợp lệ.');
  settings.commentTemplates = [...source.commentTemplates];
  settings.commentText = settings.commentTemplates.map(text => text.trim()).find(Boolean) || '';
  const peak = source.peakConfig;
  if (!peak || typeof peak.hours !== 'string' || !/^\s*\d{1,2}(?:\s*[,;\s]\s*\d{1,2})*\s*$/.test(peak.hours) ||
      peak.hours.trim().split(/[,;\s]+/).some(hour => Number(hour) > 23)) throw Error('Giờ cao điểm không hợp lệ.');
  settings.peakConfig = {
    enabled: boolean(peak.enabled), hours: peak.hours,
    durationMin: number(peak.durationMin, 1, true), reloadDelaySec: number(peak.reloadDelaySec),
    backupDurationMin: number(peak.backupDurationMin, 0, true),
    backupReloadDelaySec: number(peak.backupReloadDelaySec), successPostTarget: number(peak.successPostTarget, 1, true),
  };
  const quiet = source.quietHoursConfig;
  if (!quiet || ![quiet.startTime, quiet.endTime].every(time => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) throw Error('Giờ ít bài không hợp lệ.');
  settings.quietHoursConfig = { enabled: boolean(quiet.enabled), startTime: quiet.startTime,
    endTime: quiet.endTime, reloadDelaySec: number(quiet.reloadDelaySec) };
  // Không nhập tabId, trạng thái chạy, lịch sử bài hoặc log từ file.
  return settings;
}
