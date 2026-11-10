# Kế toán Gas

Phần mềm kế toán online cho đại lý / cửa hàng gas: **mua hàng, bán hàng, trả lại hàng, kho, tính giá xuất kho, quỹ, ngân hàng, công nợ tiền và công nợ vỏ bình**. Giao diện bố trí theo phân hệ tương tự MISA AMIS Kế toán.

Ứng dụng độc lập, nằm ngoài workspace của n8n và **không cần cài thư viện nào** (dùng SQLite có sẵn trong Node.js).

## Chạy phần mềm

Yêu cầu Node.js ≥ 22.13.

```bash
cd ke-toan-gas
node scripts/demo-data.js   # tùy chọn: nạp dữ liệu mẫu để dùng thử
node server.js
```

Mở http://localhost:3000 và đăng nhập `admin` / `admin123`. **Đổi mật khẩu ngay sau lần đăng nhập đầu** (nút "Đổi mật khẩu" góc trên phải).

| Biến môi trường | Ý nghĩa | Mặc định |
| --- | --- | --- |
| `PORT`, `HOST` | Cổng / địa chỉ lắng nghe | `3000`, `127.0.0.1` |
| `KTG_DB` | Đường dẫn file dữ liệu | `data/ketoan.db` |
| `KTG_ADMIN_PASSWORD` | Mật khẩu admin khi khởi tạo dữ liệu lần đầu | `admin123` |

Khi đưa lên mạng nội bộ / internet: đặt `HOST=0.0.0.0` và chạy sau một reverse proxy có HTTPS. Sao lưu dữ liệu bằng cách chép file `data/ketoan.db`.

## Công nợ theo loại nợ

| Tài khoản | Ý nghĩa | Tài khoản | Ý nghĩa |
| --- | --- | --- | --- |
| 1311 | Khách hàng nợ tiền | 3311 | Nợ tiền nhà cung cấp |
| 1312 | Khách hàng nợ vỏ gas 12kg | 3312 | Nợ nhà cung cấp vỏ gas 12kg |
| 1313 | Khách hàng nợ vỏ gas 45kg | 3313 | Nợ nhà cung cấp vỏ gas 45kg |

Mỗi mặt hàng gas khai báo **vỏ đi kèm** (danh mục Vật tư hàng hóa); mặt hàng vỏ khai báo **loại vỏ** (12kg / 45kg) và **giá trị 1 vỏ**. Công nợ vỏ được theo dõi cả số lượng lẫn giá trị.

## Định khoản tự động

| Chứng từ | Định khoản |
| --- | --- |
| Bán hàng | Nợ 1311 (hoặc 1111 / 1121) / Có 5111, Có 33311 · Nợ 632 / Có 156 |
| Bán hàng, tick **Khách hàng nợ vỏ** | thêm Nợ 1312 hoặc 1313 / Có 156 (vỏ xuất khỏi kho) |
| Khách hàng trả vỏ | Nợ 156 / Có 1312 hoặc 1313 (**kho vỏ tự tăng**) |
| Trả lại hàng bán | Nợ 5213, Nợ 33311 / Có 1311 · Nợ 156 / Có 632 (tick "trả lại cả vỏ": Nợ 156 / Có 1312, 1313) |
| Mua hàng | Nợ 156, Nợ 1331 / Có 3311 (hoặc 1111 / 1121) |
| Mua hàng, tick **Nợ vỏ nhà cung cấp** | thêm Nợ 156 / Có 3312 hoặc 3313 |
| Trả vỏ cho nhà cung cấp | Nợ 3312 hoặc 3313 / Có 156 |
| Trả lại hàng mua | Nợ 3311 / Có 156, Có 1331 |
| Nhập kho / Xuất kho khác | Nợ 156 / Có TK chọn · Nợ TK chọn / Có 156 |
| Phiếu thu, phiếu chi, thu / chi tiền gửi | Nợ 1111, 1121 / Có TK chọn · Nợ TK chọn / Có 1111, 1121 |

Số lượng vỏ nợ mặc định bằng số lượng bán và sửa được trên từng dòng (khách đổi vỏ ngay thì nhập 0).

## Tính giá xuất kho

Chọn ở **Kho → Tính giá xuất kho**: bình quân tức thời, bình quân cuối kỳ (theo tháng) hoặc nhập trước xuất trước. Giá vốn được tính lại tự động mỗi lần cất / sửa / xóa chứng từ; giá tính chung toàn doanh nghiệp (không tách theo kho). Vỏ cho nợ / nhận lại luôn ghi theo "giá trị 1 vỏ" để công nợ vỏ khớp số lượng — nên mua vỏ và nhập tồn đầu kỳ vỏ theo đúng giá này.

## Số dư đầu kỳ

- Tồn kho đầu kỳ: lập **Phiếu nhập kho** với TK Có 4111.
- Tiền, công nợ đầu kỳ: lập **Chứng từ nghiệp vụ khác** (ví dụ Nợ 1311 / Có 4111, chọn khách hàng).

## Sổ sách, báo cáo

Tổng quan · Sổ quỹ, sổ tiền gửi · Tổng hợp và chi tiết công nợ phải thu / phải trả theo từng loại nợ · Tổng hợp nhập-xuất-tồn, sổ chi tiết vật tư · Nhật ký chung · Sổ cái · Bảng cân đối tài khoản · Kết quả kinh doanh. Mọi báo cáo xuất được ra CSV (mở bằng Excel) và in.

## Cấu trúc

```
server.js            máy chủ HTTP, đăng nhập, API danh mục
src/db.js            lược đồ SQLite + dữ liệu khởi tạo (hệ thống tài khoản)
src/accounting.js    chứng từ -> thẻ kho + định khoản, tính giá xuất kho
src/reports.js       sổ sách, báo cáo
public/              giao diện web
```

## Giới hạn hiện tại

Chưa có: phân quyền nhiều người dùng, khóa sổ kỳ kế toán, bút toán kết chuyển cuối kỳ tự động (báo cáo KQKD tính trực tiếp từ sổ cái), hóa đơn điện tử, đền vỏ bằng tiền (thu tiền vào 1312 / 1313 không làm giảm số lượng vỏ nợ).
