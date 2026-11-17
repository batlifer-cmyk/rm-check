/* RM Check — mobile attendance app
 * Static front end for the token JSON API (Google Apps Script web app).
 * The token never leaves the URL hash: it is not sent as a header, stored in
 * the page HTML, or written to the GitHub repository.
 */
'use strict';

var API = 'https://script.google.com/macros/s/AKfycbzTqqanJzTeEzMI506hD90hznJw5h54wjeUgBNzqZODvex7zuoyHcoke5hFgSBgIvaI2A/exec';
var APP_VERSION = '1.0';

var STATUS_LABEL = {
  ATTENDED: '출석',
  NORMAL_CANCEL: '정상취소',
  SAME_DAY_CANCEL: '당일취소',
  NO_SHOW: '무단결석',
  TEACHER_SAME_DAY_CANCEL: '강사 당일취소',
  TEACHER_NORMAL_CANCEL: '강사 정상취소'
};
var STATUS_TONE = {
  ATTENDED: 'ok',
  NORMAL_CANCEL: 'neutral',
  SAME_DAY_CANCEL: 'warn',
  NO_SHOW: 'bad'
};

var state = {
  token: '',
  as: '',
  payload: null,
  overrides: {},          // occurrenceKey -> { status, rowNumber, saving, error, note }
  view: 'today',
  days: 7,
  onlyMissing: false,
  doneOpen: false,
  openMemo: {},           // occurrenceKey -> true
  reopened: {},           // occurrenceKey -> true (saved card showing buttons again)
  syncing: false,
  lastSync: 0,
  viaCache: false
};

// ---------------------------------------------------------------- utils ---
function $(id) { return document.getElementById(id); }
function norm(s) { return String(s || '').replace(/\s+/g, '').trim().toLowerCase(); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function hm(t) { return String(t || ''); }
function md(ymd) {
  var p = String(ymd || '').split('-');
  return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : ymd;
}
function weekdayOf(ymd) {
  var p = String(ymd || '').split('-');
  if (p.length !== 3) return '';
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
}
function hoursLabel(h) {
  var n = Number(h);
  if (!isFinite(n) || n <= 0) return '';
  return (Number.isInteger(n) ? String(n) : String(n)) + '시간';
}
function toast(msg, isErr) {
  var el = $('toast');
  el.textContent = msg;
  el.className = 'toast on' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.className = 'toast'; }, isErr ? 4200 : 2100);
}
function hashToken(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ------------------------------------------------------------- network ---
function apiGet(params) {
  var q = Object.assign({ token: state.token }, params || {});
  if (state.as) q.as = state.as;
  var url = API + '?' + Object.keys(q).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]);
  }).join('&');
  return fetch(url, { method: 'GET', cache: 'no-store', redirect: 'follow' })
    .then(function (r) { return r.text(); })
    .then(parseBody);
}
function apiPost(body) {
  var payload = Object.assign({ token: state.token }, state.as ? { as: state.as } : {}, body);
  return fetch(API, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.text(); }).then(parseBody);
}
function parseBody(text) {
  var data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('서버 응답을 읽을 수 없습니다.'); }
  if (!data || data.ok !== true) throw new Error((data && data.error) || '요청을 처리하지 못했습니다.');
  return data;
}

// ---------------------------------------------------------------- cache ---
function cacheKey() { return 'rmcheck.v1.' + hashToken(state.token); }
function loadCache() {
  try {
    var raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    var obj = JSON.parse(raw);
    return obj && obj.payload ? obj : null;
  } catch (e) { return null; }
}
function saveCache(payload) {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), payload: payload }));
  } catch (e) {}
}

// ----------------------------------------------------------------- boot ---
function boot() {
  var raw = location.hash.replace(/^#/, '');
  var params = new URLSearchParams(raw);
  var token = params.get('t') || params.get('token') || '';
  state.as = params.get('as') || '';
  state.view = params.get('tab') === 'records' ? 'records' : 'today';

  if (!token) {
    $('skel').classList.add('hidden');
    showSheet('<h3>링크를 확인해 주세요</h3><p style="color:var(--ink-2);font-size:14.5px;line-height:1.5">학원에서 받은 개인 링크로 열어야 합니다. 카톡·잔디의 링크를 다시 눌러 주세요.</p>');
    $('syncText').textContent = '링크 없음';
    return;
  }
  state.token = token;

  var cached = loadCache();
  if (cached) {
    state.payload = cached.payload;
    state.viaCache = true;
    render(true);
    $('syncText').textContent = '저장된 화면';
    $('sync').classList.add('live');
  }

  switchView(state.view, true);
  sync(false);

  if (params.get('filter') === 'missing') {
    state.view = 'today';
    switchView('today');
    setTimeout(function () {
      var g = $('grpMissing');
      if (g && !g.classList.contains('hidden')) {
        g.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('미입력 수업만 모아 보여드립니다');
      } else {
        toast('미입력 수업이 없습니다 👍');
      }
    }, 260);
  }
}

function sync(force) {
  if (state.syncing || !state.token) return;
  state.syncing = true;
  $('sync').classList.add('live');
  $('syncText').textContent = '동기화 중';

  apiGet(force ? { fresh: '1' } : {}).then(function (data) {
    state.payload = data;
    state.viaCache = false;
    state.lastSync = Date.now();
    saveCache(data);
    render(true);
    $('syncText').textContent = '최신';
    setTimeout(function () { if (!state.syncing) $('sync').classList.remove('live'); }, 1200);
  }).catch(function (err) {
    var msg = err && err.message ? err.message : '연결 실패';
    $('syncText').textContent = '오프라인';
    if (!state.payload) {
      $('skel').classList.add('hidden');
      showNotice(msg);
    } else {
      toast(msg, true);
    }
  }).then(function () {
    state.syncing = false;
  });
}

function showNotice(text) {
  var el = $('notice');
  el.textContent = text;
  el.classList.remove('hidden');
}

// --------------------------------------------------------------- render ---
function render(full) {
  var p = state.payload;
  if (!p) return;
  $('skel').classList.add('hidden');
  $('teacherName').textContent = p.teacher || 'RM';
  $('dateLabel').textContent = md(p.today) + ' (' + weekdayOf(p.today) + ')';
  if (p.admin && p.admin.isAdmin) $('adminBtn').hidden = false;

  if (p.calendarUnavailable) {
    showNotice('이 계정은 강사 캘린더를 읽을 수 없어 오늘 수업이 비어 있습니다. 기록·메모는 그대로 쓸 수 있습니다. (학원에 캘린더 공유를 요청하세요)');
  } else {
    $('notice').classList.add('hidden');
  }

  var lists = buildLists();
  $('sumMissing').textContent = lists.missing.length;
  $('sumLeft').textContent = lists.remaining.length;
  $('sumDone').textContent = lists.done.length;

  renderGroup('grpMissing', 'listMissing', 'cntMissing', lists.missing, 'missing');
  renderGroup('grpToday', 'listToday', 'cntToday', lists.remaining, 'today');
  renderDone(lists.done);

  $('emptyToday').classList.toggle('hidden', !!(lists.missing.length || lists.remaining.length || lists.done.length));
  renderRecords();
}

function cardKey(item) { return item.occurrenceKey || item.id; }

function buildLists() {
  var p = state.payload || {};
  var today = (p.todayLessons || []).map(function (x) { return withOverride(x, 'today'); });
  var missing = (p.missingLessons || []).map(function (x) { return withOverride(x, 'missing'); });
  var done = today.filter(function (x) { return x.saved; });
  var remaining = today.filter(function (x) { return !x.saved; });
  return { missing: missing, remaining: remaining, done: done };
}

function withOverride(item, kind) {
  var key = cardKey(item);
  var ov = state.overrides[key];
  var out = Object.assign({}, item, { _kind: kind, _key: key });
  var rec = item.existingRecord || null;

  out._status = (ov && ov.status) || (rec && rec.status) || '';
  out._saving = !!(ov && ov.saving);
  out._error = (ov && ov.error) || '';
  out._note = (ov && typeof ov.note === 'string') ? ov.note : (rec && rec.note) || '';
  out._row = (ov && ov.rowNumber) || (rec && rec.rowNumber) || 0;
  out._classType = (ov && ov.classType) || (rec && rec.classType) || defaultClassType(item.student);
  out._saved = !!(rec || (ov && ov.rowNumber));
  out._reopened = !!state.reopened[key];
  return out;
}

function defaultClassType(student) {
  var p = state.payload || {};
  var h = (p.studentHistory || {})[norm(student)];
  return (h && h[0] && h[0].t) || '';
}

function prevLesson(student) {
  var p = state.payload || {};
  var h = (p.studentHistory || {})[norm(student)];
  return h && h[0] ? h[0] : null;
}

function renderGroup(groupId, listId, countId, items, kind) {
  var g = $(groupId), l = $(listId);
  if (countId) $(countId).textContent = items.length;
  if (!items.length) { g.classList.add('hidden'); l.innerHTML = ''; return; }
  g.classList.remove('hidden');
  l.innerHTML = items.map(function (x) { return cardHTML(x, kind); }).join('');
}

function renderDone(items) {
  var g = $('grpDone');
  if (!items.length) { g.classList.add('hidden'); $('listDone').innerHTML = ''; $('toggleDone').textContent = '펼치기'; return; }
  g.classList.remove('hidden');
  $('cntDone').textContent = items.length;
  var open = state.doneOpen;
  $('toggleDone').textContent = open ? '접기' : '펼치기';
  $('listDone').innerHTML = open ? items.map(function (x) { return cardHTML(x, 'done'); }).join('') : '';
}

function cardHTML(x, kind) {
  var time = hm(x.startTime);
  var end = hm(x.endTime);
  var meta = [];
  if (x._classType) meta.push(esc(x._classType));
  if (x.plannedHours) meta.push(hoursLabel(x.plannedHours));
  var prev = prevLesson(x.student);
  if (prev) {
    var prevType = prev.t && prev.t !== x._classType ? ' · ' + esc(prev.t) : '';
    meta.push('직전 ' + md(prev.d) + prevType);
  }
  if (x.rescheduled) meta.push('일정변경됨');

  var badges = '';
  if (!x.studentConfirmed) badges += '<span class="badge warn">이름 확인</span>';
  if (kind === 'missing') badges += '<span class="badge warn">' + esc(md(x.lessonDate)) + ' 미입력</span>';
  if (kind === 'done' && x._status) badges += '<span class="badge ok">' + esc(STATUS_LABEL[x._status] || x._status) + '</span>';

  var body;
  if (x._saved && !x._reopened) {
    var tone = x._status === 'ATTENDED' ? 'ok' : (STATUS_TONE[x._status] || 'neutral');
    body = '<div class="saved-line">' +
      '<span class="saved-pill" data-tone="' + (x._saving ? 'neutral' : tone) + '">' +
      (x._saving ? '저장 중…' : '✓ ' + esc(STATUS_LABEL[x._status] || '저장됨')) + '</span>' +
      '<span class="saved-hint">' + (x._saving ? '' : esc(x.startTime || '')) + '</span>' +
      '<button class="link-btn" data-act="reopen" data-key="' + esc(x._key) + '">변경</button>' +
      '</div>';
  } else if (x._error) {
    body = '<div class="fail-line">저장 실패 — ' + esc(x._error) +
      '<button data-act="retry" data-key="' + esc(x._key) + '">새로고침</button></div>' +
      statusButtons(x);
  } else {
    body = statusButtons(x);
  }

  var memo = '';
  if (x._saved && state.openMemo[x._key]) memo = memoHTML(x);

  return '<article class="card' + (x._saved ? ' done' : '') + (x._saving ? ' pending' : '') + (x._error ? ' warn' : '') + '" data-key="' + esc(x._key) + '">' +
    '<div class="card-row">' +
      '<div class="card-time"><b>' + esc(time) + '</b>' + (end ? '<span>' + esc(end) + '</span>' : '') + '</div>' +
      '<div class="card-who">' +
        '<div class="card-name">' + esc(x.student || x.rawTitle || '이름 없음') + badges + '</div>' +
        '<div class="card-meta">' + (kind === 'missing' ? esc(md(x.lessonDate)) + ' <span class="sep">·</span> ' : '') + meta.join(' <span class="sep">·</span> ') + '</div>' +
      '</div>' +
      '<button class="more" data-act="more" data-key="' + esc(x._key) + '" aria-label="더보기">⋯</button>' +
    '</div>' + body + memo + '</article>';
}

function statusButtons(x) {
  var keys = ['ATTENDED', 'NORMAL_CANCEL', 'SAME_DAY_CANCEL', 'NO_SHOW'];
  return '<div class="actions">' + keys.map(function (k) {
    return '<button data-act="status" data-status="' + k + '" data-key="' + esc(x._key) + '">' + STATUS_LABEL[k] + '</button>';
  }).join('') + '</div>';
}

function memoHTML(x) {
  var prev = prevLesson(x.student);
  var prevLine = prev
    ? '직전 수업 <b>' + esc(md(prev.d)) + (prev.t ? ' · ' + esc(prev.t) : '') + '</b>' + (prev.n ? '<br>' + esc(prev.n.slice(0, 90)) + (prev.n.length > 90 ? '…' : '') : '')
    : '이 학생의 이전 메모가 없습니다.';
  var p = state.payload || {};
  var h = (p.studentHistory || {})[norm(x.student)] || [];
  var chips = [];
  h.forEach(function (row) {
    if (chips.length >= 3) return;
    var n = String(row.n || '').trim();
    if (n && n.length <= 18 && chips.indexOf(n) === -1) chips.push(n);
  });
  var chipHTML = chips.length ? '<div class="chips">' + chips.map(function (c) {
    return '<button data-act="chip" data-key="' + esc(x._key) + '" data-chip="' + esc(c) + '">' + esc(c) + '</button>';
  }).join('') + '</div>' : '';

  return '<div class="memo">' +
    '<div class="prev">' + prevLine + '</div>' + chipHTML +
    '<div class="input-row">' +
      '<textarea rows="1" data-memo="' + esc(x._key) + '" placeholder="한 줄 메모 (선택) — ' + esc((p.notePlaceholder || '').slice(0, 40)) + '">' + esc(x._note || '') + '</textarea>' +
      '<button class="memo-save" data-act="saveNote" data-key="' + esc(x._key) + '">저장</button>' +
    '</div>' +
    '<div class="memo-foot">' +
      '<span class="hint">출결은 이미 저장됐어요. 메모는 나중에 써도 됩니다.</span>' +
      '<button class="link-btn" data-act="editInfo" data-key="' + esc(x._key) + '">시간·유형 수정</button>' +
    '</div>' +
  '</div>';
}

// -------------------------------------------------------------- records ---
function recordsForView() {
  var p = state.payload || {};
  var rows = (p.recentRecords || []).slice();
  var cutoff = Date.now() - state.days * 86400000;
  rows = rows.filter(function (r) {
    var d = new Date(r.lessonDate + 'T12:00:00');
    return !isNaN(d.getTime()) && d.getTime() >= cutoff;
  });
  if (state.onlyMissing) rows = rows.filter(function (r) { return r.noteMissing; });
  return rows;
}

function renderRecords() {
  var rows = recordsForView();
  var host = $('recordList');
  if (!rows.length) {
    host.innerHTML = '<div class="empty">' + (state.onlyMissing ? '메모 미입력 기록이 없습니다.' : '최근 기록이 없습니다.') + '</div>';
    return;
  }
  var html = '';
  var lastDate = '';
  rows.forEach(function (r) {
    if (r.lessonDate !== lastDate) {
      lastDate = r.lessonDate;
      html += '<div class="day-head">' + esc(md(r.lessonDate)) + ' (' + weekdayOf(r.lessonDate) + ')</div>';
    }
    var note = String(r.note || '').trim();
    html += '<div class="rec">' +
      '<div class="rec-row">' +
        '<span class="rec-name">' + esc(r.student) + '</span>' +
        '<span class="pill ' + esc(r.status) + '">' + esc(r.statusLabel || STATUS_LABEL[r.status] || r.status) + '</span>' +
        (r.classType ? '<span class="rec-hours">' + esc(r.classType) + '</span>' : '') +
        (note ? '' : '<button class="rec-more" data-act="recNote" data-row="' + r.rowNumber + '" data-student="' + esc(r.student) + '" data-date="' + esc(r.lessonDate) + '">＋ 메모</button>') +
      '</div>' +
      '<div class="rec-note' + (note ? '' : ' none') + '">' + (note ? esc(note) : '메모 없음') + '</div>' +
    '</div>';
  });
  host.innerHTML = html;
}

// ----------------------------------------------------------------- find ---
function findCard(key) {
  var p = state.payload || {};
  var pool = [].concat(p.todayLessons || [], p.missingLessons || []);
  for (var i = 0; i < pool.length; i++) {
    if (cardKey(pool[i]) === key) return withOverride(pool[i], (p.missingLessons || []).indexOf(pool[i]) !== -1 ? 'missing' : 'today');
  }
  return null;
}

// ---------------------------------------------------------------- write ---
function setOverride(key, patch) {
  state.overrides[key] = Object.assign({}, state.overrides[key] || {}, patch);
}

function applyStatus(card, status, opts) {
  var key = card._key;
  if (!card.studentConfirmed) {
    openBindSheet(card);
    toast('먼저 학생 이름을 연결해 주세요');
    return;
  }
  var hours = Number((opts && opts.hours) || card.plannedHours || 1);
  var classType = (opts && opts.classType) || card._classType || ''; 
  var note = (opts && typeof opts.note === 'string') ? opts.note : card._note || '';

  if (!classType) { openInfoSheet(card, status); return; }

  setOverride(key, { status: status, saving: true, error: '' });
  render();

  apiPost({
    action: 'saveLesson',
    student: card.student,
    lessonDate: card.lessonDate,
    startTime: card.startTime,
    hours: hours,
    status: status,
    classType: classType,
    note: note,
    rowNumber: card._row || 0,
    eventId: card.eventId || '',
    rawTitle: card.rawTitle || '',
    source: 'CALENDAR',
    logId: 'c' + Date.now() + Math.floor(Math.random() * 1e4)
  }).then(function (res) {
    setOverride(key, { status: status, saving: false, rowNumber: res.rowNumber, note: note, classType: classType });
    state.reopened[key] = false;
    markSavedLocally(card, res, status, classType, note);
    state.openMemo[key] = true;
    render();
    toast(STATUS_LABEL[status] + ' 저장됨');
  }).catch(function (err) {
    setOverride(key, { status: status, saving: false, error: err.message || '저장 실패' });
    render();
    toast(err.message || '저장하지 못했습니다', true);
  });
}

function markSavedLocally(card, res, status, classType, note) {
  var p = state.payload || {};
  var source = null;
  (p.todayLessons || []).forEach(function (x) { if (cardKey(x) === card._key) source = x; });
  if (!source) (p.missingLessons || []).forEach(function (x) { if (cardKey(x) === card._key) source = x; });
  if (source) {
    source.saved = true;
    source.existingRecord = {
      rowNumber: res.rowNumber,
      student: card.student,
      lessonDate: card.lessonDate,
      displayDate: md(card.lessonDate),
      hours: res.sheetHours || card.plannedHours,
      plannedHours: card.plannedHours,
      rate: res.rate,
      total: res.total,
      classType: classType,
      note: note,
      status: status,
      statusLabel: STATUS_LABEL[status],
      noteMissing: !note,
      source: 'CALENDAR'
    };
  }
  // keep the records tab in step without another round trip
  p.recentRecords = [{
    rowNumber: res.rowNumber,
    student: card.student,
    lessonDate: card.lessonDate,
    displayDate: md(card.lessonDate),
    hours: res.sheetHours || card.plannedHours,
    plannedHours: card.plannedHours,
    rate: res.rate,
    total: res.total,
    classType: classType,
    note: note,
    status: status,
    statusLabel: STATUS_LABEL[status],
    noteMissing: !note,
    source: 'CALENDAR'
  }].concat((p.recentRecords || []).filter(function (r) { return r.rowNumber !== res.rowNumber; }));
  saveCache(p);
}

function saveMemo(card, text) {
  var note = String(text || '').trim();
  if (!card._row) { toast('먼저 출결을 저장해 주세요'); return; }
  setOverride(card._key, { note: note });
  apiPost({
    action: 'saveNote',
    rowNumber: card._row,
    student: card.student,
    note: note,
    lessonDate: card.lessonDate,
    eventId: card.eventId || '',
    occurrenceKey: card._key
  }).then(function () {
    var p = state.payload || {};
    (p.recentRecords || []).forEach(function (r) {
      if (r.rowNumber === card._row) { r.note = note; r.noteMissing = !note; }
    });
    var pool = [].concat(p.todayLessons || [], p.missingLessons || []);
    pool.forEach(function (x) {
      if (x.existingRecord && x.existingRecord.rowNumber === card._row) {
        x.existingRecord.note = note;
        x.existingRecord.noteMissing = !note;
      }
    });
    saveCache(p);
    toast(note ? '메모 저장됨' : '메모 지움');
    render();
  }).catch(function (err) {
    toast(err.message || '메모를 저장하지 못했습니다', true);
  });
}

// ----------------------------------------------------------------- sheet ---
var sheetStack = [];

function showSheet(html) {
  $('sheetBody').innerHTML = html;
  $('sheet').classList.add('on');
  $('scrim').classList.add('on');
  sheetStack.push(html);
}
function closeSheet() {
  $('sheet').classList.remove('on');
  $('scrim').classList.remove('on');
  sheetStack = [];
}

function openMoreSheet(card) {
  var items = [];
  if (!card.studentConfirmed) {
    items.push('<button class="item" data-sheet="bind" data-key="' + esc(card._key) + '"><span class="ico">✎</span>학생명 연결<span style="margin-left:auto;color:var(--ink-3);font-size:12px">' + esc(card.rawTitle || '') + '</span></button>');
  } else {
    items.push('<button class="item" data-sheet="bind" data-key="' + esc(card._key) + '"><span class="ico">✎</span>학생명 변경</button>');
  }
  items.push('<button class="item" data-sheet="ignore" data-key="' + esc(card._key) + '"><span class="ico">⊘</span>수업 아님</button>');
  items.push('<button class="item" data-sheet="resched" data-key="' + esc(card._key) + '"><span class="ico">⇄</span>일정변경</button>');
  items.push('<button class="item danger" data-sheet="graduate" data-key="' + esc(card._key) + '"><span class="ico">🎓</span>졸업 처리</button>');
  showSheet('<h3>' + esc(card.student || card.rawTitle || '') + '</h3>' + items.join(''));
}

function openInfoSheet(card, status) {
  var p = state.payload || {};
  var types = (p.classTypes || []).map(function (c) { return c.value; });
  var cur = card._classType || (types[0] || '');
  showSheet(
    '<h3>수업 정보</h3>' +
    '<div class="field"><label>수업 유형</label><select id="fType">' +
      types.map(function (t) { return '<option value="' + esc(t) + '"' + (t === cur ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="field"><label>수업 시간</label><input id="fHours" type="number" min="0.25" max="12" step="0.25" value="' + (card.plannedHours || 1) + '"></div>' +
    '<div class="field"><label>메모 (선택)</label><textarea id="fNote" placeholder="예: 스몰톡, 현재완료">' + esc(card._note || '') + '</textarea></div>' +
    '<button class="primary" data-act="confirmInfo" data-key="' + esc(card._key) + '" data-status="' + esc(status || 'ATTENDED') + '">저장</button>' +
    '<button class="secondary" data-act="close">취소</button>'
  );
}

function openBindSheet(card) {
  var p = state.payload || {};
  var names = (p.studentSuggestions || []).slice(0, 200);
  showSheet(
    '<h3>학생명 연결</h3>' +
    '<div class="field"><label>캘린더 제목</label><input type="text" value="' + esc(card.rawTitle || '') + '" disabled></div>' +
    '<div class="field"><label>학생 이름</label><input id="fStudent" type="text" list="nameList" value="' + esc(card.suggestedStudent || card.student || '') + '">' +
    '<datalist id="nameList">' + names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist></div>' +
    '<p style="font-size:12.5px;color:var(--ink-3);font-weight:600;margin:0 0 12px">같은 캘린더 제목은 다음부터 자동으로 연결됩니다.</p>' +
    '<button class="primary" data-act="doBind" data-key="' + esc(card._key) + '">연결</button>' +
    '<button class="secondary" data-act="close">취소</button>'
  );
}

function openReschedSheet(card) {
  showSheet(
    '<h3>일정변경</h3>' +
    '<p style="font-size:13.5px;color:var(--ink-2);line-height:1.5;margin:0 0 14px">' +
      esc(card.student) + ' · ' + esc(md(card.lessonDate)) + ' ' + esc(card.startTime) + '<br>' +
      '이 수업을 일정변경으로 기록하면 오늘 목록에서 사라집니다. 옮긴 날짜는 다음 단계에서 고를 수 있어요.</p>' +
    '<button class="primary" data-act="doResched" data-key="' + esc(card._key) + '">일정변경으로 기록</button>' +
    '<button class="secondary" data-act="close">취소</button>'
  );
}

function openGraduateSheet(card) {
  var p = state.payload || {};
  showSheet(
    '<h3>졸업 처리</h3>' +
    '<p style="font-size:13.5px;color:var(--ink-2);margin:0 0 12px">' + esc(card.student) + ' 님을 이 날짜부터 졸업으로 표시합니다. 이후 수업은 목록에 뜨지 않습니다.</p>' +
    '<div class="field"><label>적용일</label><input id="fDate" type="date" value="' + esc(p.today || '') + '"></div>' +
    '<button class="primary" data-act="doGraduate" data-key="' + esc(card._key) + '">졸업 처리</button>' +
    '<button class="secondary" data-act="close">취소</button>'
  );
}

function openNoteSheet(row, student, date) {
  showSheet(
    '<h3>' + esc(student) + ' 메모</h3>' +
    '<div class="field"><label>' + esc(md(date)) + ' 수업</label><textarea id="fRecNote" placeholder="예: 스몰톡, 여행영어, 숙제 점검"></textarea></div>' +
    '<button class="primary" data-act="doRecNote" data-row="' + row + '" data-student="' + esc(student) + '" data-date="' + esc(date) + '">저장</button>' +
    '<button class="secondary" data-act="close">취소</button>'
  );
  setTimeout(function () { var el = $('fRecNote'); if (el) el.focus(); }, 120);
}

function openAdminSheet() {
  var p = state.payload || {};
  var admin = p.admin || {};
  var teachers = admin.teachers || [];
  showSheet(
    '<h3>관리자</h3>' +
    '<div class="teacher-grid">' + teachers.map(function (t) {
      return '<button data-act="switchTeacher" data-teacher="' + esc(t) + '" aria-pressed="' + (t === (admin.selectedTeacher || p.teacher) ? 'true' : 'false') + '">' + esc(t) + '</button>';
    }).join('') + '</div>' +
    '<p style="font-size:12.5px;color:var(--ink-3);font-weight:600;margin:0 0 6px">버전 ' + esc(APP_VERSION) + ' · API ' + esc(p.apiVersion || '') + (p.cached ? ' · 캐시' : '') + '</p>' +
    (p.performance ? '<div class="perf">' + esc(JSON.stringify(p.performance.steps, null, 1).replace(/\n/g, '\n')) + '</div>' : '') +
    '<button class="secondary" data-act="close">닫기</button>'
  );
}

// ---------------------------------------------------------------- events ---
document.addEventListener('click', function (ev) {
  var t = ev.target.closest('[data-act],[data-sheet]');
  if (!t) return;

  if (t.id === 'scrim') { closeSheet(); return; }

  if (t.dataset.sheet) {
    var c = findCard(t.dataset.key);
    if (!c) return;
    if (t.dataset.sheet === 'bind') openBindSheet(c);
    else if (t.dataset.sheet === 'ignore') {
      showSheet('<h3>수업 아님</h3><p style="font-size:13.5px;color:var(--ink-2);margin:0 0 14px">이 캘린더 일정을 수업이 아닌 것으로 표시합니다. 같은 제목의 다른 일정에는 영향이 없습니다.</p>' +
        '<button class="primary" data-act="doIgnore" data-key="' + esc(c._key) + '">수업 아님으로 표시</button><button class="secondary" data-act="close">취소</button>');
    }
    else if (t.dataset.sheet === 'resched') openReschedSheet(c);
    else if (t.dataset.sheet === 'graduate') openGraduateSheet(c);
    return;
  }

  var act = t.dataset.act;
  var key = t.dataset.key;
  var card = key ? findCard(key) : null;

  switch (act) {
    case 'close': closeSheet(); break;
    case 'more': if (card) openMoreSheet(card); break;
    case 'status': if (card) applyStatus(card, t.dataset.status); break;
    case 'retry':
      // A failed request may still have reached the sheet: re-read the live
      // state instead of writing again and risking a duplicate row.
      toast('최신 상태를 다시 확인합니다');
      sync(true);
      break;
    case 'reopen':
      if (card) {
        state.reopened[key] = true;
        state.openMemo[key] = false;
        state.overrides[key] = Object.assign({}, state.overrides[key] || {}, { error: '' });
        render();
      }
      break;
    case 'chip': {
      var ta = document.querySelector('textarea[data-memo="' + key + '"]');
      if (ta) { ta.value = t.dataset.chip; ta.focus(); }
      break;
    }
    case 'saveNote': {
      var box = document.querySelector('textarea[data-memo="' + key + '"]');
      if (card && box) saveMemo(card, box.value);
      break;
    }
    case 'editInfo': if (card) openInfoSheet(card, card._status); break;
    case 'confirmInfo': {
      var type = $('fType') ? $('fType').value : '';
      var hours = $('fHours') ? Number($('fHours').value) : 1;
      var note = $('fNote') ? $('fNote').value : '';
      closeSheet();
      if (card) applyStatus(card, t.dataset.status || 'ATTENDED', { classType: type, hours: hours, note: note });
      break;
    }
    case 'doBind': {
      var name = $('fStudent') ? $('fStudent').value.trim() : '';
      if (!name) { toast('학생 이름을 입력하세요', true); break; }
      closeSheet();
      toast('연결 중…');
      apiPost({ action: 'bindCalendarStudent', rawTitle: card.rawTitle, student: name, eventId: card.eventId, lessonDate: card.lessonDate, startTime: card.startTime })
        .then(function () { sync(true); toast('학생명을 연결했습니다'); })
        .catch(function (e) { toast(e.message, true); });
      break;
    }
    case 'doIgnore':
      closeSheet();
      apiPost({ action: 'ignoreCalendarOccurrence', eventId: card.eventId, lessonDate: card.lessonDate, startTime: card.startTime, rawTitle: card.rawTitle, student: card.student })
        .then(function () { sync(true); toast('수업 아님으로 표시했습니다'); })
        .catch(function (e) { toast(e.message, true); });
      break;
    case 'doResched':
      closeSheet();
      apiPost({ action: 'markRescheduled', eventId: card.eventId, lessonDate: card.lessonDate, startTime: card.startTime, student: card.student })
        .then(function (res) {
          if (res.candidates && res.candidates.length) openCandidateSheet(card, res);
          else { toast('일정변경으로 기록했습니다'); sync(true); }
        })
        .catch(function (e) { toast(e.message, true); });
      break;
    case 'pickCand':
      closeSheet();
      apiPost({ action: 'setRescheduleReplacement', changeId: t.dataset.change, mode: 'CALENDAR',
        replacementDate: t.dataset.date, replacementStartTime: t.dataset.time, replacementEventId: t.dataset.event })
        .then(function () { sync(true); toast('옮긴 수업을 지정했습니다'); })
        .catch(function (e) { toast(e.message, true); });
      break;
    case 'undecided':
      closeSheet();
      apiPost({ action: 'setRescheduleReplacement', changeId: t.dataset.change, mode: 'UNKNOWN' })
        .then(function () { sync(true); toast('옮긴 날짜를 미정으로 두었습니다'); })
        .catch(function (e) { toast(e.message, true); });
      break;
    case 'doGraduate': {
      var d = $('fDate') ? $('fDate').value : '';
      closeSheet();
      apiPost({ action: 'graduateStudent', student: card.student, effectiveDate: d, eventId: card.eventId, lessonDate: card.lessonDate })
        .then(function () { sync(true); toast('졸업 처리했습니다'); })
        .catch(function (e) { toast(e.message, true); });
      break;
    }
    case 'recNote': openNoteSheet(t.dataset.row, t.dataset.student, t.dataset.date); break;
    case 'doRecNote': {
      var text = $('fRecNote') ? $('fRecNote').value : '';
      var row = Number(t.dataset.row);
      closeSheet();
      apiPost({ action: 'saveNote', rowNumber: row, note: text })
        .then(function () {
          var p2 = state.payload || {};
          (p2.recentRecords || []).forEach(function (r) { if (r.rowNumber === row) { r.note = text.trim(); r.noteMissing = !text.trim(); } });
          saveCache(p2); render(); toast('메모 저장됨');
        })
        .catch(function (e) { toast(e.message, true); });
      break;
    }
    case 'switchTeacher':
      state.as = t.dataset.teacher;
      state.payload = null;
      state.overrides = {};
      closeSheet();
      $('skel').classList.remove('hidden');
      sync(true);
      break;
    case 'refresh': sync(true); break;
  }
});

function openCandidateSheet(card, res) {
  var list = res.candidates.map(function (c) {
    return '<button data-act="pickCand" data-change="' + esc(res.changeId) + '" data-date="' + esc(c.lessonDate) + '" data-time="' + esc(c.startTime) + '" data-event="' + esc(c.eventId) + '">' +
      '<b>' + esc(md(c.lessonDate)) + ' (' + weekdayOf(c.lessonDate) + ') ' + esc(c.startTime) + '</b>' +
      '<span>' + esc(c.student) + ' · ' + hoursLabel(c.plannedHours) + '</span></button>';
  }).join('');
  showSheet(
    '<h3>옮긴 수업 고르기</h3>' +
    '<p style="font-size:13px;color:var(--ink-2);margin:0 0 10px">' + esc(card.student) + ' 님의 이후 캘린더 일정입니다.</p>' +
    '<div class="cand">' + list + '</div>' +
    '<button class="secondary" data-act="undecided" data-change="' + esc(res.changeId) + '">아직 미정</button>'
  );
}

// ----------------------------------------------------------------- tabs ---
function switchView(view, silent) {
  state.view = view;
  $('viewToday').classList.toggle('hidden', view !== 'today');
  $('viewRecords').classList.toggle('hidden', view !== 'records');
  $('tabToday').setAttribute('aria-selected', view === 'today' ? 'true' : 'false');
  $('tabRecords').setAttribute('aria-selected', view === 'records' ? 'true' : 'false');
  if (view === 'records' && !silent) renderRecords();
}

$('tabToday').addEventListener('click', function () { switchView('today'); });
$('tabRecords').addEventListener('click', function () { switchView('records'); });
$('scrim').addEventListener('click', closeSheet);
$('adminBtn').addEventListener('click', openAdminSheet);
$('toggleDone').addEventListener('click', function () { state.doneOpen = !state.doneOpen; render(); });
$('days7').addEventListener('click', function () {
  state.days = 7; $('days7').setAttribute('aria-pressed', 'true'); $('days30').setAttribute('aria-pressed', 'false'); renderRecords();
});
$('days30').addEventListener('click', function () {
  state.days = 30; $('days30').setAttribute('aria-pressed', 'true'); $('days7').setAttribute('aria-pressed', 'false'); renderRecords();
});
$('onlyMissing').addEventListener('change', function (e) { state.onlyMissing = e.target.checked; renderRecords(); });
$('sync').addEventListener('click', function () { sync(true); });

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && state.token && Date.now() - state.lastSync > 45000) sync(false);
});

boot();
