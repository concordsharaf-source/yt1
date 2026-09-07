/* ===== نظام إدارة الموظفين والرواتب ===== */
'use strict';

// ============ إدارة البيانات ============
const DB_KEYS = { EMPLOYEES: 'ems_employees', EXPENSES: 'ems_expenses', REVENUES: 'ems_revenues', SETTINGS: 'ems_settings', PAYROLL: 'ems_payroll' };

function loadData(key, defaultVal = []) {
  try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : defaultVal; }
  catch { return defaultVal; }
}
function saveData(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

let employees = loadData(DB_KEYS.EMPLOYEES);
let expenses  = loadData(DB_KEYS.EXPENSES);
let revenues  = loadData(DB_KEYS.REVENUES);
let settings  = loadData(DB_KEYS.SETTINGS, {
  companyName: 'مؤسستي', taxNumber: '', phone: '', address: '',
  currency: 'ر.س', monthlyIncome: 0, logo: ''
});
let payrollData = loadData(DB_KEYS.PAYROLL, {}); // { "2026-09": { empId: {pieces, bonus, allowance, advance, deduction} } }

let confirmCallback = null;
let deferredInstallPrompt = null;
let pendingCompanyLogo = null;
let hasUnsavedChanges = false;

// ============ أدوات مساعدة ============
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function fmt(n) {
  const cur = settings.currency || 'ر.س';
  // أرقام إنجليزية (غربية/لاتينية) في كل التطبيق
  return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + cur;
}
function monthKey(y, m) { return `${y}-${String(m).padStart(2,'0')}`; }
function curMonthKey() { const d = new Date(); return monthKey(d.getFullYear(), d.getMonth() + 1); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function revenueTotalForMonth(mk) {
  const list = revenues.filter(x => x.date?.startsWith(mk));
  return list.length ? list.reduce((sum, x) => sum + Number(x.amount || 0), 0) : Number(settings.monthlyIncome || 0);
}

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
  const advance   = Number(md.advance ?? 0);
  const installmentCount = Math.min(10, Math.max(0, Number(md.installments ?? 0)));
  const legacyDeduction = Number(md.deduction ?? 0);
  const taxRate   = Math.min(100, Math.max(0, Number(md.taxRate ?? emp.taxRate ?? 0)));
  const taxFrac   = taxRate / 100;
  const keepFrac  = 1 - taxFrac; // الجزء الذي يبقى للموظف بعد الضريبة

  // كل المبالغ المُدخَلة تُعامَل كمبالغ صافية يستلمها الموظف/العامل فعلاً،
  // ثم تُضاف الضريبة فوقها لاحقاً (Gross-up) كتكلفة على المنشأة:
  //   قبل الضريبة = مجموع الصافي ÷ (1 - نسبة الضريبة) ،  الضريبة تُحسب على ذلك.
  let netBase = 0, netExtra = 0, pieces = 0, netPiece = 0;
  // سعر القطعة الفعلي: إن حُدِّد لهذا الشهر في مسير الرواتب يُؤخذ منه،
  // وإلا سعر القطعة الأساسي المسجّل للموظف
  const piecePrice = Number(md.piecePrice ?? emp.piecePrice ?? 0);
  if (emp.type === 'piece') {
    // عامل بالقطعة: سعر القطعة المكتوب = صافي ما يستلمه عن كل قطعة،
    // وقيمة القطع كلها هي أساسه
    pieces   = Number(md.pieces ?? 0);
    netPiece = pieces * piecePrice;
    netBase  = netPiece;
    netExtra = 0;
  } else {
    // موظف شهري: الراتب المكتوب = صافي بعد الضريبة،
    // ويُضاف له أيّ قيمة قطع إضافية صافية
    netBase  = Number(emp.salary || 0);
    pieces   = Number(md.extraPieces ?? 0);
    netExtra = pieces * piecePrice;
    netPiece = netExtra;
  }

  // صافي كل ما يستلمه الموظف/العامل قبل خصم السلف والخصومات
  const netEarnings = netBase + netExtra + bonus + allowance;

  // قبل الضريبة = الصافي مرفوعاً ليشمل الضريبة (تكلفة المنشأة الإجمالية)
  const gross = keepFrac > 0 ? netEarnings / keepFrac : netEarnings;
  const tax   = gross * taxFrac;
  const afterTax = gross - tax; // == netEarnings

  // الخصومات (أقساط الشهري) تُحسب من الصافي المكتوب
  const deduction = emp.type === 'monthly' && installmentCount > 0
    ? (Number(emp.salary || 0) / 30) * installmentCount
    : legacyDeduction;
  const net = afterTax - advance - deduction;

  return {
    base: netBase, pieces, pieceTotal: netPiece,
    bonus, allowance, advance, deduction, installmentCount, taxRate,
    gross, tax, afterTax, net
  };
}

// ============ التنقل ============
const pageTitles = {
  dashboard: 'لوحة التحكم', employees: 'الموظفون', payroll: 'مسير الرواتب',
  expenses: 'النفقات التشغيلية', revenues: 'بنود الإيرادات', reports: 'التقارير المالية', settings: 'الإعدادات'
};

function showPage(page) {
  // التنقل بين صفحات التطبيق حرّ دون أي نافذة تأكيد
  $$('.page').forEach(p => p.classList.remove('active'));
  $('#page-' + page).classList.add('active');
  $$('.sidebar-menu a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $('#page-title').textContent = pageTitles[page] || '';
  closeSidebar();
  if (page === 'dashboard') renderDashboard();
  if (page === 'employees') renderEmployees();
  if (page === 'payroll')   renderPayroll();
  if (page === 'expenses')  renderExpenses();
  if (page === 'revenues')  renderRevenues();
  if (page === 'reports')   renderReports();
  if (page === 'settings')  loadSettingsForm();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============ حارس الخروج (زر الرجوع في المتصفح / الجوال) ============
// يعمل بطريقة "المصيدة": نضيف خطوة في سجل المتصفح، فإذا ضغط المستخدم زر الرجوع
// نُعيد إضافة خطوة مكانها فلا يغادر التطبيق، ونعرض رسالة من داخل التطبيق بنفس
// تصميمه (وليست نافذة المتصفح المنبثقة) تسأله هل يريد الخروج فعلًا.
let exitGuardActive = false;   // هل الحارس مفعّل الآن
let allowLeave      = false;   // صار true بعد ضغط "الخروج" للسماح بالرجوع الحقيقي
let exitDialogOpen  = false;   // هل رسالة الخروج ظاهرة حاليًا

function installExitGuard() {
  if (exitGuardActive || !window.history || !('pushState' in history)) return;
  exitGuardActive = true;
  // نعلّم صفحة التطبيق الحالية كـ "أرضية" التطبيق
  try { history.replaceState({ ems: 'app-root' }, '', location.href); } catch (err) {}
  // ثم نضيف خطوة وهمية فوقها: زر الرجوع سيبقى داخل التطبيق ولن يغادر قبل التأكيد
  try { history.pushState({ ems: 'exit-guard' }, '', location.href); } catch (err) {}
  window.addEventListener('popstate', onBackPressed);
}

// عند الضغط على زر الرجوع (أو إيماءة السحب للخلف في الجوال)
function onBackPressed(e) {
  if (allowLeave) {
    // المستخدم وافق على الخروج → نتخطى خطواتنا الوهمية ونغادر فعلاً
    const st = (e && e.state) || {};
    if (st.ems === 'exit-guard' || st.ems === 'app-root') {
      try { history.back(); } catch (err) { try { history.go(-1); } catch (_) {} }
    }
    return; // أي خطوة خارج خطواتنا: نترك المتصفح يكمل مغادرة التطبيق
  }
  // نستعيد الخطوة الوهمية حتى لا نغادر التطبيق قبل التأكيد
  try { history.pushState({ ems: 'exit-guard' }, '', location.href); } catch (err) {}

  // إذا كانت نافذة تعديل/إدخال مفتوحة: زر الرجوع يغلقها أولًا (سلوك طبيعي)
  const editingModal = [...$$('.modal.open')].find(m => m.id !== 'exit-modal');
  if (editingModal) { closeModal(editingModal.id); return; }

  // وإلا: اعرض رسالة الخروج من داخل التطبيق
  showExitDialog();
}

// إظهار رسالة الخروج (نافذة داخلية بتصميم التطبيق)
function showExitDialog() {
  if (exitDialogOpen) return;
  exitDialogOpen = true;
  openModal('exit-modal');
}

// المستخدم اختار البقاء → نغلق الرسالة ونبقى في التطبيق
function cancelExit() {
  exitDialogOpen = false;
  closeModal('exit-modal');
}

// المستخدم أكّد رغبته في الخروج → نسمح له بالرجوع فعلًا
function confirmExit() {
  exitDialogOpen = false;
  closeModal('exit-modal');
  allowLeave = true;
  // نبدأ الرجوع؛ ومُعامِل popstate (onBackPressed) يتخطى خطواتنا الوهمية
  // ويكمل حتى مغادرة التطبيق إلى الصفحة التي كانت قبله.
  try { history.back(); } catch (err) { window.location.href = document.referrer || 'about:blank'; }
}

// حماية خفيفة عند التحديث/الإغلاق مع وجود تعديلات غير محفوظة فقط
// (تُلغى تلقائيًا عند الموافقة على الخروج حتى لا تظهر نافذة المتصفح مرتين)
window.addEventListener('beforeunload', e => {
  if (allowLeave || !hasUnsavedChanges) return;
  e.preventDefault();
  e.returnValue = '';
});

document.addEventListener('input', e => {
  if (e.target.closest('.modal') || e.target.closest('#page-settings')) hasUnsavedChanges = true;
});
document.addEventListener('change', e => {
  if (e.target.closest('.modal') || e.target.closest('#page-settings')) hasUnsavedChanges = true;
});

// عند وضع المؤشر على أي خانة رقمية ثم الكتابة: يُستبدل الرقم القديم مباشرةً
// (لأن حقول type=number لا تدعم تحديد النص، فنجعل أول ضغطة تمحو القيمة القديمة)
let numericFreshField = null; // الحقل الرقمي الذي نُقِل إليه التركوز للتو

document.addEventListener('focusin', e => {
  const t = e.target;
  if (!t || t.tagName !== 'INPUT') return;
  if (t.type === 'number') { numericFreshField = t; return; }
  // حقول المبالغ النصية: عند التركيز يتم تحديد القيمة كاملة لسهولة استبدالها
  if (t.classList && t.classList.contains('money-input')) {
    // تحديد القيمة كاملة فوراً عند التركيز حتى تُستبدل بأول حرف يُكتب
    try { t.select(); } catch (err) {}
  }
});

document.addEventListener('keydown', e => {
  const t = e.target;
  if (!t || t !== numericFreshField) return;
  if (t.tagName !== 'INPUT' || t.type !== 'number') { numericFreshField = null; return; }
  // مفاتيح التنقل والتعديل لا تُفرّغ بل تُدخل على الوضع العادي
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
      e.key === 'Tab' || e.key === 'Enter' || e.key === 'Home' || e.key === 'End') {
    numericFreshField = null;
    return;
  }
  // أول إدخال رقمي/علامة يمحو القيمة القديمة ثم يُدخل الحرف
  if (e.key.length === 1 && /^[0-9.\-]$/.test(e.key)) {
    e.preventDefault();
    t.value = e.key;
    numericFreshField = null;
  }
});

document.addEventListener('mouseup', e => {
  // نقر إضافي داخل الحقل لإلغاء "الإفراغ" والسماح بالتعديل الدقيق
  const t = e.target;
  if (t && numericFreshField && t !== numericFreshField) numericFreshField = null;
});

// ====== حقول المبالغ: فاصل آلاف تلقائي (فاصلة ,) كل 3 أرقام مع كسور عشرية ======
// تُخزَّن في حقول نصية (money-input) تعرض فاصلة الآلاف أثناء الكتابة.
// عند القراءة نستخدم toNum() لتجريد القيمة من الفواصل.

// تحويل أي قيمة إلى رقم (بتجاهل فواصل الآلاف)
function toNum(v) {
  if (v == null) return 0;
  const s = String(v).replace(/,/g, '').trim();
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

// تنسيق نص حقل مبلغ: مجموعة آلاف بفاصلة + نقطة عشرية واحدة
function fmtMoneyInputText(s) {
  if (s == null) return '';
  s = String(s);
  const dotIdx = s.indexOf('.');
  let intPart, frac = '', hadDot = false;
  if (dotIdx >= 0) { hadDot = true; intPart = s.slice(0, dotIdx); frac = s.slice(dotIdx + 1).replace(/[^0-9]/g, ''); }
  else { intPart = s; }
  intPart = intPart.replace(/[^0-9]/g, '');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return hadDot ? grouped + '.' + frac : grouped;
}

// تنسيق قيم حقول المبالغ الموجودة داخل نطاق معيّن (scope)
function formatMoneyScope(scope) {
  (scope || document).querySelectorAll('.money-input').forEach(el => {
    const f = fmtMoneyInputText(el.value);
    if (el.value !== f) el.value = f;
  });
}

// أثناء الكتابة: ننسّق فاصلة الآلاف فورياً
document.addEventListener('input', e => {
  const el = e.target;
  if (!el || !(el.classList && el.classList.contains('money-input'))) return;
  const f = fmtMoneyInputText(el.value);
  if (el.value !== f) el.value = f;
});

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

  const income = revenueTotalForMonth(mk);
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
// حالة الفرز في قائمة الموظفين: الحقل (name|salary|hire) والاتجاه (1 تصاعدي | -1 تنازلي)
let empSortField = 'name';
let empSortDir   = 1;

function empSortValue(e) {
  if (empSortField === 'name') return { v: e.name || '', missing: false };
  if (empSortField === 'salary') return { v: Number(e.type === 'monthly' ? e.salary : e.piecePrice || 0) || 0, missing: false };
  // hire (تاريخ التعيين)
  return { v: e.hireDate || '', missing: !e.hireDate };
}

function getSortedEmployees(list) {
  const f = empSortField, dir = empSortDir;
  return [...list].sort((a, b) => {
    const A = empSortValue(a), B = empSortValue(b);
    // مَن بلا تاريخ تعيين يأتي دائماً آخر
    if (f === 'hire' && (A.missing || B.missing)) {
      if (A.missing && B.missing) return 0;
      return A.missing ? 1 : -1;
    }
    let r;
    if (f === 'name') {
      r = String(A.v).localeCompare(String(B.v), 'ar');
    } else {
      r = (A.v < B.v) ? -1 : (A.v > B.v ? 1 : 0);
    }
    return r * dir;
  });
}

function applyEmpSortUI() {
  const names = { name: 'الاسم', salary: 'الراتب', hire: 'تاريخ التعيين' };
  $$('#employee-sort-toolbar .sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === empSortField));
  $('#emp-sort-dir').textContent = empSortDir === 1 ? '↑ تصاعدي' : '↓ تنازلي';
}

function toggleEmpSort(field) {
  if (empSortField === field) empSortDir *= -1;
  else { empSortField = field; empSortDir = 1; }
  applyEmpSortUI();
  renderEmployees();
}
function toggleEmpSortDir() { empSortDir *= -1; applyEmpSortUI(); renderEmployees(); }

function renderEmployees() {
  const q = ($('#employee-search').value || '').trim();
  const filtered = employees.filter(e => !q || e.name.includes(q) || e.title.includes(q));
  const list = getSortedEmployees(filtered);
  applyEmpSortUI();
  $('#employees-table').innerHTML = list.length ? list.map(e => {
    const c = calcEmployeeNet(e, payrollData[curMonthKey()]?.[e.id]);
    return `<tr>
      <td>
        <div class="employee-name-wrap">
          <button class="employee-name-button" onclick="toggleEmployeeActions('${e.id}')" title="إضافة حركة مالية"><strong>${esc(e.name)}</strong><span>⌄</span></button>
          <div class="employee-actions-menu" data-employee-actions="${e.id}">
            <button onclick="openEmployeeDetails('${e.id}')">📋 التفاصيل</button>
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

// اختيار جهة اتصال من الهاتف وملء رقم الهاتف في نموذج الموظف
function pickPhoneContact() {
  try {
    if (!navigator.contacts || !navigator.contacts.select) {
      toast('اختيار جهات الاتصال غير مدعوم في هذا المتصفح — أدخل الرقم يدوياً', 'warning');
      return;
    }
    const want = ['tel'];
    if (navigator.contacts.properties && navigator.contacts.properties.includes('name')) want.push('name');
    navigator.contacts.select(want, { multiple: false }).then(contacts => {
      if (!contacts || !contacts.length) return;
      const c = contacts[0];
      if (c.telephoneNumbers && c.telephoneNumbers[0]) {
        $('#emp-phone').value = c.telephoneNumbers[0];
      }
      if (c.name && !$('#emp-name').value.trim()) $('#emp-name').value = c.name;
      toast('تم جلب بيانات جهة الاتصال ✅');
    }).catch(err => {
      // المستخدم ألغى الاختيار → لا رسالة
      if (err && err.name === 'NotFoundError') return;
      toast('تعذّر الوصول لجهات الاتصال', 'error');
    });
  } catch (e) {
    toast('اختيار جهات الاتصال غير متاح في هذا المتصفح', 'warning');
  }
}

let detailsEmpId = null; // الموظف الذي تُعرض تفاصيله حالياً

// صف معلومة داخل نافذة التفاصيل
function detailRow(label, value, highlight = false) {
  return `<div class="detail-row${highlight ? ' detail-row-total' : ''}"><span class="detail-label">${esc(label)}</span><span class="detail-value">${value ?? '—'}</span></div>`;
}

// عرض جميع تفاصيل الموظف
function openEmployeeDetails(empId) {
  const emp = employees.find(e => e.id === empId);
  if (!emp) return;
  detailsEmpId = empId;
  const mk = curMonthKey();
  const c = calcEmployeeNet(emp, payrollData[mk]?.[empId]);
  const typeName = emp.type === 'piece' ? '🔢 بالقطعة' : '📅 شهري';

  // حركات الشهر المسجلة (سلفة/خصم/حافز)
  const txList = (payrollData[mk]?.[empId]?.transactions) || [];
  const txHtml = txList.length ? txList.slice(-8).reverse().map(tx => {
    const lbl = tx.type === 'advance' ? 'سلفة' : tx.type === 'deduction' ? 'خصم' : 'حافز';
    return `<div class="detail-row"><span class="detail-label">${lbl} ${tx.note ? '(' + esc(tx.note) + ')' : ''}</span><span class="detail-value">${fmt(tx.amount)}</span></div>`;
  }).join('') : '<div class="detail-row"><span class="detail-label" style="color:#999">لا توجد حركات لهذا الشهر</span></div>';

  const baseVal = emp.type === 'piece'
    ? `${fmt(emp.piecePrice)} / قطعة`
    : fmt(emp.salary);

  $('#employee-details-title').textContent = `تفاصيل: ${emp.name}`;
  $('#employee-details-content').innerHTML = `
    <div class="details-section">${typeName}</div>

    <div class="detail-group">
      ${detailRow('المسمى الوظيفي', esc(emp.title || '—'))}
      ${detailRow('رقم الهاتف', esc(emp.phone || '—'))}
      ${detailRow('تاريخ التعيين', esc(emp.hireDate || '—'))}
      ${detailRow('نسبة الضريبة', (c.taxRate || 0) + '%')}
      ${emp.type === 'piece'
        ? detailRow('سعر القطعة', fmt(emp.piecePrice))
        : detailRow('الراتب الشهري (صافي)', fmt(emp.salary))}
      ${detailRow('نوع الحساب', typeName)}
      ${detailRow('ملاحظات', emp.notes ? esc(emp.notes) : '—')}
    </div>

    <div class="details-section">حساب الشهر الحالي</div>
    <div class="detail-group">
      ${detailRow('أساس الاستحقاق', baseVal)}
      ${detailRow('عدد القطع/الإضافية', c.pieces || 0)}
      ${detailRow('إجمالي القطع', fmt(c.pieceTotal))}
      ${detailRow('قبل الضريبة (الإجمالي)', fmt(c.gross))}
      ${detailRow('الحوافز', fmt(c.bonus))}
      ${detailRow('البدلات', fmt(c.allowance))}
      ${detailRow('الضريبة', fmt(c.tax))}
      ${detailRow('السلف', fmt(c.advance))}
      ${detailRow('الخصومات/الأقساط', fmt(c.deduction))}
      ${detailRow('صافي المستحق', fmt(c.net), true)}
    </div>

    <div class="details-section">حركات الشهر</div>
    <div class="detail-group">${txHtml}</div>
  `;
  closeSidebar();
  openModal('employee-details-modal');
}

function editEmployeeFromDetails() {
  closeModal('employee-details-modal');
  if (detailsEmpId) openEmployeeModal(detailsEmpId);
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
  const amount = toNum($('#transaction-amount').value);
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
  hasUnsavedChanges = false;
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
  $('#emp-bonus').value = emp?.bonus ?? 0;
  $('#emp-allowance').value = emp?.allowance ?? 0;
  $('#emp-notes').value = emp?.notes || '';
  const type = emp?.type || 'monthly';
  $$('input[name="emp-type"]').forEach(r => r.checked = r.value === type);
  toggleEmpType();
  formatMoneyScope($('#employee-modal'));
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
    salary: toNum($('#emp-salary').value),
    piecePrice: toNum($('#emp-piece-price').value),
    taxRate: toNum($('#emp-tax-rate').value),
    bonus: toNum($('#emp-bonus').value),
    allowance: toNum($('#emp-allowance').value),
  };
  const c = calcEmployeeNet(emp);
  $('#emp-net-preview').textContent = type === 'piece'
    ? `سعر القطعة المكتوب صافٍ للعامل (يستلم القطع × السعر). يُضاف فوقه الضريبة: قبل الضريبة ${fmt(c.gross)} — صافي ما يستلمه ${fmt(c.net)}`
    : `الراتب المكتوب صافٍ بعد الضريبة. قبل الضريبة: ${fmt(c.gross)} — ما يستلمه الموظف: ${fmt(c.net)}`;
}

['emp-salary','emp-piece-price','emp-tax-rate','emp-bonus','emp-allowance'].forEach(id => {
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
    salary: type === 'monthly' ? toNum($('#emp-salary').value) : 0,
    piecePrice: toNum($('#emp-piece-price').value),
    taxRate: Math.min(100, Math.max(0, toNum($('#emp-tax-rate').value))),
    bonus: toNum($('#emp-bonus').value),
    allowance: toNum($('#emp-allowance').value),
    notes: $('#emp-notes').value.trim(),
    updatedAt: new Date().toISOString()
  };
  if (type === 'monthly' && !emp.salary) { toast('يرجى إدخال الراتب الشهري', 'error'); return; }
  if (type === 'piece' && !emp.piecePrice) { toast('يرجى إدخال سعر القطعة', 'error'); return; }

  const idx = employees.findIndex(e => e.id === id);
  if (idx >= 0) employees[idx] = emp; else employees.push(emp);
  saveData(DB_KEYS.EMPLOYEES, employees);
  closeModal('employee-modal');
  hasUnsavedChanges = false;
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
  ['payroll','expense','revenue','report'].forEach(p => {
    const ms = $(`#${p}-month`), ys = $(`#${p}-year`);
    if (!ms || !ys) return;
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
    // سعر القطعة قابل للكتابة في المسير، ويُحفظ خاصاً بالشهر (لا يغيّر الأساسي)
    const monthPiecePrice = (d.piecePrice != null) ? d.piecePrice : e.piecePrice;
    const pieceCell = `<td><input type="number" min="0" class="form-input payroll-input" value="${d[pieceField] ?? ''}" placeholder="0" onchange="updatePayrollField('${e.id}','${pieceField}',this.value)"></td>
         <td><input type="text" inputmode="decimal" class="form-input payroll-input money-input" value="${monthPiecePrice != null ? monthPiecePrice : ''}" placeholder="0" onchange="updatePayrollField('${e.id}','piecePrice',this.value)"></td>
         <td class="amount cell-piecetotal">${fmt(c.pieceTotal)}</td>`;
    const deductionCell = e.type === 'monthly'
      ? `<select class="form-select payroll-input" onchange="updatePayrollField('${e.id}','installments',this.value)">${[0,1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${(d.installments ?? e.installments ?? 0) == n ? 'selected' : ''}>${n === 0 ? 'بدون قسط' : n + ' قسط'}</option>`).join('')}</select>`
      : `<input type="text" inputmode="decimal" class="form-input payroll-input money-input" value="${d.deduction ?? 0}" onchange="updatePayrollField('${e.id}','deduction',this.value)">`;

    return `<tr data-emp="${e.id}">
      <td>${i + 1}</td>
      <td><strong>${esc(e.name)}</strong></td>
      <td><span class="badge badge-${e.type}">${e.type === 'piece' ? 'قطعة' : 'شهري'}</span></td>
      <td class="amount">${e.type === 'monthly' ? fmt(e.salary) : '—'}</td>
      ${pieceCell}
      <td class="amount cell-gross">${fmt(c.gross)}</td>
      <td class="amount">${c.taxRate}%</td>
      <td class="amount amount-negative cell-tax">${fmt(c.tax)}</td>
      <td><input type="text" inputmode="decimal" class="form-input payroll-input money-input" value="${d.bonus ?? e.bonus ?? 0}" onchange="updatePayrollField('${e.id}','bonus',this.value)"></td>
      <td><input type="text" inputmode="decimal" class="form-input payroll-input money-input" value="${d.allowance ?? e.allowance ?? 0}" onchange="updatePayrollField('${e.id}','allowance',this.value)"></td>
      <td><input type="text" inputmode="decimal" class="form-input payroll-input money-input" value="${d.advance ?? 0}" onchange="updatePayrollField('${e.id}','advance',this.value)"></td>
      <td>${deductionCell}</td>
      <td class="amount cell-net" style="color:var(--primary);font-weight:700">${fmt(c.net)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="15" style="text-align:center;color:#999;padding:2rem">لا يوجد موظفون — أضف موظفين أولاً</td></tr>';

  formatMoneyScope($('#payroll-body'));
  refreshPayrollNumbers();
}

function updatePayrollField(empId, field, value) {
  const mk = getSelectedMonth('payroll');
  if (!payrollData[mk]) payrollData[mk] = {};
  if (!payrollData[mk][empId]) payrollData[mk][empId] = {};
  const rec = payrollData[mk][empId];
  if (field === 'piecePrice') {
    // ترك الحقل فارغاً = استخدام سعر القطعة الأساسي للموظف
    if (String(value).trim() === '') delete rec.piecePrice;
    else rec.piecePrice = toNum(value);
  } else {
    rec[field] = toNum(value);
  }
  saveData(DB_KEYS.PAYROLL, payrollData);
  // نُحدِّث خلايا الحساب والإجماليات فقط دون إعادة بناء الجدول كاملاً،
  // حتى لا يفقد المستخدم التركيز أو تُمسح مدخلات الحقول المجاورة.
  refreshPayrollNumbers();
  toast('تم حفظ التعديل ✅');
}

// إعادة حساب وتحديث الأرقام الظاهرة في مسير الرواتب (خلايا الصف + صف الإجمالي + الملخص)
// دون إعادة بناء حقول الإدخال نفسها.
function refreshPayrollNumbers() {
  const mk = getSelectedMonth('payroll');
  const md = payrollData[mk] || {};
  let totBase = 0, totGross = 0, totPieces = 0, totPieceVal = 0, totBonus = 0, totAllow = 0, totAdv = 0, totDed = 0, totTax = 0, totNet = 0;

  employees.forEach(e => {
    const c = calcEmployeeNet(e, md[e.id]);
    totBase += c.base; totGross += c.gross; totPieces += c.pieces; totPieceVal += c.pieceTotal;
    totBonus += c.bonus; totAllow += c.allowance; totAdv += c.advance; totDed += c.deduction; totTax += c.tax; totNet += c.net;

    const tr = document.querySelector(`#payroll-body tr[data-emp="${e.id}"]`);
    if (!tr) return;
    const pt = tr.querySelector('.cell-piecetotal'); if (pt) pt.textContent = fmt(c.pieceTotal);
    const gr = tr.querySelector('.cell-gross');       if (gr) gr.textContent = fmt(c.gross);
    const tx = tr.querySelector('.cell-tax');         if (tx) tx.textContent = fmt(c.tax);
    const nt = tr.querySelector('.cell-net');         if (nt) nt.textContent = fmt(c.net);
  });

  // صف الإجمالي
  $('#payroll-footer').innerHTML = employees.length ? `<tr>
    <td colspan="3">الإجمالي</td>
    <td class="amount">${fmt(totBase)}</td>
    <td class="pay-total-count">${totPieces}</td><td></td>
    <td class="amount">${fmt(totPieceVal)}</td>
    <td class="amount">${fmt(totGross)}</td><td></td><td class="amount">${fmt(totTax)}</td>
    <td class="amount">${fmt(totBonus)}</td>
    <td class="amount">${fmt(totAllow)}</td>
    <td class="amount">${fmt(totAdv)}</td>
    <td class="amount">${fmt(totDed)}</td>
    <td class="amount">${fmt(totNet)}</td>
  </tr>` : '';

  // الملخص
  $('#payroll-summary').innerHTML = `
    <div class="payroll-summary-item"><div class="val">${employees.length}</div><div class="lbl">عدد الموظفين</div></div>
    <div class="payroll-summary-item"><div class="val">${fmt(totBonus + totAllow)}</div><div class="lbl">إجمالي الحوافز والبدلات</div></div>
    <div class="payroll-summary-item"><div class="val">${fmt(totAdv + totDed)}</div><div class="lbl">إجمالي السلف والخصومات</div></div>
    <div class="payroll-summary-item"><div class="val" style="color:var(--success)">${fmt(totNet)}</div><div class="lbl">صافي المستحقات</div></div>`;
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
  formatMoneyScope($('#expense-modal'));
  openModal('expense-modal');
}

function saveExpense() {
  const id = $('#exp-id').value || 'exp_' + Date.now();
  const date = $('#exp-date').value;
  const description = $('#exp-description').value.trim();
  const amount = toNum($('#exp-amount').value);
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
  hasUnsavedChanges = false;
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

// ============ الإيرادات ==========
function renderRevenues() {
  const mk = getSelectedMonth('revenue');
  const list = revenues.filter(x => x.date?.startsWith(mk)).sort((a, b) => b.date.localeCompare(a.date));
  const total = list.reduce((sum, x) => sum + Number(x.amount || 0), 0);
  $('#revenue-total').textContent = fmt(list.length ? total : revenueTotalForMonth(mk));
  $('#revenue-count').textContent = list.length;
  $('#revenue-categories').textContent = new Set(list.map(x => x.category)).size;
  $('#revenues-table').innerHTML = list.length ? list.map(x => `
    <tr><td>${esc(x.date)}</td><td><span class="badge badge-monthly">${esc(x.category)}</span></td>
      <td>${esc(x.description)}</td><td class="amount amount-positive">${fmt(x.amount)}</td>
      <td>${esc(x.notes || '—')}</td><td>
        <button class="btn btn-sm btn-info btn-icon" onclick="editRevenue('${x.id}')">✏️</button>
        <button class="btn btn-sm btn-danger btn-icon" onclick="deleteRevenue('${x.id}')">🗑️</button>
      </td></tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:#999;padding:2rem">لا توجد إيرادات مسجلة هذا الشهر</td></tr>';
}

function openRevenueModal(id = null) {
  const rev = id ? revenues.find(x => x.id === id) : null;
  $('#revenue-modal-title').textContent = rev ? 'تعديل بند إيراد' : 'إضافة بند إيراد';
  $('#rev-id').value = rev?.id || '';
  $('#rev-date').value = rev?.date || new Date().toISOString().slice(0, 10);
  $('#rev-category').value = rev?.category || 'مبيعات';
  $('#rev-description').value = rev?.description || '';
  $('#rev-amount').value = rev?.amount ?? '';
  $('#rev-notes').value = rev?.notes || '';
  formatMoneyScope($('#revenue-modal'));
  openModal('revenue-modal');
}

function saveRevenue() {
  const id = $('#rev-id').value || 'rev_' + Date.now();
  const date = $('#rev-date').value;
  const description = $('#rev-description').value.trim();
  const amount = toNum($('#rev-amount').value);
  if (!date || !description || !amount) { toast('يرجى ملء حقول الإيراد المطلوبة', 'error'); return; }
  const rev = { id, date, category: $('#rev-category').value, description, amount, notes: $('#rev-notes').value.trim() };
  const idx = revenues.findIndex(x => x.id === id);
  if (idx >= 0) revenues[idx] = rev; else revenues.push(rev);
  saveData(DB_KEYS.REVENUES, revenues);
  closeModal('revenue-modal');
  hasUnsavedChanges = false;
  renderRevenues(); renderDashboard();
  if ($('#page-reports').classList.contains('active')) renderReports();
  toast(idx >= 0 ? 'تم تحديث بند الإيراد ✅' : 'تمت إضافة الإيراد ✅');
}

function editRevenue(id) { openRevenueModal(id); }
function deleteRevenue(id) {
  showConfirm('هل أنت متأكد من حذف بند الإيراد؟', () => {
    revenues = revenues.filter(x => x.id !== id);
    saveData(DB_KEYS.REVENUES, revenues);
    renderRevenues(); renderDashboard();
    if ($('#page-reports').classList.contains('active')) renderReports();
    toast('تم حذف بند الإيراد', 'warning');
  });
}

// ============ التقارير ============
function renderReports() {
  const mk = getSelectedMonth('report');
  const [y, m] = mk.split('-');
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  $('#report-period').textContent = `عن شهر ${months[Number(m)-1]} من عام ${y} — ${settings.companyName}`;

  const income = revenueTotalForMonth(mk);
  $('#rep-income').textContent = fmt(income);
  const monthRevenues = revenues.filter(x => x.date?.startsWith(mk));
  $('#rep-revenue-details').innerHTML = monthRevenues.length
    ? monthRevenues.map(x => `<div class="expense-detail-row"><span>${esc(x.description)} — ${esc(x.category)}</span><span class="amount amount-positive">${fmt(x.amount)}</span></div>`).join('')
    : '<div class="expense-detail-row"><span>لا توجد بنود إيرادات مفصلة — يتم استخدام الإيراد التقديري من الإعدادات</span><span>—</span></div>';

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
  formatMoneyScope($('#page-settings'));
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
    monthlyIncome: toNum($('#set-monthly-income').value),
    logo: pendingCompanyLogo !== null ? pendingCompanyLogo : (settings.logo || '')
  };
  saveData(DB_KEYS.SETTINGS, settings);
  hasUnsavedChanges = false;
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

$$('.modal').forEach(m => m.addEventListener('click', e => {
  if (e.target !== m) return;
  if (m.id === 'exit-modal') { cancelExit(); return; } // إغلاق رسالة الخروج = البقاء
  closeModal(m.id);
}));

// ============ النسخ الاحتياطي ============
function exportAllData() {
  const data = { employees, expenses, revenues, settings, payrollData, exportedAt: new Date().toISOString(), app: 'EMS v1.1' };
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
        employees = d.employees; expenses = d.expenses; revenues = d.revenues || [];
        settings = d.settings || settings; payrollData = d.payrollData || {};
        saveData(DB_KEYS.EMPLOYEES, employees); saveData(DB_KEYS.EXPENSES, expenses); saveData(DB_KEYS.REVENUES, revenues);
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
    localStorage.removeItem(DB_KEYS.REVENUES);
    localStorage.removeItem(DB_KEYS.SETTINGS);
    localStorage.removeItem(DB_KEYS.PAYROLL);
    employees = []; expenses = []; revenues = []; payrollData = {};
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
    navigator.serviceWorker.register('sw.js?v=2.8').then(reg => reg.update()).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (window.__emsReloadedForUpdate) return;
      window.__emsReloadedForUpdate = true;
      window.location.reload();
    });
  });
}

// ============ التهيئة ============
document.addEventListener('DOMContentLoaded', () => {
  installExitGuard();
  fillMonthYearSelectors();
  updateCompanyBranding();
  const d = new Date();
  const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const arabicMonths = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  // أرقام إنجليزية (لاتينية) في التاريخ مع أسماء اليوم والشهر بالعربية
  $('#header-date').textContent = `${days[d.getDay()]}، ${d.getDate()} ${arabicMonths[d.getMonth()]} ${d.getFullYear()}`;
  renderDashboard();
  setTimeout(() => $('#splash').classList.add('hide'), 1200);
});
