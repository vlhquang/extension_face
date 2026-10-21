# Hướng Dẫn Đổi Tài Khoản Facebook Cho FB Fanpage Auto Extension

Tài liệu này hướng dẫn các phương pháp chuyển đổi tài khoản Facebook an toàn, ổn định và hiệu quả nhất khi sử dụng extension tự động hóa **FB Fanpage Auto**.

---

## 📌 Tổng Quan Các Phương Pháp

| Phương pháp | Ưu điểm | Nhược điểm | Đánh giá khuyến nghị |
| :--- | :--- | :--- | :--- |
| **Cách 1: Sử dụng Chrome Profile riêng biệt** | Tách biệt 100% cookie & session, an toàn tuyệt đối, không lo checkpoint, chạy song song nhiều nick cùng lúc | Cần tạo profile mới trên Chrome | ⭐⭐⭐⭐⭐ **Khuyên dùng nhất** |
| **Cách 2: Đổi tài khoản thủ công trên cùng tab** | Đơn giản, không cần cấu hình thêm | Phải dừng extension trước khi đổi, chỉ chạy được 1 nick tại một thời điểm | ⭐⭐⭐ Thích hợp test nhanh |
| **Cách 3: Tự động swap Cookie / UI Switcher** | Tự động hóa hoàn toàn lịch trình chạy nhiều nick | Phức tạp, dễ dính checkpoint thuật toán Facebook nếu đổi session quá nhanh | ⭐⭐⭐⭐ Dành cho hệ thống lớn |

---

## 🚀 Cách 1: Sử Dụng Chrome Profile Độc Lập (Khuyên Dùng Nhất)

Đây là giải pháp chuẩn công nghiệp khi nuôi và tự động hóa nhiều tài khoản Facebook.

### 1. Tại sao nên dùng Chrome Profile?
- **Độc lập hoàn toàn:** Mỗi Profile Chrome lưu giữ cookie, cache, lịch sử và extension riêng biệt. Facebook không phát hiện được sự liên kết giữa các tài khoản.
- **Chạy song song:** Bạn có thể mở 2, 5 hoặc 10 cửa sổ Chrome tương ứng với 10 tài khoản khác nhau để cùng quét và tương tác với Fanpage cùng lúc.
- **Không bao giờ bị xung đột (conflict) dữ liệu:** `chrome.storage` của extension trên mỗi profile là riêng rẽ, mỗi nick có thể cấu hình nội dung comment và khung giờ riêng.

### 2. Các bước thực hiện:
1. **Tạo Profile mới:**
   - Trên trình duyệt Chrome, click vào biểu tượng **Avatar tròn của Chrome** ở góc trên cùng bên phải (cạnh nút 3 chấm).
   - Chọn **Thêm** (Add) ở mục *Khách hoặc hồ sơ khác*.
   - Chọn **Tiếp tục mà không cần tài khoản** (Continue without an account).
   - Đặt tên gợi nhớ (ví dụ: `Nick FB 1`, `Nick FB 2`, `HDBank Seeding 1`...).
2. **Cài đặt Extension vào Profile mới:**
   - Mở `chrome://extensions/` trên profile vừa tạo.
   - Bật công tắc **Chế độ dành cho nhà phát triển** (Developer mode).
   - Nhấn nút **Tải tiện ích đã giải nén** (Load unpacked) -> Chọn thư mục `/Users/quangvlh/work/extension_face`.
3. **Đăng nhập & Bắt đầu:**
   - Mở Facebook và đăng nhập tài khoản mong muốn.
   - Truy cập Fanpage mục tiêu.
   - Mở Extension và nhấn **Bắt đầu**.

---

## 🔄 Cách 2: Đổi Tài Khoản Thủ Công Trên Cùng Trình Duyệt

Nếu bạn chỉ có 2 tài khoản và muốn chuyển qua lại trên cùng 1 cửa sổ:

### 1. Quy trình chuẩn để không bị lỗi extension:
1. **Bước 1: Tạm dừng Extension**
   - Click vào icon extension -> Nhấn nút **⏹ Dừng lại**.
   - Đảm bảo log hiển thị trạng thái `Đã dừng tự động hóa`.
2. **Bước 2: Chuyển tài khoản trên Facebook**
   - Click vào **Avatar tài khoản Facebook** ở góc trên cùng bên phải trang web Facebook.
   - Chọn **Xem tất cả trang cá nhân / Chuyển tài khoản** (hoặc chọn **Đăng xuất** rồi đăng nhập tài khoản khác).
3. **Bước 3: Mở lại Fanpage mục tiêu**
   - Sau khi Facebook tải xong tài khoản mới, truy cập lại đúng URL Fanpage (ví dụ: `https://www.facebook.com/hdbankfanpage`).
4. **Bước 4: Bật lại Extension**
   - Mở popup extension, nhấn **Xóa log** (để xóa lịch sử cũ của nick trước nếu muốn).
   - Nhấn **▶ Bắt đầu**.

> [!IMPORTANT]
> **Lưu ý quan trọng về trạng thái Like:**
> Extension quét trạng thái nút Like theo tài khoản hiện tại đang đăng nhập. Nếu nick mới chưa like bài viết đó, extension sẽ tự động Like và Bình luận bình thường mà không bị ảnh hưởng bởi nick cũ.

---

## 🤖 Cách 3: Thiết Kế Tự Động Hóa Chuyển Đổi Tài Khoản (Nâng Cấp Code)

Nếu muốn tích hợp khả năng tự động hoán đổi nick ngay trong Extension, có 2 kiến trúc chính có thể bổ sung:

### Phương án A: Tự động click UI Chuyển tài khoản Facebook
Facebook có sẵn tính năng lưu nhiều tài khoản trên cùng trình duyệt. Extension có thể giả lập click:
1. Click vào avatar góc phải: `div[aria-label="Trang cá nhân của bạn"][role="button"]`
2. Click nút chuyển tài khoản: `div[aria-label*="Chuyển sang"][role="button"]`
3. Chờ trang Facebook reload session mới.
4. Điều hướng quay lại Fanpage và chạy chu kỳ mới.

### Phương án B: Quản lý Danh sách Cookie (Cookie Switcher)
Extension sử dụng quyền `chrome.cookies`:
1. Lưu danh sách cookie của từng nick:
   ```json
   [
     { "account": "Nick A", "c_user": "1000...", "xs": "..." },
     { "account": "Nick B", "c_user": "1000...", "xs": "..." }
   ]
   ```
2. Hết ca làm việc của Nick A (ví dụ sau 30 phút hoặc sau khi comment xong bài viết):
   - Xóa cookie hiện tại: `chrome.cookies.remove(...)`
   - Ghi cookie của Nick B vào: `chrome.cookies.set(...)`
   - Gọi `chrome.tabs.reload()` để kích hoạt nick mới.

---

## 🛡️ Khuyến Cáo An Toàn Tránh Checkpoint Facebook

Khi chuyển đổi tài khoản để chạy tự động hóa:
1. **Giãn cách thời gian:** Đặt thời gian nghỉ (cooldown) ít nhất **2 - 5 phút** giữa các lần chuyển đổi tài khoản.
2. **Khác biệt nội dung bình luận:** Không dùng 100% cùng một câu bình luận cho nhiều tài khoản khác nhau trên cùng một bài viết (tránh bị bộ lọc spam của Facebook gắn cờ).
3. **Không lạm dụng tốc độ:** Duy trì thời gian reload hợp lý (ví dụ: 60s cho giờ bình thường, 15-30s cho khung giờ cao điểm).
