'use strict';
// Nạp dữ liệu mẫu để dùng thử: node scripts/demo-data.js  (chỉ chạy trên dữ liệu trống)
const { one, run, tx } = require('../src/db');
const { saveVoucher } = require('../src/accounting');

if (one('SELECT 1 x FROM vouchers LIMIT 1')) {
  console.log('Đã có chứng từ, bỏ qua nạp dữ liệu mẫu.');
  process.exit(0);
}
const y = new Date().getFullYear();
const d = (m, day) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
tx(() => {
  const P = (code, name, kind, phone) => Number(run('INSERT INTO partners(code,name,kind,phone,address) VALUES (?,?,?,?,?)', code, name, kind, phone, 'Hà Nội').lastInsertRowid);
  const kh1 = P('KH001', 'Nhà hàng Hoa Sen', 'KH', '0901000001');
  const kh2 = P('KH002', 'Quán cơm Bình Dân', 'KH', '0901000002');
  const kh3 = P('KH003', 'Khách sạn Thái Bình', 'KH', '0901000003');
  const ncc1 = P('NCC001', 'Công ty CP Gas Petrolimex', 'NCC', '02438000001');
  const ncc2 = P('NCC002', 'Công ty TNHH Gas Miền Bắc', 'NCC', '02438000002');
  const it = (code) => one('SELECT id FROM items WHERE code=?', code).id;
  const kho = one('SELECT id FROM warehouses LIMIT 1').id;
  const L = (code, qty, price, x = {}) => ({ item_id: it(code), warehouse_id: kho, qty, price, vat_rate: 10, ...x });

  saveVoucher({ type: 'NVK', date: d(1, 1), description: 'Góp vốn bằng tiền mặt và tiền gửi', lines: [{ tk_no: '1111', tk_co: '4111', amount: 200000000 }, { tk_no: '1121', tk_co: '4111', amount: 500000000 }] });
  saveVoucher({ type: 'NK', date: d(1, 1), description: 'Tồn đầu kỳ vỏ bình', lines: [L('VO12', 100, 300000, { tk_co: '4111' }), L('VO45', 30, 1000000, { tk_co: '4111' })] });
  saveVoucher({ type: 'MH', date: d(1, 3), partner_id: ncc1, description: 'Mua gas nhập kho', lines: [L('GAS12', 200, 350000), L('GAS45', 40, 1320000)] });
  saveVoucher({ type: 'MH', date: d(1, 15), partner_id: ncc2, description: 'Mua gas, nợ vỏ nhà cung cấp', shell_debt: 1, lines: [L('GAS12', 100, 365000, { shell_qty: 50 })] });
  saveVoucher({ type: 'BH', date: d(1, 5), partner_id: kh1, description: 'Bán gas, khách nợ vỏ', shell_debt: 1, lines: [L('GAS12', 20, 420000), L('GAS45', 5, 1550000)] });
  saveVoucher({ type: 'BH', date: d(1, 10), partner_id: kh2, description: 'Bán gas thu tiền mặt', pay_method: 'TM', lines: [L('GAS12', 15, 425000)] });
  saveVoucher({ type: 'BH', date: d(1, 20), partner_id: kh3, description: 'Bán gas, khách nợ vỏ', shell_debt: 1, lines: [L('GAS45', 10, 1560000, { shell_qty: 6 }), L('GAS12', 30, 420000, { shell_qty: 10 })] });
  saveVoucher({ type: 'TV', date: d(1, 25), partner_id: kh1, description: 'Khách trả vỏ bình', lines: [L('VO12', 8, 0)] });
  saveVoucher({ type: 'BTL', date: d(1, 26), partner_id: kh1, description: 'Khách trả lại hàng lỗi van', shell_debt: 1, lines: [L('GAS12', 2, 420000)] });
  saveVoucher({ type: 'MTL', date: d(1, 27), partner_id: ncc1, description: 'Trả lại bình lỗi cho NCC', lines: [L('GAS12', 2, 350000)] });
  saveVoucher({ type: 'PT', date: d(1, 28), partner_id: kh1, description: 'Thu tiền hàng Nhà hàng Hoa Sen', lines: [{ tk_co: '1311', amount: 10000000, description: 'Thu tiền hàng' }] });
  saveVoucher({ type: 'UNC', date: d(1, 29), partner_id: ncc1, description: 'Trả tiền Gas Petrolimex', lines: [{ tk_no: '3311', amount: 80000000, description: 'Trả tiền hàng' }] });
  saveVoucher({ type: 'PC', date: d(1, 30), description: 'Chi tiền xăng xe giao hàng', lines: [{ tk_no: '641', amount: 1500000, description: 'Xăng xe' }] });
  saveVoucher({ type: 'TVN', date: d(1, 30), partner_id: ncc2, description: 'Trả vỏ cho nhà cung cấp', lines: [L('VO12', 20, 0)] });
});
console.log('Đã nạp dữ liệu mẫu.');
