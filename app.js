/* ===== نظام إدارة الموظفين والرواتب ===== */
'use strict';

// ============ إدارة البيانات ============
const DB_KEYS = { EMPLOYEES: 'ems_employees', EXPENSES: 'ems_expenses', SETTINGS: 'ems_settings', PAYROLL: 'ems_payroll' };

function loadData(key, defaultVal = []) {
  try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : defaultVal; }
  catch { return defaultVal; }
}
function saveData(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

let employees = loadData(DB_KEYS.EMPLOYEES);
let expenses  = loadData(DB_KEYS.EXPENSES);
let settings  = loadData(DB_KEYS.SETTINGS, {
  companyName: 'مؤسستي', taxNumber: '', phone: '', address: '',
  currency: 'ر.س', monthlyIncome: 0, logo: ''
});
let payrollData = loadData(DB_KEYS.PAYROLL, {}); // { "2026-09": { empId: {pieces, bonus, allowance, advance, deduction} } }

let confirmCallback = null;
let deferredInstallPrompt = null;
let pendingCompanyLogo = null;

// ============ أدوات مساعدة ============
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function fmt(n) {
  const cur = settings.currency || 'ر.س';
  return (Number(n) || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 }) + ' ' + cur;
}
function monthKey(y, m) { return `${y}-${String(m).padStart(2,'0')}`; }
function curMonthKey() { const d = new Date(); return monthKey(d.getFullYear(), d.getMonth() + 1); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ============ الحسابات ============
function calcEmployeeNet(emp, monthData = {}) {
  const md = monthData || {};
  const bonus     = Number(md.bonus     ?? emp.bonus     ?? 0);
  const allowance = Number(md.allowance ?? emp.allowance ?? 0);
  const advance   = Number(md.advance   ?? emp.advance   ?? 0);
  const deduction = Number(md.deduction ?? emp.deduction ?? 0);
  const taxRate   = Math.min(100, Math.max(0, Number(md.taxRate ?? emp.taxRate ?? 0)));

  let base = 0, pieces = 0, pieceTotal = 0;
  if (emp.type === 'piece') {
    pieces     = Number(md.pieces ?? 0);
    pieceTotal = pieces * Number(emp.piecePrice || 0);
    base = pieceTotal;
  } else {
    base = Number(emp.salary || 0);
    pieces = Number(md.extraPieces ?? 0);
    pieceTotal = pieces * Number(emp.piecePrice || 0);
    base += pieceTotal;
  }
  const gross = base + bonus + allowance;
  const tax = gross * taxRate / 100;
  const afterTax = gross - tax;
  const net   = afterTax - advance - deduction;
  return { base, pieces, pieceTotal, bonus, allowance, advance, deduction, taxRate, gross, tax, afterTax, net };
}

// ============ التنقل ============
const pageTitles = {
  dashboard: 'لوحة التحكم', employees: 'الموظفون', payroll: 'مسير الرواتب',
  expenses: 'النفقات التشغيلية', reports: 'التقارير المالية', settings: 'الإعدادات'
};

function showPage(page) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $('#page-' + page).classList.add('active');
  $$('.sidebar-menu a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $('#page-title').textContent = pageTitles[page] || '';
  closeSidebar();
  if (page === 'dashboard') renderDashboard();
  if (page === 'employees') renderEmployees();
  if (page === 'payroll')   renderPayroll();
  if (page === 'expenses')  renderExpenses();
  if (page === 'reports')   renderReports();
  if (page === 'settings')  loadSettingsForm();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleSidebar() {
  $('#sidebar').classList.toggle('open');
  $('#sidebar-overlay').classList.toggle('show');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-overlay').classList.remove('show');
}

// ============ لوحة التحكم ============
function renderDashboard() {
  const mk = curMonthKey();
  $('#stat-employees').textContent = employees.length;

  let totalSalaries = 0;
  employees.forEach(e => { totalSalaries += calcEmployeeNet(e, payrollData[mk]?.[e.id]).net; });
  $('#stat-salaries').textContent = fmt(totalSalaries);

  const monthExp = expenses.filter(x => x.date?.startsWith(mk));
  const totalExp = monthExp.reduce((s, x) => s + Number(x.amount || 0), 0);
  $('#stat-expenses').textContent = fmt(totalExp);

  const income = Number(settings.monthlyIncome || 0);
  $('#stat-net').textContent = fmt(income - totalSalaries - totalExp);

  const recent = [...employees].slice(-5).reverse();
  $('#recent-employees').innerHTML = recent.length ? recent.map(e => `
    <tr>
      <td>${esc(e.name)}</td>
      <td>${esc(e.title)}</td>
      <td><span class="badge badge-${e.type}">${e.type === 'piece' ? 'بالقطعة' : 'شهري'}</span></td>
      <td class="amount">${e.type === 'piece' ? fmt(e.piecePrice) + ' / قطعة' : fmt(e.salary)}</td>
    </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;color:#999;padding:2rem">لا يوجد موظفون بعد — أضف أول موظف!</td></tr>';
}

function toggleEmployeeActions(id) {
  const menu = document.querySelector(`[data-employee-actions="${id}"]`);
  if (!menu) return;
  $$('.employee-actions-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
  menu.classList.toggle('open');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.employee-name-wrap')) $$('.employee-actions-menu.open').forEach(m => m.classList.remove('open'));
});

// ============ الموظفون ============
function renderEmployees() {
  const q = ($('#employee-search').value || '').trim();
  const list = employees.filter(e => !q || e.name.includes(q) || e.title.includes(q));
  $('#employees-table').innerHTML = list.length ? list.map(e => {
    const c = calcEmployeeNet(e, payrollData[curMonthKey()]?.[e.id]);
    return `<tr>
      <td>
        <div class="employee-name-wrap">
          <button class="employee-name-button" onclick="toggleEmployeeActions('${e.id}')" title="إضافة حركة مالية"><strong>${esc(e.name)}</strong><span>⌄</span></button>
          <div class="employee-actions-menu" data-employee-actions="${e.id}">
            <button onclick="openEmployeeTransaction('${e.id}','advance')">💸 سلفة</button>
            <button onclick="openEmployeeTransaction('${e.id}','deduction')">➖ خصم</button>
            <button onclick="openEmployeeTransaction('${e.id}','bonus')">🎁 حافز</button>
          </div>
        </div>
      </td>
      <td>${esc(e.title)}</td>
      <td><span class="badge badge-${e.type}">${e.type === 'piece' ? '🔢 بالقطعة' : '📅 شهري'}</span></td>
      <td class="amount">${e.type === 'piece' ? fmt(e.piecePrice) + '/قطعة' : fmt(e.salary)}</td>
      <td class="amount">${fmt(c.gross)}</td>
      <td class="amount">${c.taxRate}%</td>
      <td class="amount amount-positive">${fmt(c.afterTax)}</td>
      <td class="amount amount-negative">${fmt(c.advance)}</td>
      <td class="amount amount-negative">${fmt(c.deduction)}</td>
      <td class="amount amount-positive">${fmt(c.bonus)}</td>
      <td class="amount" style="color:var(--primary);font-weight:700">${fmt(c.net)}</td>
      <td>
        <button class="btn btn-sm btn-info btn-icon" onclick="editEmployee('${e.id}')" title="تعديل">✏️</button>
        <button class="btn btn-sm btn-danger btn-icon" onclick="deleteEmployee('${e.id}')" title="حذف">🗑️</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="12" style="text-align:center;color:#999;padding:2rem">لا توجد نتائج</td></tr>';
}

function openEmployeeTransaction(empId, type = 'advance') {
  const emp = employees.find(e => e.id === empId);
  if (!emp) return;
  $('#transaction-employee-id').value = empId;
  $('#transaction-type').value = type;
  $('#transaction-amount').value = '';
  $('#transaction-note').value = '';
  $('#employee-transaction-title').textContent = `${type === 'advance' ? 'سلفة' : type === 'deduction' ? 'خصم' : 'حافز'} — ${emp.name}`;
  const menu = document.querySelector(`[data-employee-actions="${empId}"]`);
  if (menu) menu.classList.remove('open');
  openModal('employee-transaction-modal');
  setTimeout(() => $('#transaction-amount').focus(), 100);
}

function saveEmployeeTransaction() {
  const empId = $('#transaction-employee-id').value;
  const type = $('#transaction-type').value;
  const amount = Number($('#transaction-amount').value || 0);
  if (!empId || !amount || amount < 0) { toast('يرجى إدخال مبلغ صحيح', 'error'); return; }
  const mk = curMonthKey();
  if (!payrollData[mk]) payrollData[mk] = {};
  if (!payrollData[mk][empId]) payrollData[mk][empId] = {};
  const record = payrollData[mk][empId];
  record[type] = Number(record[type] || 0) + amount;
  record.transactions = record.transactions || [];
  record.transactions.push({ type, amount, note: $('#transaction-note').value.trim(), createdAt: new Date().toISOString() });
  saveData(DB_KEYS.PAYROLL, payrollData);
  closeModal('employee-transaction-modal');
  renderEmployees(); renderDashboard();
  if ($('#page-payroll').classList.contains('active')) renderPayroll();
  if ($('#page-reports').classList.contains('active')) renderReports();
  toast(`تمت إضافة ${type === 'advance' ? 'السلفة' : type === 'deduction' ? 'الخصم' : 'الحافز'} ✅`);
}

function openEmployeeModal(id = null) {
  const emp = id ? employees.find(e => e.id === id) : null;
  $('#employee-modal-title').textContent = emp ? 'تعديل بيانات الموظف' : 'إضافة موظف جديد';
  $('#emp-id').value = emp?.id || '';
  $('#emp-name').value = emp?.name || '';
  $('#emp-title').value = emp?.title || '';
  $('#emp-phone').value = emp?.phone || '';
  $('#emp-hire-date').value = emp?.hireDate || new Date().toISOString().slice(0, 10);
  $('#emp-salary').value = emp?.salary ?? '';
  $('#emp-piece-price').value = emp?.piecePrice ?? '';
  $('#emp-tax-rate').value = emp?.taxRate ?? 0;
  $('#emp-advance').value = emp?.advance ?? 0;
  $('#emp-deduction').value = emp?.deduction ?? 0;
  $('#emp-bonus').value = emp?.bonus ?? 0;
  $('#emp-allowance').value = emp?.allowance ?? 0;
  $('#emp-notes').value = emp?.notes || '';
  const type = emp?.type || 'monthly';
  $$('input[name="emp-type"]').forEach(r => r.checked = r.value === type);
  toggleEmpType();
  updateNetPreview();
  openModal('employee-modal');
  setTimeout(() => $('#emp-name').focus(), 100);
}

function toggleEmpType() {
  const type = document.querySelector('input[name="emp-type"]:checked').value;
  $('#group-monthly-salary').style.display = type === 'monthly' ? '' : 'none';
  $('#group-piece-price').style.display    = '';
  $('#piece-price-label').textContent = type === 'piece' ? 'سعر القطعة *' : 'سعر القطعة الإضافية';
  updateNetPreview();
}

function updateNetPreview() {
  const type = document.querySelector('input[name="emp-type"]:checked').value;
  const emp = {
    type,
    salary: Number($('#emp-salary').value || 0),
    piecePrice: Number($('#emp-piece-price').value || 0),
    taxRate: Number($('#emp-tax-rate').value || 0),
    bonus: Number($('#emp-bonus').value || 0),
    allowance: Number($('#emp-allowance').value || 0),
    advance: Number($('#emp-advance').value || 0),
    deduction: Number($('#emp-deduction').value || 0),
  };
  const c = calcEmployeeNet(emp);
  $('#emp-net-preview').textContent = type === 'piece'
    ? `صافي المستحق (بدون احتساب القطع): ${fmt(c.net)} — سيُضاف (القطع × ${fmt(emp.piecePrice)})`
    : `صافي الراتب المتوقع: ${fmt(c.net)}`;
}

['emp-salary','emp-piece-price','emp-tax-rate','emp-bonus','emp-allowance','emp-advance','emp-deduction'].forEach(id => {
  document.addEventListener('input', e => { if (e.target.id === id) updateNetPreview(); });
});

function saveEmployee() {
  const id = $('#emp-id').value || 'emp_' + Date.now();
  const type = document.querySelector('input[name="emp-type"]:checked').value;
  const name = $('#emp-name').value.trim();
  const title = $('#emp-title').value.trim();
  if (!name || !title) { toast('يرجى إدخال الاسم والمسمى الوظيفي', 'error'); return; }

  const emp = {
    id, name, title, type,
    phone: $('#emp-phone').value.trim(),
    hireDate: $('#emp-hire-date').value,
    salary: type === 'monthly' ? Number($('#emp-salary').value || 0) : 0,
    piecePrice: Number($('#emp-piece-price').value || 0),
    taxRate: Math.min(100, Math.max(0, Number($('#emp-tax-rate').value || 0))),
    advance: Number($('#emp-advance').value || 0),
    deduction: Number($('#emp-deduction').value || 0),
    bonus: Number($('#emp-bonus').value || 0),
    allowance: Number($('#emp-allowance').value || 0),
    notes: $('#emp-notes').value.trim(),
    updatedAt: new Date().toISOString()
  };
  if (type === 'monthly' && !emp.salary) { toast('يرجى إدخال الراتب الشهري', 'error'); return; }
  if (type === 'piece' && !emp.piecePrice) { toast('يرجى إدخال سعر القطعة', 'error'); return; }

  const idx = employees.findIndex(e => e.id === id);
  if (idx >= 0) employees[idx] = emp; else employees.push(emp);
  saveData(DB_KEYS.EMPLOYEES, employees);
  closeModal('employee-modal');
  renderEmployees(); renderDashboard();
  toast(idx >= 0 ? 'تم تحديث بيانات الموظف ✅' : 'تمت إضافة الموظف بنجاح ✅');
}

function editEmployee(id) { openEmployeeModal(id); }

function deleteEmployee(id) {
  const emp = employees.find(e => e.id === id);
  showConfirm(`هل أنت متأكد من حذف الموظف "${emp?.name}"؟ لا يمكن التراجع عن هذا الإجراء.`, () => {
    employees = employees.filter(e => e.id !== id);
    saveData(DB_KEYS.EMPLOYEES, employees);
    renderEmployees(); renderDashboard();
    toast('تم حذف الموظف', 'warning');
  });
}

// ============ مسير الرواتب ============
function fillMonthYearSelectors() {
  const now = new Date();
  const years = [];
  for (let y = now.getFullYear() - 3; y <= now.getFullYear() + 1; y++) years.push(y);
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  ['payroll','expense','report'].forEach(p => {
    const ms = $(`#${p}-month`), ys = $(`#${p}-year`);
    if (!ms) return;
    ms.innerHTML = months.map((m, i) => `<option value="${i+1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('');
    ys.innerHTML = years.map(y => `<option value="${y}" ${y === now.getFullYear() ? 'selected' : ''}>${y}</option>`).join('');
  });
}

function getSelectedMonth(prefix) {
  return monthKey(Number($(`#${prefix}-year`).value), Number($(`#${prefix}-month`).value));
}

function renderPayroll() {
  const mk = getSelectedMonth('payroll');
  if (!payrollData[mk]) payrollData[mk] = {};
  const md = payrollData[mk];

  let totBase = 0, totGross = 0, totPieces = 0, totPieceVal = 0, totBonus = 0, totAllow = 0, totAdv = 0, totDed = 0, totTax = 0, totNet = 0;

  $('#payroll-body').innerHTML = employees.length ? employees.map((e, i) => {
    const d = md[e.id] || {};
    const c = calcEmployeeNet(e, d);
    totBase += c.base; totGross += c.gross; totPieces += c.pieces; totPieceVal += c.pieceTotal;
    totBonus += c.bonus; totAllow += c.allowance; totAdv += c.advance; totDed += c.deduction; totTax += c.tax; totNet += c.net;

    const pieceField = e.type === 'piece' ? 'pieces' : 'extraPieces';
    const pieceCell = `<td><input type="number" min="0" class="form-input payroll-input" value="${d[pieceField] ?? ''}" placeholder="0" onchange="updatePayrollField('${e.id}','${pieceField}',this.value)"></td>
         <td class="amount">${fmt(e.piecePrice)}</td>
         <td class="amount">${fmt(c.pieceTotal)}</td>`;

    return `<tr>
      <td>${i + 1}</td>
      <td><strong>${esc(e.name)}</strong></td>
      <td><span class="badge badge-${e.type}">${e.type === 'piece' ? 'قطعة' : 'شهري'}</span></td>
      <td class="amount">${e.type === 'monthly' ? fmt(e.salary) : '—'}</td>
      ${pieceCell}
      <td class="amount">${fmt(c.gross)}</td>
      <td class="amount">${c.taxRate}%</td>
      <td class="amount amount-negative">${fmt(c.tax)}</td>
      <td><input type="number" min="0" class="form-input payroll-input" value="${d.bonus ?? e.bonus ?? 0}" onchange="updatePayrollField('${e.id}','bonus',this.value)"></td>
      <td><input type="number" min="0" class="form-input payroll-input" value="${d.allowance ?? e.allowance ?? 0}" onchange="updatePayrollField('${e.id}','allowance',this.value)"></td>
      <td><input type="number" min="0" class="form-input payroll-input" value="${d.advance ?? e.advance ?? 0}" onchange="updatePayrollField('${e.id}','advance',this.value)"></td>
      <td><input type="number" min="0" class="form-input payroll-input" value="${d.deduction ?? e.deduction ?? 0}" onchange="updatePayrollField('${e.id}','deduction',this.value)"></td>
      <td class="amount" style="color:var(--primary);font-weight:700">${fmt(c.net)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="15" style="text-align:center;color:#999;padding:2rem">لا يوجد موظفون — أضف موظفين أولاً</td></tr>';

  $('#payroll-footer').innerHTML = employees.length ? `<tr>
    <td colspan="3">الإجمالي</td>
    <td class="amount">${fmt(totBase)}</td>
    <td>${totPieces}</td><td></td>
    <td class="amount">${fmt(totPieceVal)}</td>
    <td class="amount">${fmt(totGross)}</td><td></td><td class="amount">${fmt(totTax)}</td>
    <td class="amount">${fmt(totBonus)}</td>
    <td class="amount">${fmt(totAllow)}</td>
    <td class="amount">${fmt(totAdv)}</td>
    <td class="amount">${fmt(totDed)}</td>
    <td class="amount">${fmt(totNet)}</td>
  </tr>` : '';

  $('#payroll-summary').innerHTML = `
    <div class="payroll-summary-item"><div class="val">${employees.length}</div><div class="lbl">عدد الموظفين</div></div>
    <div class="payroll-summary-item"><div class="val">${fmt(totBonus + totAllow)}</div><div class="lbl">إجمالي الحوافز والبدلات</div></div>
    <div class="payroll-summary-item"><div class="val">${fmt(totAdv + totDed)}</div><div class="lbl">إجمالي السلف والخصومات</div></div>
    <div class="payroll-summary-item"><div class="val" style="color:var(--success)">${fmt(totNet)}</div><div class="lbl">صافي المستحقات</div></div>`;
}

function updatePayrollField(empId, field, value) {
  const mk = getSelectedMonth('payroll');
  if (!payrollData[mk]) payrollData[mk] = {};
  if (!payrollData[mk][empId]) payrollData[mk][empId] = {};
  payrollData[mk][empId][field] = Number(value || 0);
  saveData(DB_KEYS.PAYROLL, payrollData);
  renderPayroll();
  toast('تم حفظ التعديل ✅');
}

function printPayroll() {
  const mk = getSelectedMonth('payroll');
  const [y, m] = mk.split('-');
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const oldTitle = document.title;
  document.title = `مسير رواتب ${months[Number(m)-1]} ${y} - ${settings.companyName}`;
  window.print();
  document.title = oldTitle;
}

// ============ النفقات ============
function renderExpenses() {
  const mk = getSelectedMonth('expense');
  const list = expenses.filter(x => x.date?.startsWith(mk)).sort((a, b) => b.date.localeCompare(a.date));
  const total = list.reduce((s, x) => s + Number(x.amount || 0), 0);
  const cats = new Set(list.map(x => x.category));

  $('#expense-total').textContent = fmt(total);
  $('#expense-count').textContent = list.length;
  $('#expense-categories').textContent = cats.size;

  $('#expenses-table').innerHTML = list.length ? list.map(x => `
    <tr>
      <td>${esc(x.date)}</td>
      <td><span class="badge badge-monthly">${esc(x.category)}</span></td>
      <td>${esc(x.description)}</td>
      <td class="amount amount-negative">${fmt(x.amount)}</td>
      <td>${esc(x.notes || '—')}</td>
      <td>
        <button class="btn btn-sm btn-info btn-icon" onclick="editExpense('${x.id}')">✏️</button>
        <button class="btn btn-sm btn-danger btn-icon" onclick="deleteExpense('${x.id}')">🗑️</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:#999;padding:2rem">لا توجد نفقات مسجلة هذا الشهر</td></tr>';
}

function openExpenseModal(id = null) {
  const ex = id ? expenses.find(x => x.id === id) : null;
  $('#expense-modal-title').textContent = ex ? 'تعديل نفقة' : 'إضافة نفقة تشغيلية';
  $('#exp-id').value = ex?.id || '';
  $('#exp-date').value = ex?.date || new Date().toISOString().slice(0, 10);
  $('#exp-category').value = ex?.category || 'أخرى';
  $('#exp-description').value = ex?.description || '';
  $('#exp-amount').value = ex?.amount ?? '';
  $('#exp-notes').value = ex?.notes || '';
  openModal('expense-modal');
}

function saveExpense() {
  const id = $('#exp-id').value || 'exp_' + Date.now();
  const date = $('#exp-date').value;
  const description = $('#exp-description').value.trim();
  const amount = Number($('#exp-amount').value || 0);
  if (!date || !description || !amount) { toast('يرجى ملء جميع الحقول المطلوبة', 'error'); return; }

  const ex = {
    id, date,
    category: $('#exp-category').value,
    description, amount,
    notes: $('#exp-notes').value.trim()
  };
  const idx = expenses.findIndex(x => x.id === id);
  if (idx >= 0) expenses[idx] = ex; else expenses.push(ex);
  saveData(DB_KEYS.EXPENSES, expenses);
  closeModal('expense-modal');
  renderExpenses(); renderDashboard();
  toast(idx >= 0 ? 'تم تحديث النفقة ✅' : 'تمت إضافة النفقة ✅');
}

function editExpense(id) { openExpenseModal(id); }

function deleteExpense(id) {
  showConfirm('هل أنت متأكد من حذف هذه النفقة؟', () => {
    expenses = expenses.filter(x => x.id !== id);
    saveData(DB_KEYS.EXPENSES, expenses);
    renderExpenses(); renderDashboard();
    toast('تم حذف النفقة', 'warning');
  });
}

// ============ التقارير ============
function renderReports() {
  const mk = getSelectedMonth('report');
  const [y, m] = mk.split('-');
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  $('#report-period').textContent = `عن شهر ${months[Number(m)-1]} من عام ${y} — ${settings.companyName}`;

  const income = Number(settings.monthlyIncome || 0);
  $('#rep-income').textContent = fmt(income);

  const md = payrollData[mk] || {};
  let totBase = 0, totGross = 0, totBonus = 0, totAllow = 0, totTax = 0, totAfterTax = 0, totAdv = 0, totDed = 0, totNet = 0;
  employees.forEach(e => {
    const c = calcEmployeeNet(e, md[e.id]);
    totBase += c.base; totGross += c.gross; totBonus += c.bonus; totAllow += c.allowance; totTax += c.tax; totAfterTax += c.afterTax;
    totAdv += c.advance; totDed += c.deduction; totNet += c.net;
  });

  $('#rep-emp-count').textContent = employees.length;
  $('#rep-base-salaries').textContent = fmt(totBase);
  $('#rep-gross-salaries').textContent = fmt(totGross);
  $('#rep-bonuses').textContent = fmt(totBonus);
  $('#rep-allowances').textContent = fmt(totAllow);
  $('#rep-taxes').textContent = fmt(totTax);
  $('#rep-after-tax-salaries').textContent = fmt(totAfterTax);
  $('#rep-advances').textContent = fmt(totAdv);
  $('#rep-deductions').textContent = fmt(totDed);
  $('#rep-net-salaries').textContent = fmt(totNet);

  const monthExp = expenses.filter(x => x.date?.startsWith(mk));
  const byCat = {};
  monthExp.forEach(x => { byCat[x.category] = (byCat[x.category] || 0) + Number(x.amount || 0); });
  const totalExp = Object.values(byCat).reduce((s, v) => s + v, 0);

  $('#rep-expense-details').innerHTML = Object.keys(byCat).length ? Object.entries(byCat).map(([cat, amt]) =>
    `<div class="expense-detail-row"><span>${esc(cat)}</span><span class="amount">${fmt(amt)}</span></div>`
  ).join('') : '<div class="expense-detail-row"><span>لا توجد نفقات</span><span>—</span></div>';
  $('#rep-total-expenses').textContent = fmt(totalExp);

  const totalOut = totNet + totalExp;
  const netProfit = income - totalOut;
  $('#rep-final-income').textContent = fmt(income);
  $('#rep-final-expenses').textContent = fmt(totalOut);
  $('#rep-final-net').textContent = fmt(netProfit);
  $('.grand-total').classList.toggle('loss', netProfit < 0);
}

function printReport() { window.print(); }

// ============ الإعدادات ============
function loadSettingsForm() {
  $('#set-company-name').value = settings.companyName || '';
  $('#set-tax-number').value = settings.taxNumber || '';
  $('#set-phone').value = settings.phone || '';
  $('#set-address').value = settings.address || '';
  $('#set-currency').value = settings.currency || 'ر.س';
  $('#set-monthly-income').value = settings.monthlyIncome || 0;
  pendingCompanyLogo = null;
  updateCompanyBranding();
}

function previewCompanyLogo(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    pendingCompanyLogo = e.target.result;
    $('#company-logo-preview').src = pendingCompanyLogo;
    $('#company-logo-preview').style.display = '';
  };
  reader.readAsDataURL(file);
}

function removeCompanyLogo() {
  pendingCompanyLogo = '';
  $('#company-logo-preview').src = '';
  $('#company-logo-preview').style.display = 'none';
  $('#set-company-logo').value = '';
}

function updateCompanyBranding() {
  const logo = pendingCompanyLogo !== null ? pendingCompanyLogo : (settings.logo || '');
  ['company-logo-preview', 'report-logo'].forEach(id => {
    const img = $('#' + id);
    if (!img) return;
    img.src = logo;
    img.style.display = logo ? '' : 'none';
  });
  const sidebarLogo = $('#sidebar-logo');
  if (sidebarLogo) sidebarLogo.innerHTML = logo ? `<img class="sidebar-logo-image" src="${esc(logo)}" alt="شعار المؤسسة">` : '💼';
}

function saveSettings() {
  settings = {
    companyName: $('#set-company-name').value.trim() || 'مؤسستي',
    taxNumber: $('#set-tax-number').value.trim(),
    phone: $('#set-phone').value.trim(),
    address: $('#set-address').value.trim(),
    currency: $('#set-currency').value,
    monthlyIncome: Number($('#set-monthly-income').value || 0),
    logo: pendingCompanyLogo !== null ? pendingCompanyLogo : (settings.logo || '')
  };
  saveData(DB_KEYS.SETTINGS, settings);
  pendingCompanyLogo = null;
  updateCompanyBranding();
  renderDashboard();
  toast('تم حفظ الإعدادات ✅');
}

// ============ النوافذ ============
function openModal(id) { $('#' + id).classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeModal(id) { $('#' + id).classList.remove('open'); document.body.style.overflow = ''; }

function showConfirm(msg, cb) {
  $('#confirm-message').textContent = msg;
  confirmCallback = cb;
  openModal('confirm-modal');
}
function executeConfirm() {
  closeModal('confirm-modal');
  if (confirmCallback) { confirmCallback(); confirmCallback = null; }
}

$$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); }));

// ============ النسخ الاحتياطي ============
function exportAllData() {
  const data = { employees, expenses, settings, payrollData, exportedAt: new Date().toISOString(), app: 'EMS v1.0' };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `نسخة_احتياطية_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('تم تصدير النسخة الاحتياطية ✅');
}

function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      if (!d.employees || !d.expenses) throw new Error('ملف غير صالح');
      showConfirm('سيتم استبدال جميع البيانات الحالية بالبيانات المستوردة. هل تريد المتابعة؟', () => {
        employees = d.employees; expenses = d.expenses;
        settings = d.settings || settings; payrollData = d.payrollData || {};
        saveData(DB_KEYS.EMPLOYEES, employees); saveData(DB_KEYS.EXPENSES, expenses);
        saveData(DB_KEYS.SETTINGS, settings); saveData(DB_KEYS.PAYROLL, payrollData);
        renderDashboard();
        toast('تم استيراد البيانات بنجاح ✅');
      });
    } catch { toast('ملف غير صالح — تعذر الاستيراد', 'error'); }
  };
  reader.readAsText(file);
  input.value = '';
}

function clearAllData() {
  showConfirm('⚠️ تحذير: سيتم مسح جميع البيانات نهائياً (الموظفون، النفقات، الإعدادات). هل أنت متأكد؟', () => {
    localStorage.removeItem(DB_KEYS.EMPLOYEES);
    localStorage.removeItem(DB_KEYS.EXPENSES);
    localStorage.removeItem(DB_KEYS.SETTINGS);
    localStorage.removeItem(DB_KEYS.PAYROLL);
    employees = []; expenses = []; payrollData = {};
    settings = { companyName: 'مؤسستي', taxNumber: '', phone: '', address: '', currency: 'ر.س', monthlyIncome: 0, logo: '' };
    pendingCompanyLogo = null;
    updateCompanyBranding();
    renderDashboard();
    toast('تم مسح جميع البيانات', 'warning');
  });
}

// ============ PWA ============
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = $('#install-btn');
  if (btn) btn.style.display = '';
});

function installApp() {
  if (!deferredInstallPrompt) { toast('افتح قائمة المتصفح واختر "إضافة إلى الشاشة الرئيسية"', 'info'); return; }
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(choice => {
    if (choice.outcome === 'accepted') toast('تم تثبيت التطبيق ✅');
    deferredInstallPrompt = null;
    $('#install-btn').style.display = 'none';
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (window.__emsReloadedForUpdate) return;
      window.__emsReloadedForUpdate = true;
      window.location.reload();
    });
  });
}

// ============ التهيئة ============
document.addEventListener('DOMContentLoaded', () => {
  fillMonthYearSelectors();
  updateCompanyBranding();
  const d = new Date();
  const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  $('#header-date').textContent = `${days[d.getDay()]}، ${d.toLocaleDateString('ar-EG')}`;
  renderDashboard();
  setTimeout(() => $('#splash').classList.add('hide'), 1200);
});
