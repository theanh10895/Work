'use strict';
// Kết nối SQLite (module có sẵn của Node.js, không cần cài thêm thư viện)
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.KTG_DB || path.join(__dirname, '..', 'data', 'ketoan.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, full_name TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, parent TEXT, nature TEXT NOT NULL DEFAULT 'N'
);
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('KH','NCC')),
  address TEXT, phone TEXT, tax_code TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS warehouses (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, unit TEXT,
  kind TEXT NOT NULL DEFAULT 'HH' CHECK (kind IN ('HH','VO')),  -- HH: hàng hóa, VO: vỏ bình gas
  shell_type TEXT NOT NULL DEFAULT '',                           -- '12' | '45' (chỉ với vỏ)
  shell_item_id INTEGER REFERENCES items(id),                    -- vỏ đi kèm mặt hàng gas
  shell_price REAL NOT NULL DEFAULT 0,                           -- giá trị 1 vỏ dùng ghi nhận nợ vỏ
  sale_price REAL NOT NULL DEFAULT 0, buy_price REAL NOT NULL DEFAULT 0, vat_rate REAL NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, no TEXT NOT NULL, date TEXT NOT NULL,
  partner_id INTEGER REFERENCES partners(id), description TEXT,
  pay_method TEXT NOT NULL DEFAULT 'NO',       -- NO: ghi công nợ, TM: tiền mặt, CK: chuyển khoản
  shell_debt INTEGER NOT NULL DEFAULT 0,       -- tick "nợ vỏ"
  warehouse_to_id INTEGER REFERENCES warehouses(id),
  total_amount REAL NOT NULL DEFAULT 0, total_vat REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (type, no)
);
CREATE TABLE IF NOT EXISTS voucher_lines (
  id INTEGER PRIMARY KEY, voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  item_id INTEGER REFERENCES items(id), warehouse_id INTEGER REFERENCES warehouses(id),
  qty REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
  vat_rate REAL NOT NULL DEFAULT 0, vat_amount REAL NOT NULL DEFAULT 0, shell_qty REAL NOT NULL DEFAULT 0,
  tk_no TEXT, tk_co TEXT, description TEXT
);
-- Thẻ kho: mỗi dòng là một lần nhập (dir=1) hoặc xuất (dir=-1)
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  date TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  dir INTEGER NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
  cost_mode TEXT NOT NULL DEFAULT 'fixed'      -- fixed: giá đích danh theo chứng từ; calc: hệ thống tính; transfer: chuyển kho
);
-- Sổ nhật ký chung
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY, voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  date TEXT NOT NULL, tk_no TEXT NOT NULL, tk_co TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
  partner_id INTEGER REFERENCES partners(id), item_id INTEGER REFERENCES items(id), qty REAL NOT NULL DEFAULT 0,
  move_id INTEGER REFERENCES stock_moves(id) ON DELETE CASCADE, description TEXT
);
CREATE INDEX IF NOT EXISTS ix_journal_date ON journal(date);
CREATE INDEX IF NOT EXISTS ix_journal_no ON journal(tk_no);
CREATE INDEX IF NOT EXISTS ix_journal_co ON journal(tk_co);
CREATE INDEX IF NOT EXISTS ix_moves_item ON stock_moves(item_id, date);
CREATE INDEX IF NOT EXISTS ix_vouchers_type ON vouchers(type, date);
-- Sổ cái dạng 1 dòng / 1 vế tài khoản
CREATE VIEW IF NOT EXISTS ledger AS
  SELECT id AS jid, voucher_id, date, tk_no AS acc, tk_co AS contra, amount AS dr, 0 AS cr, partner_id, item_id, qty AS qty_dr, 0 AS qty_cr, description FROM journal
  UNION ALL
  SELECT id, voucher_id, date, tk_co, tk_no, 0, amount, partner_id, item_id, 0, qty, description FROM journal;
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}

// ----- Dữ liệu khởi tạo -----
const ACCOUNTS = [
  ['111', 'Tiền mặt', '', 'N'], ['1111', 'Tiền Việt Nam', '111', 'N'],
  ['112', 'Tiền gửi ngân hàng', '', 'N'], ['1121', 'Tiền Việt Nam', '112', 'N'],
  ['131', 'Phải thu của khách hàng', '', 'L'],
  ['1311', 'Phải thu khách hàng - Nợ tiền', '131', 'L'],
  ['1312', 'Phải thu khách hàng - Nợ vỏ gas 12kg', '131', 'L'],
  ['1313', 'Phải thu khách hàng - Nợ vỏ gas 45kg', '131', 'L'],
  ['133', 'Thuế GTGT được khấu trừ', '', 'N'], ['1331', 'Thuế GTGT được khấu trừ của hàng hóa, dịch vụ', '133', 'N'],
  ['138', 'Phải thu khác', '', 'N'], ['1388', 'Phải thu khác', '138', 'N'],
  ['141', 'Tạm ứng', '', 'N'],
  ['153', 'Công cụ, dụng cụ', '', 'N'],
  ['156', 'Hàng hóa', '', 'N'],
  ['211', 'Tài sản cố định hữu hình', '', 'N'], ['214', 'Hao mòn tài sản cố định', '', 'C'],
  ['242', 'Chi phí trả trước', '', 'N'],
  ['331', 'Phải trả cho người bán', '', 'L'],
  ['3311', 'Phải trả người bán - Nợ tiền', '331', 'L'],
  ['3312', 'Phải trả người bán - Nợ vỏ gas 12kg', '331', 'L'],
  ['3313', 'Phải trả người bán - Nợ vỏ gas 45kg', '331', 'L'],
  ['333', 'Thuế và các khoản phải nộp Nhà nước', '', 'C'], ['3331', 'Thuế giá trị gia tăng phải nộp', '333', 'C'],
  ['33311', 'Thuế GTGT đầu ra', '3331', 'C'], ['3334', 'Thuế thu nhập doanh nghiệp', '333', 'C'],
  ['334', 'Phải trả người lao động', '', 'C'],
  ['338', 'Phải trả, phải nộp khác', '', 'C'], ['3388', 'Phải trả, phải nộp khác', '338', 'C'],
  ['341', 'Vay và nợ thuê tài chính', '', 'C'],
  ['411', 'Vốn đầu tư của chủ sở hữu', '', 'C'], ['4111', 'Vốn góp của chủ sở hữu', '411', 'C'],
  ['421', 'Lợi nhuận sau thuế chưa phân phối', '', 'C'], ['4212', 'LNST chưa phân phối năm nay', '421', 'C'],
  ['511', 'Doanh thu bán hàng và cung cấp dịch vụ', '', 'C'], ['5111', 'Doanh thu bán hàng hóa', '511', 'C'],
  ['515', 'Doanh thu hoạt động tài chính', '', 'C'],
  ['521', 'Các khoản giảm trừ doanh thu', '', 'N'], ['5211', 'Chiết khấu thương mại', '521', 'N'],
  ['5212', 'Giảm giá hàng bán', '521', 'N'], ['5213', 'Hàng bán bị trả lại', '521', 'N'],
  ['632', 'Giá vốn hàng bán', '', 'N'], ['635', 'Chi phí tài chính', '', 'N'],
  ['641', 'Chi phí bán hàng', '', 'N'], ['642', 'Chi phí quản lý doanh nghiệp', '', 'N'],
  ['711', 'Thu nhập khác', '', 'C'], ['811', 'Chi phí khác', '', 'N'],
  ['821', 'Chi phí thuế thu nhập doanh nghiệp', '', 'N'], ['911', 'Xác định kết quả kinh doanh', '', 'L'],
];

function seed() {
  tx(() => {
    if (!one('SELECT 1 x FROM accounts LIMIT 1')) {
      for (const a of ACCOUNTS) run('INSERT INTO accounts(code,name,parent,nature) VALUES (?,?,?,?)', ...a);
    }
    if (!one('SELECT 1 x FROM settings LIMIT 1')) {
      const s = { company_name: 'CÔNG TY TNHH GAS', costing_method: 'BQTT', allow_negative: '0' };
      for (const [k, v] of Object.entries(s)) run('INSERT INTO settings(key,value) VALUES (?,?)', k, v);
    }
    if (!one('SELECT 1 x FROM warehouses LIMIT 1')) run("INSERT INTO warehouses(code,name) VALUES ('KHO1','Kho hàng hóa')");
    if (!one('SELECT 1 x FROM items LIMIT 1')) {
      const v12 = run("INSERT INTO items(code,name,unit,kind,shell_type,shell_price,sale_price,buy_price,vat_rate) VALUES ('VO12','Vỏ bình gas 12kg','Cái','VO','12',300000,300000,300000,10)").lastInsertRowid;
      const v45 = run("INSERT INTO items(code,name,unit,kind,shell_type,shell_price,sale_price,buy_price,vat_rate) VALUES ('VO45','Vỏ bình gas 45kg','Cái','VO','45',1000000,1000000,1000000,10)").lastInsertRowid;
      run("INSERT INTO items(code,name,unit,kind,shell_item_id,sale_price,buy_price,vat_rate) VALUES ('GAS12','Gas bình 12kg','Bình','HH',?,420000,360000,10)", v12);
      run("INSERT INTO items(code,name,unit,kind,shell_item_id,sale_price,buy_price,vat_rate) VALUES ('GAS45','Gas bình 45kg','Bình','HH',?,1550000,1350000,10)", v45);
    }
    if (!one('SELECT 1 x FROM users LIMIT 1')) {
      const { salt, hash } = hashPassword(process.env.KTG_ADMIN_PASSWORD || 'admin123');
      run("INSERT INTO users(username,full_name,salt,hash) VALUES ('admin','Quản trị',?,?)", salt, hash);
    }
  });
}
seed();

module.exports = { db, all, one, run, tx, hashPassword };
