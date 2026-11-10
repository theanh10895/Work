'use strict';
// Máy chủ web: API JSON + giao diện tĩnh. Chạy: node server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { all, one, run, tx, hashPassword } = require('./src/db');
const acc = require('./src/accounting');
const reports = require('./src/reports');
const { UserError } = acc;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ----- Phiên đăng nhập (lưu trong bộ nhớ) -----
const sessions = new Map();
const SESSION_TTL = 12 * 3600 * 1000;
function currentUser(req) {
  const m = /(?:^|;\s*)ktg_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const s = m && sessions.get(m[1]);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  s.expires = Date.now() + SESSION_TTL;
  return { ...s, sid: m[1] };
}
const attempts = new Map();
function login(body, req) {
  const ip = req.socket.remoteAddress;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw new UserError('Đăng nhập sai quá nhiều lần, vui lòng thử lại sau ít phút', 429);
  const u = one('SELECT * FROM users WHERE username=?', String(body.username || ''));
  const ok = u && crypto.timingSafeEqual(Buffer.from(hashPassword(String(body.password || ''), u.salt).hash), Buffer.from(u.hash));
  if (!ok) {
    a.n++;
    if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
    attempts.set(ip, a);
    throw new UserError('Tên đăng nhập hoặc mật khẩu không đúng', 401);
  }
  attempts.delete(ip);
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { id: u.id, username: u.username, full_name: u.full_name, expires: Date.now() + SESSION_TTL });
  return sid;
}

// ----- Danh mục -----
const CATALOGS = {
  partners: { fields: ['code', 'name', 'kind', 'address', 'phone', 'tax_code', 'note'], order: 'kind, code', refs: [['vouchers', 'partner_id'], ['journal', 'partner_id']] },
  warehouses: { fields: ['code', 'name'], order: 'code', refs: [['voucher_lines', 'warehouse_id'], ['stock_moves', 'warehouse_id'], ['vouchers', 'warehouse_to_id']] },
  items: {
    fields: ['code', 'name', 'unit', 'kind', 'shell_type', 'shell_item_id', 'shell_price', 'sale_price', 'buy_price', 'vat_rate'],
    numeric: ['shell_price', 'sale_price', 'buy_price', 'vat_rate'], order: 'kind, code',
    refs: [['voucher_lines', 'item_id'], ['stock_moves', 'item_id'], ['items', 'shell_item_id']],
  },
  accounts: { fields: ['code', 'name', 'parent', 'nature'], order: 'code', refs: [] },
};
function catalogValues(name, body) {
  const C = CATALOGS[name];
  const v = {};
  for (const f of C.fields) {
    let x = body[f];
    if (C.numeric?.includes(f)) x = Number(x) || 0;
    else if (f === 'shell_item_id') x = Number(x) || null;
    else x = x === undefined || x === null ? '' : String(x).trim();
    v[f] = x;
  }
  if (!v.code) throw new UserError('Chưa nhập mã');
  if (!v.name) throw new UserError('Chưa nhập tên');
  if (name === 'partners' && !['KH', 'NCC'].includes(v.kind)) throw new UserError('Loại đối tượng không hợp lệ');
  if (name === 'items') {
    if (!['HH', 'VO'].includes(v.kind)) throw new UserError('Loại hàng hóa không hợp lệ');
    if (v.kind === 'VO') {
      if (!['12', '45'].includes(v.shell_type)) throw new UserError('Vỏ bình phải chọn loại 12kg hoặc 45kg');
      v.shell_item_id = null;
    } else {
      v.shell_type = '';
      v.shell_price = 0;
      if (v.shell_item_id && one('SELECT kind FROM items WHERE id=?', v.shell_item_id)?.kind !== 'VO') throw new UserError('Vỏ đi kèm phải là mặt hàng loại "Vỏ bình"');
    }
  }
  if (name === 'accounts') {
    if (!/^\d{3,8}$/.test(v.code)) throw new UserError('Số tài khoản phải gồm 3-8 chữ số');
    if (!['N', 'C', 'L'].includes(v.nature)) v.nature = 'N';
    if (v.parent && !one('SELECT 1 x FROM accounts WHERE code=?', v.parent)) throw new UserError('Tài khoản tổng hợp không tồn tại');
    if (v.parent && !v.code.startsWith(v.parent)) throw new UserError('Số tài khoản chi tiết phải bắt đầu bằng số tài khoản tổng hợp');
  }
  return v;
}
const accountUsed = (code) => one('SELECT 1 x FROM journal WHERE tk_no=? OR tk_co=? LIMIT 1', code, code) || one('SELECT 1 x FROM voucher_lines WHERE tk_no=? OR tk_co=? LIMIT 1', code, code);
function catalogSave(name, body, id) {
  const C = CATALOGS[name];
  const v = catalogValues(name, body);
  return tx(() => {
    if (one(`SELECT 1 x FROM ${name} WHERE code=? AND id<>?`, v.code, id || 0)) throw new UserError(`Mã ${v.code} đã tồn tại`);
    if (id) {
      const old = one(`SELECT * FROM ${name} WHERE id=?`, id);
      if (!old) throw new UserError('Không tìm thấy bản ghi', 404);
      if (name === 'accounts') { v.code = old.code; v.parent = old.parent; }
      if (name === 'partners' && old.kind !== v.kind && one('SELECT 1 x FROM vouchers WHERE partner_id=?', id)) throw new UserError('Đối tượng đã phát sinh chứng từ, không được đổi loại');
      if (name === 'items' && (old.kind !== v.kind || old.shell_type !== v.shell_type) && one('SELECT 1 x FROM stock_moves WHERE item_id=?', id)) throw new UserError('Hàng hóa đã phát sinh, không được đổi loại');
      if (name === 'items' && v.shell_item_id === id) throw new UserError('Vỏ đi kèm không hợp lệ');
      run(`UPDATE ${name} SET ${C.fields.map((f) => f + '=?').join(',')} WHERE id=?`, ...C.fields.map((f) => v[f]), id);
      return id;
    }
    if (name === 'accounts' && v.parent && accountUsed(v.parent)) throw new UserError(`Tài khoản ${v.parent} đã có phát sinh, không thể thêm tài khoản chi tiết`);
    return Number(run(`INSERT INTO ${name}(${C.fields.join(',')}) VALUES (${C.fields.map(() => '?').join(',')})`, ...C.fields.map((f) => v[f])).lastInsertRowid);
  });
}
function catalogDelete(name, id) {
  const row = one(`SELECT * FROM ${name} WHERE id=?`, id);
  if (!row) throw new UserError('Không tìm thấy bản ghi', 404);
  const used = name === 'accounts' ? accountUsed(row.code) || one('SELECT 1 x FROM accounts WHERE parent=?', row.code) : CATALOGS[name].refs.some(([t, c]) => one(`SELECT 1 x FROM ${t} WHERE ${c}=? LIMIT 1`, id));
  if (used) throw new UserError('Bản ghi đã có phát sinh hoặc đang được sử dụng, không thể xóa');
  run(`DELETE FROM ${name} WHERE id=?`, id);
}
const settings = () => Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
const bootstrap = (user) => ({
  user: { username: user.username, full_name: user.full_name },
  settings: settings(),
  accounts: all('SELECT * FROM accounts ORDER BY code'),
  partners: all('SELECT * FROM partners ORDER BY kind, code'),
  warehouses: all('SELECT * FROM warehouses ORDER BY code'),
  items: all('SELECT * FROM items ORDER BY kind, code'),
});

// ----- Định tuyến -----
async function api(req, res, url) {
  const p = url.pathname.slice(5);
  const method = req.method;
  const query = Object.fromEntries(url.searchParams);
  const body = ['POST', 'PUT'].includes(method) ? await readJson(req) : {};
  // Chống CSRF: yêu cầu thay đổi dữ liệu phải đến từ chính trang này
  if (method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new UserError('Yêu cầu không hợp lệ', 403);

  if (p === 'login' && method === 'POST') {
    const sid = login(body, req);
    res.setHeader('Set-Cookie', `ktg_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
    return { ok: true };
  }
  const user = currentUser(req);
  if (!user) throw new UserError('Chưa đăng nhập', 401);
  if (p === 'logout' && method === 'POST') {
    sessions.delete(user.sid);
    res.setHeader('Set-Cookie', 'ktg_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  }
  if (p === 'change-password' && method === 'POST') {
    const u = one('SELECT * FROM users WHERE id=?', user.id);
    if (hashPassword(String(body.old || ''), u.salt).hash !== u.hash) throw new UserError('Mật khẩu hiện tại không đúng');
    if (String(body.new || '').length < 6) throw new UserError('Mật khẩu mới phải có ít nhất 6 ký tự');
    const h = hashPassword(String(body.new));
    run('UPDATE users SET salt=?, hash=? WHERE id=?', h.salt, h.hash, user.id);
    return { ok: true };
  }
  if (p === 'bootstrap' && method === 'GET') return bootstrap(user);

  let m;
  if ((m = /^(partners|warehouses|items|accounts)(?:\/(\d+))?$/.exec(p))) {
    const [, name, id] = m;
    if (method === 'GET') return all(`SELECT * FROM ${name} ORDER BY ${CATALOGS[name].order}`);
    if (method === 'POST' && !id) return { id: catalogSave(name, body) };
    if (method === 'PUT' && id) return { id: catalogSave(name, body, Number(id)) };
    if (method === 'DELETE' && id) { catalogDelete(name, Number(id)); return { ok: true }; }
  }
  if (p === 'vouchers/next-no' && method === 'GET') return { no: acc.nextNo(query.type) };
  if ((m = /^vouchers(?:\/(\d+))?$/.exec(p))) {
    const id = m[1] && Number(m[1]);
    if (method === 'GET') return id ? acc.getVoucher(id) : acc.listVouchers(query);
    if (method === 'POST' && !id) return acc.getVoucher(acc.saveVoucher(body));
    if (method === 'PUT' && id) return acc.getVoucher(acc.saveVoucher(body, id));
    if (method === 'DELETE' && id) { acc.deleteVoucher(id); return { ok: true }; }
  }
  if (p === 'settings' && method === 'PUT') {
    tx(() => {
      for (const k of ['company_name', 'costing_method', 'allow_negative']) {
        if (body[k] === undefined) continue;
        if (k === 'costing_method' && !['BQTT', 'BQCK', 'FIFO'].includes(body[k])) throw new UserError('Phương pháp tính giá không hợp lệ');
        run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(body[k]));
      }
    });
    return settings();
  }
  if (p === 'costing/run' && method === 'POST') {
    return tx(() => {
      if (body.method) {
        if (!['BQTT', 'BQCK', 'FIFO'].includes(body.method)) throw new UserError('Phương pháp tính giá không hợp lệ');
        run("UPDATE settings SET value=? WHERE key='costing_method'", body.method);
      }
      return { items: acc.recalcCosts(), settings: settings() };
    });
  }
  if ((m = /^reports\/([a-z-]+)$/.exec(p)) && method === 'GET' && Object.hasOwn(reports, m[1])) return reports[m[1]](query);
  throw new UserError('Không tìm thấy', 404);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2e6) { reject(new UserError('Dữ liệu quá lớn', 413)); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new UserError('JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (url.pathname.startsWith('/api/')) {
    try {
      const data = await api(req, res, url);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      const status = e instanceof UserError ? e.status : 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Lỗi hệ thống' : e.message }));
    }
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Không tìm thấy');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Kế toán Gas đang chạy tại http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
module.exports = { server };
