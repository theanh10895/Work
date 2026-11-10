'use strict';
// Nghiệp vụ: lập chứng từ -> tự động sinh thẻ kho + định khoản, tính giá xuất kho
const { all, one, run, tx } = require('./db');

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// grid: item = chứng từ có hàng hóa; cash = thu/chi tiền; gl = định khoản tự do
const TYPES = {
  BH: { prefix: 'BH', name: 'Chứng từ bán hàng', partner: 'KH', grid: 'item' },
  BTL: { prefix: 'BTL', name: 'Trả lại hàng bán', partner: 'KH', grid: 'item' },
  TV: { prefix: 'TV', name: 'Khách hàng trả vỏ', partner: 'KH', grid: 'item', shellOnly: true },
  MH: { prefix: 'MH', name: 'Chứng từ mua hàng', partner: 'NCC', grid: 'item' },
  MTL: { prefix: 'MTL', name: 'Trả lại hàng mua', partner: 'NCC', grid: 'item' },
  TVN: { prefix: 'TVN', name: 'Trả vỏ cho nhà cung cấp', partner: 'NCC', grid: 'item', shellOnly: true },
  NK: { prefix: 'NK', name: 'Phiếu nhập kho', grid: 'item' },
  XK: { prefix: 'XK', name: 'Phiếu xuất kho', grid: 'item' },
  CK: { prefix: 'CK', name: 'Chuyển kho', grid: 'item' },
  PT: { prefix: 'PT', name: 'Phiếu thu', grid: 'cash', cash: '1111', side: 'thu' },
  PC: { prefix: 'PC', name: 'Phiếu chi', grid: 'cash', cash: '1111', side: 'chi' },
  BC: { prefix: 'BC', name: 'Thu tiền gửi', grid: 'cash', cash: '1121', side: 'thu' },
  UNC: { prefix: 'UNC', name: 'Chi tiền gửi', grid: 'cash', cash: '1121', side: 'chi' },
  NVK: { prefix: 'NVK', name: 'Chứng từ nghiệp vụ khác', grid: 'gl' },
};

const TK_KHO = '156';
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (v) => Math.round(v);
const getSetting = (key) => one('SELECT value FROM settings WHERE key=?', key)?.value;

/** Tài khoản công nợ theo loại nợ: 1 = tiền, 2 = vỏ 12kg, 3 = vỏ 45kg */
function debtAccount(partnerKind, shellType) {
  const base = partnerKind === 'KH' ? '131' : '331';
  return base + (shellType === '12' ? '2' : shellType === '45' ? '3' : '1');
}

function nextNo(type) {
  const T = TYPES[type];
  if (!T) throw new UserError('Loại chứng từ không hợp lệ');
  const rows = all('SELECT no FROM vouchers WHERE type=?', type);
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.no);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return T.prefix + String(max + 1).padStart(5, '0');
}

function leafAccount(code, label) {
  const acc = one('SELECT code FROM accounts WHERE code=?', code || '');
  if (!acc) throw new UserError(`${label}: tài khoản "${code || ''}" không tồn tại`);
  if (one('SELECT 1 x FROM accounts WHERE parent=?', code))
    throw new UserError(`${label}: phải chọn tài khoản chi tiết của ${code}`);
  return code;
}

/** Dựng thẻ kho + định khoản từ chứng từ */
function buildPosting(v, lines, T) {
  const moves = [];
  const entries = [];
  const partner = v.partner_id ? one('SELECT * FROM partners WHERE id=?', v.partner_id) : null;
  if (T.partner) {
    if (!partner) throw new UserError(T.partner === 'KH' ? 'Chưa chọn khách hàng' : 'Chưa chọn nhà cung cấp');
    if (partner.kind !== T.partner) throw new UserError('Đối tượng không đúng loại (khách hàng / nhà cung cấp)');
  }
  const move = (item, wh, dir, qty, unit, mode) => {
    moves.push({ item_id: item.id, warehouse_id: wh, dir, qty, unit_cost: unit, amount: round(qty * unit), cost_mode: mode });
    return moves.length - 1;
  };
  const entry = (no, co, amount, x = {}) => {
    if (!amount && x.moveRef === undefined && !x.qty) return;
    entries.push({ tk_no: no, tk_co: co, amount, description: x.desc || v.description || T.name, item_id: x.item_id ?? null, qty: x.qty || 0, moveRef: x.moveRef });
  };
  const moneyAcc = () => {
    if (v.pay_method === 'TM') return '1111';
    if (v.pay_method === 'CK') return '1121';
    return debtAccount(T.partner, '');
  };

  if (T.grid === 'item') {
    if (v.type === 'CK') {
      if (!v.warehouse_to_id || !one('SELECT 1 x FROM warehouses WHERE id=?', v.warehouse_to_id))
        throw new UserError('Chưa chọn kho nhập');
    }
    for (const [i, l] of lines.entries()) {
      const label = `Dòng ${i + 1}`;
      const item = one('SELECT * FROM items WHERE id=?', l.item_id);
      if (!item) throw new UserError(`${label}: chưa chọn hàng hóa`);
      if (!one('SELECT 1 x FROM warehouses WHERE id=?', l.warehouse_id)) throw new UserError(`${label}: chưa chọn kho`);
      if (!(l.qty > 0)) throw new UserError(`${label}: số lượng phải lớn hơn 0`);
      if (l.price < 0) throw new UserError(`${label}: đơn giá không hợp lệ`);
      const shell = item.shell_item_id ? one('SELECT * FROM items WHERE id=?', item.shell_item_id) : null;
      const hasShell = v.shell_debt && shell && shell.shell_type && l.shell_qty > 0;
      if (!hasShell) l.shell_qty = 0;
      const shellDesc = shell ? `${shell.name} (SL: ${l.shell_qty})` : '';

      switch (v.type) {
        case 'BH': {
          entry(moneyAcc(), '5111', l.amount, { desc: `Bán ${item.name}` });
          entry(moneyAcc(), '33311', l.vat_amount, { desc: `Thuế GTGT - ${item.name}` });
          const m = move(item, l.warehouse_id, -1, l.qty, 0, 'calc');
          entry('632', TK_KHO, 0, { moveRef: m, desc: `Giá vốn ${item.name}`, item_id: item.id, qty: l.qty });
          if (hasShell) {
            // Khách nợ vỏ: vỏ rời kho, ghi tăng công nợ vỏ 1312 / 1313
            const ms = move(shell, l.warehouse_id, -1, l.shell_qty, shell.shell_price, 'fixed');
            entry(debtAccount('KH', shell.shell_type), TK_KHO, moves[ms].amount, { moveRef: ms, desc: `Khách nợ ${shellDesc}`, item_id: shell.id, qty: l.shell_qty });
          }
          break;
        }
        case 'BTL': {
          entry('5213', moneyAcc(), l.amount, { desc: `Hàng bán bị trả lại - ${item.name}` });
          entry('33311', moneyAcc(), l.vat_amount, { desc: `Giảm thuế GTGT - ${item.name}` });
          const m = move(item, l.warehouse_id, 1, l.qty, 0, 'calc');
          entry(TK_KHO, '632', 0, { moveRef: m, desc: `Nhập lại ${item.name}`, item_id: item.id, qty: l.qty });
          if (hasShell) {
            const ms = move(shell, l.warehouse_id, 1, l.shell_qty, shell.shell_price, 'fixed');
            entry(TK_KHO, debtAccount('KH', shell.shell_type), moves[ms].amount, { moveRef: ms, desc: `Khách trả ${shellDesc}`, item_id: shell.id, qty: l.shell_qty });
          }
          break;
        }
        case 'MH': {
          const m = move(item, l.warehouse_id, 1, l.qty, l.price, 'fixed');
          moves[m].amount = l.amount;
          entry(TK_KHO, moneyAcc(), l.amount, { moveRef: m, desc: `Mua ${item.name}`, item_id: item.id, qty: l.qty });
          entry('1331', moneyAcc(), l.vat_amount, { desc: `Thuế GTGT - ${item.name}` });
          if (hasShell) {
            // Nợ vỏ nhà cung cấp: vỏ nhập kho, ghi tăng công nợ vỏ 3312 / 3313
            const ms = move(shell, l.warehouse_id, 1, l.shell_qty, shell.shell_price, 'fixed');
            entry(TK_KHO, debtAccount('NCC', shell.shell_type), moves[ms].amount, { moveRef: ms, desc: `Nợ NCC ${shellDesc}`, item_id: shell.id, qty: l.shell_qty });
          }
          break;
        }
        case 'MTL': {
          const m = move(item, l.warehouse_id, -1, l.qty, l.price, 'fixed');
          moves[m].amount = l.amount;
          entry(moneyAcc(), TK_KHO, l.amount, { moveRef: m, desc: `Trả lại ${item.name}`, item_id: item.id, qty: l.qty });
          entry(moneyAcc(), '1331', l.vat_amount, { desc: `Giảm thuế GTGT - ${item.name}` });
          if (hasShell) {
            const ms = move(shell, l.warehouse_id, -1, l.shell_qty, shell.shell_price, 'fixed');
            entry(debtAccount('NCC', shell.shell_type), TK_KHO, moves[ms].amount, { moveRef: ms, desc: `Trả NCC ${shellDesc}`, item_id: shell.id, qty: l.shell_qty });
          }
          break;
        }
        case 'TV':
        case 'TVN': {
          if (item.kind !== 'VO' || !item.shell_type) throw new UserError(`${label}: chỉ được chọn mặt hàng vỏ bình gas`);
          const isKH = v.type === 'TV';
          l.price = item.shell_price;
          l.amount = round(l.qty * l.price);
          const ms = move(item, l.warehouse_id, isKH ? 1 : -1, l.qty, item.shell_price, 'fixed');
          const acc = debtAccount(isKH ? 'KH' : 'NCC', item.shell_type);
          const x = { moveRef: ms, item_id: item.id, qty: l.qty, desc: `${isKH ? 'Khách trả' : 'Trả NCC'} ${item.name} (SL: ${l.qty})` };
          if (isKH) entry(TK_KHO, acc, moves[ms].amount, x); // khách trả vỏ: kho 156 tăng, giảm nợ vỏ
          else entry(acc, TK_KHO, moves[ms].amount, x);
          break;
        }
        case 'NK': {
          const m = move(item, l.warehouse_id, 1, l.qty, l.price, 'fixed');
          moves[m].amount = l.amount;
          entry(TK_KHO, leafAccount(l.tk_co, `${label} - TK Có`), l.amount, { moveRef: m, item_id: item.id, qty: l.qty, desc: `Nhập kho ${item.name}` });
          break;
        }
        case 'XK': {
          const m = move(item, l.warehouse_id, -1, l.qty, 0, 'calc');
          entry(leafAccount(l.tk_no, `${label} - TK Nợ`), TK_KHO, 0, { moveRef: m, item_id: item.id, qty: l.qty, desc: `Xuất kho ${item.name}` });
          break;
        }
        case 'CK': {
          if (l.warehouse_id === v.warehouse_to_id) throw new UserError(`${label}: kho xuất và kho nhập phải khác nhau`);
          move(item, l.warehouse_id, -1, l.qty, 0, 'transfer');
          move(item, v.warehouse_to_id, 1, l.qty, 0, 'transfer');
          break;
        }
      }
    }
  } else if (T.grid === 'cash') {
    for (const [i, l] of lines.entries()) {
      if (!(l.amount > 0)) throw new UserError(`Dòng ${i + 1}: số tiền phải lớn hơn 0`);
      if (T.side === 'thu') entry(T.cash, leafAccount(l.tk_co, `Dòng ${i + 1} - TK Có`), l.amount, { desc: l.description });
      else entry(leafAccount(l.tk_no, `Dòng ${i + 1} - TK Nợ`), T.cash, l.amount, { desc: l.description });
    }
  } else {
    for (const [i, l] of lines.entries()) {
      if (!(l.amount > 0)) throw new UserError(`Dòng ${i + 1}: số tiền phải lớn hơn 0`);
      const no = leafAccount(l.tk_no, `Dòng ${i + 1} - TK Nợ`);
      const co = leafAccount(l.tk_co, `Dòng ${i + 1} - TK Có`);
      if (no === co) throw new UserError(`Dòng ${i + 1}: TK Nợ và TK Có phải khác nhau`);
      entry(no, co, l.amount, { desc: l.description });
    }
  }
  const isDebt = (a) => a.startsWith('131') || a.startsWith('331');
  if (!partner && entries.some((e) => isDebt(e.tk_no) || isDebt(e.tk_co)))
    throw new UserError('Chứng từ có tài khoản công nợ 131/331: phải chọn đối tượng');
  return { moves, entries };
}

function normalize(input, T) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '') || Number.isNaN(Date.parse(input.date)))
    throw new UserError('Ngày chứng từ không hợp lệ');
  const v = {
    type: input.type,
    no: String(input.no || '').trim() || nextNo(input.type),
    date: input.date,
    partner_id: num(input.partner_id) || null,
    description: String(input.description || '').trim(),
    pay_method: ['NO', 'TM', 'CK'].includes(input.pay_method) ? input.pay_method : 'NO',
    shell_debt: input.shell_debt ? 1 : 0,
    warehouse_to_id: input.type === 'CK' ? num(input.warehouse_to_id) || null : null,
  };
  if (!['BH', 'BTL', 'MH', 'MTL'].includes(v.type)) {
    v.pay_method = 'NO';
    v.shell_debt = 0;
  }
  const raw = Array.isArray(input.lines) ? input.lines : [];
  if (!raw.length) throw new UserError('Chứng từ chưa có dòng chi tiết');
  const hasVat = ['BH', 'BTL', 'MH', 'MTL'].includes(v.type);
  const lines = raw.map((r) => {
    const l = {
      item_id: num(r.item_id) || null,
      warehouse_id: num(r.warehouse_id) || null,
      qty: num(r.qty),
      price: num(r.price),
      amount: num(r.amount),
      vat_rate: hasVat ? num(r.vat_rate) : 0,
      vat_amount: 0,
      shell_qty: r.shell_qty === undefined || r.shell_qty === null || r.shell_qty === '' ? num(r.qty) : num(r.shell_qty),
      tk_no: r.tk_no ? String(r.tk_no).trim() : null,
      tk_co: r.tk_co ? String(r.tk_co).trim() : null,
      description: String(r.description || '').trim(),
    };
    if (T.grid === 'item') {
      if (['XK', 'CK'].includes(v.type)) l.price = 0;
      l.amount = round(l.qty * l.price);
      l.vat_amount = round((l.amount * l.vat_rate) / 100);
      if (l.shell_qty < 0) l.shell_qty = 0;
    } else {
      l.amount = round(l.amount);
      l.shell_qty = 0;
    }
    return l;
  });
  return { v, lines };
}

function checkStock(pairs) {
  if (getSetting('allow_negative') === '1') return;
  for (const key of pairs) {
    const [itemId, whId] = key.split(':').map(Number);
    const r = one('SELECT COALESCE(SUM(dir*qty),0) q FROM stock_moves WHERE item_id=? AND warehouse_id=?', itemId, whId);
    if (r.q < -1e-6) {
      const item = one('SELECT name FROM items WHERE id=?', itemId);
      const wh = one('SELECT name FROM warehouses WHERE id=?', whId);
      throw new UserError(`Không đủ tồn kho: "${item.name}" tại "${wh.name}" sẽ bị âm ${Math.abs(r.q)}. (Có thể cho phép xuất âm trong Thiết lập)`);
    }
  }
}

function saveVoucher(input, id) {
  const T = TYPES[input?.type];
  if (!T) throw new UserError('Loại chứng từ không hợp lệ');
  return tx(() => {
    const { v, lines } = normalize(input, T);
    const posting = buildPosting(v, lines, T);
    const touched = new Set();
    const itemIds = new Set();
    const collect = (rows) => rows.forEach((m) => { touched.add(`${m.item_id}:${m.warehouse_id}`); itemIds.add(m.item_id); });
    v.total_amount = lines.reduce((s, l) => s + l.amount, 0);
    v.total_vat = lines.reduce((s, l) => s + l.vat_amount, 0);
    v.total = v.total_amount + v.total_vat;
    const dup = one('SELECT id FROM vouchers WHERE type=? AND no=? AND id<>?', v.type, v.no, id || 0);
    if (dup) throw new UserError(`Số chứng từ ${v.no} đã tồn tại`);
    if (id) {
      const old = one('SELECT * FROM vouchers WHERE id=?', id);
      if (!old) throw new UserError('Không tìm thấy chứng từ', 404);
      if (old.type !== v.type) throw new UserError('Không được đổi loại chứng từ');
      collect(all('SELECT item_id, warehouse_id FROM stock_moves WHERE voucher_id=?', id));
      run('DELETE FROM journal WHERE voucher_id=?', id);
      run('DELETE FROM stock_moves WHERE voucher_id=?', id);
      run('DELETE FROM voucher_lines WHERE voucher_id=?', id);
      run(
        'UPDATE vouchers SET no=?, date=?, partner_id=?, description=?, pay_method=?, shell_debt=?, warehouse_to_id=?, total_amount=?, total_vat=?, total=? WHERE id=?',
        v.no, v.date, v.partner_id, v.description, v.pay_method, v.shell_debt, v.warehouse_to_id, v.total_amount, v.total_vat, v.total, id,
      );
    } else {
      id = Number(
        run(
          'INSERT INTO vouchers(type,no,date,partner_id,description,pay_method,shell_debt,warehouse_to_id,total_amount,total_vat,total) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          v.type, v.no, v.date, v.partner_id, v.description, v.pay_method, v.shell_debt, v.warehouse_to_id, v.total_amount, v.total_vat, v.total,
        ).lastInsertRowid,
      );
    }
    lines.forEach((l, i) =>
      run(
        'INSERT INTO voucher_lines(voucher_id,idx,item_id,warehouse_id,qty,price,amount,vat_rate,vat_amount,shell_qty,tk_no,tk_co,description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, i, l.item_id, l.warehouse_id, l.qty, l.price, l.amount, l.vat_rate, l.vat_amount, l.shell_qty, l.tk_no, l.tk_co, l.description,
      ),
    );
    const moveIds = posting.moves.map((m) =>
      Number(
        run(
          'INSERT INTO stock_moves(voucher_id,date,item_id,warehouse_id,dir,qty,unit_cost,amount,cost_mode) VALUES (?,?,?,?,?,?,?,?,?)',
          id, v.date, m.item_id, m.warehouse_id, m.dir, m.qty, m.unit_cost, m.amount, m.cost_mode,
        ).lastInsertRowid,
      ),
    );
    collect(posting.moves);
    for (const e of posting.entries)
      run(
        'INSERT INTO journal(voucher_id,date,tk_no,tk_co,amount,partner_id,item_id,qty,move_id,description) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, v.date, e.tk_no, e.tk_co, e.amount, v.partner_id, e.item_id, e.qty, e.moveRef === undefined ? null : moveIds[e.moveRef], e.description,
      );
    recalcCosts([...itemIds]);
    checkStock(touched);
    return id;
  });
}

function deleteVoucher(id) {
  return tx(() => {
    if (!one('SELECT id FROM vouchers WHERE id=?', id)) throw new UserError('Không tìm thấy chứng từ', 404);
    const moves = all('SELECT DISTINCT item_id, warehouse_id FROM stock_moves WHERE voucher_id=?', id);
    run('DELETE FROM journal WHERE voucher_id=?', id);
    run('DELETE FROM stock_moves WHERE voucher_id=?', id);
    run('DELETE FROM vouchers WHERE id=?', id);
    recalcCosts([...new Set(moves.map((m) => m.item_id))]);
    checkStock(new Set(moves.map((m) => `${m.item_id}:${m.warehouse_id}`)));
  });
}

function getVoucher(id) {
  const v = one('SELECT v.*, p.name partner_name FROM vouchers v LEFT JOIN partners p ON p.id=v.partner_id WHERE v.id=?', id);
  if (!v) throw new UserError('Không tìm thấy chứng từ', 404);
  v.lines = all('SELECT * FROM voucher_lines WHERE voucher_id=? ORDER BY idx', id);
  v.entries = all('SELECT tk_no, tk_co, amount, qty, description FROM journal WHERE voucher_id=? AND (amount<>0 OR qty<>0) ORDER BY id', id);
  return v;
}

function listVouchers({ type, from, to, q }) {
  const types = String(type || '').split(',').filter((t) => TYPES[t]);
  if (!types.length) throw new UserError('Loại chứng từ không hợp lệ');
  let sql = `SELECT v.id, v.type, v.no, v.date, v.description, v.pay_method, v.shell_debt, v.total_amount, v.total_vat, v.total,
      p.code partner_code, p.name partner_name,
      (SELECT COALESCE(SUM(shell_qty),0) FROM voucher_lines l WHERE l.voucher_id=v.id) shell_qty,
      (SELECT COALESCE(SUM(qty),0) FROM voucher_lines l WHERE l.voucher_id=v.id) qty
    FROM vouchers v LEFT JOIN partners p ON p.id=v.partner_id
    WHERE v.type IN (${types.map(() => '?').join(',')})`;
  const params = [...types];
  if (from) { sql += ' AND v.date>=?'; params.push(from); }
  if (to) { sql += ' AND v.date<=?'; params.push(to); }
  if (q) {
    sql += ' AND (v.no LIKE ? OR v.description LIKE ? OR p.name LIKE ? OR p.code LIKE ?)';
    params.push(...Array(4).fill(`%${q}%`));
  }
  return all(sql + ' ORDER BY v.date DESC, v.id DESC LIMIT 2000', ...params);
}

// ---------------- Tính giá xuất kho ----------------
// BQTT: bình quân tức thời | BQCK: bình quân cuối kỳ (tháng) | FIFO: nhập trước xuất trước
// Giá tính chung cho toàn doanh nghiệp (không theo từng kho) nên chuyển kho không làm đổi giá.
function costItem(itemId, method) {
  const moves = all('SELECT * FROM stock_moves WHERE item_id=? ORDER BY date, dir DESC, id', itemId);
  const out = (m, unit, amount) => { m.unit_cost = unit; m.amount = amount; };
  let last = 0;

  if (method === 'BQCK') {
    let qty = 0;
    let val = 0;
    const periods = new Map();
    for (const m of moves) {
      const k = m.date.slice(0, 7);
      if (!periods.has(k)) periods.set(k, []);
      periods.get(k).push(m);
    }
    for (const list of periods.values()) {
      let nq = qty;
      let nv = val;
      for (const m of list) if (m.cost_mode === 'fixed') { nq += m.dir * m.qty; nv += m.dir * m.amount; }
      const unit = nq > 1e-9 && nv > 0 ? nv / nq : last;
      last = unit;
      let lastOut = null;
      for (const m of list) {
        if (m.cost_mode !== 'fixed') out(m, unit, round(m.qty * unit));
        if (m.cost_mode === 'transfer') continue;
        qty += m.dir * m.qty;
        val += m.dir * m.amount;
        if (m.cost_mode === 'calc' && m.dir < 0) lastOut = m;
      }
      if (Math.abs(qty) < 1e-9 && val !== 0 && lastOut) { lastOut.amount += val; val = 0; } // dồn chênh lệch làm tròn
    }
  } else if (method === 'FIFO') {
    const layers = [];
    const take = (q) => {
      let amount = 0;
      while (q > 1e-9 && layers.length) {
        const L = layers[0];
        const t = Math.min(q, L.qty);
        amount += t * L.cost;
        L.qty -= t;
        q -= t;
        if (L.qty <= 1e-9) layers.shift();
      }
      return amount + q * last; // xuất âm: tạm tính theo giá gần nhất
    };
    for (const m of moves) {
      if (m.cost_mode === 'transfer') { out(m, layers[0]?.cost ?? last, round(m.qty * (layers[0]?.cost ?? last))); continue; }
      if (m.dir > 0) {
        if (m.cost_mode === 'calc') out(m, last, round(m.qty * last));
        const cost = m.qty ? m.amount / m.qty : 0;
        layers.push({ qty: m.qty, cost });
        last = cost || last;
      } else if (m.cost_mode === 'calc') {
        const amount = round(take(m.qty));
        out(m, m.qty ? amount / m.qty : 0, amount);
        if (m.unit_cost) last = m.unit_cost;
      } else take(m.qty);
    }
  } else {
    let qty = 0;
    let val = 0;
    for (const m of moves) {
      const unit = qty > 1e-9 && val > 0 ? val / qty : last;
      if (m.cost_mode === 'transfer') { out(m, unit, round(m.qty * unit)); continue; }
      if (m.cost_mode === 'calc') {
        const allOut = m.dir < 0 && qty > 1e-9 && val > 0 && Math.abs(m.qty - qty) < 1e-9;
        out(m, unit, allOut ? round(val) : round(m.qty * unit)); // xuất hết thì lấy trọn giá trị tồn
      }
      qty += m.dir * m.qty;
      val += m.dir * m.amount;
      if (m.dir > 0 && m.qty) last = m.amount / m.qty || last;
      else if (unit) last = unit;
    }
  }
  for (const m of moves) {
    if (m.cost_mode === 'fixed') continue;
    run('UPDATE stock_moves SET unit_cost=?, amount=? WHERE id=?', m.unit_cost, m.amount, m.id);
    run('UPDATE journal SET amount=? WHERE move_id=?', m.amount, m.id);
  }
}

function recalcCosts(itemIds) {
  const method = getSetting('costing_method') || 'BQTT';
  return tx(() => {
    const ids = itemIds || all('SELECT id FROM items').map((r) => r.id);
    for (const id of ids) costItem(id, method);
    return ids.length;
  });
}

module.exports = { TYPES, UserError, saveVoucher, deleteVoucher, getVoucher, listVouchers, nextNo, recalcCosts, getSetting, debtAccount };
