'use strict';
// Sổ sách - báo cáo
const { all, one } = require('./db');
const { UserError } = require('./accounting');

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function range(p) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(p.to || '') ? p.to : today();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(p.from || '') ? p.from : to.slice(0, 4) + '-01-01';
  return { from, to };
}

/** Sổ nhật ký chung */
function journal(p) {
  const { from, to } = range(p);
  return {
    from, to,
    rows: all(
      `SELECT j.id, j.date, v.id voucher_id, v.type, v.no, j.description, j.tk_no, j.tk_co, j.amount, j.qty, pa.name partner_name
       FROM journal j JOIN vouchers v ON v.id=j.voucher_id LEFT JOIN partners pa ON pa.id=j.partner_id
       WHERE j.date BETWEEN ? AND ? AND j.amount<>0 ORDER BY j.date, v.id, j.id`,
      from, to,
    ),
  };
}

/** Sổ cái / sổ chi tiết tài khoản (có thể lọc theo đối tượng) */
function ledger(p) {
  const { from, to } = range(p);
  if (!p.acc) throw new UserError('Chưa chọn tài khoản');
  const like = p.acc + '%';
  const partner = Number(p.partner_id) || null;
  const cond = partner ? ' AND l.partner_id=' + partner : '';
  const open = one(`SELECT COALESCE(SUM(dr-cr),0) v, COALESCE(SUM(qty_dr-qty_cr),0) q FROM ledger l WHERE acc LIKE ? AND date<?${cond}`, like, from);
  const rows = all(
    `SELECT l.date, v.id voucher_id, v.type, v.no, l.description, l.acc, l.contra, l.dr, l.cr, l.qty_dr, l.qty_cr, pa.name partner_name
     FROM ledger l JOIN vouchers v ON v.id=l.voucher_id LEFT JOIN partners pa ON pa.id=l.partner_id
     WHERE l.acc LIKE ? AND l.date BETWEEN ? AND ? AND (l.dr<>0 OR l.cr<>0)${cond} ORDER BY l.date, v.id, l.jid`,
    like, from, to,
  );
  return { from, to, acc: p.acc, opening: open.v, opening_qty: open.q, rows };
}

/** Bảng cân đối tài khoản */
function trialBalance(p) {
  const { from, to } = range(p);
  const sums = all(
    `SELECT acc, SUM(CASE WHEN date<? THEN dr-cr ELSE 0 END) open,
            SUM(CASE WHEN date>=? THEN dr ELSE 0 END) dr, SUM(CASE WHEN date>=? THEN cr ELSE 0 END) cr
     FROM ledger WHERE date<=? GROUP BY acc`,
    from, from, from, to,
  );
  const accounts = all('SELECT code, name, parent FROM accounts ORDER BY code');
  const rows = [];
  for (const a of accounts) {
    const r = { code: a.code, name: a.name, parent: a.parent, open: 0, dr: 0, cr: 0 };
    for (const s of sums) if (s.acc.startsWith(a.code)) { r.open += s.open; r.dr += s.dr; r.cr += s.cr; }
    r.close = r.open + r.dr - r.cr;
    if (r.open || r.dr || r.cr) rows.push(r);
  }
  return { from, to, rows };
}

/** Tổng hợp công nợ theo từng loại nợ (tiền / vỏ 12kg / vỏ 45kg) */
function debts(p) {
  const { from, to } = range(p);
  const kind = p.kind === 'NCC' ? 'NCC' : 'KH';
  const base = kind === 'KH' ? '131' : '331';
  const sign = kind === 'KH' ? 1 : -1; // phải thu dư Nợ, phải trả dư Có
  const data = all(
    `SELECT partner_id, acc,
        SUM(CASE WHEN date<? THEN dr-cr ELSE 0 END) open, SUM(CASE WHEN date>=? THEN dr ELSE 0 END) dr,
        SUM(CASE WHEN date>=? THEN cr ELSE 0 END) cr,
        SUM(CASE WHEN date<? THEN qty_dr-qty_cr ELSE 0 END) open_qty,
        SUM(CASE WHEN date>=? THEN qty_dr ELSE 0 END) qty_dr, SUM(CASE WHEN date>=? THEN qty_cr ELSE 0 END) qty_cr
     FROM ledger WHERE acc LIKE ? AND date<=? AND partner_id IS NOT NULL GROUP BY partner_id, acc`,
    from, from, from, from, from, from, base + '%', to,
  );
  const partners = all('SELECT id, code, name, phone FROM partners WHERE kind=? ORDER BY code', kind);
  const rows = partners.map((pa) => {
    const r = { partner_id: pa.id, code: pa.code, name: pa.name, phone: pa.phone, accs: {} };
    for (const suffix of ['1', '2', '3']) {
      const d = data.find((x) => x.partner_id === pa.id && x.acc === base + suffix) || {};
      const open = sign * (d.open || 0);
      const inc = kind === 'KH' ? d.dr || 0 : d.cr || 0;
      const dec = kind === 'KH' ? d.cr || 0 : d.dr || 0;
      const openQty = sign * (d.open_qty || 0);
      const incQty = kind === 'KH' ? d.qty_dr || 0 : d.qty_cr || 0;
      const decQty = kind === 'KH' ? d.qty_cr || 0 : d.qty_dr || 0;
      r.accs[base + suffix] = { open, inc, dec, close: open + inc - dec, open_qty: openQty, inc_qty: incQty, dec_qty: decQty, close_qty: openQty + incQty - decQty };
    }
    return r;
  });
  return { from, to, kind, base, rows: p.all === '1' ? rows : rows.filter((r) => Object.values(r.accs).some((a) => a.open || a.inc || a.dec || a.open_qty || a.inc_qty || a.dec_qty)) };
}

/** Tổng hợp nhập - xuất - tồn */
function stockSummary(p) {
  const { from, to } = range(p);
  const wh = Number(p.warehouse_id) || null;
  const cond = wh ? ' AND m.warehouse_id=' + wh : " AND m.cost_mode<>'transfer'";
  const data = all(
    `SELECT m.item_id,
       SUM(CASE WHEN date<? THEN dir*qty ELSE 0 END) open_qty, SUM(CASE WHEN date<? THEN dir*amount ELSE 0 END) open_val,
       SUM(CASE WHEN date>=? AND dir>0 THEN qty ELSE 0 END) in_qty, SUM(CASE WHEN date>=? AND dir>0 THEN amount ELSE 0 END) in_val,
       SUM(CASE WHEN date>=? AND dir<0 THEN qty ELSE 0 END) out_qty, SUM(CASE WHEN date>=? AND dir<0 THEN amount ELSE 0 END) out_val
     FROM stock_moves m WHERE date<=?${cond} GROUP BY m.item_id`,
    from, from, from, from, from, from, to,
  );
  const items = all('SELECT id, code, name, unit, kind FROM items ORDER BY kind, code');
  const rows = items.map((it) => {
    const d = data.find((x) => x.item_id === it.id) || { open_qty: 0, open_val: 0, in_qty: 0, in_val: 0, out_qty: 0, out_val: 0 };
    return { ...it, ...d, item_id: it.id, close_qty: d.open_qty + d.in_qty - d.out_qty, close_val: d.open_val + d.in_val - d.out_val };
  });
  return { from, to, rows };
}

/** Sổ chi tiết vật tư hàng hóa (thẻ kho) */
function stockCard(p) {
  const { from, to } = range(p);
  const itemId = Number(p.item_id);
  if (!itemId) throw new UserError('Chưa chọn hàng hóa');
  const wh = Number(p.warehouse_id) || null;
  const cond = wh ? ' AND m.warehouse_id=' + wh : " AND m.cost_mode<>'transfer'";
  const open = one(`SELECT COALESCE(SUM(dir*qty),0) q, COALESCE(SUM(dir*amount),0) v FROM stock_moves m WHERE item_id=? AND date<?${cond}`, itemId, from);
  const rows = all(
    `SELECT m.date, v.id voucher_id, v.type, v.no, v.description, w.name warehouse, m.dir, m.qty, m.unit_cost, m.amount, pa.name partner_name
     FROM stock_moves m JOIN vouchers v ON v.id=m.voucher_id JOIN warehouses w ON w.id=m.warehouse_id LEFT JOIN partners pa ON pa.id=v.partner_id
     WHERE m.item_id=? AND m.date BETWEEN ? AND ?${cond} ORDER BY m.date, m.dir DESC, m.id`,
    itemId, from, to,
  );
  return { from, to, opening_qty: open.q, opening_val: open.v, rows };
}

/** Tồn kho hiện tại theo hàng hóa + kho (dùng gợi ý khi lập chứng từ) */
function stockNow() {
  return all('SELECT item_id, warehouse_id, SUM(dir*qty) qty FROM stock_moves GROUP BY item_id, warehouse_id');
}

/** Báo cáo kết quả kinh doanh (tính trực tiếp từ sổ cái) */
function pnl(p) {
  const { from, to } = range(p);
  const s = (acc, side) => {
    const r = one('SELECT COALESCE(SUM(dr),0) dr, COALESCE(SUM(cr),0) cr FROM ledger WHERE acc LIKE ? AND date BETWEEN ? AND ? AND contra NOT LIKE ?', acc + '%', from, to, '911%');
    return side === 'C' ? r.cr - r.dr : r.dr - r.cr;
  };
  const dt = s('511', 'C');
  const gt = s('521', 'N');
  const gv = s('632', 'N');
  const dttc = s('515', 'C');
  const cptc = s('635', 'N');
  const cpbh = s('641', 'N');
  const cpql = s('642', 'N');
  const tnk = s('711', 'C');
  const cpk = s('811', 'N');
  const thue = s('821', 'N');
  const dtt = dt - gt;
  const lng = dtt - gv;
  const lnhd = lng + dttc - cptc - cpbh - cpql;
  const lntt = lnhd + tnk - cpk;
  return {
    from, to,
    rows: [
      ['01', 'Doanh thu bán hàng và cung cấp dịch vụ', dt],
      ['02', 'Các khoản giảm trừ doanh thu', gt],
      ['10', 'Doanh thu thuần (10 = 01 - 02)', dtt, 1],
      ['11', 'Giá vốn hàng bán', gv],
      ['20', 'Lợi nhuận gộp (20 = 10 - 11)', lng, 1],
      ['21', 'Doanh thu hoạt động tài chính', dttc],
      ['22', 'Chi phí tài chính', cptc],
      ['25', 'Chi phí bán hàng', cpbh],
      ['26', 'Chi phí quản lý doanh nghiệp', cpql],
      ['30', 'Lợi nhuận thuần từ hoạt động kinh doanh', lnhd, 1],
      ['31', 'Thu nhập khác', tnk],
      ['32', 'Chi phí khác', cpk],
      ['50', 'Tổng lợi nhuận kế toán trước thuế', lntt, 1],
      ['51', 'Chi phí thuế TNDN', thue],
      ['60', 'Lợi nhuận sau thuế', lntt - thue, 1],
    ].map(([code, name, value, bold]) => ({ code, name, value, bold: !!bold })),
  };
}

function dashboard() {
  const bal = (acc) => one('SELECT COALESCE(SUM(dr-cr),0) v, COALESCE(SUM(qty_dr-qty_cr),0) q FROM ledger WHERE acc LIKE ?', acc + '%');
  const year = today().slice(0, 4);
  const monthly = all(
    `SELECT substr(date,1,7) ym,
        SUM(CASE WHEN acc LIKE '511%' THEN cr-dr WHEN acc LIKE '521%' THEN cr-dr ELSE 0 END) revenue,
        SUM(CASE WHEN acc LIKE '632%' THEN dr-cr ELSE 0 END) cogs
     FROM ledger WHERE date LIKE ? AND (acc LIKE '511%' OR acc LIKE '521%' OR acc LIKE '632%') GROUP BY ym ORDER BY ym`,
    year + '%',
  );
  const topDebt = (base, sign) =>
    all(
      `SELECT pa.code, pa.name, ${sign}*SUM(dr-cr) v FROM ledger l JOIN partners pa ON pa.id=l.partner_id
       WHERE acc=? GROUP BY l.partner_id HAVING ABS(v)>0 ORDER BY v DESC LIMIT 5`,
      base + '1',
    );
  return {
    year,
    cash: bal('111').v,
    bank: bal('112').v,
    receivable: bal('1311').v,
    payable: -bal('3311').v,
    shells: {
      kh12: bal('1312'), kh45: bal('1313'),
      ncc12: { v: -bal('3312').v, q: -bal('3312').q }, ncc45: { v: -bal('3313').v, q: -bal('3313').q },
    },
    stock_value: bal('156').v,
    monthly,
    top_receivable: topDebt('131', 1),
    top_payable: topDebt('331', -1),
    stock: all(
      `SELECT i.code, i.name, i.unit, i.kind, COALESCE(SUM(CASE WHEN m.cost_mode<>'transfer' THEN m.dir*m.qty END),0) qty,
              COALESCE(SUM(CASE WHEN m.cost_mode<>'transfer' THEN m.dir*m.amount END),0) val
       FROM items i LEFT JOIN stock_moves m ON m.item_id=i.id GROUP BY i.id ORDER BY i.kind, i.code`,
    ),
  };
}

module.exports = { journal, ledger, 'trial-balance': trialBalance, debts, 'stock-summary': stockSummary, 'stock-card': stockCard, 'stock-now': stockNow, pnl, dashboard };
