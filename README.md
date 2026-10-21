# FB Fanpage Auto – Chrome Extension (Manifest V3)

> **Tiện ích mở rộng Google Chrome (Manifest V3)** hỗ trợ tự động hóa quét bài viết, bày tỏ cảm xúc (Like) và đăng bình luận (Comment) trên các Fanpage Facebook theo thời gian thực với độ chính xác và tính an toàn cao.

---

## 📋 Mục Lục
1. [Tính Năng Nổi Bật](#-tính-năng-nổi-bật)
2. [Cấu Trúc Thư Mục Dự Án](#-cấu-trúc-thư-mục-dự-án)
3. [Hướng Dẫn Cài Đặt](#-hướng-dẫn-cài-đặt)
4. [Hướng Dẫn Sử Dụng](#-hướng-dẫn-sử-dụng)
5. [Nguyên Lý Hoạt Động Chi Tiết](#-nguyên-lý-hoạt-động-chi-tiết)
   - [Quy trình quét bài viết](#1-quy-trình-quét-bài-viết)
   - [Cơ chế xử lý Like & Comment trong Popup](#2-cơ-chế-xử-lý-like--comment-trong-popup)
   - [Cơ chế khung giờ vàng (Peak Hours)](#3-cơ-chế-khung-giờ-vàng-peak-hours)
   - [Đảm bảo chạy ngầm và không bị Chrome đóng băng](#4-đảm-bảo-chạy-ngầm-và-không-bị-chrome-đóng-băng)
6. [Cấu Hình & Lưu Trữ (Storage)](#-cấu-hình--lưu-trữ-storage)
7. [Xử Lý Lỗi Thường Gặp (Troubleshooting)](#-xử-lý-lỗi-thường-gặp-troubleshooting)

---

## ✨ Tính Năng Nổi Bật

- **Tự động nhận diện bài viết:** Quét trực tiếp danh sách bài viết trong `div[data-pagelet="ProfileTimeline"]` (chính xác từng unit bài viết `TimelineFeedUnit`).
- **Lựa chọn phạm vi quét linh hoạt:**
  - *Quét N bài mới nhất* (mặc định 2 bài đầu trang `[0, 1]`).
  - *Chỉ định thứ tự bài viết cụ thể* để test hoặc nhắm mục tiêu (ví dụ: `0, 2, 4` hoặc `4`).
- **Phân luồng thông minh Inline vs Popup:**
  - *Bài viết có sẵn ô nhập:* Bày tỏ cảm xúc (Like) và gửi bình luận song song ngay trên timeline.
  - *Bài viết chưa mở ô nhập:* Tự động click mở popup dialog bài viết, thực hiện like và bình luận **bên trong popup** mà không làm ảnh hưởng giao diện feed.
- **Cơ chế Thử lại (Retry) 5 lần ngay trong popup:** Nếu thao tác like hoặc comment chưa thành công ở lần đầu, extension tự động thử lại tối đa 5 lần **ngay trong popup đang mở** trước khi đóng popup, không cần reload lại trang từ đầu.
- **Tương thích hoàn hảo trình soạn thảo Facebook Lexical:** Chống lỗi lặp ký tự (duplicate text), kích hoạt synthetic events của React 18 và tự động submit bằng nút Đăng hoặc phím Enter.
- **Cô lập từng Tab (Tab Isolation):** Extension chỉ hoạt động trên đúng tab bạn bấm nút "Bắt đầu". Các tab Facebook khác của bạn hoàn toàn độc lập và không bị ảnh hưởng.
- **Chạy nền liên tục (Background Persistence):** Sử dụng Service Worker relay ping để vượt qua cơ chế đóng băng hẹn giờ (timer throttling) của Chrome khi bạn chuyển tab hoặc thu nhỏ trình duyệt.
- **Chế độ tiết kiệm tài nguyên (Resource Optimization):** Tự động chặn tải hình ảnh/media nặng (`declarativeNetRequest`) chỉ riêng trên tab tự động hóa để tăng tốc độ phản hồi và tiết kiệm RAM/CPU.
- **Cấu hình Khung giờ cao điểm (Peak Hours):** Hỗ trợ đặt lịch reload riêng cho các khung giờ quan trọng trong ngày (ví dụ: `10h, 12h, 15h, 17h, 20h`) duy trì trong $X$ phút với tần suất reload nhanh hơn (ví dụ: 15s).
- **Reload chuẩn xác URL ban đầu:** Khi đến chu kỳ làm mới trang, extension luôn tải lại đúng URL Fanpage được lưu lúc bắt đầu (tránh bị lạc sang URL bài viết con).

---

## 📁 Cấu Trúc Thư Mục Dự Án

```
/Users/quangvlh/work/extension_face/
├── manifest.json         # Khai báo cấu hình extension Manifest V3, permissions, DNR rules
├── background.js         # Service worker quản lý quy tắc chặn media tab, giữ timer nền, relay
├── content.js            # Engine tự động hóa chính: tương tác DOM, like, comment, retry popup
├── popup.html            # Giao diện điều khiển người dùng (UI cấu hình, log, bật/tắt)
├── popup.js              # Xử lý logic giao diện popup, lưu trữ chrome.storage, gửi lệnh
├── styles.css            # Định kiểu giao diện popup hiện đại theo phong cách Facebook
├── icons/                # Thư mục chứa biểu tượng extension các kích thước (16x16, 48x48, 128x128)
├── README.md             # Tài liệu kỹ thuật chi tiết của dự án
└── HUONG_DAN_DOI_TAI_KHOAN.md # Hướng dẫn chuyển đổi và quản lý nhiều tài khoản FB
```

---

## 🛠 Hướng Dẫn Cài Đặt

1. **Mở trình duyệt Google Chrome** (hoặc trình duyệt nhân Chromium như Edge, Brave, Cốc Cốc).
2. Truy cập vào trang quản lý tiện ích:
   ```text
   chrome://extensions/
   ```
3. Bật công tắc **Chế độ dành cho nhà phát triển** (Developer mode) ở góc trên bên phải.
4. Nhấn vào nút **Tải tiện ích đã giải nén** (Load unpacked).
5. Chọn thư mục dự án:
   ```text
   /Users/quangvlh/work/extension_face
   ```
6. Tiện ích **FB Fanpage Auto** sẽ xuất hiện trên thanh công cụ của trình duyệt. Ghim icon extension để tiện thao tác.

---

## 📖 Hướng Dẫn Sử Dụng

### 1. Chuẩn bị
- Đăng nhập tài khoản Facebook trên trình duyệt.
- Truy cập vào trang Fanpage bạn muốn theo dõi (ví dụ: `https://www.facebook.com/hdbankfanpage`).

### 2. Thiết lập cấu hình trên Popup
Click vào biểu tượng extension trên thanh công cụ để mở bảng điều khiển:
- **Nội dung bình luận:** Nhập đoạn văn bản bạn muốn tự động bình luận vào bài viết.
- **Phạm vi quét bài:**
  - Chọn *Duyệt qua số bài mới nhất* (nhập số lượng bài, ví dụ: `2`).
  - Hoặc chọn *Chỉ định thứ tự bài viết test* (nhập danh sách chỉ số, ví dụ: `0` là bài đầu tiên, `4` là bài thứ 5).
- **Thời gian chờ Reload bình thường (giây):** Thời gian nghỉ giữa các chu kỳ quét (ví dụ: `60` giây).
- **Cấu hình Khung giờ cao điểm (Tùy chọn):**
  - Tích chọn *Kích hoạt cấu hình khung giờ cao điểm*.
  - Nhập các mốc giờ cách nhau bằng dấu phẩy (ví dụ: `10, 12, 15, 17, 20`).
  - Nhập thời gian duy trì (ví dụ: `15` phút kể từ đầu mỗi khung giờ).
  - Nhập thời gian reload nhanh trong khung giờ (ví dụ: `15` giây).

### 3. Vận hành
- Nhấn nút **▶ Bắt đầu**.
- Tab hiện tại sẽ được đánh dấu là tab tự động hóa, extension bắt đầu chu kỳ quét đầu tiên.
- Quan sát tiến trình thực thi trực tiếp tại hộp **Nhật ký hoạt động (Logs)**.
- Khi muốn dừng lại, nhấn nút **⏹ Dừng lại**.

---

## ⚙️ Nguyên Lý Hoạt Động Chi Tiết

### 1. Quy trình quét bài viết
```
[Bắt đầu chu kỳ]
       │
       ▼
Tìm container: div[data-pagelet="ProfileTimeline"]
       │
       ▼
Lấy danh sách các bài viết: div[data-pagelet^="TimelineFeedUnit_"]
       │
       ▼
Lọc theo danh sách index đã cấu hình (ví dụ: bài 0, 1 hoặc bài 4)
       │
       ▼
Đối với từng bài viết:
  ├─ 1. Cuộn bài viết vào giữa màn hình (scrollIntoView)
  ├─ 2. Kiểm tra trạng thái đã Like: [aria-label="Gỡ Thích"]
  │      ├─ NẾU ĐÃ LIKE -> Bỏ qua toàn bộ (skip cả like lẫn comment)
  │      └─ NẾU CHƯA LIKE -> Tiến hành bước xử lý Like & Comment
```

### 2. Cơ chế xử lý Like & Comment trong Popup
Đối với các bài viết không có ô nhập bình luận trực tiếp trên timeline:
1. Extension kích hoạt click nút mở bình luận: `[data-ad-rendering-role="comment_button"]` hoặc `aria-label="Viết bình luận"`.
2. Theo dõi sự xuất hiện của `div[role="dialog"]`.
3. Khi popup mở:
   - **Thao tác Like:** Nhắm trực tiếp vào phần tử có thuộc tính `[data-ad-rendering-role="like_button"]` của bài viết (tránh click nhầm nút like trong các bình luận của người khác).
   - **Thao tác Comment:** Tìm ô soạn thảo Lexical `div[data-lexical-editor="true"]`. Nếu chưa xuất hiện, extension tự động click nút "Viết bình luận" bên trong popup để kích hoạt ô nhập.
   - **Nhập văn bản an toàn:** Dùng lệnh chèn văn bản kết hợp clipboard event và dispatch synthetic event để tương thích với React 18 của Facebook.
   - **Gửi bình luận:** Tìm nút `aria-label="Đăng bình luận"` (khi đã hết trạng thái disabled) hoặc dự phòng bằng phím Enter.
4. **Cơ chế Retry tối đa 5 lần:** Nếu thao tác Like hoặc Comment chưa thành công, extension **giữ nguyên popup đang mở**, đợi 1 giây và lặp lại thao tác tối đa 5 lần.
5. Sau khi hoàn tất (hoặc hết lượt retry), extension click nút `aria-label="Đóng"` để đóng popup và trả lại giao diện timeline sạch sẽ.

### 3. Cơ chế khung giờ vàng (Peak Hours)
Hàm `getReloadScheduleInfo()` trong [content.js](file:///Users/quangvlh/work/extension_face/content.js) tính toán thời gian thực theo đồng hồ hệ thống:
- Nếu giờ hiện tại trùng với mốc giờ cấu hình (ví dụ: `10:05` thuộc khung 10h với thời lượng duy trì 15 phút):
  - Áp dụng thời gian reload nhanh (ví dụ: `15s`).
  - Ghi log thông báo: `[Khung giờ cao điểm: 10h (duy trì 15p) - Reload: 15s]`.
- Nếu ngoài khung giờ vàng:
  - Áp dụng thời gian reload bình thường (ví dụ: `60s`).

### 4. Đảm bảo chạy ngầm và không bị Chrome đóng băng
- Khi người dùng chuyển sang tab khác hoặc thu nhỏ cửa sổ Chrome, trình duyệt thường bóp nghẹt (throttle) `setTimeout` của trang web xuống còn 1 lần/phút hoặc đóng băng tab hoàn toàn.
- Để khắc phục, extension triển khai cơ chế:
  1. `chrome.tabs.update(tabId, { autoDiscardable: false })`: Ngăn chặn Chrome tự động giải phóng RAM tab đang chạy.
  2. `BACKGROUND_SLEEP`: [content.js](file:///Users/quangvlh/work/extension_face/content.js) gửi yêu cầu đếm thời gian sang [background.js](file:///Users/quangvlh/work/extension_face/background.js) (Service Worker) để duy trì luồng đếm nhịp chính xác từng giây.

---

## 💾 Cấu Hình & Lưu Trữ (Storage)

Extension lưu trữ trạng thái người dùng trong `chrome.storage.local`:

| Khóa (Key) | Kiểu dữ liệu | Mô tả |
| :--- | :--- | :--- |
| `commentText` | `string` | Nội dung văn bản bình luận |
| `normalReloadDelay` | `number` | Số giây chờ tải lại trang ở khung giờ thường |
| `scanMode` | `string` | Chế độ quét: `'latest'` (N bài mới) hoặc `'indices'` (chỉ số cụ thể) |
| `postCount` | `number` | Số bài mới cần quét khi ở chế độ `'latest'` |
| `customIndices` | `string` | Chuỗi các chỉ số bài viết test (ví dụ: `"0, 2"`) |
| `peakHoursEnabled` | `boolean` | Trạng thái kích hoạt khung giờ cao điểm |
| `peakHoursList` | `string` | Danh sách các mốc giờ (ví dụ: `"10, 12, 15, 17, 20"`) |
| `peakDuration` | `number` | Số phút duy trì của mỗi khung giờ cao điểm |
| `peakReloadDelay` | `number` | Số giây chờ tải lại trang trong khung giờ cao điểm |
| `isRunning` | `boolean` | Trạng thái tự động hóa đang chạy hay dừng |
| `automationTabId` | `number` | ID của tab trình duyệt được giao nhiệm vụ tự động hóa |
| `originalUrl` | `string` | URL Fanpage gốc được lưu tại thời điểm bấm bắt đầu |
| `activityLogs` | `Array<string>` | Danh sách các dòng nhật ký hoạt động |

---

## ❓ Xử Lý Lỗi Thường Gặp (Troubleshooting)

1. **Không mở được popup hoặc bị báo "không tìm thấy nút like":**
   - Đảm bảo bạn đang mở đúng trang Fanpage dạng dòng thời gian chuẩn của Facebook.
   - Thử cuộn chuột nhẹ trang web 1-2 lần để Facebook tải cấu trúc DOM ban đầu trước khi bấm Bắt đầu.
2. **Facebook đổi giao diện hoặc ngôn ngữ:**
   - Extension hỗ trợ song ngữ Tiếng Việt và Tiếng Anh (`Thích` / `Like`, `Bình luận` / `Comment`). Tuy nhiên, khuyến nghị sử dụng giao diện Facebook Tiếng Việt để có độ tương thích cao nhất.
3. **Cập nhật code extension sau khi chỉnh sửa:**
   - Vào `chrome://extensions/`.
   - Tìm thẻ **FB Fanpage Auto**, nhấn vào biểu tượng **Tải lại** (nút xoay tròn 🔄).
   - F5 lại tab Fanpage Facebook đang chạy.
