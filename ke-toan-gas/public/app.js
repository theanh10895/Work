'use strict';
/* Kế toán Gas - giao diện một trang (không dùng thư viện ngoài) */

// ---------- Tiện ích ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
const fmt = (n) => (n ? nf.format(Math.abs(n) < 1e-9 ? 0 : n) : '');
const fmt0 = (n) => nf.format(n || 0);
const money = (n) => `<span class="${n < 0 ? 'neg' : ''}">${fmt(n)}</span>`;
const fdate = (d) => (d ? d.split('-').reverse().join('/') : '');
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const yearStart = () => today().slice(0, 4) + '-01-01';
const parseNum = (s) => {
  const t = String(s ?? '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  return Number(t) || 0;
};

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    renderLogin();
    throw new Error('Phiên đăng nhập đã hết hạn');
  }
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra');
  return data;
}
const qs = (o) => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

function toast(msg, err) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (err) d.className = 'err';
  $('#toast').append(d);
  setTimeout(() => d.remove(), err ? 6000 : 2500);
}
const guard = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------- Trạng thái ----------
let B = null; // dữ liệu danh mục
const reloadBoot = async () => (B = await api('GET', '/bootstrap'));
const item = (id) => B.items.find((x) => x.id === Number(id));
const leafAccounts = () => B.accounts.filter((a) => !B.accounts.some((c) => c.parent === a.code));
const opts = (rows, sel, label, empty) =>
  (empty === undefined ? '' : `<option value="">${esc(empty)}</option>`) +
  rows.map((r) => `<option value="${esc(r.id ?? r.code)}"${String(r.id ?? r.code) === String(sel ?? '') ? ' selected' : ''}>${esc(label(r))}</option>`).join('');
const optAcc = (sel) => opts(leafAccounts().map((a) => ({ code: a.code, name: a.name })), sel, (a) => `${a.code} - ${a.name}`, '');
const optPartner = (kind, sel, empty = '') => opts(B.partners.filter((p) => !kind || p.kind === kind), sel, (p) => `${p.code} - ${p.name}`, empty);
const optWh = (sel, empty) => opts(B.warehouses, sel, (w) => w.name, empty);
const optItem = (sel, shellOnly) => opts(B.items.filter((i) => !shellOnly || i.kind === 'VO'), sel, (i) => `${i.code} - ${i.name}`, '');

// ---------- Loại chứng từ ----------
const VT = {
  BH: { name: 'Chứng từ bán hàng', partner: 'KH', grid: 'item', vat: true, price: 'sale_price', pay: { NO: 'Chưa thu tiền', TM: 'Thu tiền mặt', CK: 'Thu chuyển khoản' }, shell: 'Khách hàng nợ vỏ', shellCol: 'SL vỏ nợ', desc: 'Bán hàng' },
  BTL: { name: 'Trả lại hàng bán', partner: 'KH', grid: 'item', vat: true, price: 'sale_price', pay: { NO: 'Giảm trừ công nợ', TM: 'Trả lại tiền mặt', CK: 'Trả lại chuyển khoản' }, shell: 'Khách trả lại cả vỏ (giảm nợ vỏ)', shellCol: 'SL vỏ trả', desc: 'Hàng bán bị trả lại' },
  TV: { name: 'Khách hàng trả vỏ', partner: 'KH', grid: 'item', shellOnly: true, price: 'shell_price', fixedPrice: true, desc: 'Khách hàng trả vỏ bình gas' },
  MH: { name: 'Chứng từ mua hàng', partner: 'NCC', grid: 'item', vat: true, price: 'buy_price', pay: { NO: 'Chưa thanh toán', TM: 'Trả tiền mặt', CK: 'Chuyển khoản' }, shell: 'Nợ vỏ nhà cung cấp', shellCol: 'SL vỏ nợ', desc: 'Mua hàng nhập kho' },
  MTL: { name: 'Trả lại hàng mua', partner: 'NCC', grid: 'item', vat: true, price: 'buy_price', pay: { NO: 'Giảm trừ công nợ', TM: 'Thu lại tiền mặt', CK: 'Thu lại chuyển khoản' }, shell: 'Trả lại cả vỏ (giảm nợ vỏ NCC)', shellCol: 'SL vỏ trả', desc: 'Trả lại hàng mua' },
  TVN: { name: 'Trả vỏ cho nhà cung cấp', partner: 'NCC', grid: 'item', shellOnly: true, price: 'shell_price', fixedPrice: true, desc: 'Trả vỏ bình gas cho nhà cung cấp' },
  NK: { name: 'Phiếu nhập kho', grid: 'item', price: 'buy_price', tk: 'tk_co', tkDefault: '711', desc: 'Nhập kho' },
  XK: { name: 'Phiếu xuất kho', grid: 'item', noPrice: true, tk: 'tk_no', tkDefault: '632', desc: 'Xuất kho' },
  CK: { name: 'Chuyển kho', grid: 'item', noPrice: true, toWh: true, desc: 'Chuyển kho nội bộ' },
  PT: { name: 'Phiếu thu tiền mặt', grid: 'cash', tk: 'tk_co', anyPartner: true, desc: 'Thu tiền' },
  PC: { name: 'Phiếu chi tiền mặt', grid: 'cash', tk: 'tk_no', anyPartner: true, desc: 'Chi tiền' },
  BC: { name: 'Thu tiền gửi', grid: 'cash', tk: 'tk_co', anyPartner: true, desc: 'Thu tiền gửi ngân hàng' },
  UNC: { name: 'Chi tiền gửi (Ủy nhiệm chi)', grid: 'cash', tk: 'tk_no', anyPartner: true, desc: 'Chi tiền gửi ngân hàng' },
  NVK: { name: 'Chứng từ nghiệp vụ khác', grid: 'gl', anyPartner: true, desc: '' },
};

// ---------- Phân hệ ----------
const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const vTab = (type, name) => ({ id: type.toLowerCase(), name, render: (el) => voucherList(el, type) });
const MODULES = [
  { id: 'tongquan', name: 'Tổng quan', icon: I('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'), tabs: [{ id: 'home', name: 'Tổng quan', render: dashboard }] },
  { id: 'tienmat', name: 'Tiền mặt', icon: I('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>'), tabs: [vTab('PT', 'Phiếu thu'), vTab('PC', 'Phiếu chi'), { id: 'soquy', name: 'Sổ quỹ tiền mặt', render: (el) => ledgerReport(el, '1111') }] },
  { id: 'tiengui', name: 'Tiền gửi', icon: I('<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'), tabs: [vTab('BC', 'Thu tiền gửi'), vTab('UNC', 'Chi tiền gửi'), { id: 'sotg', name: 'Sổ tiền gửi ngân hàng', render: (el) => ledgerReport(el, '1121') }] },
  { id: 'muahang', name: 'Mua hàng', icon: I('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l3 13h11l2-9H7"/>'), tabs: [vTab('MH', 'Mua hàng'), vTab('MTL', 'Trả lại hàng mua'), vTab('TVN', 'Trả vỏ cho NCC'), { id: 'congno', name: 'Công nợ phải trả', render: (el) => debtReport(el, 'NCC') }] },
  { id: 'banhang', name: 'Bán hàng', icon: I('<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.2"/>'), tabs: [vTab('BH', 'Bán hàng'), vTab('BTL', 'Trả lại hàng bán'), vTab('TV', 'Khách trả vỏ'), { id: 'congno', name: 'Công nợ phải thu', render: (el) => debtReport(el, 'KH') }] },
  { id: 'kho', name: 'Kho', icon: I('<path d="M3 9l9-5 9 5v11H3z"/><path d="M8 20v-7h8v7"/>'), tabs: [vTab('NK', 'Nhập kho'), vTab('XK', 'Xuất kho'), vTab('CK', 'Chuyển kho'), { id: 'tonkho', name: 'Tổng hợp tồn kho', render: stockReport }, { id: 'tinhgia', name: 'Tính giá xuất kho', render: costingView }] },
  { id: 'tonghop', name: 'Tổng hợp', icon: I('<path d="M5 3h10l4 4v14H5z"/><path d="M9 12h6M9 16h6M9 8h3"/>'), tabs: [vTab('NVK', 'Chứng từ nghiệp vụ khác'), { id: 'nkc', name: 'Sổ nhật ký chung', render: journalReport }, { id: 'socai', name: 'Sổ cái tài khoản', render: (el) => ledgerReport(el) }, { id: 'cdtk', name: 'Bảng cân đối tài khoản', render: trialReport }, { id: 'kqkd', name: 'Kết quả kinh doanh', render: pnlReport }] },
  { id: 'danhmuc', name: 'Danh mục', icon: I('<path d="M4 6h16M4 12h16M4 18h16"/>'), tabs: ['khachhang', 'nhacungcap', 'hanghoa', 'khohang', 'taikhoan'].map((id) => ({ id, name: { khachhang: 'Khách hàng', nhacungcap: 'Nhà cung cấp', hanghoa: 'Vật tư hàng hóa', khohang: 'Kho', taikhoan: 'Hệ thống tài khoản' }[id], render: (el) => catalogView(el, id) })) },
  { id: 'thietlap', name: 'Thiết lập', icon: I('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'), tabs: [{ id: 'chung', name: 'Thiết lập chung', render: settingsView }] },
];

// ---------- Khung ứng dụng ----------
function renderLogin() {
  $('#overlay-root').innerHTML = '';
  $('#modal-root').innerHTML = '';
  $('#root').innerHTML = `<div class="login"><form>
    <h1>Kế toán Gas</h1><p>Mua hàng · Bán hàng · Kho · Công nợ vỏ</p>
    <input class="input" name="username" placeholder="Tên đăng nhập" autocomplete="username" required autofocus>
    <input class="input" name="password" type="password" placeholder="Mật khẩu" autocomplete="current-password" required>
    <button class="btn primary">Đăng nhập</button></form></div>`;
  $('.login form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('POST', '/login', { username: f.get('username'), password: f.get('password') });
    await start();
  });
}

function renderShell() {
  $('#root').innerHTML = `<div id="app">
    <aside class="sidebar"><div class="brand"><div class="logo">G</div><span>Kế toán Gas</span></div>
      <nav class="nav">${MODULES.map((m) => `<a href="#/${m.id}" data-mod="${m.id}" title="${esc(m.name)}">${m.icon}<span>${esc(m.name)}</span></a>`).join('')}</nav></aside>
    <div class="main">
      <div class="topbar"><div class="company" id="company"></div><span class="user">${esc(B.user.full_name || B.user.username)}</span>
        <button class="btn small" id="btn-pass">Đổi mật khẩu</button><button class="btn small" id="btn-logout">Đăng xuất</button></div>
      <div class="tabs" id="tabs"></div><section id="view"></section>
    </div></div>`;
  $('#company').textContent = B.settings.company_name || '';
  $('#btn-logout').onclick = guard(async () => {
    await api('POST', '/logout');
    renderLogin();
  });
  $('#btn-pass').onclick = () =>
    formModal('Đổi mật khẩu', [{ k: 'old', label: 'Mật khẩu hiện tại', type: 'password', span: 4 }, { k: 'new', label: 'Mật khẩu mới (từ 6 ký tự)', type: 'password', span: 4 }], {}, async (v) => {
      await api('POST', '/change-password', v);
      toast('Đã đổi mật khẩu');
    });
}

function route() {
  if (!B) return;
  const [, modId, tabId] = location.hash.split('/');
  const mod = MODULES.find((m) => m.id === modId) || MODULES[0];
  const tab = mod.tabs.find((t) => t.id === tabId) || mod.tabs[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.mod === mod.id));
  $('#tabs').innerHTML = mod.tabs.map((t) => `<a href="#/${mod.id}/${t.id}" class="${t === tab ? 'active' : ''}">${esc(t.name)}</a>`).join('');
  const view = $('#view');
  view.innerHTML = '';
  view.onclick = null;
  guard(tab.render)(view);
}
window.addEventListener('hashchange', route);

async function start() {
  try {
    await reloadBoot();
  } catch {
    return; // api() đã chuyển về màn hình đăng nhập
  }
  renderShell();
  route();
}

// ---------- Hộp thoại ----------
function modal(title, bodyHtml, { wide, foot = '' } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}"><h3><span>${esc(title)}</span><a data-close>✕</a></h3>
    <div class="m-body">${bodyHtml}</div><div class="m-foot">${foot}<button class="btn" data-close>Đóng</button></div></div></div>`;
  const close = () => (root.innerHTML = '');
  $$('[data-close]', root).forEach((b) => (b.onclick = close));
  return { el: $('.modal', root), close };
}
function formModal(title, fields, values, onSave) {
  const html = `<form class="fields">${fields
    .map((f) => {
      const v = values[f.k] ?? f.def ?? '';
      const attr = `name="${f.k}" class="input" ${f.readonly ? 'disabled' : ''}`;
      const ctl = f.options ? `<select ${attr}>${f.options(v)}</select>` : `<input ${attr} type="${f.type || 'text'}" value="${esc(f.money ? fmt0(v) : v)}" ${f.type === 'number' ? 'step="any"' : ''}>`;
      return `<label class="span${f.span || 2}">${esc(f.label)}${ctl}</label>`;
    })
    .join('')}</form>`;
  const m = modal(title, html, { foot: '<button class="btn primary" data-save>Cất</button>' });
  $('[data-save]', m.el).onclick = guard(async () => {
    const out = {};
    for (const f of fields) {
      const el = $(`[name="${f.k}"]`, m.el);
      out[f.k] = f.money ? parseNum(el.value) : el.value;
    }
    await onSave(out);
    m.close();
  });
  $('form', m.el).onsubmit = (e) => {
    e.preventDefault();
    $('[data-save]', m.el).click();
  };
  return m;
}

// ---------- Bảng + xuất dữ liệu ----------
function exportCsv(table, name) {
  const rows = $$('tr', table).map((tr) => $$('th,td', tr).map((c) => {
    let t = c.textContent.trim();
    if (c.classList.contains('num')) t = t.replace(/\./g, '').replace(',', '.');
    return '"' + t.replace(/"/g, '""') + '"';
  }).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = name + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
const filterBar = (extra = '', { dates = true, add } = {}) => `<div class="toolbar">
  ${dates ? `<label>Từ ngày<input type="date" class="input" data-f="from" value="${yearStart()}"></label><label>Đến ngày<input type="date" class="input" data-f="to" value="${today()}"></label>` : ''}
  ${extra}<button class="btn" data-act="load">Lấy dữ liệu</button><span class="grow"></span>
  <button class="btn" data-act="csv">Xuất Excel (CSV)</button><button class="btn" data-act="print">In</button>
  ${add ? `<button class="btn primary" data-act="add">+ ${esc(add)}</button>` : ''}</div><div class="table-wrap" data-out></div>`;
function wireReport(el, name, load) {
  const params = () => Object.fromEntries($$('[data-f]', el).map((i) => [i.dataset.f, i.value]));
  const run = guard(async () => {
    $('[data-out]', el).innerHTML = await load(params());
  });
  $('[data-act=load]', el).onclick = run;
  $('[data-act=csv]', el).onclick = () => { const t = $('table', el); if (t) exportCsv(t, name); };
  $('[data-act=print]', el).onclick = () => window.print();
  $$('[data-f]', el).forEach((i) => i.addEventListener('change', run));
  run();
  return run;
}
const vLink = (r) => `<a data-voucher="${r.voucher_id}" data-type="${r.type}">${esc(r.no)}</a>`;
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-voucher]');
  if (a) guard(openVoucher)(a.dataset.type, Number(a.dataset.voucher), route);
});

// ---------- Tổng quan ----------
async function dashboard(el) {
  const d = await api('GET', '/reports/dashboard');
  const max = Math.max(1, ...d.monthly.flatMap((m) => [m.revenue, m.cogs]));
  const months = Array.from({ length: 12 }, (_, i) => d.monthly.find((m) => m.ym === `${d.year}-${pad(i + 1)}`) || { revenue: 0, cogs: 0 });
  const debtTable = (rows) => rows.length ? `<table class="grid"><tbody>${rows.map((r) => `<tr><td>${esc(r.code)}</td><td class="wrap">${esc(r.name)}</td><td class="num">${money(r.v)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Chưa có công nợ</div>';
  el.innerHTML = `
  <div class="kpis">
    <div class="kpi green"><div class="label">Tiền mặt (111)</div><div class="value">${fmt0(d.cash)}</div></div>
    <div class="kpi green"><div class="label">Tiền gửi ngân hàng (112)</div><div class="value">${fmt0(d.bank)}</div></div>
    <div class="kpi"><div class="label">Phải thu khách hàng - tiền (1311)</div><div class="value">${fmt0(d.receivable)}</div></div>
    <div class="kpi red"><div class="label">Phải trả nhà cung cấp - tiền (3311)</div><div class="value">${fmt0(d.payable)}</div></div>
    <div class="kpi navy"><div class="label">Giá trị hàng tồn kho (156)</div><div class="value">${fmt0(d.stock_value)}</div></div>
  </div>
  <div class="kpis">
    <div class="kpi orange"><div class="label">Khách nợ vỏ 12kg (1312)</div><div class="value">${fmt0(d.shells.kh12.q)} vỏ</div><div class="sub">Giá trị: ${fmt0(d.shells.kh12.v)}</div></div>
    <div class="kpi orange"><div class="label">Khách nợ vỏ 45kg (1313)</div><div class="value">${fmt0(d.shells.kh45.q)} vỏ</div><div class="sub">Giá trị: ${fmt0(d.shells.kh45.v)}</div></div>
    <div class="kpi red"><div class="label">Nợ NCC vỏ 12kg (3312)</div><div class="value">${fmt0(d.shells.ncc12.q)} vỏ</div><div class="sub">Giá trị: ${fmt0(d.shells.ncc12.v)}</div></div>
    <div class="kpi red"><div class="label">Nợ NCC vỏ 45kg (3313)</div><div class="value">${fmt0(d.shells.ncc45.q)} vỏ</div><div class="sub">Giá trị: ${fmt0(d.shells.ncc45.v)}</div></div>
  </div>
  <div class="cols">
    <div class="card"><h3>Doanh thu thuần và giá vốn năm ${esc(d.year)}</h3><div class="body">
      <div class="chart">${months.map((m, i) => `<div class="col"><div class="bars"><div class="bar" style="height:${Math.max(0, (m.revenue / max) * 100)}%" title="Doanh thu T${i + 1}: ${fmt0(m.revenue)}"></div><div class="bar b2" style="height:${Math.max(0, (m.cogs / max) * 100)}%" title="Giá vốn T${i + 1}: ${fmt0(m.cogs)}"></div></div><div class="x">T${i + 1}</div></div>`).join('')}</div>
      <div class="legend"><span><i></i>Doanh thu thuần</span><span><i class="b2"></i>Giá vốn</span></div></div></div>
    <div class="card"><h3>Tồn kho hiện tại</h3><div class="body" style="padding:0"><table class="grid"><thead><tr><th>Mã</th><th>Tên hàng</th><th>ĐVT</th><th class="num">Số lượng</th><th class="num">Giá trị</th></tr></thead>
      <tbody>${d.stock.map((s) => `<tr><td>${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.unit)}</td><td class="num">${fmt0(s.qty)}</td><td class="num">${money(s.val)}</td></tr>`).join('')}</tbody></table></div></div>
  </div>
  <div class="cols">
    <div class="card"><h3>Khách hàng nợ tiền nhiều nhất</h3><div class="body" style="padding:0">${debtTable(d.top_receivable)}</div></div>
    <div class="card"><h3>Nợ tiền nhà cung cấp nhiều nhất</h3><div class="body" style="padding:0">${debtTable(d.top_payable)}</div></div>
  </div>`;
}

// ---------- Danh sách chứng từ ----------
function voucherList(el, type) {
  const T = VT[type];
  const isItem = T.grid === 'item';
  el.innerHTML = filterBar('<label>Tìm kiếm<input class="input" data-f="q" placeholder="Số CT, đối tượng, diễn giải"></label>', { add: 'Thêm ' + T.name.toLowerCase() });
  const run = wireReport(el, T.name, async (p) => {
    const rows = await api('GET', '/vouchers' + qs({ ...p, type }));
    if (!rows.length) return '<div class="empty">Chưa có chứng từ trong khoảng thời gian này</div>';
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    return `<table class="grid"><thead><tr><th>Ngày</th><th>Số chứng từ</th>${T.partner || T.anyPartner ? '<th>Đối tượng</th>' : ''}<th>Diễn giải</th>
      ${isItem ? '<th class="num">Số lượng</th>' : ''}${T.vat ? '<th class="num">Tiền hàng</th><th class="num">Thuế GTGT</th>' : ''}${type === 'CK' || type === 'XK' ? '' : '<th class="num">Tổng tiền</th>'}
      ${T.pay ? '<th>Thanh toán</th>' : ''}${T.shell ? '<th class="num">SL vỏ</th>' : ''}</tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" data-id="${r.id}"><td>${fdate(r.date)}</td><td><a>${esc(r.no)}</a></td>${T.partner || T.anyPartner ? `<td>${esc(r.partner_name)}</td>` : ''}<td class="wrap">${esc(r.description)}</td>
        ${isItem ? `<td class="num">${fmt(r.qty)}</td>` : ''}${T.vat ? `<td class="num">${fmt(r.total_amount)}</td><td class="num">${fmt(r.total_vat)}</td>` : ''}${type === 'CK' || type === 'XK' ? '' : `<td class="num">${fmt(r.total)}</td>`}
        ${T.pay ? `<td><span class="badge ${r.pay_method === 'NO' ? 'orange' : ''}">${esc(T.pay[r.pay_method])}</span></td>` : ''}${T.shell ? `<td class="num">${r.shell_debt ? fmt(r.shell_qty) : ''}</td>` : ''}</tr>`).join('')}
      </tbody><tfoot><tr><td colspan="${3 + (T.partner || T.anyPartner ? 1 : 0)}">Tổng: ${rows.length} chứng từ</td>
      ${isItem ? `<td class="num">${fmt(sum('qty'))}</td>` : ''}${T.vat ? `<td class="num">${fmt(sum('total_amount'))}</td><td class="num">${fmt(sum('total_vat'))}</td>` : ''}${type === 'CK' || type === 'XK' ? '' : `<td class="num">${fmt(sum('total'))}</td>`}
      ${T.pay ? '<td></td>' : ''}${T.shell ? '<td></td>' : ''}</tr></tfoot></table>`;
  });
  $('[data-f=q]', el).addEventListener('keydown', (e) => e.key === 'Enter' && run());
  $('[data-act=add]', el).onclick = () => guard(openVoucher)(type, null, run);
  $('[data-out]', el).addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) guard(openVoucher)(type, Number(tr.dataset.id), run);
  });
}

// ---------- Form chứng từ ----------
async function openVoucher(type, id, onDone) {
  const T = VT[type];
  const root = $('#overlay-root');
  let v;
  let stock = {};
  const loadStock = async () => {
    stock = {};
    if (T.grid === 'item') for (const s of await api('GET', '/reports/stock-now')) stock[`${s.item_id}:${s.warehouse_id}`] = s.qty;
  };
  const blank = () => ({ item_id: '', warehouse_id: B.warehouses[0]?.id || '', qty: 1, price: 0, vat_rate: 0, shell_qty: 1, shellTouched: false, tk_no: T.tk === 'tk_no' && T.grid === 'item' ? T.tkDefault : '', tk_co: T.tk === 'tk_co' && T.grid === 'item' ? T.tkDefault : '', amount: 0, description: '' });
  const fresh = async () => ({ type, id: null, date: v?.date || today(), no: (await api('GET', '/vouchers/next-no' + qs({ type }))).no, partner_id: '', description: T.desc, pay_method: 'NO', shell_debt: 0, warehouse_to_id: '', lines: [blank()], entries: [] });
  const load = (data) => {
    v = data;
    v.lines.forEach((l) => (l.shellTouched = true));
  };
  if (id) load(await api('GET', '/vouchers/' + id));
  else v = await fresh();
  await loadStock();

  const lineAmount = (l) => (T.grid === 'item' ? Math.round(l.qty * l.price) : l.amount);
  const lineVat = (l) => (T.vat ? Math.round((lineAmount(l) * l.vat_rate) / 100) : 0);
  const shellOf = (l) => { const it = item(l.item_id); return it?.shell_item_id ? item(it.shell_item_id) : null; };
  const totals = () => {
    const a = v.lines.reduce((s, l) => s + lineAmount(l), 0);
    const t = v.lines.reduce((s, l) => s + lineVat(l), 0);
    return { a, t, all: a + t };
  };

  function rowHtml(l, i) {
    const cell = (k, cls = '', extra = '') => `<td><input class="input ${cls}" data-k="${k}" value="${esc(cls.includes('money') ? fmt0(l[k]) : l[k])}" ${extra}></td>`;
    let h = `<tr data-i="${i}"><td class="ro center muted">${i + 1}</td>`;
    if (T.grid === 'item') {
      const it = item(l.item_id);
      h += `<td style="min-width:210px"><select class="input" data-k="item_id">${optItem(l.item_id, T.shellOnly)}</select></td>
        <td style="min-width:130px"><select class="input" data-k="warehouse_id">${optWh(l.warehouse_id)}</select></td>
        <td class="ro">${esc(it?.unit)}</td><td class="ro num muted" data-c="stock">${it ? fmt0(stock[`${l.item_id}:${l.warehouse_id}`]) : ''}</td>
        ${cell('qty', 'num', 'type="number" min="0" step="any" style="width:90px"')}`;
      if (!T.noPrice) h += (T.fixedPrice ? `<td class="ro num">${fmt(l.price)}</td>` : cell('price', 'num money', 'style="width:120px"')) + `<td class="ro num" data-c="amount">${fmt(lineAmount(l))}</td>`;
      if (T.vat) h += `<td><select class="input" data-k="vat_rate" style="width:70px">${[0, 5, 8, 10].map((r) => `<option ${Number(l.vat_rate) === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td><td class="ro num" data-c="vat">${fmt(lineVat(l))}</td>`;
      if (T.shell && v.shell_debt) h += shellOf(l) ? cell('shell_qty', 'num', `type="number" min="0" step="any" style="width:90px" title="${esc(shellOf(l).name)}"`) : '<td class="ro muted center">–</td>';
      if (T.tk) h += `<td style="min-width:200px"><select class="input" data-k="${T.tk}">${optAcc(l[T.tk])}</select></td>`;
    } else {
      h += `<td style="min-width:260px"><input class="input" data-k="description" value="${esc(l.description)}"></td>`;
      if (T.grid === 'gl' || T.tk === 'tk_no') h += `<td style="min-width:220px"><select class="input" data-k="tk_no">${optAcc(l.tk_no)}</select></td>`;
      if (T.grid === 'gl' || T.tk === 'tk_co') h += `<td style="min-width:220px"><select class="input" data-k="tk_co">${optAcc(l.tk_co)}</select></td>`;
      h += cell('amount', 'num money', 'style="width:150px"');
    }
    return h + `<td class="center"><button class="del" data-del title="Xóa dòng">✕</button></td></tr>`;
  }

  function render() {
    const t = totals();
    const head = T.grid === 'item'
      ? `<th>Hàng hóa</th><th>Kho${T.toWh ? ' xuất' : ''}</th><th>ĐVT</th><th class="num">Tồn</th><th class="num">Số lượng</th>${T.noPrice ? '' : '<th class="num">Đơn giá</th><th class="num">Thành tiền</th>'}${T.vat ? '<th>% GTGT</th><th class="num">Tiền thuế</th>' : ''}${T.shell && v.shell_debt ? `<th class="num">${esc(T.shellCol)}</th>` : ''}${T.tk ? `<th>${T.tk === 'tk_no' ? 'TK Nợ' : 'TK Có'}</th>` : ''}`
      : `<th>Diễn giải</th>${T.grid === 'gl' || T.tk === 'tk_no' ? '<th>TK Nợ</th>' : ''}${T.grid === 'gl' || T.tk === 'tk_co' ? '<th>TK Có</th>' : ''}<th class="num">Số tiền</th>`;
    const partnerLabel = T.partner === 'KH' ? 'Khách hàng' : T.partner === 'NCC' ? 'Nhà cung cấp' : 'Đối tượng';
    root.innerHTML = `<div class="overlay">
      <div class="ov-head"><h2>${esc(T.name)} <span class="muted" style="font-weight:400">${esc(v.no)}</span> ${v.id ? '<span class="badge">Đã ghi sổ</span>' : '<span class="badge gray">Thêm mới</span>'}</h2><button class="x" data-act="close" title="Đóng">✕</button></div>
      <div class="ov-body">
        <div class="form-top"><div class="fields">
          ${T.partner || T.anyPartner ? `<label class="span3">${partnerLabel}<select class="input" data-h="partner_id">${optPartner(T.partner, v.partner_id, '')}</select></label>` : ''}
          ${T.toWh ? `<label class="span3">Kho nhập<select class="input" data-h="warehouse_to_id">${optWh(v.warehouse_to_id, '')}</select></label>` : ''}
          ${!T.partner && !T.anyPartner && !T.toWh ? '<span class="span3"></span>' : ''}
          <label>Ngày chứng từ<input type="date" class="input" data-h="date" value="${esc(v.date)}"></label>
          <label class="span2">Số chứng từ<input class="input" data-h="no" value="${esc(v.no)}"></label>
          <label class="span6">Diễn giải<input class="input" data-h="description" value="${esc(v.description)}"></label>
          ${T.pay || T.shell ? `<div class="span6 checks">${T.pay ? Object.entries(T.pay).map(([k, n]) => `<label><input type="radio" name="pay" value="${k}" ${v.pay_method === k ? 'checked' : ''}>${esc(n)}</label>`).join('') : ''}
            ${T.shell ? `<label class="shell-check"><input type="checkbox" data-h="shell_debt" ${v.shell_debt ? 'checked' : ''}>${esc(T.shell)}</label>` : ''}</div>` : ''}
        </div><div class="total-box"><div class="lbl">Tổng tiền</div><div class="val" data-c="grand">${fmt0(t.all)}</div></div></div>
        <div class="table-wrap" style="max-height:none"><table class="grid detail"><thead><tr><th class="center">#</th>${head}<th></th></tr></thead><tbody>${v.lines.map(rowHtml).join('')}</tbody></table></div>
        <div style="margin-top:8px"><button class="btn small" data-act="addline">+ Thêm dòng</button></div>
        ${T.grid === 'item' && !T.noPrice ? `<div class="sum-row"><table><tr><td>Tổng tiền hàng</td><td data-c="sum-a">${fmt0(t.a)}</td></tr>${T.vat ? `<tr><td>Thuế GTGT</td><td data-c="sum-t">${fmt0(t.t)}</td></tr><tr><td>Tổng tiền thanh toán</td><td data-c="sum-all">${fmt0(t.all)}</td></tr>` : ''}</table></div>` : ''}
        ${v.id && v.entries?.length ? `<div class="section-title">Hạch toán (tự động)</div><div class="table-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Diễn giải</th><th>TK Nợ</th><th>TK Có</th><th class="num">Số lượng</th><th class="num">Số tiền</th></tr></thead><tbody>
          ${v.entries.map((e) => `<tr><td class="wrap">${esc(e.description)}</td><td>${esc(e.tk_no)}</td><td>${esc(e.tk_co)}</td><td class="num">${fmt(e.qty)}</td><td class="num">${fmt(e.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${v.id && type === 'CK' ? '<div class="help" style="margin-top:10px">Chuyển kho nội bộ không phát sinh định khoản (cùng tài khoản 156).</div>' : ''}
      </div>
      <div class="ov-foot"><button class="btn" data-act="close">Hủy</button>${v.id ? '<button class="btn" data-act="delete">Xóa</button><button class="btn" data-act="print">In</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-act="save">Cất</button><button class="btn primary" data-act="savenew">Cất và Thêm</button></div></div>`;
    document.body.classList.add('has-overlay');
  }
  const refreshTotals = () => {
    const t = totals();
    const set = (c, val) => { const e = $(`[data-c=${c}]`, root); if (e) e.textContent = fmt0(val); };
    set('grand', t.all); set('sum-a', t.a); set('sum-t', t.t); set('sum-all', t.all);
  };
  const close = () => {
    root.innerHTML = '';
    document.body.classList.remove('has-overlay');
  };

  const save = async (andNew) => {
    const payload = { ...v, lines: v.lines.filter((l) => (T.grid === 'item' ? l.item_id : l.amount || l.tk_no || l.tk_co)).map((l) => ({ ...l, shell_qty: v.shell_debt ? l.shell_qty : 0 })) };
    delete payload.entries;
    const saved = v.id ? await api('PUT', '/vouchers/' + v.id, payload) : await api('POST', '/vouchers', payload);
    toast('Đã cất chứng từ ' + saved.no);
    onDone?.();
    await loadStock();
    if (andNew) v = await fresh();
    else load(saved);
    render();
  };

  root.onclick = guard(async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const del = e.target.closest('[data-del]');
    if (del) {
      v.lines.splice(Number(del.closest('tr').dataset.i), 1);
      if (!v.lines.length) v.lines.push(blank());
      return render();
    }
    if (act === 'close') return close();
    if (act === 'addline') { v.lines.push(blank()); render(); $$('tbody tr:last-child .input', root)[0]?.focus(); return; }
    if (act === 'print') return window.print();
    if (act === 'save') return save(false);
    if (act === 'savenew') return save(true);
    if (act === 'delete' && confirm(`Xóa chứng từ ${v.no}? Sổ sách và tồn kho sẽ được cập nhật lại.`)) {
      await api('DELETE', '/vouchers/' + v.id);
      toast('Đã xóa chứng từ');
      onDone?.();
      close();
    }
  });
  root.oninput = (e) => {
    const el = e.target;
    if (el.name === 'pay') return void (v.pay_method = el.value);
    if (el.dataset.h) {
      const k = el.dataset.h;
      if (k === 'shell_debt') { v.shell_debt = el.checked ? 1 : 0; return render(); }
      v[k] = el.value;
      return;
    }
    const k = el.dataset.k;
    if (!k) return;
    const tr = el.closest('tr');
    const l = v.lines[Number(tr.dataset.i)];
    if (k === 'item_id') {
      l.item_id = Number(el.value) || '';
      const it = item(l.item_id);
      if (it) { l.price = it[T.price] || 0; l.vat_rate = T.vat ? it.vat_rate : 0; }
      return render();
    }
    if (k === 'warehouse_id') { l.warehouse_id = Number(el.value); return render(); }
    if (['tk_no', 'tk_co', 'description'].includes(k)) return void (l[k] = el.value);
    if (k === 'vat_rate') l.vat_rate = Number(el.value);
    else if (k === 'shell_qty') { l.shell_qty = Number(el.value) || 0; l.shellTouched = true; }
    else if (k === 'qty') {
      l.qty = Number(el.value) || 0;
      if (!l.shellTouched) { l.shell_qty = l.qty; const s = $('[data-k=shell_qty]', tr); if (s) s.value = l.qty; }
    } else l[k] = parseNum(el.value);
    const a = $('[data-c=amount]', tr); if (a) a.textContent = fmt(lineAmount(l));
    const t = $('[data-c=vat]', tr); if (t) t.textContent = fmt(lineVat(l));
    refreshTotals();
  };
  root.addEventListener('focusout', (e) => {
    if (e.target.classList?.contains('money')) e.target.value = fmt0(parseNum(e.target.value));
  });
  render();
}

// ---------- Báo cáo ----------
function journalReport(el) {
  el.innerHTML = filterBar();
  wireReport(el, 'So-nhat-ky-chung', async (p) => {
    const d = await api('GET', '/reports/journal' + qs(p));
    if (!d.rows.length) return '<div class="empty">Không có phát sinh</div>';
    return `<table class="grid"><thead><tr><th>Ngày</th><th>Số chứng từ</th><th>Diễn giải</th><th>Đối tượng</th><th>TK Nợ</th><th>TK Có</th><th class="num">Số tiền</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr><td>${fdate(r.date)}</td><td>${vLink(r)}</td><td class="wrap">${esc(r.description)}</td><td>${esc(r.partner_name)}</td><td>${esc(r.tk_no)}</td><td>${esc(r.tk_co)}</td><td class="num">${fmt(r.amount)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="6">Tổng cộng</td><td class="num">${fmt(d.rows.reduce((s, r) => s + r.amount, 0))}</td></tr></tfoot></table>`;
  });
}

function ledgerTable(d, showQty) {
  let bal = d.opening;
  let dr = 0;
  let cr = 0;
  const body = d.rows.map((r) => {
    bal += r.dr - r.cr; dr += r.dr; cr += r.cr;
    return `<tr><td>${fdate(r.date)}</td><td>${vLink(r)}</td><td class="wrap">${esc(r.description)}</td><td>${esc(r.partner_name)}</td><td>${esc(r.acc)}</td><td>${esc(r.contra)}</td>
      ${showQty ? `<td class="num">${fmt(r.qty_dr - r.qty_cr)}</td>` : ''}<td class="num">${fmt(r.dr)}</td><td class="num">${fmt(r.cr)}</td><td class="num">${money(bal)}</td></tr>`;
  }).join('');
  const n = showQty ? 7 : 6;
  return `<table class="grid"><thead><tr><th>Ngày</th><th>Số chứng từ</th><th>Diễn giải</th><th>Đối tượng</th><th>Tài khoản</th><th>TK đối ứng</th>${showQty ? '<th class="num">SL vỏ (+/-)</th>' : ''}<th class="num">Phát sinh Nợ</th><th class="num">Phát sinh Có</th><th class="num">Số dư (Nợ - Có)</th></tr></thead>
    <tbody><tr class="bold"><td colspan="${n}">Số dư đầu kỳ</td><td></td><td></td><td class="num">${money(d.opening)}</td></tr>${body}</tbody>
    <tfoot><tr><td colspan="${n}">Cộng phát sinh / Số dư cuối kỳ</td><td class="num">${fmt(dr)}</td><td class="num">${fmt(cr)}</td><td class="num">${money(bal)}</td></tr></tfoot></table>`;
}
function ledgerReport(el, fixedAcc) {
  const accs = B.accounts.map((a) => ({ code: a.code, name: a.name }));
  el.innerHTML = filterBar(fixedAcc ? `<input type="hidden" data-f="acc" value="${fixedAcc}">` : `<label>Tài khoản<select class="input" data-f="acc">${opts(accs, '1311', (a) => `${a.code} - ${a.name}`)}</select></label><label>Đối tượng<select class="input" data-f="partner_id">${optPartner(null, '', 'Tất cả')}</select></label>`);
  wireReport(el, 'So-cai-' + (fixedAcc || 'tai-khoan'), async (p) => ledgerTable(await api('GET', '/reports/ledger' + qs(p))));
}

function trialReport(el) {
  el.innerHTML = filterBar();
  wireReport(el, 'Bang-can-doi-tai-khoan', async (p) => {
    const d = await api('GET', '/reports/trial-balance' + qs(p));
    if (!d.rows.length) return '<div class="empty">Không có số liệu</div>';
    const side = (v) => `<td class="num">${v > 0 ? fmt(v) : ''}</td><td class="num">${v < 0 ? fmt(-v) : ''}</td>`;
    const top = d.rows.filter((r) => !r.parent);
    const s = (f) => top.reduce((a, r) => a + f(r), 0);
    return `<table class="grid"><thead><tr><th rowspan="2">Số TK</th><th rowspan="2">Tên tài khoản</th><th colspan="2" class="center">Đầu kỳ</th><th colspan="2" class="center">Phát sinh</th><th colspan="2" class="center">Cuối kỳ</th></tr>
      <tr><th class="num">Nợ</th><th class="num">Có</th><th class="num">Nợ</th><th class="num">Có</th><th class="num">Nợ</th><th class="num">Có</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr class="${r.parent ? '' : 'lvl1'}"><td>${esc(r.code)}</td><td class="wrap" style="padding-left:${10 + (r.code.length - 3) * 14}px">${esc(r.name)}</td>${side(r.open)}<td class="num">${fmt(r.dr)}</td><td class="num">${fmt(r.cr)}</td>${side(r.close)}</tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">Tổng cộng</td><td class="num">${fmt(s((r) => Math.max(r.open, 0)))}</td><td class="num">${fmt(s((r) => Math.max(-r.open, 0)))}</td><td class="num">${fmt(s((r) => r.dr))}</td><td class="num">${fmt(s((r) => r.cr))}</td><td class="num">${fmt(s((r) => Math.max(r.close, 0)))}</td><td class="num">${fmt(s((r) => Math.max(-r.close, 0)))}</td></tr></tfoot></table>`;
  });
}

function pnlReport(el) {
  el.innerHTML = filterBar();
  wireReport(el, 'Ket-qua-kinh-doanh', async (p) => {
    const d = await api('GET', '/reports/pnl' + qs(p));
    return `<table class="grid"><thead><tr><th>Mã số</th><th>Chỉ tiêu</th><th class="num">Số tiền</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr class="${r.bold ? 'bold' : ''}"><td>${r.code}</td><td>${esc(r.name)}</td><td class="num">${fmt0(r.value)}</td></tr>`).join('')}</tbody></table>`;
  });
}

function debtReport(el, kind) {
  const isKH = kind === 'KH';
  const base = isKH ? '131' : '331';
  const who = isKH ? 'Khách hàng' : 'Nhà cung cấp';
  el.innerHTML = filterBar(`<label>Hiển thị<select class="input" data-f="all"><option value="">Có phát sinh / số dư</option><option value="1">Tất cả ${who.toLowerCase()}</option></select></label>`);
  wireReport(el, isKH ? 'Cong-no-phai-thu' : 'Cong-no-phai-tra', async (p) => {
    const d = await api('GET', '/reports/debts' + qs({ ...p, kind }));
    if (!d.rows.length) return '<div class="empty">Không có công nợ</div>';
    const tot = {};
    const cells = (r, acc, shell) => {
      const a = r.accs[acc];
      tot[acc] ??= { open: 0, inc: 0, dec: 0, close: 0, open_qty: 0, inc_qty: 0, dec_qty: 0, close_qty: 0 };
      for (const k in tot[acc]) tot[acc][k] += a[k];
      return shell
        ? `<td class="num">${fmt(a.open_qty)}</td><td class="num">${fmt(a.inc_qty)}</td><td class="num">${fmt(a.dec_qty)}</td><td class="num"><b>${money(a.close_qty)}</b></td><td class="num">${money(a.close)}</td>`
        : `<td class="num">${money(a.open)}</td><td class="num">${fmt(a.inc)}</td><td class="num">${fmt(a.dec)}</td><td class="num"><b>${money(a.close)}</b></td>`;
    };
    const body = d.rows.map((r) => `<tr class="click" data-pid="${r.partner_id}"><td>${esc(r.code)}</td><td>${esc(r.name)}</td>${cells(r, base + '1')}${cells(r, base + '2', 1)}${cells(r, base + '3', 1)}</tr>`).join('');
    const t = (acc, shell) => { const a = tot[acc]; return shell ? `<td class="num">${fmt(a.open_qty)}</td><td class="num">${fmt(a.inc_qty)}</td><td class="num">${fmt(a.dec_qty)}</td><td class="num">${fmt(a.close_qty)}</td><td class="num">${fmt(a.close)}</td>` : `<td class="num">${fmt(a.open)}</td><td class="num">${fmt(a.inc)}</td><td class="num">${fmt(a.dec)}</td><td class="num">${fmt(a.close)}</td>`; };
    const sh = `<th class="num">Đầu kỳ</th><th class="num">${isKH ? 'Nợ thêm' : 'Nợ thêm'}</th><th class="num">Đã trả</th><th class="num">Còn nợ (SL)</th><th class="num">Giá trị</th>`;
    return `<table class="grid"><thead><tr><th rowspan="2">Mã</th><th rowspan="2">${who}</th><th colspan="4" class="center">Nợ tiền (${base}1)</th><th colspan="5" class="center">Nợ vỏ gas 12kg (${base}2)</th><th colspan="5" class="center">Nợ vỏ gas 45kg (${base}3)</th></tr>
      <tr><th class="num">Đầu kỳ</th><th class="num">Tăng</th><th class="num">Giảm</th><th class="num">Cuối kỳ</th>${sh}${sh}</tr></thead><tbody>${body}</tbody>
      <tfoot><tr><td colspan="2">Tổng cộng</td>${t(base + '1')}${t(base + '2', 1)}${t(base + '3', 1)}</tr></tfoot></table>`;
  });
  $('[data-out]', el).addEventListener('click', guard(async (e) => {
    const tr = e.target.closest('tr[data-pid]');
    if (!tr) return;
    const pa = B.partners.find((x) => x.id === Number(tr.dataset.pid));
    const from = $('[data-f=from]', el).value;
    const to = $('[data-f=to]', el).value;
    const names = { 1: 'Nợ tiền', 2: 'Nợ vỏ gas 12kg', 3: 'Nợ vỏ gas 45kg' };
    const m = modal(`Chi tiết công nợ - ${pa.name}`, `<div class="toolbar"><label>Loại nợ<select class="input" id="d-acc">${[1, 2, 3].map((s) => `<option value="${base}${s}">${base}${s} - ${names[s]}</option>`).join('')}</select></label></div><div class="table-wrap" id="d-out" style="max-height:60vh"></div>`, { wide: true });
    const show = guard(async () => {
      const acc = $('#d-acc').value;
      const d = await api('GET', '/reports/ledger' + qs({ acc, partner_id: pa.id, from, to }));
      $('#d-out').innerHTML = ledgerTable(d, !acc.endsWith('1')) + (acc.endsWith('1') ? '' : `<div class="help" style="padding:8px 10px">Số lượng vỏ đầu kỳ: <b>${fmt0((isKH ? 1 : -1) * d.opening_qty)}</b> · còn nợ cuối kỳ: <b>${fmt0((isKH ? 1 : -1) * (d.opening_qty + d.rows.reduce((s, r) => s + r.qty_dr - r.qty_cr, 0)))}</b> vỏ</div>`);
    });
    $('#d-acc').onchange = show;
    $('#d-out').addEventListener('click', (ev) => ev.target.closest('[data-voucher]') && m.close());
    show();
  }));
}

function stockReport(el) {
  el.innerHTML = filterBar(`<label>Kho<select class="input" data-f="warehouse_id">${optWh('', 'Tất cả kho')}</select></label>`);
  wireReport(el, 'Tong-hop-ton-kho', async (p) => {
    const d = await api('GET', '/reports/stock-summary' + qs(p));
    const s = (k) => d.rows.reduce((a, r) => a + r[k], 0);
    return `<table class="grid"><thead><tr><th rowspan="2">Mã hàng</th><th rowspan="2">Tên hàng</th><th rowspan="2">ĐVT</th><th colspan="2" class="center">Đầu kỳ</th><th colspan="2" class="center">Nhập kho</th><th colspan="2" class="center">Xuất kho</th><th colspan="2" class="center">Cuối kỳ</th></tr>
      <tr>${'<th class="num">Số lượng</th><th class="num">Giá trị</th>'.repeat(4)}</tr></thead><tbody>
      ${d.rows.map((r) => `<tr class="click" data-item="${r.item_id}"><td>${esc(r.code)}</td><td>${esc(r.name)} ${r.kind === 'VO' ? '<span class="badge orange">Vỏ</span>' : ''}</td><td>${esc(r.unit)}</td><td class="num">${fmt(r.open_qty)}</td><td class="num">${fmt(r.open_val)}</td><td class="num">${fmt(r.in_qty)}</td><td class="num">${fmt(r.in_val)}</td><td class="num">${fmt(r.out_qty)}</td><td class="num">${fmt(r.out_val)}</td><td class="num"><b>${money(r.close_qty)}</b></td><td class="num">${money(r.close_val)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="3">Tổng giá trị</td><td></td><td class="num">${fmt(s('open_val'))}</td><td></td><td class="num">${fmt(s('in_val'))}</td><td></td><td class="num">${fmt(s('out_val'))}</td><td></td><td class="num">${fmt(s('close_val'))}</td></tr></tfoot></table>`;
  });
  $('[data-out]', el).addEventListener('click', guard(async (e) => {
    const tr = e.target.closest('tr[data-item]');
    if (!tr) return;
    const it = item(tr.dataset.item);
    const p = Object.fromEntries($$('[data-f]', el).map((i) => [i.dataset.f, i.value]));
    const d = await api('GET', '/reports/stock-card' + qs({ ...p, item_id: it.id }));
    let q = d.opening_qty;
    let val = d.opening_val;
    const m = modal(`Sổ chi tiết vật tư hàng hóa - ${it.code} - ${it.name}`, `<div class="table-wrap" style="max-height:65vh"><table class="grid"><thead><tr><th>Ngày</th><th>Số chứng từ</th><th>Diễn giải</th><th>Kho</th><th class="num">Đơn giá</th><th class="num">SL nhập</th><th class="num">GT nhập</th><th class="num">SL xuất</th><th class="num">GT xuất</th><th class="num">SL tồn</th><th class="num">GT tồn</th></tr></thead>
      <tbody><tr class="bold"><td colspan="9">Tồn đầu kỳ</td><td class="num">${fmt(q)}</td><td class="num">${fmt(val)}</td></tr>
      ${d.rows.map((r) => { q += r.dir * r.qty; val += r.dir * r.amount; return `<tr><td>${fdate(r.date)}</td><td>${vLink(r)}</td><td class="wrap">${esc(r.description)}${r.partner_name ? ' - ' + esc(r.partner_name) : ''}</td><td>${esc(r.warehouse)}</td><td class="num">${fmt(Math.round(r.unit_cost))}</td>${r.dir > 0 ? `<td class="num">${fmt(r.qty)}</td><td class="num">${fmt(r.amount)}</td><td></td><td></td>` : `<td></td><td></td><td class="num">${fmt(r.qty)}</td><td class="num">${fmt(r.amount)}</td>`}<td class="num">${money(q)}</td><td class="num">${money(val)}</td></tr>`; }).join('')}
      </tbody></table></div>`, { wide: true });
    m.el.addEventListener('click', (ev) => ev.target.closest('[data-voucher]') && m.close());
  }));
}

// ---------- Tính giá xuất kho ----------
const METHODS = { BQTT: 'Bình quân tức thời', BQCK: 'Bình quân cuối kỳ (theo tháng)', FIFO: 'Nhập trước xuất trước' };
function costingView(el) {
  el.innerHTML = `<div class="card" style="max-width:760px"><h3>Tính giá xuất kho</h3><div class="body">
    <div class="toolbar"><label>Phương pháp tính giá<select class="input" id="c-method">${Object.entries(METHODS).map(([k, n]) => `<option value="${k}" ${B.settings.costing_method === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="btn primary" id="c-run">Thực hiện tính giá</button></div>
    <div class="help">
      • Hệ thống tự động tính lại giá vốn (Nợ 632 / Có 156) mỗi khi cất, sửa hoặc xóa chứng từ theo phương pháp đang chọn.<br>
      • Bấm <b>Thực hiện tính giá</b> để đổi phương pháp và tính lại giá xuất kho cho toàn bộ hàng hóa từ đầu.<br>
      • <b>Bình quân tức thời</b>: giá xuất = giá trị tồn / số lượng tồn tại thời điểm xuất.<br>
      • <b>Bình quân cuối kỳ</b>: giá xuất trong tháng = (giá trị tồn đầu tháng + giá trị nhập trong tháng) / (số lượng tồn đầu tháng + số lượng nhập trong tháng).<br>
      • <b>Nhập trước xuất trước</b>: hàng nhập trước được xuất trước theo đúng giá của từng lần nhập.<br>
      • Giá được tính chung toàn doanh nghiệp (không theo từng kho). Vỏ bình cho nợ / nhận lại luôn ghi theo "Giá trị 1 vỏ" khai báo ở danh mục hàng hóa để công nợ vỏ 1312, 1313, 3312, 3313 luôn khớp số lượng.
    </div></div></div>`;
  $('#c-run').onclick = guard(async () => {
    const r = await api('POST', '/costing/run', { method: $('#c-method').value });
    B.settings = r.settings;
    toast(`Đã tính giá xuất kho cho ${r.items} mặt hàng theo phương pháp ${METHODS[B.settings.costing_method]}`);
  });
}

function settingsView(el) {
  el.innerHTML = `<div class="card" style="max-width:760px"><h3>Thiết lập chung</h3><div class="body"><div class="fields">
    <label class="span6">Tên đơn vị<input class="input" id="s-name" value="${esc(B.settings.company_name)}"></label>
    <label class="span3">Phương pháp tính giá xuất kho<select class="input" id="s-method">${Object.entries(METHODS).map(([k, n]) => `<option value="${k}" ${B.settings.costing_method === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="span3">Xuất kho khi không đủ tồn<select class="input" id="s-neg"><option value="0">Không cho phép</option><option value="1" ${B.settings.allow_negative === '1' ? 'selected' : ''}>Cho phép xuất âm</option></select></label>
    </div><div style="margin-top:12px"><button class="btn primary" id="s-save">Cất</button></div></div></div>`;
  $('#s-save').onclick = guard(async () => {
    const changed = $('#s-method').value !== B.settings.costing_method;
    B.settings = await api('PUT', '/settings', { company_name: $('#s-name').value, allow_negative: $('#s-neg').value });
    if (changed) B.settings = (await api('POST', '/costing/run', { method: $('#s-method').value })).settings;
    $('#company').textContent = B.settings.company_name;
    toast(changed ? 'Đã lưu và tính lại giá xuất kho' : 'Đã lưu thiết lập');
  });
}

// ---------- Danh mục ----------
const CATALOGS = {
  khachhang: { api: 'partners', title: 'khách hàng', filter: (r) => r.kind === 'KH', fixed: { kind: 'KH' }, cols: [['code', 'Mã'], ['name', 'Tên khách hàng'], ['address', 'Địa chỉ'], ['phone', 'Điện thoại'], ['tax_code', 'Mã số thuế']],
    fields: () => [{ k: 'code', label: 'Mã khách hàng' }, { k: 'name', label: 'Tên khách hàng' }, { k: 'address', label: 'Địa chỉ', span: 4 }, { k: 'phone', label: 'Điện thoại' }, { k: 'tax_code', label: 'Mã số thuế' }, { k: 'note', label: 'Ghi chú', span: 4 }] },
  nhacungcap: { api: 'partners', title: 'nhà cung cấp', filter: (r) => r.kind === 'NCC', fixed: { kind: 'NCC' }, cols: [['code', 'Mã'], ['name', 'Tên nhà cung cấp'], ['address', 'Địa chỉ'], ['phone', 'Điện thoại'], ['tax_code', 'Mã số thuế']],
    fields: () => [{ k: 'code', label: 'Mã nhà cung cấp' }, { k: 'name', label: 'Tên nhà cung cấp' }, { k: 'address', label: 'Địa chỉ', span: 4 }, { k: 'phone', label: 'Điện thoại' }, { k: 'tax_code', label: 'Mã số thuế' }, { k: 'note', label: 'Ghi chú', span: 4 }] },
  hanghoa: { api: 'items', title: 'hàng hóa', cols: [['code', 'Mã'], ['name', 'Tên hàng hóa'], ['unit', 'ĐVT'], ['kind', 'Loại', (r) => (r.kind === 'VO' ? `<span class="badge orange">Vỏ bình ${esc(r.shell_type)}kg</span>` : 'Hàng hóa')], ['shell_item_id', 'Vỏ đi kèm', (r) => esc(item(r.shell_item_id)?.name)], ['shell_price', 'Giá trị 1 vỏ', 'num'], ['buy_price', 'Giá mua', 'num'], ['sale_price', 'Giá bán', 'num'], ['vat_rate', '% GTGT', 'num']],
    fields: (r) => [{ k: 'code', label: 'Mã hàng' }, { k: 'name', label: 'Tên hàng hóa' }, { k: 'unit', label: 'Đơn vị tính', span: 1 }, { k: 'kind', label: 'Loại', span: 1, options: (v) => opts([{ code: 'HH', n: 'Hàng hóa' }, { code: 'VO', n: 'Vỏ bình gas' }], v, (x) => x.n) },
      { k: 'shell_type', label: 'Loại vỏ (nếu là vỏ bình)', options: (v) => opts([{ code: '12', n: 'Vỏ 12kg → TK 1312 / 3312' }, { code: '45', n: 'Vỏ 45kg → TK 1313 / 3313' }], v, (x) => x.n, 'Không phải vỏ') },
      { k: 'shell_item_id', label: 'Vỏ đi kèm (nếu là gas bình)', options: (v) => opts(B.items.filter((i) => i.kind === 'VO' && i.id !== r?.id), v, (i) => i.name, 'Không có') },
      { k: 'shell_price', label: 'Giá trị 1 vỏ (ghi nợ vỏ)', money: true }, { k: 'buy_price', label: 'Giá mua', money: true }, { k: 'sale_price', label: 'Giá bán', money: true }, { k: 'vat_rate', label: '% thuế GTGT', type: 'number', def: 10 }] },
  khohang: { api: 'warehouses', title: 'kho', cols: [['code', 'Mã kho'], ['name', 'Tên kho']], fields: () => [{ k: 'code', label: 'Mã kho' }, { k: 'name', label: 'Tên kho' }] },
  taikhoan: { api: 'accounts', title: 'tài khoản', cols: [['code', 'Số tài khoản'], ['name', 'Tên tài khoản', (r) => `<span style="padding-left:${(r.code.length - 3) * 16}px;${r.parent ? '' : 'font-weight:600'}">${esc(r.name)}</span>`], ['nature', 'Tính chất', (r) => ({ N: 'Dư Nợ', C: 'Dư Có', L: 'Lưỡng tính' })[r.nature]]],
    fields: (r) => [{ k: 'code', label: 'Số tài khoản', readonly: !!r }, { k: 'parent', label: 'TK tổng hợp', readonly: !!r, options: (v) => opts(B.accounts.map((a) => ({ code: a.code, name: a.name })), v, (a) => `${a.code} - ${a.name}`, 'Không có') }, { k: 'name', label: 'Tên tài khoản', span: 4 }, { k: 'nature', label: 'Tính chất', options: (v) => opts([{ code: 'N', n: 'Dư Nợ' }, { code: 'C', n: 'Dư Có' }, { code: 'L', n: 'Lưỡng tính' }], v, (x) => x.n) }] },
};
function catalogView(el, id) {
  const C = CATALOGS[id];
  const draw = () => {
    const rows = B[C.api].filter(C.filter || (() => true));
    el.innerHTML = `<div class="toolbar"><span class="grow"></span><button class="btn primary" id="cat-add">+ Thêm ${esc(C.title)}</button></div><div class="table-wrap">${rows.length ? `<table class="grid"><thead><tr>${C.cols.map(([, n, f]) => `<th class="${f === 'num' ? 'num' : ''}">${esc(n)}</th>`).join('')}<th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" data-id="${r.id}">${C.cols.map(([k, , f]) => (f === 'num' ? `<td class="num">${fmt(r[k])}</td>` : `<td>${typeof f === 'function' ? f(r) : esc(r[k])}</td>`)).join('')}<td class="center"><a data-del="${r.id}" class="neg">Xóa</a></td></tr>`).join('')}</tbody></table>` : `<div class="empty">Chưa có ${esc(C.title)}</div>`}</div>`;
    $('#cat-add').onclick = () => edit(null);
  };
  const edit = (r) =>
    formModal((r ? 'Sửa ' : 'Thêm ') + C.title, C.fields(r), r || {}, async (v) => {
      const body = { ...v, ...C.fixed };
      if (r) await api('PUT', `/${C.api}/${r.id}`, body);
      else await api('POST', `/${C.api}`, body);
      await reloadBoot();
      draw();
      toast('Đã cất');
    });
  el.onclick = guard(async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!confirm('Xóa bản ghi này?')) return;
      await api('DELETE', `/${C.api}/${del.dataset.del}`);
      await reloadBoot();
      draw();
      return toast('Đã xóa');
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) edit(B[C.api].find((x) => x.id === Number(tr.dataset.id)));
  });
  draw();
}

start();
