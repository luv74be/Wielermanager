/* ═══════════════════════════════════════════════════════════════════════════
   Sporza Wielermanager – SPA JavaScript
   Spelregels: Voorjaar Mannen 2026
   ═══════════════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  page: 'dashboard',
  previousPage: 'dashboard',
  koersDetailId: null,
  renners: [],
  ploeg: null,
  koersen: [],
  stats: null,
  instellingen: {},
  geplandTransfers: [],
  transfers: [],
  rennerFilter: { zoek: '', rol: '', sort: 'punten', dir: 'desc' },
  navHistory: [],   // [{page, label, koersDetailId, rennerDetailId}]
  // AI chat
  chatMessages: [],   // [{role:'user'|'assistant', content:'...', transfer_suggestion?:{...}}]
  chatLoading: false,
};

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const defaults = { headers: { 'Content-Type': 'application/json' } };
  const res = await fetch(path, { ...defaults, ...options });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const get  = path => api(path);
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const put  = (path, body) => api(path, { method: 'PUT',  body: JSON.stringify(body) });
const del  = path => api(path, { method: 'DELETE' });

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span> ${msg}`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Modal ────────────────────────────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').style.display = 'flex';
}
function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
}
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target.id === 'modal-overlay') closeModal();
});

// ── Navigatie helpers ────────────────────────────────────────────────────────
const PAGE_LABELS = {
  dashboard:    'Start',
  ploeg:        'Mijn Ploeg',
  renners:      'Renners',
  koersen:      'Wedstrijden',
  statistieken: 'Statistieken',
  suggesties:   'Suggesties',
  spelregels:   'Spelregels',
  'ai-chat':         'AI Assistent',
  'mini-competitie': 'Minicompetitie',
  instellingen:      'Instellingen',
};

function getPageLabel(page) {
  if (page === 'koers-detail') {
    const k = state.koersen.find(k => k.id === state.koersDetailId);
    return k ? k.naam : 'Wedstrijd';
  }
  if (page === 'renner-detail') {
    const r = state.renners.find(r => r.id === state.rennerDetailId);
    return r ? r.naam : 'Renner';
  }
  return PAGE_LABELS[page] || page;
}

function _pushHistory() {
  state.navHistory.push({
    page: state.page,
    label: getPageLabel(state.page),
    koersDetailId: state.koersDetailId || null,
    rennerDetailId: state.rennerDetailId || null,
  });
}

function _syncNavActive(page) {
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.page === page);
  });
}

// ── Sidebar navigation ───────────────────────────────────────────────────────
function navigate(page) {
  state.navHistory = [];   // menu-navigatie start altijd opnieuw
  state.page = page;
  state.koersDetailId = null;
  state.rennerDetailId = null;
  _syncNavActive(page);
  document.getElementById('sidebar').classList.remove('open');
  renderPage();
}
document.querySelectorAll('.nav-link').forEach(l => {
  l.addEventListener('click', e => { e.preventDefault(); navigate(l.dataset.page); });
});

function openKoersDetail(kid) {
  _pushHistory();
  state.koersDetailId = kid;
  state.page = 'koers-detail';
  document.getElementById('sidebar').classList.remove('open');
  renderPage();
}

function openRennerDetail(rid) {
  if (!rid) { toast('Ongeldige renner ID', 'error'); return; }
  _pushHistory();
  state.rennerDetailId = rid;
  state.page = 'renner-detail';
  document.getElementById('sidebar').classList.remove('open');
  renderPage().catch(e => toast('Fout bij laden renner: ' + e.message, 'error'));
}

function goBack() {
  if (state.navHistory.length > 0) {
    const prev = state.navHistory.pop();
    state.page = prev.page;
    state.koersDetailId = prev.koersDetailId;
    state.rennerDetailId = prev.rennerDetailId;
  } else {
    state.page = 'dashboard';
    state.koersDetailId = null;
    state.rennerDetailId = null;
  }
  _syncNavActive(state.page);
  renderPage();
}

function goBackTo(index) {
  const target = state.navHistory[index];
  state.navHistory = state.navHistory.slice(0, index);
  state.page = target.page;
  state.koersDetailId = target.koersDetailId || null;
  state.rennerDetailId = target.rennerDetailId || null;
  _syncNavActive(state.page);
  renderPage();
}

function renderBreadcrumb() {
  if (state.page === 'dashboard') return '';
  const hist = state.navHistory;
  const crumbs = hist.map((h, i) =>
    `<span class="bc-item" onclick="goBackTo(${i})">${h.label}</span>`
  );
  crumbs.push(`<span class="bc-current">${getPageLabel(state.page)}</span>`);

  return `
    <div class="breadcrumb-bar">
      <button class="btn btn-secondary btn-sm bc-back" onclick="goBack()">← Terug</button>
      <nav class="bc-trail" aria-label="Breadcrumb">
        ${crumbs.join('<span class="bc-sep">›</span>')}
      </nav>
    </div>`;
}
document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// Sluit sidebar bij klik buiten het menu
document.addEventListener('click', e => {
  const sidebar  = document.getElementById('sidebar');
  const hamburger = document.getElementById('hamburger');
  if (sidebar.classList.contains('open') &&
      !sidebar.contains(e.target) &&
      !hamburger.contains(e.target)) {
    sidebar.classList.remove('open');
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, dd] = d.split('-');
  return `${dd}/${m}/${y}`;
}
function fmtPrijs(p) { return `€${Number(p).toFixed(1)}M`; }
function rolBadge(rol) { return `<span class="badge badge-${rol}">${rol}</span>`; }
function soortBadge(s) {
  const labels = { monument: 'Monument', worldtour: 'World Tour', niet_wt: 'Niet-WT' };
  return `<span class="badge badge-${s}">${labels[s] || s}</span>`;
}
function avatarHtml(r, size = 'sm') {
  if (r.foto) return `<img src="${r.foto}" class="renner-avatar renner-avatar-${size}" alt="${r.naam}" />`;
  return `<div class="renner-avatar renner-avatar-${size} renner-avatar-placeholder">👤</div>`;
}

function sortTable(arr, key, dir) {
  return [...arr].sort((a, b) => {
    const va = a[key] ?? 0, vb = b[key] ?? 0;
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return dir === 'asc' ? va - vb : vb - va;
  });
}

// ── Load data ────────────────────────────────────────────────────────────────
async function loadAll() {
  const [renners, ploeg, koersen, stats, inst, gepland, transfers] = await Promise.all([
    get('/api/renners'),
    get('/api/mijn-ploeg'),
    get('/api/koersen'),
    get('/api/stats'),
    get('/api/instellingen'),
    get('/api/geplande-transfers'),
    get('/api/transfers'),
  ]);
  state.renners          = renners;
  state.ploeg            = ploeg;
  state.koersen          = koersen;
  state.stats            = stats;
  state.instellingen     = inst;
  state.geplandTransfers = gepland;
  state.transfers        = transfers;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Dashboard
// ═══════════════════════════════════════════════════════════════════════════
function renderDashboard() {
  const { ploeg, stats, koersen, instellingen } = state;
  const budget_pct = ploeg ? Math.round((ploeg.budget_uitgegeven / ploeg.budget_totaal) * 100) : 0;
  const danger = budget_pct > 85;
  const komende = koersen.filter(k => !k.afgelopen).slice(0, 4);
  const chartData = stats?.punten_per_koers || [];
  const maxPunten = Math.max(...chartData.map(d => d.punten), 1);
  const topRenners = stats?.top_renners || [];
  const gratis_rest = (stats?.transfers_gratis ?? 3) - (stats?.transfer_count ?? 0);

  // Countdown berekening
  const volgende = koersen.find(k => !k.afgelopen);
  const vandaagKoers = (() => {
    const today = new Date().toISOString().slice(0, 10);
    return koersen.find(k => k.datum === today && !k.afgelopen) || null;
  })();
  const today = new Date(new Date().toISOString().slice(0,10));
  const daysUntil = volgende
    ? Math.round((new Date(volgende.datum) - today) / 86400000)
    : null;
  const geenOpstelling = volgende && (volgende.opstelling_aantal === 0);
  const countdownHtml = volgende ? (() => {
    const isUrgent = geenOpstelling && daysUntil !== null && daysUntil <= 7;
    const isToday  = daysUntil === 0;
    const isPast   = daysUntil < 0;
    const icon     = isPast ? '🚨' : isToday ? '🏁' : daysUntil <= 3 ? '⏰' : '📅';
    const dagTxt   = isPast  ? `${Math.abs(daysUntil)}d geleden gestart`
                   : isToday ? 'Vandaag!'
                   : daysUntil === 1 ? 'Morgen!'
                   : `Over ${daysUntil} dagen`;
    const opsTxt   = geenOpstelling
      ? `<span style="color:var(--red);font-weight:700">⚠️ Opstelling nog niet ingesteld!</span>`
      : volgende.opstelling_aantal > 0
        ? `<span style="color:var(--green)">👥 ${volgende.opstelling_aantal}/12 opgesteld ✓</span>`
        : '';
    const bg   = isUrgent ? 'rgba(239,68,68,0.10)' : 'rgba(74,222,128,0.07)';
    const border = isUrgent ? 'rgba(239,68,68,0.35)' : 'rgba(74,222,128,0.25)';
    return `
      <div style="background:${bg};border:1px solid ${border};border-radius:12px;
                  padding:14px 18px;margin-bottom:20px;cursor:pointer;transition:opacity .15s"
           onclick="openKoersDetail(${volgende.id})">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:1.7rem">${icon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:0.95rem">${volgende.naam}</div>
            <div style="font-size:0.82rem;color:var(--muted);margin-top:2px;display:flex;gap:8px;flex-wrap:wrap">
              <span>${fmtDate(volgende.datum)} · ${dagTxt}</span>
              ${opsTxt ? `<span>·</span>${opsTxt}` : ''}
            </div>
          </div>
          ${geenOpstelling ? `
            <button class="btn btn-sm" style="background:var(--red);color:#fff;flex-shrink:0"
              onclick="event.stopPropagation();openKoersDetail(${volgende.id})">
              Opstelling instellen →
            </button>` : ''}
        </div>
      </div>`;
  })() : '';

  return `
    <div style="margin-bottom:16px">
      <div class="page-subtitle">${instellingen.competitie || 'Voorjaar Mannen 2026'}</div>
    </div>

    ${countdownHtml}

    ${vandaagKoers ? `
    <div class="card mt-0 mb-20" id="live-card" style="border:1px solid rgba(239,68,68,0.4);background:rgba(239,68,68,0.04)">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
        <span style="display:flex;align-items:center;gap:8px">
          <span class="live-dot"></span>
          <span>LIVE · ${vandaagKoers.naam}</span>
        </span>
        <button class="btn btn-secondary btn-sm" onclick="laadLiveData(${vandaagKoers.id})" style="font-size:0.72rem;padding:3px 10px">⟳ Vernieuwen</button>
      </div>
      <div id="live-koers-data" style="margin-top:8px">
        <div class="text-muted fs-sm" style="padding:8px 0">⏳ Live data laden…</div>
      </div>
    </div>` : ''}

    <div class="stats-grid stats-grid-4">
      <div class="stat-card" onclick="openPuntenOverzicht()" style="cursor:pointer" title="Bekijk punten per wedstrijd">
        <div class="stat-label">Totaal Punten</div>
        <div class="stat-value text-accent">${stats?.totaal_punten ?? 0}</div>
        <div class="stat-sub">dit seizoen →</div>
      </div>
      <div class="stat-card green" onclick="navigate('ploeg')" style="cursor:pointer" title="Bekijk mijn ploeg">
        <div class="stat-label">Budget Resterend</div>
        <div class="stat-value ${danger ? 'text-red' : ''}">${fmtPrijs(ploeg?.budget_resterend ?? 0)}</div>
        <div class="stat-sub budget-bar-wrap">
          <div class="budget-bar"><div class="budget-bar-fill ${danger ? 'danger' : ''}" style="width:${budget_pct}%"></div></div>
          ${fmtPrijs(ploeg?.budget_uitgegeven ?? 0)} / ${fmtPrijs(ploeg?.budget_totaal ?? 0)} gebruikt →
        </div>
      </div>
      <div class="stat-card blue" onclick="navigate('ploeg')" style="cursor:pointer" title="Bekijk mijn ploeg">
        <div class="stat-label">Renners in Ploeg</div>
        <div class="stat-value">${ploeg?.aantal ?? 0} / ${instellingen.max_renners || 20}</div>
        <div class="stat-sub">Opstelling per wedstrijd instellen →</div>
      </div>
      <div class="stat-card purple" onclick="openTransfersOverzicht()" style="cursor:pointer" title="Bekijk transferhistoriek">
        <div class="stat-label">Gratis Transfers</div>
        <div class="stat-value ${gratis_rest <= 0 ? 'text-red' : 'text-green'}">${Math.max(0, gratis_rest)}</div>
        <div class="stat-sub">resterend (${stats?.transfer_count ?? 0} gedaan) →</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        Top Scorers in Ploeg
        ${topRenners.length > 5 ? `<button class="btn btn-secondary btn-sm" id="top-scorers-toggle" onclick="toggleTopScorers()" style="font-size:0.72rem;padding:3px 8px">Toon alle (${topRenners.length})</button>` : ''}
      </div>
      ${topRenners.length === 0
        ? '<div class="text-muted fs-sm mt-12">Nog geen resultaten</div>'
        : `<div class="chart-bars">
            ${topRenners.map((r, i) => `
              <div class="chart-row top-scorer-row${i >= 5 ? ' top-scorer-extra' : ''}" ${i >= 5 ? 'style="display:none"' : ''}>
                <div class="chart-label" style="display:flex;align-items:center;gap:5px;cursor:pointer" ondblclick="openRennerDetail(${r.id})">${jerseyHtml(r.ploeg,{size:16})}${i+1}. ${r.naam}</div>
                <div class="chart-bar-wrap">
                  <div class="chart-bar-fill" style="width:${Math.round(r.punten/topRenners[0].punten*100)}%">${r.punten}</div>
                </div>
              </div>
            `).join('')}
          </div>`}
    </div>

    <div class="card mt-20">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        Wedstrijden
        <span class="text-muted fs-sm fw-400">${koersen.filter(k=>!k.afgelopen).length} komend · ${koersen.filter(k=>k.afgelopen===2).length} doorgezet · ${koersen.filter(k=>k.afgelopen===1).length} afgelopen</span>
      </div>
      <div class="koers-blokken">
        ${koersen.map(k => {
          const foto = k.afgelopen === 1 ? (k.winnaar_foto || k.kopman_foto) : k.kopman_foto;
          const naam = k.afgelopen === 1 ? (k.winnaar_naam || k.kopman_naam) : k.kopman_naam;
          const avatarEl = foto
            ? `<img src="${foto}" title="${naam||''}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0;margin-right:3px"/>`
            : '';
          return `
          <div class="koers-blok ${k.soort}${k.afgelopen === 1 ? ' afgelopen' : ''}" onclick="openKoersDetail(${k.id})" title="${k.naam}">
            <div class="koers-blok-datum">${fmtDate(k.datum)}${k.afgelopen === 2 ? ' <span style="color:var(--accent);font-size:0.65rem">📤</span>' : k.afgelopen === 1 ? ' <span style="color:var(--muted);font-size:0.65rem">✓</span>' : ''}</div>
            <div class="koers-blok-naam">${k.naam}</div>
            <div class="koers-blok-ops">
              ${avatarEl}
              ${k.afgelopen === 1
                ? `<span class="koers-blok-done">✓</span><span style="font-size:0.78rem;font-weight:700;color:${k.mijn_punten > 0 ? 'var(--green)' : 'var(--muted)'}">${k.mijn_punten > 0 ? k.mijn_punten + ' pt' : '0 pt'}</span>`
                : k.afgelopen === 2
                  ? `<span style="color:var(--accent);font-size:0.72rem">📤 Doorgezet</span>`
                  : k.opstelling_aantal > 0
                    ? `<span style="color:var(--green);font-size:0.72rem">👥 ${k.opstelling_aantal}/12</span>`
                    : `<span style="color:var(--muted);font-size:0.72rem">👥 —</span>`}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

// ── Live wedstrijd ─────────────────────────────────────────────────────────────
let _liveRefreshTimer = null;

function _renderLiveKlassement(data) {
  const {
    klassement = [], commentaar = [], uitvallers = [], favorieten = [],
    bron, status, race_klaar, cookie_verlopen, geen_cookie
  } = data;

  const hasData = klassement.length || uitvallers.length || favorieten.length || commentaar.length;

  // ── Cookie-melding ────────────────────────────────────────────────────────
  const cookieMelding = (cookie_verlopen || geen_cookie) ? `
    <div style="font-size:0.76rem;color:var(--muted);background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:6px;padding:6px 10px;margin-bottom:8px;display:flex;align-items:center;gap:6px">
      <span>⚠️</span>
      <span>${geen_cookie
        ? 'Stel je <a href="#" onclick="navigate(\'instellingen\')" style="color:var(--accent)">Sporza cookie</a> in voor live puntenstanden.'
        : 'Sporza sessie verlopen (auto-refresh mislukt). Kopieer een nieuwe <a href="#" onclick="navigate(\'instellingen\')" style="color:var(--accent)">refresh token</a>.'
      }</span>
    </div>` : '';

  if (!hasData) {
    return cookieMelding + `<div class="text-muted fs-sm" style="padding:4px 0">
      Nog geen data beschikbaar. De wedstrijd is mogelijk nog niet gestart of de resultaten zijn nog niet verwerkt.
    </div>`;
  }

  // ── Helper: renner-rij renderen ───────────────────────────────────────────
  const riderRow = (r, showPos = true) => {
    const isOpstel = r.inOpstelling;
    const isPloeg  = r.inPloeg && !isOpstel;
    const bg = isOpstel ? 'rgba(74,222,128,0.12)' : isPloeg ? 'rgba(99,102,241,0.08)' : '';
    const badge = isOpstel
      ? '<span style="font-size:0.67rem;background:rgba(74,222,128,0.2);color:var(--green);padding:1px 5px;border-radius:10px;flex-shrink:0">★ opstelling</span>'
      : isPloeg
      ? '<span style="font-size:0.67rem;background:rgba(99,102,241,0.15);color:#a5b4fc;padding:1px 5px;border-radius:10px;flex-shrink:0">in ploeg</span>'
      : '';
    const rechts = r.punten > 0
      ? `<span style="margin-left:auto;font-weight:700;color:var(--accent);flex-shrink:0">${r.punten}pt</span>`
      : r.tijd
      ? `<span style="margin-left:auto;color:var(--muted);font-size:0.78rem;flex-shrink:0">${r.tijd}</span>`
      : '';
    const posEl = showPos
      ? `<span style="width:22px;text-align:right;color:var(--muted);font-weight:700;flex-shrink:0">${r.pos ?? ''}</span>`
      : `<span style="width:22px;text-align:right;color:var(--muted);font-size:0.7rem;flex-shrink:0">${r.pos ?? ''}</span>`;
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;font-size:0.82rem;background:${bg}">
      ${posEl}
      <span style="flex:1;font-weight:${isOpstel ? '700' : '400'};min-width:0">${r.naam}${r.ploeg ? `<span style="color:var(--muted);font-weight:400;font-size:0.76rem"> · ${r.ploeg}</span>` : ''}</span>
      ${badge}${rechts}
    </div>`;
  };

  // ── Klassement (Sporza WM of PCS einduitslag) ─────────────────────────────
  const klasHtml = klassement.length ? `
    <div style="margin-bottom:10px">
      <div style="font-size:0.71rem;color:var(--muted);font-weight:600;margin-bottom:5px;letter-spacing:.05em;text-transform:uppercase">
        ${race_klaar ? '🏆 Einduitslag' : 'Klassement'}${bron ? ` · ${bron}` : ''}${status ? ` · ${status}` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:3px">
        ${klassement.slice(0, 10).map(r => riderRow(r)).join('')}
      </div>
    </div>` : '';

  // ── Top favorieten van PCS (als geen Sporza data) ─────────────────────────
  const favHtml = (!klassement.length && favorieten.length) ? `
    <div style="margin-bottom:10px">
      <div style="font-size:0.71rem;color:var(--muted);font-weight:600;margin-bottom:5px;letter-spacing:.05em;text-transform:uppercase">
        🎯 Top-candidates (PCS pre-race)
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:5px">
        ${favorieten.map(f => {
          const isOps = f.inOpstelling, isPloeg = f.inPloeg && !isOps;
          const bg = isOps ? 'rgba(74,222,128,0.15)' : isPloeg ? 'rgba(99,102,241,0.1)' : 'var(--bg3)';
          const clr = isOps ? 'var(--green)' : isPloeg ? '#a5b4fc' : 'var(--text)';
          return `<span style="font-size:0.77rem;padding:3px 8px;border-radius:12px;background:${bg};color:${clr};font-weight:${isOps?'700':'400'}">${f.naam}</span>`;
        }).join('')}
      </div>
    </div>` : '';

  // ── Uitvallers (DNF/DNS) ──────────────────────────────────────────────────
  const eigneUitvallers = uitvallers.filter(u => u.inPloeg || u.inOpstelling);
  const andereUitvallers = uitvallers.filter(u => !u.inPloeg && !u.inOpstelling);
  const uitHtml = uitvallers.length ? `
    <div style="margin-bottom:${commentaar.length ? '10px' : '0'}">
      <div style="font-size:0.71rem;color:var(--muted);font-weight:600;margin-bottom:5px;letter-spacing:.05em;text-transform:uppercase">
        ❌ Uitvallers (${uitvallers.length})
      </div>
      <div style="display:flex;flex-direction:column;gap:3px">
        ${eigneUitvallers.map(r => riderRow(r, true)).join('')}
        ${andereUitvallers.slice(0, Math.max(0, 8 - eigneUitvallers.length)).map(r => riderRow(r, true)).join('')}
        ${andereUitvallers.length > 8 - eigneUitvallers.length ? `<div style="font-size:0.74rem;color:var(--muted);padding:2px 6px">...en ${andereUitvallers.length - Math.max(0, 8 - eigneUitvallers.length)} andere</div>` : ''}
      </div>
    </div>` : '';

  // ── Live commentaar (Sporza) ──────────────────────────────────────────────
  const commHtml = commentaar.length ? `
    <div>
      <div style="font-size:0.71rem;color:var(--muted);font-weight:600;margin-bottom:5px;letter-spacing:.05em;text-transform:uppercase">📡 Live updates</div>
      <div style="display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto">
        ${commentaar.map(c => `<div style="font-size:0.79rem;padding:3px 0;border-bottom:1px solid var(--border);line-height:1.4">${c}</div>`).join('')}
      </div>
    </div>` : '';

  return cookieMelding + klasHtml + favHtml + uitHtml + commHtml;
}

async function laadLiveData(koersId) {
  const el = document.getElementById('live-koers-data');
  if (!el) return;
  el.innerHTML = '<div class="text-muted fs-sm" style="padding:8px 0">⏳ Laden…</div>';
  try {
    const data = await get(`/api/koersen/${koersId}/live`);
    el.innerHTML = _renderLiveKlassement(data);
    // Toon tijdstip van laatste update
    const ts = document.getElementById('live-ts');
    if (ts) ts.textContent = new Date().toLocaleTimeString('nl-BE', {hour:'2-digit',minute:'2-digit'});
  } catch (e) {
    el.innerHTML = `<div class="text-muted fs-sm">Kon live data niet laden: ${e.message}</div>`;
  }
}

function startLiveRefresh(koersId) {
  stopLiveRefresh();
  laadLiveData(koersId);  // Direct eerste keer laden
  _liveRefreshTimer = setInterval(() => {
    if (document.getElementById('live-koers-data')) {
      laadLiveData(koersId);
    } else {
      stopLiveRefresh();
    }
  }, 60000);  // Elke 60 seconden
}

function stopLiveRefresh() {
  if (_liveRefreshTimer) {
    clearInterval(_liveRefreshTimer);
    _liveRefreshTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
function toggleTopScorers() {
  const extras = document.querySelectorAll('.top-scorer-extra');
  const btn = document.getElementById('top-scorers-toggle');
  const expanded = extras[0]?.style.display !== 'none';
  extras.forEach(el => el.style.display = expanded ? 'none' : '');
  if (btn) btn.textContent = expanded ? `Toon alle (${extras.length + 5})` : 'Inklappen';
}

// ── Seizoensgrafiek (SVG lijndiagram) ─────────────────────────────────────────
function renderSeizoensgrafiek(data) {
  if (!data || data.length < 2) return '';
  const padL = 38, padR = 16, padT = 16, padB = 36;
  const svgW = 600, svgH = 130;
  const innerW = svgW - padL - padR;
  const innerH = svgH - padT - padB;

  // Cumulatief
  let cum = 0;
  const cumulPoints = data.map(d => { cum += d.punten; return cum; });
  const maxPt = Math.max(...cumulPoints, 1);

  const xs = data.map((_, i) => padL + (i / (data.length - 1)) * innerW);
  const ys = cumulPoints.map(p => padT + innerH - (p / maxPt) * innerH);

  const lineD = xs.map((x, i) => `${i===0?'M':'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const areaD = lineD
    + ` L${xs[xs.length-1].toFixed(1)},${(padT+innerH).toFixed(1)}`
    + ` L${padL},${(padT+innerH).toFixed(1)} Z`;

  const dots = xs.map((x, i) => `
    <circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="4"
      fill="var(--accent)" stroke="var(--card-bg)" stroke-width="2">
      <title>${data[i].naam}: +${data[i].punten} pt (totaal: ${cumulPoints[i]})</title>
    </circle>`).join('');

  const xlabels = data.map((d, i) => {
    const name = d.naam.length > 14 ? d.naam.slice(0, 12) + '…' : d.naam;
    return `<text x="${xs[i].toFixed(1)}" y="${(padT+innerH+13).toFixed(1)}"
      text-anchor="middle" font-size="8.5" fill="var(--muted)"
      transform="rotate(-28,${xs[i].toFixed(1)},${(padT+innerH+13).toFixed(1)})">${name}</text>`;
  }).join('');

  // Y-axis labels
  const yTop = `<text x="${padL-4}" y="${(padT+5).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${maxPt}</text>`;
  const yBot = `<text x="${padL-4}" y="${(padT+innerH).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">0</text>`;

  const minW = Math.max(300, data.length * 48);

  return `
    <div class="card mt-20">
      <div class="card-title">📈 Seizoensverloop</div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
        <svg viewBox="0 0 ${svgW} ${svgH}"
          style="width:100%;min-width:${minW}px;height:${svgH}px;display:block">
          <defs>
            <linearGradient id="sg-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/>
            </linearGradient>
          </defs>
          <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT+innerH}"
            stroke="var(--border)" stroke-width="1"/>
          <line x1="${padL}" y1="${padT+innerH}" x2="${svgW-padR}" y2="${padT+innerH}"
            stroke="var(--border)" stroke-width="1"/>
          ${yTop}${yBot}
          <path d="${areaD}" fill="url(#sg-grad)"/>
          <path d="${lineD}" fill="none" stroke="var(--accent)"
            stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          ${dots}
          ${xlabels}
        </svg>
      </div>
    </div>`;
}

// ── Kopman-overzicht ──────────────────────────────────────────────────────────
function renderKopmanOverzicht(kopmanStats) {
  if (!kopmanStats || kopmanStats.length === 0) return '';
  return `
    <div class="card mt-20">
      <div class="card-title">⭐ Kopmannen dit Seizoen</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px">
        ${kopmanStats.map(k => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;
            background:var(--bg3);border-radius:10px;cursor:pointer;min-width:180px;flex:1"
            onclick="openRennerDetail(${k.id})">
            ${k.foto
              ? `<img src="${k.foto}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0"/>`
              : `<div style="width:40px;height:40px;border-radius:50%;background:var(--bg);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:1.2rem">👤</div>`}
            <div style="min-width:0">
              <div style="font-weight:700;font-size:0.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${k.naam}</div>
              <div style="font-size:0.77rem;color:var(--muted)">${k.keren_kopman}× kopman</div>
            </div>
            <div style="margin-left:auto;text-align:right;flex-shrink:0">
              <div style="font-weight:700;color:var(--accent);font-size:1rem">+${k.bonus_punten}</div>
              <div style="font-size:0.72rem;color:var(--muted)">bonus pt</div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

// PAGE: Mijn Ploeg
// ═══════════════════════════════════════════════════════════════════════════
function renderPloeg() {
  const { ploeg, instellingen } = state;
  if (!ploeg) return '<div class="loading">Laden...</div>';

  const renners = ploeg.renners;
  const budget_pct = Math.round((ploeg.budget_uitgegeven / ploeg.budget_totaal) * 100);
  const danger = budget_pct > 85;

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Mijn Ploeg</div>
        <div class="page-subtitle">${ploeg.aantal} renners · max ${instellingen.max_per_ploeg || 4} per team</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="openPlanTransfer()">📅 Transfer plannen</button>
        <button class="btn btn-primary" onclick="openRennerToevoegen()">+ Renner Toevoegen</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Budget Resterend</div>
        <div class="stat-value ${danger ? 'text-red' : 'text-green'}">${fmtPrijs(ploeg.budget_resterend)}</div>
        <div class="stat-sub budget-bar-wrap">
          <div class="budget-bar"><div class="budget-bar-fill ${danger ? 'danger' : ''}" style="width:${budget_pct}%"></div></div>
          ${fmtPrijs(ploeg.budget_uitgegeven)} / ${fmtPrijs(ploeg.budget_totaal)}
        </div>
      </div>
      <div class="stat-card blue">
        <div class="stat-label">Renners</div>
        <div class="stat-value">${ploeg.aantal} / ${instellingen.max_renners || 20}</div>
        <div class="stat-sub">Opstelling instellen via Wedstrijden →</div>
      </div>
    </div>

    ${renderGeplandTransfersCompact(state.geplandTransfers)}

    <div class="card mt-20">
      <div class="card-title">🚴 Ploeg (${renners.length}/20)</div>
      <div class="text-muted fs-sm" style="margin:8px 0 14px">
        Per wedstrijd stel je de opstelling in (12 renners + kopman). Dat doe je via het <strong>Wedstrijden</strong>-overzicht.
      </div>
      ${renners.length === 0
        ? '<div class="text-muted fs-sm">Nog geen renners in je ploeg</div>'
        : `<div class="table-wrap"><table>
            <thead><tr><th></th><th>Naam</th><th class="col-mob-hide">Ploeg</th><th>Rol</th><th class="col-mob-hide">Prijs</th><th>Punten</th><th></th></tr></thead>
            <tbody>
              ${renners.map(r => `<tr ${r.geblesseerd ? 'style="opacity:0.6"' : ''}>
                <td style="width:36px;padding-right:0;cursor:pointer" ondblclick="openRennerDetail(${r.id})">${avatarHtml(r)}</td>
                <td class="fw-700" style="cursor:pointer" ondblclick="openRennerDetail(${r.id})">
                  ${r.naam}
                  ${r.geblesseerd ? '<span title="Geblesseerd / Start niet" style="font-size:0.8rem;margin-left:4px">🤕</span>' : ''}
                </td>
                <td class="text-muted fs-sm col-mob-hide"><span style="display:inline-flex;align-items:center;gap:5px">${jerseyHtml(r.renner_ploeg,{size:18})}${r.renner_ploeg}</span></td>
                <td>${rolBadge(r.rol)}</td>
                <td class="price-tag col-mob-hide">${fmtPrijs(r.prijs)}</td>
                <td><span class="fw-700 ${r.totaal_punten > 0 ? 'text-green' : 'text-muted'}">${r.totaal_punten}</span></td>
                <td style="white-space:nowrap">
                  <button class="btn btn-sm ${r.geblesseerd ? 'btn-secondary' : 'btn-secondary'}"
                    title="${r.geblesseerd ? 'Als fit markeren' : 'Als geblesseerd markeren'}"
                    onclick="toggleGeblesseerd(${r.id},'${r.naam.replace(/'/g,"\\'")}',${r.geblesseerd?1:0})">
                    ${r.geblesseerd ? '✅' : '🤕'}
                  </button>
                  <button class="btn btn-sm btn-danger" onclick="removeUitPloeg(${r.id},'${r.naam.replace(/'/g,"\\'")}')">✕</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table></div>`}
    </div>

    ${renderTransferGeschiedenis(state.transfers, state.instellingen)}
  `;
}

async function removeUitPloeg(rid, naam) {
  if (!confirm(`${naam} verwijderen uit ploeg?`)) return;
  try {
    await post('/api/mijn-ploeg/remove', { renner_id: rid });
    toast(`${naam} verwijderd`, 'success');
    await refreshAll();
  } catch(e) { toast(e.message, 'error'); }
}

async function toggleGeblesseerd(rid, naam, huidig) {
  try {
    const data = await post(`/api/renners/${rid}/toggle-geblesseerd`, {});
    const status = data.geblesseerd ? '🤕 Geblesseerd' : '✅ Fit';
    toast(`${naam}: ${status}`, 'info');
    await refreshAll();
  } catch(e) { toast(e.message, 'error'); }
}

function openRennerToevoegen() {
  const beschikbaar = state.renners.filter(r => !r.in_ploeg);
  const budget = state.ploeg?.budget_resterend ?? 0;
  const maxPerPloeg = parseInt(state.instellingen.max_per_ploeg || 4);

  const perPloeg = {};
  (state.ploeg?.renners || []).forEach(r => {
    perPloeg[r.renner_ploeg] = (perPloeg[r.renner_ploeg] || 0) + 1;
  });

  openModal(`
    <div class="modal-title">Renner Toevoegen</div>
    <div class="filter-bar">
      <input class="search-input" placeholder="Zoek renner..." id="modal-zoek" oninput="filterModalRenners()" />
      <select class="filter-select" id="modal-rol" onchange="filterModalRenners()">
        <option value="">Alle rollen</option>
        <option value="sprinter">Sprinter</option>
        <option value="klimmer">Klimmer</option>
        <option value="allrounder">Allrounder</option>
        <option value="tijdrijder">Tijdrijder</option>
        <option value="helper">Helper</option>
      </select>
    </div>
    <div class="text-muted fs-sm" style="margin-bottom:12px">
      Budget: <strong class="text-green">${fmtPrijs(budget)}</strong> &nbsp;·&nbsp; Max ${maxPerPloeg} per wielerploeg
    </div>
    <div id="modal-renners-list">${renderModalRennersList(beschikbaar, budget, perPloeg, maxPerPloeg)}</div>
  `);
}

function renderModalRennersList(renners, budget, perPloeg, maxPerPloeg) {
  if (renners.length === 0) return '<div class="text-muted fs-sm">Geen renners gevonden</div>';
  return `<div class="table-wrap" style="max-height:380px;overflow-y:auto"><table>
    <thead><tr><th></th><th>Naam</th><th>Rol</th><th>Prijs</th><th>Punten</th><th></th></tr></thead>
    <tbody>
      ${renners.map(r => {
        const kanKopen = r.prijs <= budget;
        const ploegVol = (perPloeg[r.ploeg] || 0) >= maxPerPloeg;
        const disabled = !kanKopen || ploegVol;
        const reden = ploegVol ? `Max ${maxPerPloeg} van ${r.ploeg}` : 'Onvoldoende budget';
        return `<tr>
          <td style="width:36px;padding-right:0">${avatarHtml(r)}</td>
          <td><div class="fw-700">${r.naam}</div><div class="text-muted fs-sm" style="display:flex;align-items:center;gap:5px">${jerseyHtml(r.ploeg,{size:16})}${r.ploeg}</div></td>
          <td>${rolBadge(r.rol)}</td>
          <td class="${kanKopen && !ploegVol ? 'price-tag' : 'text-red fw-700'}">${fmtPrijs(r.prijs)}</td>
          <td>${r.totaal_punten}</td>
          <td>
            <button class="btn btn-sm btn-success" ${disabled ? `disabled title="${reden}"` : ''}
              onclick="voegRennerToe(${r.id},'${r.naam.replace(/'/g,"\\'")}')">+ Toevoegen</button>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

function filterModalRenners() {
  const zoek = document.getElementById('modal-zoek').value.toLowerCase();
  const rol  = document.getElementById('modal-rol').value;
  const budget = state.ploeg?.budget_resterend ?? 0;
  const maxPerPloeg = parseInt(state.instellingen.max_per_ploeg || 4);
  const perPloeg = {};
  (state.ploeg?.renners || []).forEach(r => { perPloeg[r.renner_ploeg] = (perPloeg[r.renner_ploeg] || 0) + 1; });

  let renners = state.renners.filter(r => !r.in_ploeg);
  if (zoek) renners = renners.filter(r => r.naam.toLowerCase().includes(zoek) || r.ploeg.toLowerCase().includes(zoek));
  if (rol)  renners = renners.filter(r => r.rol === rol);
  document.getElementById('modal-renners-list').innerHTML = renderModalRennersList(renners, budget, perPloeg, maxPerPloeg);
}

async function voegRennerToe(rid, naam) {
  try {
    await post('/api/mijn-ploeg/add', { renner_id: rid });
    toast(`${naam} toegevoegd aan ploeg`, 'success');
    closeModal();
    await refreshAll();
  } catch(e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Renners
// ═══════════════════════════════════════════════════════════════════════════
function renderRenners() {
  const f = state.rennerFilter;
  let renners = [...state.renners];
  if (f.zoek) renners = renners.filter(r =>
    r.naam.toLowerCase().includes(f.zoek.toLowerCase()) ||
    r.ploeg.toLowerCase().includes(f.zoek.toLowerCase())
  );
  if (f.rol) renners = renners.filter(r => r.rol === f.rol);
  renners = sortTable(renners, f.sort === 'punten' ? 'totaal_punten' : f.sort, f.dir);

  function sortHeader(label, key) {
    const active = f.sort === key;
    const arrow = active ? (f.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th onclick="sortRenners('${key}')">${label}${arrow}</th>`;
  }

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Renners Database</div>
        <div class="page-subtitle">${renners.length} van ${state.renners.length} renners</div>
      </div>
      <button class="btn btn-primary" onclick="openNieuweRenner()">+ Renner Toevoegen</button>
    </div>
    <div class="filter-bar">
      <input class="search-input" id="renner-zoek-veld" placeholder="Zoek op naam of ploeg..." value="${f.zoek}"
        oninput="zoekRennersFilter(this.value)" />
      <select class="filter-select" onchange="state.rennerFilter.rol=this.value; renderPage()">
        <option value="" ${!f.rol?'selected':''}>Alle rollen</option>
        ${['sprinter','klimmer','allrounder','tijdrijder','helper'].map(r =>
          `<option value="${r}" ${f.rol===r?'selected':''}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`
        ).join('')}
      </select>
      <select class="filter-select" onchange="state.rennerFilter.sort=this.value; renderPage()">
        <option value="punten" ${f.sort==='punten'?'selected':''}>Sorteren: Punten</option>
        <option value="prijs"  ${f.sort==='prijs'?'selected':''}>Sorteren: Prijs</option>
        <option value="naam"   ${f.sort==='naam'?'selected':''}>Sorteren: Naam</option>
      </select>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th></th>${sortHeader('Naam','naam')}<th class="col-mob-hide">Wielerploeg</th><th>Rol</th>
            ${sortHeader('Prijs','prijs')}${sortHeader('Punten','punten')}<th class="col-mob-hide">Ratio</th><th class="col-mob-hide">In Ploeg</th><th></th>
          </tr></thead>
          <tbody>
            ${renners.length === 0 ? `<tr><td colspan="9"><div class="empty-state">
              <div class="empty-icon">🔍</div><div class="empty-title">Geen renners gevonden</div>
            </div></td></tr>` : renners.map(r => {
              const ratio = r.prijs > 0 ? (r.totaal_punten / r.prijs).toFixed(1) : '0.0';
              return `<tr>
                <td style="width:36px;padding-right:0;cursor:pointer" onclick="openRennerDetail(${r.id})">${avatarHtml(r)}</td>
                <td class="fw-700" style="cursor:pointer" onclick="openRennerDetail(${r.id})">${r.naam}</td>
                <td class="text-muted fs-sm col-mob-hide"><span style="display:inline-flex;align-items:center;gap:5px">${jerseyHtml(r.ploeg,{size:18})}${r.ploeg}</span></td>
                <td>${rolBadge(r.rol)}</td>
                <td class="price-tag">${fmtPrijs(r.prijs)}</td>
                <td><span class="fw-700 ${r.totaal_punten > 0 ? 'text-green' : 'text-muted'}">${r.totaal_punten}</span></td>
                <td class="col-mob-hide"><span class="ratio-value">${ratio}</span> <span class="text-muted fs-sm">p/€M</span></td>
                <td class="col-mob-hide">${r.in_ploeg ? '<span class="in-ploeg-dot"></span>' : '<span class="text-muted">—</span>'}</td>
                <td><div class="flex gap-8">
                  ${!r.in_ploeg
                    ? `<button class="btn btn-sm btn-success" onclick="quickAdd(${r.id},'${r.naam.replace(/'/g,"\\'")}')">+ Ploeg</button>`
                    : `<button class="btn btn-sm btn-danger" onclick="removeUitPloeg(${r.id},'${r.naam.replace(/'/g,"\\'")}')">✕</button>`}
                  <button class="btn btn-sm btn-secondary" onclick="editRenner(${r.id})">✏️</button>
                  <button class="btn btn-sm" onclick="openRennerDetail(${r.id})" title="Renner detail & PCS wedstrijden">🔍</button>
                </div></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function sortRenners(key) {
  if (state.rennerFilter.sort === key) {
    state.rennerFilter.dir = state.rennerFilter.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.rennerFilter.sort = key;
    state.rennerFilter.dir = 'desc';
  }
  renderPage();
}

async function zoekRennersFilter(val) {
  state.rennerFilter.zoek = val;
  await renderPage();
  // Focus herstellen op het zoekveld na re-render
  const el = document.getElementById('renner-zoek-veld');
  if (el) {
    el.focus();
    el.setSelectionRange(val.length, val.length);
  }
}

async function quickAdd(rid, naam) {
  try {
    await post('/api/mijn-ploeg/add', { renner_id: rid });
    toast(`${naam} toegevoegd`, 'success');
    await refreshAll();
  } catch(e) { toast(e.message, 'error'); }
}

function openNieuweRenner() {
  openModal(`
    <div class="modal-title">Nieuwe Renner Toevoegen</div>

    <div style="margin-bottom:14px">
      <label class="form-label" style="margin-bottom:6px;display:block">🔍 Opzoeken op Sporza WM</label>
      <div style="display:flex;gap:8px">
        <input id="renner-zoek-input" class="form-input" placeholder="Typ een naam om te zoeken..."
          style="flex:1" oninput="debounceRennerZoek()" />
        <button type="button" class="btn btn-secondary" onclick="zoekRennerSporza()">Zoek</button>
      </div>
      <div id="renner-zoek-resultaten" style="margin-top:6px"></div>
    </div>

    <div style="border-top:1px solid var(--border);padding-top:14px">
      <form id="nieuw-renner-form">
        <!-- Foto preview (zichtbaar na selectie) -->
        <div id="renner-foto-preview" style="display:none;margin-bottom:16px;display:none;align-items:center;gap:14px;background:var(--bg3);border-radius:10px;padding:10px 14px">
          <img id="renner-foto-img" src="" alt=""
            style="width:64px;height:80px;object-fit:cover;border-radius:8px;border:2px solid var(--border);flex-shrink:0;background:var(--bg)" />
          <div>
            <div id="renner-foto-naam" style="font-weight:700;font-size:0.95rem"></div>
            <div id="renner-foto-status" class="text-muted fs-sm" style="margin-top:3px"></div>
          </div>
        </div>
        <input type="hidden" id="nieuw-foto" name="foto" value="" />

        <div class="form-row">
          <div class="form-group"><label class="form-label">Naam *</label>
            <input class="form-input" id="nieuw-naam" name="naam" required placeholder="Voornaam Achternaam" /></div>
          <div class="form-group"><label class="form-label">Wielerploeg *</label>
            <input class="form-input" id="nieuw-ploeg" name="ploeg" required placeholder="Team naam" /></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Rol *</label>
            <select class="form-input" name="rol" required>
              ${['sprinter','klimmer','allrounder','tijdrijder','helper'].map(r =>
                `<option value="${r}" ${r==='allrounder'?'selected':''}>${r}</option>`).join('')}
            </select></div>
          <div class="form-group"><label class="form-label">Prijs (€M) *</label>
            <input class="form-input" id="nieuw-prijs" name="prijs" type="number"
              min="0.5" max="30" step="0.5" required placeholder="8.0" /></div>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">
          Renner Opslaan
        </button>
      </form>
    </div>
  `);
  document.getElementById('nieuw-renner-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await post('/api/renners', Object.fromEntries(new FormData(e.target)));
      toast('Renner toegevoegd', 'success');
      closeModal(); await refreshAll();
    } catch(err) { toast(err.message, 'error'); }
  });
}

let _rennerZoekTimeout = null;
function debounceRennerZoek() {
  clearTimeout(_rennerZoekTimeout);
  _rennerZoekTimeout = setTimeout(zoekRennerSporza, 400);
}

async function zoekRennerSporza() {
  const zoek = document.getElementById('renner-zoek-input')?.value?.trim();
  const result_div = document.getElementById('renner-zoek-resultaten');
  if (!result_div) return;
  if (!zoek || zoek.length < 2) { result_div.innerHTML = ''; return; }

  result_div.innerHTML = '<div class="text-muted fs-sm">Zoeken op Sporza WM…</div>';
  try {
    const resultaten = await get(`/api/renners/opzoeken?naam=${encodeURIComponent(zoek)}`);
    if (!resultaten.length) {
      result_div.innerHTML = '<div class="text-muted fs-sm">Geen resultaten gevonden op Sporza WM.</div>';
      return;
    }
    result_div.innerHTML = `
      <div class="text-muted fs-sm" style="margin-bottom:5px">Klik om het formulier in te vullen:</div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${resultaten.map(r => `
          <button type="button" class="btn btn-secondary"
            style="text-align:left;padding:7px 12px;font-size:0.85rem;display:flex;align-items:center;gap:10px"
            data-naam="${r.naam.replace(/"/g,'&quot;')}"
            data-ploeg="${(r.ploeg||'').replace(/"/g,'&quot;')}"
            data-prijs="${r.prijs}"
            data-foto="${(r.foto||'').replace(/"/g,'&quot;')}"
            onclick="vulRennerIn(this.dataset.naam,this.dataset.ploeg,parseFloat(this.dataset.prijs),this.dataset.foto)">
            ${r.foto
              ? `<img src="${r.foto}" style="width:28px;height:34px;object-fit:cover;border-radius:4px;flex-shrink:0" />`
              : `<span style="width:28px;height:34px;border-radius:4px;background:var(--bg);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:1rem">🚴</span>`}
            <span style="min-width:0;flex:1">
              <strong>${r.naam}</strong>
              ${r.ploeg ? `<span class="text-muted fs-sm"> · ${r.ploeg}</span>` : ''}
            </span>
            ${r.prijs ? `<span class="price-tag" style="flex-shrink:0">${fmtPrijs(r.prijs)}</span>` : ''}
          </button>
        `).join('')}
      </div>
    `;
  } catch(e) {
    const isCookieErr = e.message.toLowerCase().includes('cookie') || e.message.toLowerCase().includes('sessie');
    result_div.innerHTML = isCookieErr
      ? `<div class="text-muted fs-sm">⚠️ ${e.message}
           <button type="button" class="btn btn-secondary"
             style="font-size:0.75rem;padding:3px 8px;margin-left:6px"
             onclick="closeModal();navigate('instellingen')">⚙️ Instellingen</button>
         </div>`
      : `<div class="text-muted fs-sm">⚠️ ${e.message}</div>`;
  }
}

async function vulRennerIn(naam, ploeg, prijs, sporzaFoto) {
  const rd = document.getElementById('renner-zoek-resultaten');

  // Duplicaat-check op bestaande renners in state
  const naamNorm = naam.trim().toLowerCase();
  const bestaand = (state.renners || []).find(r => r.naam.trim().toLowerCase() === naamNorm);
  if (bestaand) {
    if (rd) rd.innerHTML =
      `<div class="text-muted fs-sm" style="color:var(--red)">⚠️ ${naam} staat al in de database.</div>`;
    return;
  }

  // Formuliervelden invullen
  const n  = document.getElementById('nieuw-naam');
  const p  = document.getElementById('nieuw-ploeg');
  const pr = document.getElementById('nieuw-prijs');
  const fo = document.getElementById('nieuw-foto');
  if (n)  n.value  = naam;
  if (p)  p.value  = ploeg || '';
  if (pr && prijs) pr.value = prijs;
  if (fo) fo.value = sporzaFoto || '';

  // Zoekresultaten vervangen door bevestiging
  if (rd) rd.innerHTML =
    `<div class="text-muted fs-sm" style="color:var(--green)">✓ ${naam} ingevuld — selecteer nog de rol.</div>`;

  // Fotopreview tonen
  const preview = document.getElementById('renner-foto-preview');
  const img     = document.getElementById('renner-foto-img');
  const status  = document.getElementById('renner-foto-status');
  const naamEl  = document.getElementById('renner-foto-naam');
  if (!preview) return;

  preview.style.display = 'flex';
  if (naamEl) naamEl.textContent = naam;

  if (sporzaFoto) {
    // Sporza heeft al een foto
    if (img) { img.src = sporzaFoto; img.style.display = ''; }
    if (status) status.textContent = '📸 Foto via Sporza WM';
  } else {
    // Wikipedia / PCS opzoeken
    if (img) { img.src = ''; img.style.display = 'none'; }
    if (status) status.innerHTML = '<span class="text-muted">🔍 Foto opzoeken via Wikipedia…</span>';
    try {
      const data = await get(`/api/renners/opzoeken-foto?naam=${encodeURIComponent(naam)}`);
      if (data.foto) {
        if (fo) fo.value = data.foto;
        if (img) { img.src = data.foto; img.style.display = ''; }
        const bron = data.foto.includes('wikipedia') ? 'Wikipedia' : 'ProCyclingStats';
        if (status) status.textContent = `📸 Foto via ${bron}`;
      } else {
        if (img) img.style.display = 'none';
        if (status) status.textContent = 'Geen foto gevonden — kan manueel worden toegevoegd.';
      }
    } catch {
      if (img) img.style.display = 'none';
      if (status) status.textContent = 'Foto opzoeken mislukt.';
    }
  }
}

function editRenner(rid) {
  const r = state.renners.find(x => x.id === rid);
  if (!r) return;
  openModal(`
    <div class="modal-title">Renner Bewerken</div>
    <div class="form-group" style="margin-bottom:16px">
      <label class="form-label">Foto</label>
      <div style="display:flex;align-items:center;gap:14px">
        ${r.foto
          ? `<img src="${r.foto}" class="renner-avatar renner-avatar-lg" id="foto-preview-${r.id}" />`
          : `<div class="renner-avatar renner-avatar-lg renner-avatar-placeholder" id="foto-preview-${r.id}">👤</div>`}
        <div>
          <input type="file" id="foto-input-${r.id}" accept="image/*" style="display:none"
            onchange="uploadRennerFoto(${r.id})" />
          <button type="button" class="btn btn-secondary btn-sm"
            onclick="document.getElementById('foto-input-${r.id}').click()">
            📷 Foto uploaden
          </button>
          <div class="text-muted fs-sm" style="margin-top:5px">${r.foto ? 'Foto aanwezig' : 'Nog geen foto'}</div>
        </div>
      </div>
    </div>
    <form id="edit-renner-form">
      <div class="form-row">
        <div class="form-group"><label class="form-label">Naam</label>
          <input class="form-input" name="naam" value="${r.naam}" required /></div>
        <div class="form-group"><label class="form-label">Wielerploeg</label>
          <input class="form-input" name="ploeg" value="${r.ploeg}" required /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Rol</label>
          <select class="form-input" name="rol">
            ${['sprinter','klimmer','allrounder','tijdrijder','helper'].map(rol =>
              `<option value="${rol}" ${r.rol===rol?'selected':''}>${rol}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Prijs (€M)</label>
          <input class="form-input" name="prijs" type="number" min="0.5" max="30" step="0.5" value="${r.prijs}" /></div>
      </div>
      <div class="form-group"><label class="form-label">Totaal Punten (handmatig)</label>
        <input class="form-input" name="totaal_punten" type="number" min="0" value="${r.totaal_punten}" /></div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button type="submit" class="btn btn-primary" style="flex:1">Opslaan</button>
        <button type="button" class="btn btn-danger" onclick="verwijderRenner(${r.id},'${r.naam.replace(/'/g,"\\'")}')">Verwijderen</button>
      </div>
    </form>
  `);
  document.getElementById('edit-renner-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await put(`/api/renners/${rid}`, Object.fromEntries(new FormData(e.target)));
      toast('Renner bijgewerkt', 'success');
      closeModal(); await refreshAll();
    } catch(err) { toast(err.message, 'error'); }
  });
}

async function uploadRennerFoto(rid) {
  const input = document.getElementById(`foto-input-${rid}`);
  if (!input || !input.files.length) return;
  const formData = new FormData();
  formData.append('foto', input.files[0]);
  try {
    const res = await fetch(`/api/renners/${rid}/foto`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload mislukt');
    toast('Foto opgeslagen ✅', 'success');
    // Update preview in modal
    const preview = document.getElementById(`foto-preview-${rid}`);
    if (preview) {
      const img = document.createElement('img');
      img.src = `${data.foto}?t=${Date.now()}`;
      img.className = 'renner-avatar renner-avatar-lg';
      img.id = `foto-preview-${rid}`;
      preview.replaceWith(img);
    }
    // Update lokale state
    const r = state.renners.find(r => r.id === rid);
    if (r) r.foto = data.foto;
  } catch(e) { toast(e.message, 'error'); }
}

async function verwijderRenner(rid, naam) {
  if (!confirm(`${naam} verwijderen?`)) return;
  try {
    await del(`/api/renners/${rid}`);
    toast(`${naam} verwijderd`, 'success');
    closeModal(); await refreshAll();
  } catch(e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Koersen
// ═══════════════════════════════════════════════════════════════════════════
function renderKoersen() {
  const komend = state.koersen.filter(k => k.afgelopen !== 1);
  const afgelopen = state.koersen.filter(k => k.afgelopen === 1);

  function koersTable(arr) {
    if (!arr.length) return '<div class="text-muted fs-sm mt-12">Geen wedstrijden</div>';
    return `<div class="table-wrap"><table>
      <thead><tr><th>Wedstrijd</th><th>Datum</th><th class="col-mob-hide">Type</th><th>Opstelling</th><th class="col-mob-hide">Mijn Punten</th><th></th></tr></thead>
      <tbody>
        ${arr.map(k => `<tr onclick="openKoersDetail(${k.id})" style="cursor:pointer">
          <td class="fw-700">${k.naam}</td>
          <td class="koers-date">${fmtDate(k.datum)}</td>
          <td class="col-mob-hide">${soortBadge(k.soort)}${k.afstand ? ` &nbsp;<span class="text-muted" style="font-size:0.77rem">${k.afstand} km</span>` : ''}${k.hoogtemeters ? ` &nbsp;<span class="text-muted" style="font-size:0.77rem">↑${Number(k.hoogtemeters).toLocaleString()} m</span>` : ''}</td>
          <td>
            ${k.opstelling_aantal > 0
              ? `<span class="text-green fw-700">${k.opstelling_aantal}/12</span>`
              : '<span class="text-muted fs-sm">—</span>'}
          </td>
          <td class="col-mob-hide">${k.mijn_punten > 0 ? `<span class="fw-700 text-green">${k.mijn_punten}</span>` : '<span class="text-muted">—</span>'}</td>
          <td onclick="event.stopPropagation()"><div class="flex gap-8">
            <button class="btn btn-sm btn-secondary btn-mob-hide" onclick="openOpstelling(${k.id},'${k.naam.replace(/'/g,"\\'")}')">👥 Opstelling</button>
            <button class="btn btn-sm btn-secondary btn-mob-hide" onclick="openResultaten(${k.id},'${k.naam.replace(/'/g,"\\'")}','${k.soort}')">📝 Resultaten</button>
            ${k.afgelopen === 1
              ? `<button class="btn btn-sm btn-secondary btn-mob-hide" onclick="markeerDoorgezet(${k.id})" title="Zet terug naar doorgezet">↩ Doorgezet</button>`
              : k.afgelopen === 2
                ? `<button class="btn btn-sm btn-success btn-mob-hide" onclick="markeerAfgelopen(${k.id})">✓ Afgelopen</button>
                   <button class="btn btn-sm btn-secondary btn-mob-hide" onclick="markeerActief(${k.id})" title="Zet terug als komende wedstrijd">↩ Heropen</button>`
                : `<button class="btn btn-sm btn-success btn-mob-hide" onclick="markeerAfgelopen(${k.id})">✓ Afgelopen</button>`}
            <button class="btn btn-sm btn-danger" onclick="verwijderKoers(${k.id},'${k.naam.replace(/'/g,"\\'")}')">✕</button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Wedstrijden</div>
        <div class="page-subtitle">${state.koersen.filter(k=>!k.afgelopen).length} komend · ${komend.filter(k=>k.afgelopen===2).length} doorgezet · ${afgelopen.length} afgelopen · ${state.koersen.length} totaal</div>
      </div>
      <button class="btn btn-primary" onclick="openNieuweKoers()">+ Wedstrijd Toevoegen</button>
    </div>
    <div class="card"><div class="card-title">📅 Komende Wedstrijden (${komend.length})</div>${koersTable(komend)}</div>
    <div class="card mt-20"><div class="card-title">✅ Afgelopen Wedstrijden (${afgelopen.length})</div>${koersTable(afgelopen)}</div>
  `;
}

// ── Opstelling per koers ──────────────────────────────────────────────────────

async function openOpstelling(kid, naam) {
  const data = await get(`/api/koersen/${kid}/opstelling`);
  const max = data.max_opstelling;
  const renners = data.renners;
  const kopman = renners.find(r => r.is_kopman);

  openModal(`
    <div class="modal-title">👥 Opstelling – ${naam}</div>
    <div class="text-muted fs-sm" style="margin-bottom:12px">
      Selecteer max <strong>${max} renners</strong> voor de opstelling en duid één als <strong>kopman</strong> aan.
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg3);border-radius:8px;margin-bottom:12px">
      <span>Geselecteerd: <strong id="opstelling-teller">${data.huidig_aantal}</strong> / ${max}</span>
      <span id="kopman-label" class="${kopman ? 'text-accent fw-700' : 'text-muted fs-sm'}">
        ${kopman ? `⭐ Kopman: ${kopman.naam}` : 'Nog geen kopman'}
      </span>
    </div>
    <div class="table-wrap" style="max-height:380px;overflow-y:auto">
      <table>
        <thead><tr>
          <th style="width:36px;text-align:center">In</th>
          <th style="width:32px"></th>
          <th>Naam</th>
          <th class="text-muted" style="font-size:0.78rem">Ploeg</th>
          <th>Prijs</th>
          <th style="width:60px;text-align:center">Kopman</th>
        </tr></thead>
        <tbody>
          ${renners.map(r => `<tr id="ops-row-${r.id}">
            <td style="text-align:center">
              <input type="checkbox" id="ops-${r.id}" ${r.in_opstelling ? 'checked' : ''}
                onchange="updateOpstellingUI(${max})" />
            </td>
            <td style="padding-right:0">${avatarHtml(r)}</td>
            <td class="fw-700" style="cursor:pointer" ondblclick="openRennerDetail(${r.id})">${r.naam}</td>
            <td class="text-muted fs-sm"><span style="display:inline-flex;align-items:center;gap:5px">${jerseyHtml(r.renner_ploeg,{size:18})}${r.renner_ploeg}</span></td>
            <td class="price-tag">${fmtPrijs(r.prijs)}</td>
            <td style="text-align:center">
              <input type="radio" name="kopman-radio" id="kop-${r.id}" value="${r.id}"
                ${r.is_kopman ? 'checked' : ''}
                onchange="updateKopmanLabel('${r.naam.replace(/'/g,"\\'")}',${r.id})" />
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:16px">
      <button class="btn btn-primary" style="width:100%" onclick="slaOpstellingOp(${kid},${max})">
        💾 Opstelling Opslaan
      </button>
    </div>
  `);
}

function updateOpstellingUI(max) {
  const checked = document.querySelectorAll('[id^="ops-"]:checked').length;
  const teller = document.getElementById('opstelling-teller');
  if (teller) {
    teller.textContent = checked;
    teller.style.color = checked > max ? 'var(--red)' : checked === max ? 'var(--green)' : '';
  }
}

function updateKopmanLabel(naam) {
  const el = document.getElementById('kopman-label');
  if (el) {
    el.textContent = `⭐ Kopman: ${naam}`;
    el.className = 'text-accent fw-700';
  }
}

async function slaOpstellingOp(kid, max) {
  const checkboxes = document.querySelectorAll('[id^="ops-"]');
  const renner_ids = Array.from(checkboxes)
    .filter(cb => cb.checked)
    .map(cb => parseInt(cb.id.replace('ops-', '')));

  if (renner_ids.length > max) {
    toast(`Maximaal ${max} renners in de opstelling`, 'error');
    return;
  }

  const kopmanRadio = document.querySelector('[name="kopman-radio"]:checked');
  const kopman_id = kopmanRadio ? parseInt(kopmanRadio.value) : null;

  if (renner_ids.length > 0 && !kopman_id) {
    toast('Kies een kopman voor de opstelling', 'error');
    return;
  }

  if (kopman_id && !renner_ids.includes(kopman_id)) {
    toast('De kopman moet in de opstelling staan', 'error');
    return;
  }

  try {
    await post(`/api/koersen/${kid}/opstelling`, { renner_ids, kopman_id });
    toast(`Opstelling opgeslagen (${renner_ids.length} renners)`, 'success');
    closeModal();
    await refreshKoersen();
  } catch(e) { toast(e.message, 'error'); }
}

// ── Koersen hulpfuncties ──────────────────────────────────────────────────────

function openNieuweKoers() {
  openModal(`
    <div class="modal-title">Wedstrijd Toevoegen</div>
    <form id="nieuw-koers-form">
      <div class="form-group"><label class="form-label">Naam *</label>
        <input class="form-input" name="naam" required placeholder="Naam van de wedstrijd" /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Datum *</label>
          <input class="form-input" name="datum" type="date" required /></div>
        <div class="form-group"><label class="form-label">Type *</label>
          <select class="form-input" name="soort" required>
            <option value="monument">Monument</option>
            <option value="worldtour">World Tour</option>
            <option value="niet_wt" selected>Niet-WorldTour</option>
          </select></div>
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Toevoegen</button>
    </form>
  `);
  document.getElementById('nieuw-koers-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await post('/api/koersen', Object.fromEntries(new FormData(e.target)));
      toast('Wedstrijd toegevoegd', 'success');
      closeModal(); await refreshKoersen();
    } catch(err) { toast(err.message, 'error'); }
  });
}

async function markeerAfgelopen(kid) {
  try {
    await put(`/api/koersen/${kid}`, { afgelopen: 1 });
    toast('Wedstrijd afgelopen', 'success');
    await refreshKoersen();
  } catch(e) { toast(e.message, 'error'); }
}

async function markeerActief(kid) {
  try {
    await put(`/api/koersen/${kid}`, { afgelopen: 0 });
    toast('Wedstrijd terug actief gezet', 'success');
    await refreshKoersen();
  } catch(e) { toast(e.message, 'error'); }
}

async function markeerDoorgezet(kid) {
  try {
    await put(`/api/koersen/${kid}`, { afgelopen: 2 });
    toast('Wedstrijd terug naar doorgezet', 'success');
    await refreshKoersen();
  } catch(e) { toast(e.message, 'error'); }
}

async function fetchProfiel(kid) {
  const btn = document.getElementById(`profiel-btn-${kid}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Ophalen…'; }
  try {
    const data = await post(`/api/koersen/${kid}/fetch-profiel`, {});
    if (data.error) {
      toast(data.error, true);
      if (btn) { btn.disabled = false; btn.textContent = '📡 Ophalen van PCS'; }
    } else {
      const parts = [];
      if (data.afstand)      parts.push(`${data.afstand} km`);
      if (data.hoogtemeters) parts.push(`${Number(data.hoogtemeters).toLocaleString()} m`);
      toast(`Profiel opgehaald${parts.length ? ': ' + parts.join(' · ') : ' (geen data gevonden op PCS)'}`);
      await loadAll();
      renderPage();
    }
  } catch(e) {
    toast('Fout bij ophalen profiel', true);
    if (btn) { btn.disabled = false; btn.textContent = '📡 Ophalen van PCS'; }
  }
}

async function fetchFavorieten(kid) {
  const btn = document.getElementById(`fav-btn-${kid}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Ophalen…'; }
  try {
    const data = await post(`/api/koersen/${kid}/fetch-favorieten`, {});
    if (data.error) {
      toast(data.error, true);
      if (btn) { btn.disabled = false; btn.textContent = '📡 Ophalen van PCS'; }
    } else {
      toast(`${data.aantal} favorieten opgehaald van PCS`);
      await loadAll();
      renderPage();
    }
  } catch(e) {
    toast('Fout bij ophalen favorieten', true);
    if (btn) { btn.disabled = false; btn.textContent = '📡 Ophalen van PCS'; }
  }
}

async function verwijderKoers(kid, naam) {
  if (!confirm(`"${naam}" en alle resultaten verwijderen?`)) return;
  try {
    await del(`/api/koersen/${kid}`);
    toast('Wedstrijd verwijderd', 'success');
    if (state.page === 'koers-detail') {
      state.page = 'koersen';
      state.koersDetailId = null;
    }
    await refreshAll();
  } catch(e) { toast(e.message, 'error'); }
}

// ── Resultaten ────────────────────────────────────────────────────────────────

async function openResultaten(kid, naam, soort) {
  const [resultaten, opstellingData] = await Promise.all([
    get(`/api/koersen/${kid}/resultaten`),
    get(`/api/koersen/${kid}/opstelling`),
  ]);

  const opstellingRenners = opstellingData.renners.filter(r => r.in_opstelling);
  const kopman = opstellingRenners.find(r => r.is_kopman);
  const heeftOpstelling = opstellingRenners.length > 0;
  const soortLabel = { monument: 'Monument', worldtour: 'World Tour', niet_wt: 'Niet-WorldTour' }[soort] || soort;

  openModal(`
    <div class="modal-title">Resultaten – ${naam} <span class="badge badge-${soort}" style="font-size:0.75rem">${soortLabel}</span></div>
    <div class="tabs" id="resultaat-tabs">
      <button class="tab-btn active" onclick="switchResultaatTab('bekijk')">Bekijk</button>
      <button class="tab-btn" onclick="switchResultaatTab('invoer')">Invoer</button>
    </div>

    <div id="tab-bekijk">
      ${(() => {
          const koers = state.koersen.find(k => k.id === kid);
          const winnaarNaam = koers?.winnaar_naam;
          const winnaarFoto = koers?.winnaar_foto;
          const winnaarInPloeg = winnaarNaam
            ? resultaten.find(r => r.positie === 1 && r.in_mijn_ploeg)
            : null;
          const winnaarExtern = winnaarNaam && !winnaarInPloeg;
          const winnaarRij = winnaarExtern ? `
            <tr style="background:rgba(232,185,79,0.07);border-left:3px solid var(--gold,#e8b94f)">
              <td class="fw-700" style="color:var(--gold,#e8b94f)">1</td>
              <td style="width:32px;padding-right:0">${winnaarFoto
                ? `<img src="${winnaarFoto}" style="width:28px;height:28px;border-radius:50%;object-fit:cover">`
                : '<span style="font-size:1.1rem">🏆</span>'}</td>
              <td class="fw-700" style="color:var(--gold,#e8b94f)">
                🏆 ${winnaarNaam}
                <span class="text-muted fs-sm" style="font-weight:400;margin-left:4px">(niet in ploeg)</span>
              </td>
              <td class="text-muted">—</td><td class="text-muted">—</td><td class="text-muted">—</td>
              <td class="text-muted fw-700">0</td>
            </tr>` : '';

          if (resultaten.length === 0 && !winnaarNaam)
            return '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">Nog geen resultaten</div></div>';

          return `<div class="table-wrap" style="max-height:400px;overflow-y:auto"><table>
            <thead><tr><th>Pos</th><th></th><th>Naam</th><th>Basis</th><th>Kopman+</th><th>Ploegmaat+</th><th>Totaal</th></tr></thead>
            <tbody>
              ${winnaarRij}
              ${resultaten.map(r => {
                const isEchteWinnaar = winnaarNaam && r.positie === 1 && !winnaarExtern && winnaarInPloeg?.renner_id === r.renner_id;
                return `<tr ${!r.in_opstelling && r.in_mijn_ploeg ? 'style="opacity:0.45"' : ''}>
                  <td class="text-muted">${isEchteWinnaar ? '🏆' : (r.positie ?? '—')}</td>
                  <td style="width:32px;padding-right:0">${avatarHtml(r)}</td>
                  <td class="fw-700" ${r.in_mijn_ploeg ? `style="cursor:pointer" ondblclick="openRennerDetail(${r.renner_id})"` : ''}>${r.naam}
                    ${r.in_opstelling ? '<span class="in-ploeg-dot"></span>' : ''}
                    ${r.is_kopman ? ' ⭐' : ''}
                    ${r.in_mijn_ploeg && !r.in_opstelling ? ' <span class="text-muted fs-sm">(bus)</span>' : ''}
                  </td>
                  <td>${r.punten - r.bonuspunten_kopman - r.bonuspunten_ploegmaat}</td>
                  <td>${r.bonuspunten_kopman > 0 ? `<span class="text-accent">+${r.bonuspunten_kopman}</span>` : '—'}</td>
                  <td>${r.bonuspunten_ploegmaat > 0 ? `<span class="text-green">+${r.bonuspunten_ploegmaat}</span>` : '—'}</td>
                  <td class="fw-700 ${r.punten > 0 ? 'text-green' : 'text-muted'}">${r.punten}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>`;
        })()}
    </div>

    <div id="tab-invoer" style="display:none">
      ${!heeftOpstelling
        ? `<div style="padding:20px;text-align:center">
            <div style="font-size:2rem;margin-bottom:8px">👥</div>
            <div class="fw-700" style="margin-bottom:6px">Geen opstelling ingesteld</div>
            <div class="text-muted fs-sm" style="margin-bottom:16px">Stel eerst de opstelling in voor deze wedstrijd.</div>
            <button class="btn btn-primary" onclick="closeModal();openOpstelling(${kid},'${naam.replace(/'/g,"\\'")}')">
              Opstelling instellen →
            </button>
          </div>`
        : `<div style="padding:6px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
            <span class="text-muted fs-sm">Opstelling: </span>
            <strong>${opstellingRenners.length} renners</strong>
            ${kopman ? `&nbsp;·&nbsp; ⭐ Kopman: <strong>${kopman.naam}</strong>` : ''}
          </div>
          <div class="text-muted fs-sm" style="margin-bottom:12px">
            Geef de eindpositie (in de wedstrijd) voor renners in je opstelling die in de top 30 finishten.
          </div>
          <div id="bulk-invoer">
            <div style="display:grid;grid-template-columns:1fr 80px auto;gap:6px 10px;align-items:center;font-size:0.82rem;font-weight:600;color:var(--muted);padding:0 0 6px 0;border-bottom:1px solid var(--border);margin-bottom:8px">
              <span>Renner</span><span style="text-align:center">Positie</span><span style="text-align:center">Ploegmaat winnaar?</span>
            </div>
            ${opstellingRenners.map(r => `
              <div style="display:grid;grid-template-columns:1fr 80px auto;gap:6px 10px;align-items:center;margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:8px">${avatarHtml(r)}<span class="fw-700" style="font-size:0.88rem;cursor:pointer" ondblclick="openRennerDetail(${r.id})">${r.naam} ${r.is_kopman ? '⭐' : ''}</span></div>
                <input class="punten-input" type="number" min="1" max="200" placeholder="pos"
                  id="pos-${r.id}" style="width:60px;text-align:center" />
                <label style="display:flex;align-items:center;gap:4px;font-size:0.8rem;cursor:pointer">
                  <input type="checkbox" id="ploegmaat-${r.id}" /> +10
                </label>
              </div>
            `).join('')}
          </div>
          <div style="margin-top:16px">
            <button class="btn btn-primary" style="width:100%" onclick="slaResultatenOp(${kid},'${soort}')">
              💾 Opslaan & Punten Berekenen
            </button>
          </div>`}
    </div>
  `);
}

function switchResultaatTab(tab) {
  document.querySelectorAll('#resultaat-tabs .tab-btn').forEach((b, i) => {
    b.classList.toggle('active', ['bekijk','invoer'][i] === tab);
  });
  document.getElementById('tab-bekijk').style.display = tab === 'bekijk' ? '' : 'none';
  document.getElementById('tab-invoer').style.display = tab === 'invoer' ? '' : 'none';
}

async function slaResultatenOp(kid, soort) {
  const inputs = document.querySelectorAll('[id^="pos-"]');
  const bulk = Array.from(inputs).map(input => {
    const rid = parseInt(input.id.replace('pos-', ''));
    const pos = input.value ? parseInt(input.value) : null;
    if (!pos) return null;
    const ploegmaat = document.getElementById(`ploegmaat-${rid}`)?.checked || false;
    return { renner_id: rid, positie: pos, is_ploegmaat_winnaar: ploegmaat };
  }).filter(Boolean);

  if (!bulk.length) { toast('Geen posities ingevoerd', 'info'); return; }
  try {
    await post(`/api/koersen/${kid}/resultaten/bulk`, { renners: bulk });
    toast('Resultaten opgeslagen ✅', 'success');
    closeModal(); await refreshAll();
  } catch(e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Koers Detail
// ═══════════════════════════════════════════════════════════════════════════
async function renderKoersDetail() {
  const kid = state.koersDetailId;
  const koers = state.koersen.find(k => k.id === kid);
  if (!koers) return '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Wedstrijd niet gevonden</div></div>';

  const [opstellingData, resultaten, besteOps, favorieten] = await Promise.all([
    get(`/api/koersen/${kid}/opstelling`),
    get(`/api/koersen/${kid}/resultaten`),
    koers.afgelopen === 1 ? get(`/api/koersen/${kid}/beste-opstelling`) : Promise.resolve(null),
    get(`/api/koersen/${kid}/favorieten`).catch(() => []),
  ]);

  const max = opstellingData.max_opstelling;
  const renners = opstellingData.renners;
  const opstellingRenners = renners.filter(r => r.in_opstelling);
  const kopman = renners.find(r => r.is_kopman);
  const totaalPuntenKoers = resultaten
    .filter(r => r.in_opstelling)
    .reduce((s, r) => s + r.punten, 0);

  const heeftProfiel = koers.afstand || koers.hoogtemeters || koers.profiel_url;
  const profielCard = `
    <div class="card" style="margin-bottom:20px">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        🗺️ Wedstrijdprofiel
        <button class="btn btn-secondary btn-sm" id="profiel-btn-${kid}"
          onclick="fetchProfiel(${kid})">📡 Ophalen van PCS</button>
      </div>
      ${heeftProfiel ? `
        <div style="display:flex;gap:32px;margin-bottom:${koers.profiel_url ? '14px' : '0'};flex-wrap:wrap">
          ${koers.afstand ? `
            <div style="text-align:center;padding:4px 0">
              <div style="font-size:1.6rem;font-weight:700;color:var(--accent)">${koers.afstand} km</div>
              <div class="text-muted fs-sm">Totale afstand</div>
            </div>` : ''}
          ${koers.hoogtemeters ? `
            <div style="text-align:center;padding:4px 0">
              <div style="font-size:1.6rem;font-weight:700;color:var(--green)">${Number(koers.hoogtemeters).toLocaleString()} m</div>
              <div class="text-muted fs-sm">Hoogtemeters</div>
            </div>` : ''}
        </div>
        ${koers.profiel_url ? `
          <img src="${koers.profiel_url}" alt="Profiel ${koers.naam}"
            style="width:100%;border-radius:8px;max-height:220px;object-fit:contain;background:var(--bg2)"
            onerror="this.style.display='none'" />` : ''}
      ` : `
        <div class="empty-state" style="padding:16px 0">
          <div class="empty-icon" style="font-size:1.5rem">🗺️</div>
          <div class="empty-title" style="font-size:0.88rem">Nog geen profieldata</div>
          <div class="text-muted fs-sm">Klik "Ophalen van PCS" om afstand, hoogtemeters en profielfoto te laden.</div>
        </div>
      `}
    </div>`;

  // ── Favorietenkaart ──────────────────────────────────────────────────────
  function chipHtml(f) {
    const bg = f.inOpstelling
      ? 'background:rgba(232,185,79,0.18);border:1px solid rgba(232,185,79,0.45);color:var(--accent)'
      : f.inPloeg
        ? 'background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);color:var(--green)'
        : 'background:var(--bg3);border:1px solid var(--border);color:var(--text)';
    const badge = f.inOpstelling ? ' ★' : f.inPloeg ? ' ✓' : '';
    return `<span style="display:inline-flex;align-items:center;gap:3px;padding:4px 10px;border-radius:20px;font-size:0.8rem;font-weight:600;${bg}">${f.naam}${badge ? `<span style="font-size:0.75rem;opacity:0.85">${badge}</span>` : ''}</span>`;
  }
  const favorietenCard = `
    <div class="card" style="margin-bottom:20px">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        🎯 Favorieten${favorieten.length ? ` <span style="font-size:0.78rem;font-weight:400;color:var(--muted)">(${favorieten.length})</span>` : ''}
        <button class="btn btn-secondary btn-sm" id="fav-btn-${kid}"
          onclick="fetchFavorieten(${kid})">📡 Ophalen van PCS</button>
      </div>
      ${favorieten.length ? `
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${favorieten.map(chipHtml).join('')}
        </div>
        <div class="text-muted fs-sm" style="margin-top:8px">
          ${favorieten.filter(f=>f.inOpstelling).length ? `<span style="color:var(--accent)">★ in opstelling</span>&nbsp;&nbsp;` : ''}${favorieten.filter(f=>f.inPloeg&&!f.inOpstelling).length ? `<span style="color:var(--green)">✓ in ploeg (niet in opstelling)</span>` : ''}
        </div>
      ` : `
        <div class="empty-state" style="padding:16px 0">
          <div class="empty-icon" style="font-size:1.5rem">🎯</div>
          <div class="empty-title" style="font-size:0.88rem">Nog geen favorieten</div>
          <div class="text-muted fs-sm">Klik "Ophalen van PCS" om de top-candidates te laden.</div>
        </div>
      `}
    </div>`;

  return `
    <div class="page-header">
      <div>
        <div class="page-title">${koers.naam}</div>
        <div class="page-subtitle" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${fmtDate(koers.datum)} &nbsp;·&nbsp; ${soortBadge(koers.soort)}
            &nbsp;·&nbsp; ${koers.afgelopen === 2
              ? '<span class="badge" style="background:rgba(96,165,250,0.15);color:var(--accent)">📤 Doorgezet</span>'
              : koers.afgelopen
                ? '<span class="badge" style="background:rgba(156,163,175,0.15);color:var(--muted)">✓ Afgelopen</span>'
                : '<span class="badge" style="background:rgba(74,222,128,0.15);color:var(--green)">Komend</span>'}
            ${koers.afgelopen && totaalPuntenKoers > 0
              ? `&nbsp;·&nbsp; <span class="badge" style="background:rgba(74,222,128,0.15);color:var(--green);font-weight:700">🏆 ${totaalPuntenKoers} pt</span>`
              : ''}
            ${koers.winnaar_naam
              ? `&nbsp;·&nbsp; <span style="display:inline-flex;align-items:center;gap:6px">
                  ${koers.winnaar_foto ? `<img src="${koers.winnaar_foto}" style="width:20px;height:20px;border-radius:50%;object-fit:cover">` : ''}
                  <span style="font-size:0.85rem">🏆 <strong>${koers.winnaar_naam}</strong></span>
                </span>`
              : ''}
          </div>
        </div>
      </div>
      <div class="flex gap-8" style="flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="openDeelnemers(${kid})">🔍 Deelnemers</button>
        ${koers.afgelopen !== 2 ? `<button class="btn btn-secondary btn-sm" onclick="openDoorzettenSporza(${kid})">🚀 Doorzetten</button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="openUitslagPCS(${kid})">📊 Uitslag</button>
        ${koers.afgelopen === 1
          ? `<button class="btn btn-secondary btn-sm" onclick="markeerDoorgezet(${kid})">↩ Doorgezet</button>`
          : koers.afgelopen === 2
            ? `<button class="btn btn-success btn-sm" onclick="markeerAfgelopen(${kid})">✓ Afgelopen</button>
               <button class="btn btn-secondary btn-sm" onclick="markeerActief(${kid})">↩ Heropen</button>`
            : `<button class="btn btn-success btn-sm" onclick="markeerAfgelopen(${kid})">✓ Afgelopen</button>`}
        <button class="btn btn-danger btn-sm" onclick="verwijderKoers(${kid},'${koers.naam.replace(/'/g,"\\'")}')">✕ Verwijder</button>
      </div>
    </div>

    ${favorietenCard}

    ${profielCard}

    <div class="grid-2">

      <!-- ── Opstelling ───────────────────────────────────────── -->
      <div class="card">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
          👥 Opstelling
          <span id="detail-ops-teller" style="font-size:0.85rem;font-weight:400;color:${opstellingData.huidig_aantal === max ? 'var(--green)' : 'var(--muted)'}">
            ${opstellingData.huidig_aantal} / ${max}
          </span>
        </div>
        ${kopman
          ? `<div style="margin:0 0 10px;padding:8px 12px;background:rgba(232,185,79,0.12);border:1px solid rgba(232,185,79,0.3);border-radius:8px;font-size:0.85rem">
              ⭐ Kopman: <strong>${kopman.naam}</strong>
             </div>`
          : `<div style="margin:0 0 10px;padding:8px 12px;background:rgba(239,68,68,0.08);border-radius:8px;font-size:0.82rem;color:var(--muted)">
              Nog geen kopman aangeduid
             </div>`}
        ${koers.afgelopen
          ? `<div class="text-muted fs-sm" style="margin-bottom:10px">De opstelling is afgesloten.${koers.afgelopen === 2 ? ' Zet terug naar Komend om te bewerken.' : ''}</div>`
          : `<div class="text-muted fs-sm" style="margin-bottom:10px">Selecteer max ${max} renners en duid één als kopman aan.</div>`}
        <div class="table-wrap" style="max-height:420px;overflow-y:auto">
          <table>
            <thead><tr>
              <th style="width:36px;text-align:center">In</th>
              <th style="width:32px"></th>
              <th>Naam</th>
              <th class="text-muted" style="font-size:0.78rem">Ploeg</th>
              <th style="width:60px;text-align:center">⭐</th>
            </tr></thead>
            <tbody>
              ${renners.map(r => `<tr>
                <td style="text-align:center">
                  <input type="checkbox" id="det-ops-${r.id}" ${r.in_opstelling ? 'checked' : ''}
                    ${koers.afgelopen ? 'disabled' : `onchange="updateDetailOpstellingUI(${max})"`} />
                </td>
                <td style="padding-right:0">${avatarHtml(r)}</td>
                <td class="fw-700" style="cursor:pointer" ondblclick="openRennerDetail(${r.id})">${r.naam}</td>
                <td class="text-muted fs-sm"><span style="display:inline-flex;align-items:center;gap:5px">${jerseyHtml(r.renner_ploeg,{size:18})}${r.renner_ploeg}</span></td>
                <td style="text-align:center">
                  <input type="radio" name="det-kopman-radio" value="${r.id}"
                    ${r.is_kopman ? 'checked' : ''}
                    ${koers.afgelopen || !r.in_opstelling ? 'disabled style="opacity:0.3"' : ''} />
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${!koers.afgelopen ? `
          ${opstellingData.huidig_aantal === 0 ? `
            <button class="btn btn-secondary" style="width:100%;margin-bottom:8px"
              onclick="kopieerOpstelling(${kid})">
              📋 Kopieer van vorige wedstrijd
            </button>` : ''}
          <button class="btn btn-primary" style="width:100%;margin-top:6px"
            onclick="slaDetailOpstellingOp(${kid},${max})">
            💾 Opstelling Opslaan
          </button>` : ''}
      </div>

      <!-- ── Resultaten ──────────────────────────────────────── -->
      <div class="card">
        <div class="card-title">📝 Resultaten</div>
        <div class="tabs" id="detail-resultaat-tabs" style="margin-bottom:14px">
          <button class="tab-btn active" onclick="switchDetailResultaatTab('bekijk')">Bekijk</button>
          <button class="tab-btn" onclick="switchDetailResultaatTab('invoer')">Invoer</button>
        </div>

        <div id="det-tab-bekijk">
          ${resultaten.length === 0 && !koers.winnaar_naam
            ? '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">Nog geen resultaten</div></div>'
            : (() => {
                // Echte winnaar: is die al in de resultaten-lijst (als ploegrenner)?
                const winnaarInPloeg = koers.winnaar_naam
                  ? resultaten.find(r => r.naam === koers.winnaar_naam || (r.positie === 1 && r.in_mijn_ploeg))
                  : null;
                const winnaarExtern = koers.winnaar_naam && !winnaarInPloeg;

                const winnaarRij = winnaarExtern ? `
                  <tr style="background:rgba(232,185,79,0.07);border-left:3px solid var(--gold,#e8b94f)">
                    <td class="fw-700" style="color:var(--gold,#e8b94f)">1</td>
                    <td style="width:32px;padding-right:0">${koers.winnaar_foto
                      ? `<img src="${koers.winnaar_foto}" style="width:28px;height:28px;border-radius:50%;object-fit:cover">`
                      : '<span style="font-size:1.1rem">🏆</span>'}</td>
                    <td class="fw-700" style="color:var(--gold,#e8b94f)">
                      🏆 ${koers.winnaar_naam}
                      <span class="text-muted fs-sm" style="font-weight:400;margin-left:4px">(niet in ploeg)</span>
                    </td>
                    <td class="text-muted">—</td><td class="text-muted">—</td><td class="text-muted">—</td>
                    <td class="text-muted fw-700">0</td>
                  </tr>` : '';

                return `<div class="table-wrap" style="max-height:480px;overflow-y:auto"><table>
                  <thead><tr><th>Pos</th><th></th><th>Naam</th><th>Basis</th><th>Kop+</th><th>Ploeg+</th><th>Totaal</th></tr></thead>
                  <tbody>
                    ${winnaarRij}
                    ${resultaten.map(r => {
                      const isEchteWinnaar = koers.winnaar_naam && r.positie === 1 && !winnaarExtern && winnaarInPloeg?.renner_id === r.renner_id;
                      return `<tr ${!r.in_opstelling && r.in_mijn_ploeg ? 'style="opacity:0.45"' : ''}>
                        <td class="text-muted">${isEchteWinnaar ? '🏆' : (r.positie ?? '—')}</td>
                        <td style="width:32px;padding-right:0">${avatarHtml(r)}</td>
                        <td class="fw-700" ${r.in_mijn_ploeg ? `style="cursor:pointer" ondblclick="openRennerDetail(${r.renner_id})"` : ''}>${r.naam}
                          ${r.in_opstelling ? '<span class="in-ploeg-dot"></span>' : ''}
                          ${r.is_kopman ? ' ⭐' : ''}
                          ${r.in_mijn_ploeg && !r.in_opstelling ? ' <span class="text-muted fs-sm">(bus)</span>' : ''}
                        </td>
                        <td>${r.punten - r.bonuspunten_kopman - r.bonuspunten_ploegmaat}</td>
                        <td>${r.bonuspunten_kopman > 0 ? `<span class="text-accent">+${r.bonuspunten_kopman}</span>` : '—'}</td>
                        <td>${r.bonuspunten_ploegmaat > 0 ? `<span class="text-green">+${r.bonuspunten_ploegmaat}</span>` : '—'}</td>
                        <td class="fw-700 ${r.punten > 0 ? 'text-green' : 'text-muted'}">${r.punten}</td>
                      </tr>`;
                    }).join('')}
                  </tbody>
                </table></div>`;
              })()}
        </div>

        <div id="det-tab-invoer" style="display:none">
          ${opstellingRenners.length === 0
            ? `<div style="padding:20px;text-align:center">
                <div style="font-size:2rem;margin-bottom:8px">👥</div>
                <div class="fw-700" style="margin-bottom:6px">Geen opstelling ingesteld</div>
                <div class="text-muted fs-sm">Stel eerst de opstelling in (links).</div>
              </div>`
            : `<div style="padding:6px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
                <span class="text-muted fs-sm">Opstelling: </span>
                <strong>${opstellingRenners.length} renners</strong>
                ${kopman ? `&nbsp;·&nbsp; ⭐ Kopman: <strong>${kopman.naam}</strong>` : ''}
              </div>
              <div class="text-muted fs-sm" style="margin-bottom:12px">
                Geef de eindpositie voor renners die in de top 30 finishten.
              </div>
              <div style="display:grid;grid-template-columns:1fr 80px auto;gap:6px 10px;align-items:center;font-size:0.82rem;font-weight:600;color:var(--muted);padding:0 0 6px 0;border-bottom:1px solid var(--border);margin-bottom:8px">
                <span>Renner</span><span style="text-align:center">Positie</span><span style="text-align:center">Ploegmaat winnaar?</span>
              </div>
              ${opstellingRenners.map(r => `
                <div style="display:grid;grid-template-columns:1fr 80px auto;gap:6px 10px;align-items:center;margin-bottom:8px">
                  <div style="display:flex;align-items:center;gap:8px">${avatarHtml(r)}<span class="fw-700" style="font-size:0.88rem;cursor:pointer" ondblclick="openRennerDetail(${r.id})">${r.naam} ${r.is_kopman ? '⭐' : ''}</span></div>
                  <input class="punten-input" type="number" min="1" max="200" placeholder="pos"
                    id="det-pos-${r.id}" style="width:60px;text-align:center" />
                  <label style="display:flex;align-items:center;gap:4px;font-size:0.8rem;cursor:pointer">
                    <input type="checkbox" id="det-ploegmaat-${r.id}" /> +10
                  </label>
                </div>
              `).join('')}
              <div style="margin-top:16px">
                <button class="btn btn-primary" style="width:100%" onclick="slaDetailResultatenOp(${kid},'${koers.soort}')">
                  💾 Opslaan & Punten Berekenen
                </button>
              </div>`}
        </div>
      </div>

    </div>

    ${besteOps && besteOps.beste && besteOps.beste.length > 0 ? `
    <div class="card mt-20">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        🏆 Beste Opstelling Achteraf
        <span style="font-size:0.85rem;font-weight:400;color:var(--green)">${besteOps.beste_punten} pt max</span>
      </div>
      <div class="text-muted fs-sm" style="margin-bottom:10px">
        Top ${besteOps.max} renners uit jouw ploeg op basis van behaalde punten:
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th></th><th>Naam</th><th>Rol</th><th>Punten</th><th>In opstelling</th></tr></thead>
          <tbody>
            ${besteOps.beste.map((r, i) => `<tr ${!r.in_opstelling && r.punten === 0 ? 'style="opacity:0.45"' : ''}>
              <td class="text-muted">${i+1}</td>
              <td style="width:32px;padding-right:0">${avatarHtml(r)}</td>
              <td class="fw-700" style="cursor:pointer" ondblclick="openRennerDetail(${r.id})">${r.naam}</td>
              <td>${rolBadge(r.rol)}</td>
              <td class="fw-700 ${r.punten > 0 ? 'text-green' : 'text-muted'}">${r.punten}</td>
              <td style="text-align:center">${r.in_opstelling
                ? '<span style="color:var(--green);font-weight:700">✓</span>'
                : '<span style="color:var(--red)">✗</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `;
}

// ── Kopieer opstelling van vorige wedstrijd ─────────────────────────────────

async function kopieerOpstelling(kid) {
  const sorted = [...state.koersen].sort((a, b) => a.datum.localeCompare(b.datum));
  const idx = sorted.findIndex(k => k.id === kid);
  let prevKoers = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (sorted[i].opstelling_aantal > 0) { prevKoers = sorted[i]; break; }
  }
  if (!prevKoers) { toast('Geen vorige opstelling gevonden', 'info'); return; }

  try {
    const [prevData, currData] = await Promise.all([
      get(`/api/koersen/${prevKoers.id}/opstelling`),
      get(`/api/koersen/${kid}/opstelling`),
    ]);
    const prevIds = prevData.renners.filter(r => r.in_opstelling).map(r => r.id);
    const prevKopman = prevData.renners.find(r => r.is_kopman);
    const currIds = new Set(currData.renners.map(r => r.id));

    const filteredIds = prevIds.filter(id => currIds.has(id));
    const filteredKopman = prevKopman && currIds.has(prevKopman.id) ? prevKopman.id : (filteredIds[0] || null);

    if (!filteredIds.length) { toast('Geen renners van de vorige opstelling zitten nog in je ploeg', 'info'); return; }

    await post(`/api/koersen/${kid}/opstelling`, { renner_ids: filteredIds, kopman_id: filteredKopman });
    toast(`Opstelling gekopieerd van "${prevKoers.naam}" (${filteredIds.length} renners)`, 'success');
    state.koersen = await get('/api/koersen');
    renderPage();
  } catch(e) { toast(e.message, 'error'); }
}

// ── Deelnemers (PCS startlijst) ────────────────────────────────────────────────

async function openDeelnemers(kid) {
  const koers = state.koersen.find(k => k.id === kid);
  openModal(`
    <div class="modal-title">🔍 Deelnemers – ${koers?.naam || ''}</div>
    <div class="text-muted fs-sm" style="margin:12px 0">Startlijst laden van ProCyclingStats...</div>
    <div style="text-align:center;padding:30px;font-size:2rem">⏳</div>
  `);
  try {
    const data = await get(`/api/koersen/${kid}/deelnemers`);
    const bevestigd = data.renners.filter(r => r.bevestigd);
    const niet = data.renners.filter(r => !r.bevestigd);

    openModal(`
      <div class="modal-title">🔍 Deelnemers – ${data.koers.naam}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        <span class="badge" style="background:rgba(74,222,128,0.15);color:var(--green);font-size:0.82rem;padding:5px 10px">
          ✓ ${bevestigd.length} van ${data.renners.length} bevestigd
        </span>
        <span class="badge" style="background:rgba(239,68,68,0.08);color:var(--muted);font-size:0.82rem;padding:5px 10px">
          ✗ ${niet.length} niet gevonden
        </span>
        <a href="${data.url}" target="_blank" style="margin-left:auto;font-size:0.78rem;color:var(--muted);text-decoration:none">
          📎 PCS ${data.bron || 'startlijst'} ↗
        </a>
      </div>
      <div class="table-wrap" style="max-height:360px;overflow-y:auto"><table>
        <thead><tr><th></th><th>Naam</th><th>Rol</th><th>Prijs</th><th>Status</th></tr></thead>
        <tbody>
          ${data.renners.map(r => `<tr>
            <td style="width:36px;padding-right:0">${avatarHtml(r)}</td>
            <td class="fw-700">${r.naam}</td>
            <td>${rolBadge(r.rol)}</td>
            <td class="price-tag">${fmtPrijs(r.prijs)}</td>
            <td>${r.bevestigd
              ? '<span style="color:var(--green);font-weight:700">✓ Bevestigd</span>'
              : '<span style="color:var(--muted);font-size:0.82rem">— Niet gevonden</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      ${bevestigd.length > 0 ? `
        <div style="margin-top:14px;padding:10px 14px;background:var(--bg3);border-radius:8px;font-size:0.84rem">
          <strong>Voorgestelde opstelling:</strong> ${data.suggestie_opstelling.length} renners
          ${data.suggestie_kopman
            ? `&nbsp;·&nbsp; ⭐ Kopman: <strong>${data.renners.find(r => r.id === data.suggestie_kopman)?.naam || ''}</strong>`
            : ''}
        </div>
        <button class="btn btn-primary" style="width:100%;margin-top:10px"
          onclick="pasteDeelnemersOpstelling(${kid},${JSON.stringify(data.suggestie_opstelling)},${data.suggestie_kopman})">
          👥 Opstelling opmaken van bevestigde renners
        </button>
      ` : ''}
    `);
  } catch(e) {
    openModal(`
      <div class="modal-title">🔍 Deelnemers</div>
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-title">Kon startlijst niet laden</div>
        <div class="empty-text">${e.message}</div>
      </div>
    `);
  }
}

async function pasteDeelnemersOpstelling(kid, renner_ids, kopman_id) {
  try {
    await post(`/api/koersen/${kid}/opstelling`, { renner_ids, kopman_id });
    toast(`Opstelling opgeslagen (${renner_ids.length} bevestigde renners)`, 'success');
    closeModal();
    state.koersen = await get('/api/koersen');
    renderPage();
  } catch(e) { toast(e.message, 'error'); }
}

// ── Uitslag ophalen (PCS) ──────────────────────────────────────────────────────

async function openUitslagPCS(kid) {
  const koers = state.koersen.find(k => k.id === kid);
  openModal(`
    <div class="modal-title">📊 Uitslag ophalen – ${koers?.naam || ''}</div>
    <div class="text-muted fs-sm" style="margin:12px 0">Uitslag laden van ProCyclingStats...</div>
    <div style="text-align:center;padding:20px">⏳</div>
  `);
  try {
    const data = await get(`/api/koersen/${kid}/uitslag-pcs`);
    const opstelling = data.renners.filter(r => r.in_opstelling);
    const bus = data.renners.filter(r => !r.in_opstelling);
    const totaalPunten = opstelling.reduce((s, r) => s + r.totaal, 0);

    openModal(`
      <div class="modal-title">📊 Uitslag – ${data.koers.naam}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        <span style="font-size:0.85rem">🏆 <strong>${data.winnaar || '—'}</strong>
          ${data.winnaar_ploeg ? `<span class="text-muted fs-sm" style="display:inline-flex;align-items:center;gap:4px">${jerseyHtml(data.winnaar_ploeg,{size:16})}(${data.winnaar_ploeg})</span>` : ''}
        </span>
        <span class="badge" style="background:rgba(74,222,128,0.15);color:var(--green);font-size:0.82rem;margin-left:auto">
          +${totaalPunten} pt voor jouw ploeg
        </span>
        <a href="${data.url}" target="_blank" style="font-size:0.78rem;color:var(--muted);text-decoration:none">📎 PCS uitslag ↗</a>
      </div>

      <div class="table-wrap" style="max-height:370px;overflow-y:auto"><table>
        <thead><tr>
          <th style="width:32px"></th><th>Naam</th>
          <th style="text-align:center">Pos</th>
          <th style="text-align:right">Basis</th>
          <th style="text-align:right">Kop+</th>
          <th style="text-align:right;white-space:nowrap">Ploeg+ <span class="text-muted fs-sm">(✎)</span></th>
          <th style="text-align:right">Tot</th>
        </tr></thead>
        <tbody>
          ${opstelling.map(r => `<tr>
            <td style="padding-right:0">${avatarHtml(r)}</td>
            <td class="fw-700" style="cursor:pointer" ondblclick="openRennerDetail(${r.id})">${r.naam}${r.is_kopman ? ' ⭐' : ''}</td>
            <td style="text-align:center;color:var(--muted)">${r.positie ?? '—'}</td>
            <td style="text-align:right">${r.punten_basis || '—'}</td>
            <td style="text-align:right">${r.bonus_kopman > 0 ? `<span style="color:var(--accent)">+${r.bonus_kopman}</span>` : '—'}</td>
            <td style="text-align:right">
              <label style="display:flex;align-items:center;justify-content:flex-end;gap:4px;cursor:pointer;font-size:0.8rem">
                <input type="checkbox" id="ploegmaat-${r.id}" ${r.is_ploegmaat_winnaar ? 'checked' : ''}/>
                <span style="color:var(--green)">+10</span>
              </label>
            </td>
            <td style="text-align:right" class="fw-700 ${r.totaal > 0 ? 'text-green' : 'text-muted'}">${r.totaal}</td>
          </tr>`).join('')}
          ${bus.length > 0 ? `<tr><td colspan="7" style="padding:8px 0;color:var(--muted);font-size:0.78rem;border-top:1px solid var(--border)">
            Bus (geen punten): ${bus.map(r => `<span style="cursor:pointer" ondblclick="openRennerDetail(${r.id})">${r.naam}</span>`).join(', ')}
          </td></tr>` : ''}
        </tbody>
      </table></div>

      <button class="btn btn-primary" style="width:100%;margin-top:14px"
        onclick="slaUitslagPCSop(${kid})">
        💾 Opslaan &amp; Punten Berekenen
      </button>
    `);
    // Store renner data + winnaar globally to avoid JSON quoting issues in onclick
    window._uitslagRenners = opstelling.map(r => ({renner_id: r.id, positie: r.positie}));
    window._uitslagWinnaar = data.winnaar ? { naam: data.winnaar, ploeg: data.winnaar_ploeg || '' } : null;
  } catch(e) {
    openModal(`
      <div class="modal-title">📊 Uitslag</div>
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-title">Kon uitslag niet laden</div>
        <div class="empty-text">${e.message}</div>
      </div>
    `);
  }
}

async function slaUitslagPCSop(kid) {
  const renners = window._uitslagRenners || [];
  // Stuur ALLE opstelling-renners (ook zonder positie): ploegmaat-bonus geldt ook zonder top-30 notering
  const bulk = renners.map(r => ({
    renner_id: r.renner_id,
    positie: r.positie || null,
    is_ploegmaat_winnaar: document.getElementById(`ploegmaat-${r.renner_id}`)?.checked || false,
  }));

  if (!bulk.length) { toast('Geen opstelling gevonden', 'info'); return; }
  if (!bulk.some(r => r.positie || r.is_ploegmaat_winnaar)) {
    toast('Geen posities of bonussen om op te slaan', 'info'); return;
  }
  try {
    await post(`/api/koersen/${kid}/resultaten/bulk`, {
      renners: bulk,
      winnaar_naam: window._uitslagWinnaar?.naam || null,
      winnaar_ploeg: window._uitslagWinnaar?.ploeg || null,
    });
    toast('Uitslag opgeslagen ✅', 'success');
    closeModal();
    await refreshAll();
  } catch(e) { toast(e.message, 'error'); }
}

async function openDoorzettenSporza(kid) {
  const koers = state.koersen.find(k => k.id === kid);

  // Controleer of er al een sessie is ingesteld
  let sessieOk = false;
  try {
    const s = await get('/api/sporza-session');
    sessieOk = s.configured;
  } catch(e) {}

  if (!sessieOk) {
    // Toon setup-modal voor cookie invoer
    openModal(`
      <div class="modal-title">🚀 Doorzetten – Sporza WM Sessie</div>
      <div class="text-muted fs-sm" style="margin:10px 0 12px">
        Geef eenmalig je cookies in. Met de <strong>refresh token</strong> vernieuwt de app je sessie automatisch — je hoeft dit dan nooit meer te doen.
      </div>
      <ol style="font-size:0.83rem;line-height:1.8;color:var(--text);padding-left:20px;margin-bottom:14px">
        <li>Open <a href="https://wielermanager.sporza.be" target="_blank" style="color:var(--accent)">wielermanager.sporza.be</a> en log in</li>
        <li>Open DevTools: <kbd style="background:var(--card-bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px">F12</kbd> of <kbd style="background:var(--card-bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px">Cmd+Option+I</kbd></li>
        <li>Ga naar <strong>Application</strong> → <strong>Cookies</strong> → <code>https://sporza.be</code></li>
        <li>Kopieer de waarden van de drie cookies hieronder</li>
      </ol>
      <label class="form-label" style="font-size:0.82rem">
        Cookie <code>sporza-site_profile_rt</code>
        <span style="margin-left:6px;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);color:var(--green);border-radius:4px;padding:1px 7px;font-size:0.75rem">🔄 auto-refresh</span>
      </label>
      <input id="sporza-cookie-rt-input" type="password" class="input" placeholder="eyJhbGci… (refresh token)" style="width:100%;margin-bottom:10px" />
      <label class="form-label" style="font-size:0.82rem">Cookie <code>sporza-site_profile_at</code> <span class="text-muted">(access token — optioneel als RT opgegeven)</span></label>
      <input id="sporza-cookie-input" type="password" class="input" placeholder="eyJraWQi…" style="width:100%;margin-bottom:10px" />
      <label class="form-label" style="font-size:0.82rem">Cookie <code>sporza-site_profile_vt</code> <span class="text-muted">(optioneel)</span></label>
      <input id="sporza-cookie-vt-input" type="password" class="input" placeholder="eyJhbGci…" style="width:100%;margin-bottom:14px" />
      <button class="btn btn-primary" style="width:100%" onclick="slaSporzaSessionOp(${kid})">💾 Sessie opslaan &amp; doorzetten</button>
    `);
    setTimeout(() => document.getElementById('sporza-cookie-rt-input')?.focus(), 100);
    return;
  }

  await _voerDoorzettenUit(kid, koers);
}

async function slaSporzaSessionOp(kid) {
  const cookie    = document.getElementById('sporza-cookie-input')?.value?.trim()    || '';
  const cookie_vt = document.getElementById('sporza-cookie-vt-input')?.value?.trim() || '';
  const cookie_rt = document.getElementById('sporza-cookie-rt-input')?.value?.trim() || '';
  if (!cookie && !cookie_rt) { toast('Geef minstens de AT of RT cookie in', true); return; }
  try {
    await post('/api/sporza-session', { cookie, cookie_vt, cookie_rt });
    toast('Sessie opgeslagen ✅');
    closeModal();
    await _voerDoorzettenUit(kid, state.koersen.find(k => k.id === kid));
  } catch(e) { toast(e.message, true); }
}

async function _voerDoorzettenUit(kid, koers) {
  openModal(`
    <div class="modal-title">🚀 Doorzetten naar Sporza WM</div>
    <div class="text-muted fs-sm" style="margin:12px 0">Opstelling doorzetten voor <strong>${koers?.naam || ''}</strong>…</div>
    <div style="text-align:center;padding:20px;font-size:1.5rem">⏳</div>
  `);
  try {
    const res = await fetch(`/api/koersen/${kid}/doorzetten-sporza`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      // Markeer wedstrijd als "Doorgezet" (status 2)
      try { await put(`/api/koersen/${kid}`, { afgelopen: 2 }); } catch(_) {}
      await refreshKoersen();
      openModal(`
        <div class="modal-title">🚀 Doorzetten geslaagd!</div>
        <div style="text-align:center;padding:24px 0">
          <div style="font-size:2.5rem;margin-bottom:12px">✅</div>
          <div style="font-size:1rem;color:var(--text)">Opstelling voor <strong>${koers?.naam || ''}</strong> is ingevuld op Sporza Wielermanager.</div>
          <div class="text-muted fs-sm" style="margin-top:8px">${data.lineup_count} renners verwerkt · status → 📤 Doorgezet</div>
        </div>
        <a href="https://wielermanager.sporza.be/${data.edition || 'vrjr-m-26'}/team" target="_blank"
           class="btn btn-primary" style="width:100%;text-align:center;text-decoration:none">
          🌐 Bekijk op Sporza WM
        </a>
      `);
      return;
    }

    // Error afhandeling
    const errorMsg = data.error || `HTTP ${res.status}`;
    const isAuth = errorMsg.includes('verlopen') || errorMsg.includes('cookie');
    const consoleCmd = data.console_command;

    let icon = '⚠️', title = 'Fout', extra = '';

    if (isAuth) {
      icon = '🔑'; title = 'Sessie verlopen';
      extra = `<button class="btn btn-primary" style="width:100%;margin-top:12px"
        onclick="resetSporzaSession(${kid})">🔑 Nieuwe cookie instellen</button>`;
    } else if (consoleCmd) {
      icon = '🔧'; title = 'Sporza blokkeert server-request';
      window._sporzaConsoleCmd = consoleCmd;
      extra = `
        <div style="margin-top:16px;padding:14px;background:var(--surface);border-radius:8px;text-align:left">
          <div style="font-weight:600;margin-bottom:10px">Alternatief: via Chrome Console</div>
          <ol style="font-size:0.85rem;margin:0;padding-left:20px;line-height:1.8">
            <li>Ga naar <a href="https://wielermanager.sporza.be/vrjr-m-26/team" target="_blank" style="color:var(--accent)">wielermanager.sporza.be</a></li>
            <li>Druk <kbd style="background:var(--bg3);padding:2px 6px;border-radius:4px;font-size:0.8rem">F12</kbd> → tabblad <strong>Console</strong></li>
            <li>Klik <strong>📋 Kopieer</strong> hieronder en plak in de console</li>
            <li>Druk <kbd style="background:var(--bg3);padding:2px 6px;border-radius:4px;font-size:0.8rem">Enter</kbd></li>
          </ol>
          <button class="btn btn-primary" style="width:100%;margin-top:12px"
            onclick="navigator.clipboard.writeText(window._sporzaConsoleCmd).then(()=>{this.textContent='✅ Gekopieerd!';this.style.background='var(--green)'})">
            📋 Kopieer console-commando
          </button>
        </div>`;
    }

    openModal(`
      <div class="modal-title">🚀 Doorzetten mislukt</div>
      <div class="empty-state">
        <div class="empty-icon">${icon}</div>
        <div class="empty-title">${title}</div>
        <div class="empty-text">${errorMsg}</div>
      </div>
      ${extra}
    `);
  } catch(e) {
    openModal(`
      <div class="modal-title">🚀 Doorzetten mislukt</div>
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-title">Netwerkfout</div>
        <div class="empty-text">${e.message || 'Kon de server niet bereiken'}</div>
      </div>
    `);
  }
}

async function resetSporzaSession(kid) {
  try {
    await post('/api/sporza-session', { cookie: '' });
  } catch(e) {}
  await openDoorzettenSporza(kid);
}

async function slaSporzaCookieOpInstellingen() {
  const rt = document.getElementById('inst-sporza-rt')?.value?.trim() || '';
  const at = document.getElementById('inst-sporza-at')?.value?.trim() || '';
  const vt = document.getElementById('inst-sporza-vt')?.value?.trim() || '';
  const rtNieuw = rt && !rt.startsWith('•');
  const atNieuw = at && !at.startsWith('•');
  const vtNieuw = vt && !vt.startsWith('•');
  if (!rtNieuw && !atNieuw) {
    toast('Vul minstens de AT of de RT cookie in', true); return;
  }
  try {
    await post('/api/sporza-session', {
      cookie:    atNieuw ? at : '',
      cookie_vt: vtNieuw ? vt : '',
      cookie_rt: rtNieuw ? rt : '',
    });
    toast('Cookies opgeslagen ✅');
    navigate('instellingen');   // refresh om status te tonen
  } catch(e) {
    toast('Fout: ' + (e.message || 'onbekend'), true);
  }
}

async function testSporzaVerbinding() {
  const btn = document.getElementById('test-sporza-btn');
  const resultDiv = document.getElementById('sporza-test-result');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Testen…'; }
  if (resultDiv) { resultDiv.style.display = 'none'; }
  try {
    const data = await get('/api/sporza-verbinding-test');
    if (resultDiv) {
      resultDiv.style.display = 'block';
      const kleur = data.ok ? 'var(--green)' : 'var(--red)';
      let extra = '';
      if (data.minuten_resterend > 0)
        extra = `<div class="text-muted fs-sm">Cookie verloopt over ${data.minuten_resterend} minuten</div>`;
      if (data.sporza_body)
        extra += `<div class="text-muted fs-sm" style="margin-top:4px;word-break:break-all">Sporza: ${data.sporza_body}</div>`;
      resultDiv.innerHTML = `
        <div style="padding:10px;border-radius:8px;border:1px solid ${kleur};background:${kleur}22">
          <div style="color:${kleur};font-weight:600">${data.bericht}</div>
          ${extra}
        </div>`;
    }
  } catch(e) {
    if (resultDiv) {
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `<div style="color:var(--red);font-size:0.85rem">Fout: ${e.message}</div>`;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔌 Test verbinding'; }
  }
}

function switchDetailResultaatTab(tab) {
  document.querySelectorAll('#detail-resultaat-tabs .tab-btn').forEach((b, i) => {
    b.classList.toggle('active', ['bekijk', 'invoer'][i] === tab);
  });
  document.getElementById('det-tab-bekijk').style.display = tab === 'bekijk' ? '' : 'none';
  document.getElementById('det-tab-invoer').style.display = tab === 'invoer' ? '' : 'none';
}

function updateDetailOpstellingUI(max) {
  const checked = document.querySelectorAll('[id^="det-ops-"]:checked').length;
  const teller = document.getElementById('detail-ops-teller');
  if (teller) {
    teller.textContent = `${checked} / ${max}`;
    teller.style.color = checked > max ? 'var(--red)' : checked === max ? 'var(--green)' : 'var(--muted)';
  }
  // Kopman-radio mag enkel aangevinkt zijn als de renner in de opstelling zit
  document.querySelectorAll('[id^="det-ops-"]').forEach(cb => {
    const rid = cb.id.replace('det-ops-', '');
    const radio = document.querySelector(`[name="det-kopman-radio"][value="${rid}"]`);
    if (!radio) return;
    if (!cb.checked) {
      if (radio.checked) radio.checked = false;
      radio.disabled = true;
      radio.style.opacity = '0.3';
    } else {
      radio.disabled = false;
      radio.style.opacity = '';
    }
  });
}

async function slaDetailOpstellingOp(kid, max) {
  const checkboxes = document.querySelectorAll('[id^="det-ops-"]');
  const renner_ids = Array.from(checkboxes)
    .filter(cb => cb.checked)
    .map(cb => parseInt(cb.id.replace('det-ops-', '')));

  if (renner_ids.length > max) {
    toast(`Maximaal ${max} renners in de opstelling`, 'error'); return;
  }
  const kopmanRadio = document.querySelector('[name="det-kopman-radio"]:checked');
  const kopman_id = kopmanRadio ? parseInt(kopmanRadio.value) : null;

  if (renner_ids.length > 0 && !kopman_id) {
    toast('Kies een kopman voor de opstelling', 'error'); return;
  }
  if (kopman_id && !renner_ids.includes(kopman_id)) {
    toast('De kopman moet in de opstelling staan', 'error'); return;
  }
  try {
    await post(`/api/koersen/${kid}/opstelling`, { renner_ids, kopman_id });
    toast(`Opstelling opgeslagen (${renner_ids.length} renners)`, 'success');
    state.koersen = await get('/api/koersen');
    renderPage();
  } catch(e) { toast(e.message, 'error'); }
}

async function slaDetailResultatenOp(kid, soort) {
  const inputs = document.querySelectorAll('[id^="det-pos-"]');
  const bulk = Array.from(inputs).map(input => {
    const rid = parseInt(input.id.replace('det-pos-', ''));
    const pos = input.value ? parseInt(input.value) : null;
    if (!pos) return null;
    const ploegmaat = document.getElementById(`det-ploegmaat-${rid}`)?.checked || false;
    return { renner_id: rid, positie: pos, is_ploegmaat_winnaar: ploegmaat };
  }).filter(Boolean);

  if (!bulk.length) { toast('Geen posities ingevoerd', 'info'); return; }
  try {
    await post(`/api/koersen/${kid}/resultaten/bulk`, bulk);
    toast('Resultaten opgeslagen ✅', 'success');
    await loadAll();
    renderPage();
  } catch(e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Geplande Transfers – helpers, modal & acties
// ═══════════════════════════════════════════════════════════════════════════

async function openTransfersOverzicht() {
  const gepland  = state.geplandTransfers || [];
  const vandaag  = new Date().toISOString().slice(0, 10);
  const count    = parseInt(state.instellingen?.transfer_count  || 0);
  const gratis   = parseInt(state.instellingen?.transfers_gratis || 3);

  let uitgevoerd = [];
  try { uitgevoerd = await get('/api/transfers'); } catch(e) {}

  const geplandHtml = gepland.length === 0
    ? `<div class="text-muted fs-sm" style="padding:10px 0">Geen geplande transfers.</div>`
    : gepland.map((t, i) => {
        const vervallen   = t.datum <= vandaag;
        const verwacht_nr = count + i + 1;
        const kosten      = Math.max(0, verwacht_nr - gratis);
        return `
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding:9px 0;
            border-bottom:1px solid var(--border);
            ${vervallen ? 'background:rgba(232,185,79,0.07);margin:0 -4px;padding:9px 4px;border-radius:6px' : ''}">
            <span style="font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:12px;white-space:nowrap;flex-shrink:0;
              background:${vervallen ? 'rgba(232,185,79,0.25)' : 'var(--bg3)'};
              color:${vervallen ? 'var(--accent2)' : 'var(--muted)'}">
              ${vervallen ? '⏰ ' : ''}${fmtDate(t.datum)}
            </span>
            <span style="display:flex;align-items:center;gap:5px;font-size:0.84rem;min-width:0">
              ${avatarHtml({foto:t.uit_foto,naam:t.uit_naam,rol:t.uit_rol})}
              <strong>${t.uit_naam}</strong>
              <span class="text-muted fs-sm">${fmtPrijs(t.uit_prijs)}</span>
            </span>
            <span class="text-muted">→</span>
            <span style="display:flex;align-items:center;gap:5px;font-size:0.84rem;min-width:0">
              ${avatarHtml({foto:t.in_foto,naam:t.in_naam,rol:t.in_rol})}
              <strong>${t.in_naam}</strong>
              <span class="text-muted fs-sm">${fmtPrijs(t.in_prijs)}</span>
            </span>
            <span style="margin-left:auto;font-size:0.8rem;font-weight:700;flex-shrink:0;
              color:${kosten > 0 ? 'var(--red)' : 'var(--green)'}">
              ${kosten > 0 ? `-€${kosten}M` : 'gratis'}
            </span>
            <button class="btn btn-sm btn-primary" style="padding:3px 10px;flex-shrink:0"
              onclick="uitvoerenGeplandTransfer(${t.id},'${t.uit_naam.replace(/'/g,"\\'")}','${t.in_naam.replace(/'/g,"\\'")}')">▶</button>
            <button class="btn btn-sm btn-danger" style="padding:3px 8px;flex-shrink:0"
              onclick="verwijderGeplandTransfer(${t.id})">✕</button>
          </div>`;
      }).join('');

  const uitgevoerdHtml = uitgevoerd.length === 0
    ? `<div class="text-muted fs-sm" style="padding:10px 0">Nog geen transfers uitgevoerd.</div>`
    : uitgevoerd.map(t => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <span class="text-muted fs-sm" style="flex-shrink:0;min-width:72px">${fmtDate(t.datum)}</span>
          <span style="font-size:0.84rem;min-width:0"><strong>${t.renner_uit}</strong>
            <span class="text-muted fs-sm"> ${fmtPrijs(t.prijs_uit)}</span></span>
          <span class="text-muted">→</span>
          <span style="font-size:0.84rem;min-width:0"><strong>${t.renner_in}</strong>
            <span class="text-muted fs-sm"> ${fmtPrijs(t.prijs_in)}</span></span>
          <span style="margin-left:auto;font-size:0.8rem;font-weight:700;flex-shrink:0;
            color:${t.kosten > 0 ? 'var(--red)' : 'var(--green)'}">
            ${t.kosten > 0 ? `-€${t.kosten}M` : 'gratis'}
          </span>
        </div>`).join('');

  openModal(`
    <div class="modal-title">Transfers Overzicht</div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;margin-top:4px">
      <div style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">
        📅 Gepland (${gepland.length})
      </div>
      <button class="btn btn-primary btn-sm" onclick="openPlanTransfer()">+ Plannen</button>
    </div>
    ${geplandHtml}

    <div style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-top:18px;margin-bottom:6px">
      ✅ Uitgevoerd (${uitgevoerd.length})
    </div>
    ${uitgevoerdHtml}
  `);
}

function openPuntenOverzicht() {
  const afgelopen = state.koersen.filter(k => k.afgelopen === 1);
  const totaal = state.stats?.totaal_punten ?? 0;

  const blokkenHtml = afgelopen.length === 0
    ? '<div class="empty-state"><div class="empty-icon">🏁</div><div class="empty-title">Nog geen afgelopen wedstrijden</div></div>'
    : `<div class="koers-blokken" style="margin-top:0">${afgelopen.map(k => {
        const foto = k.winnaar_foto || k.kopman_foto;
        const naam = k.winnaar_naam || k.kopman_naam;
        const avatarEl = foto
          ? `<img src="${foto}" title="${naam||''}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0;margin-right:3px"/>`
          : '';
        return `
          <div class="koers-blok ${k.soort} afgelopen" onclick="closeModal();openKoersDetail(${k.id})" title="${k.naam}">
            <div class="koers-blok-datum">${fmtDate(k.datum)}</div>
            <div class="koers-blok-naam">${k.naam}</div>
            <div class="koers-blok-ops">
              ${avatarEl}
              <span class="koers-blok-done">✓</span>
              <span style="font-size:0.78rem;font-weight:700;color:${k.mijn_punten > 0 ? 'var(--green)' : 'var(--muted)'}">
                ${k.mijn_punten > 0 ? k.mijn_punten + ' pt' : '0 pt'}
              </span>
            </div>
          </div>`;
      }).join('')}</div>`;

  openModal(`
    <div class="modal-title">🏅 Punten Overzicht</div>

    <div style="display:flex;align-items:center;gap:16px;margin:8px 0 18px;padding:14px;background:var(--bg3);border-radius:10px">
      <div style="font-size:2.4rem;font-weight:800;color:var(--accent);line-height:1">${totaal}</div>
      <div>
        <div style="font-size:0.88rem;font-weight:600">totale punten dit seizoen</div>
        <div class="text-muted fs-sm">${afgelopen.length} wedstrijd${afgelopen.length !== 1 ? 'en' : ''} gespeeld</div>
      </div>
    </div>

    <div style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px">
      Afgelopen wedstrijden — klik voor details
    </div>
    ${blokkenHtml}
  `);
}

function renderTransferGeschiedenis(transfers, inst) {
  if (!transfers || transfers.length === 0) return '';
  const max = 10;
  const zichtbaar = transfers.slice(0, max);
  const meer = transfers.length > max;
  return `
    <div class="card" style="margin-top:20px">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>🔄 Transfergeschiedenis (${transfers.length})</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Eruit</th>
              <th></th>
              <th>Erin</th>
              <th class="col-mob-hide" style="text-align:right">Kosten</th>
            </tr>
          </thead>
          <tbody>
            ${zichtbaar.map((t) => {
              const kosten = parseFloat(t.kosten || 0);
              const kostenLabel = kosten === 0
                ? `<span style="color:var(--green);font-size:0.78rem">Gratis</span>`
                : `<span style="color:var(--danger);font-size:0.82rem;font-weight:700">-€${kosten.toFixed(1)}M</span>`;
              return `<tr>
                <td style="white-space:nowrap;font-size:0.78rem;color:var(--muted)">${fmtDate(t.datum ? t.datum.slice(0,10) : '')}</td>
                <td style="font-size:0.85rem">
                  <span style="display:inline-flex;align-items:center;gap:5px">
                    <span style="color:var(--danger)">✕</span>
                    <span class="fw-700">${t.renner_uit || '—'}</span>
                    ${t.prijs_uit != null ? `<span style="color:var(--muted);font-size:0.75rem">(€${parseFloat(t.prijs_uit).toFixed(1)}M)</span>` : ''}
                  </span>
                </td>
                <td style="color:var(--muted);padding:0 4px">→</td>
                <td style="font-size:0.85rem">
                  <span style="display:inline-flex;align-items:center;gap:5px">
                    <span style="color:var(--green)">✓</span>
                    <span class="fw-700">${t.renner_in || '—'}</span>
                    ${t.prijs_in != null ? `<span style="color:var(--muted);font-size:0.75rem">(€${parseFloat(t.prijs_in).toFixed(1)}M)</span>` : ''}
                  </span>
                </td>
                <td class="col-mob-hide" style="text-align:right">${kostenLabel}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${meer ? `<div style="padding-top:8px;font-size:0.78rem;color:var(--muted)">Toont de laatste ${max} van ${transfers.length} transfers.</div>` : ''}
    </div>
  `;
}

function renderGeplandTransfersCompact(transfers) {
  if (!transfers.length) return '';
  const vandaag = new Date().toISOString().slice(0, 10);
  const heeft_vervallen = transfers.some(t => t.datum <= vandaag);
  const zichtbaar = transfers.slice(0, 3);
  const meer = transfers.length > 3;
  return `
    <div class="card" style="margin-bottom:20px;border:1px solid ${heeft_vervallen ? 'rgba(232,185,79,0.45)' : 'var(--border)'}">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>📅 Geplande Transfers (${transfers.length})</span>
        <button class="btn btn-secondary btn-sm" onclick="openPlanTransfer()">+ Plannen</button>
      </div>
      ${zichtbaar.map(t => {
        const vervallen = t.datum <= vandaag;
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:12px;white-space:nowrap;flex-shrink:0;
            background:${vervallen ? 'rgba(232,185,79,0.22)' : 'var(--bg3)'};
            color:${vervallen ? 'var(--accent2)' : 'var(--muted)'}">
            ${vervallen ? '⏰ ' : ''}${fmtDate(t.datum)}
          </span>
          <span style="display:flex;align-items:center;gap:4px;font-size:0.82rem;min-width:0">
            ${avatarHtml({foto:t.uit_foto,naam:t.uit_naam,rol:t.uit_rol})}
            <span class="fw-700" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.uit_naam}</span>
          </span>
          <span style="color:var(--muted);flex-shrink:0">→</span>
          <span style="display:flex;align-items:center;gap:4px;font-size:0.82rem;min-width:0">
            ${avatarHtml({foto:t.in_foto,naam:t.in_naam,rol:t.in_rol})}
            <span class="fw-700" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.in_naam}</span>
          </span>
          <button class="btn btn-sm btn-primary" style="margin-left:auto;padding:3px 10px;flex-shrink:0"
            onclick="uitvoerenGeplandTransfer(${t.id},'${t.uit_naam.replace(/'/g,"\\'")}','${t.in_naam.replace(/'/g,"\\'")}')">▶</button>
        </div>`;
      }).join('')}
      ${meer ? `<div style="padding-top:8px;font-size:0.78rem"><a href="#" onclick="navigate('suggesties');return false" style="color:var(--accent)">Bekijk alle ${transfers.length} geplande transfers →</a></div>` : ''}
    </div>
  `;
}

function renderGeplandTransfersFull(transfers) {
  const vandaag = new Date().toISOString().slice(0, 10);
  const count  = parseInt(state.instellingen.transfer_count  || 0);
  const gratis = parseInt(state.instellingen.transfers_gratis || 3);
  return `
    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>📅 Geplande Transfers</span>
        <button class="btn btn-primary btn-sm" onclick="openPlanTransfer()">+ Transfer plannen</button>
      </div>
      ${transfers.length === 0
        ? `<div class="empty-state" style="padding:20px 0">
            <div class="empty-icon">📅</div>
            <div class="empty-title">Geen transfers gepland</div>
            <div class="empty-text">Klik '+ Transfer plannen' om een toekomstige transfer in te plannen.</div>
          </div>`
        : transfers.map((t, i) => {
            const vervallen = t.datum <= vandaag;
            const verwacht_nr = count + i + 1;
            const verwacht_kosten = Math.max(0, verwacht_nr - gratis);
            return `
              <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 0;
                border-bottom:1px solid var(--border);
                ${vervallen ? 'background:rgba(232,185,79,0.07);margin:0 -4px;padding:10px 4px;border-radius:6px' : ''}">
                <span style="font-size:0.75rem;font-weight:700;padding:3px 10px;border-radius:12px;white-space:nowrap;flex-shrink:0;
                  background:${vervallen ? 'rgba(232,185,79,0.25)' : 'var(--bg3)'};
                  color:${vervallen ? 'var(--accent2)' : 'var(--muted)'}">
                  ${vervallen ? '⏰ ' : ''}${fmtDate(t.datum)}
                </span>
                <span style="display:flex;align-items:center;gap:6px;min-width:0">
                  ${avatarHtml({foto:t.uit_foto,naam:t.uit_naam,rol:t.uit_rol})}
                  <span class="fw-700" style="font-size:0.87rem">${t.uit_naam}</span>
                  <span class="text-muted fs-sm">${fmtPrijs(t.uit_prijs)}</span>
                </span>
                <span style="color:var(--muted)">→</span>
                <span style="display:flex;align-items:center;gap:6px;min-width:0">
                  ${avatarHtml({foto:t.in_foto,naam:t.in_naam,rol:t.in_rol})}
                  <span class="fw-700" style="font-size:0.87rem">${t.in_naam}</span>
                  <span class="text-muted fs-sm">${fmtPrijs(t.in_prijs)}</span>
                </span>
                <span style="margin-left:auto;font-size:0.8rem;font-weight:700;flex-shrink:0;
                  color:${verwacht_kosten > 0 ? 'var(--red)' : 'var(--green)'}">
                  ${verwacht_kosten > 0 ? `-€${verwacht_kosten}M` : 'gratis'}
                </span>
                <button class="btn btn-sm btn-primary" style="padding:3px 12px;flex-shrink:0"
                  onclick="uitvoerenGeplandTransfer(${t.id},'${t.uit_naam.replace(/'/g,"\\'")}','${t.in_naam.replace(/'/g,"\\'")}')">▶ Uitvoeren</button>
                <button class="btn btn-sm btn-danger" style="padding:3px 8px;flex-shrink:0"
                  onclick="verwijderGeplandTransfer(${t.id})">✕</button>
              </div>`;
          }).join('')}
    </div>
  `;
}

async function openPlanTransfer() {
  const ploegRenners = (state.ploeg?.renners || []).slice().sort((a,b) => a.naam.localeCompare(b.naam));
  const beschikbaar  = state.renners.filter(r => !r.in_ploeg).sort((a,b) => b.prijs - a.prijs);
  const vandaag = new Date().toISOString().slice(0, 10);
  window._planBeschikbaar  = beschikbaar;
  window._planPloegRenners = ploegRenners;

  openModal(`
    <div class="modal-title">📅 Transfer plannen</div>
    <div style="display:grid;gap:14px;margin-top:4px">
      <div>
        <label class="fw-700 fs-sm" style="display:block;margin-bottom:6px">Wie gaat eruit?</label>
        <select id="plan-uit" onchange="updatePlanTransferPreview()"
          style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:0.9rem">
          ${ploegRenners.map(r => `<option value="${r.id}" data-prijs="${r.prijs}">${r.naam} – ${fmtPrijs(r.prijs)} (${r.renner_ploeg})</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="fw-700 fs-sm" style="display:block;margin-bottom:6px">Wie komt erin?</label>
        <input id="plan-in-zoek" type="text" placeholder="Zoek renner of ploeg..."
          oninput="filterPlanInRenners()"
          style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:0.9rem;margin-bottom:6px;box-sizing:border-box" />
        <select id="plan-in" onchange="updatePlanTransferPreview()" size="7"
          style="width:100%;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:0.88rem;padding:4px">
          ${beschikbaar.map(r => `<option value="${r.id}" data-prijs="${r.prijs}">${r.naam} – ${fmtPrijs(r.prijs)} (${r.ploeg})</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="fw-700 fs-sm" style="display:block;margin-bottom:6px">Wanneer?</label>
        <input type="date" id="plan-datum" min="${vandaag}" value="${vandaag}"
          style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:0.9rem;box-sizing:border-box" />
      </div>
      <div id="plan-preview" style="padding:10px 14px;border-radius:8px;background:var(--bg3);font-size:0.85rem;line-height:1.8;color:var(--muted)">
        Selecteer een renner om de preview te zien.
      </div>
      <button class="btn btn-primary" onclick="slaGeplandTransferOp()">📅 Transfer plannen</button>
    </div>
  `);
  updatePlanTransferPreview();
}

function filterPlanInRenners() {
  const zoek = (document.getElementById('plan-in-zoek')?.value || '').toLowerCase();
  const sel = document.getElementById('plan-in');
  if (!sel) return;
  const gefilterd = (window._planBeschikbaar || []).filter(r =>
    r.naam.toLowerCase().includes(zoek) || r.ploeg.toLowerCase().includes(zoek)
  ).sort((a,b) => b.prijs - a.prijs);
  sel.innerHTML = gefilterd.map(r =>
    `<option value="${r.id}" data-prijs="${r.prijs}">${r.naam} – ${fmtPrijs(r.prijs)} (${r.ploeg})</option>`
  ).join('');
  updatePlanTransferPreview();
}

function updatePlanTransferPreview() {
  const preview = document.getElementById('plan-preview');
  if (!preview) return;
  const uitSel = document.getElementById('plan-uit');
  const inSel  = document.getElementById('plan-in');
  if (!uitSel || !inSel || !inSel.value) {
    preview.textContent = 'Selecteer een renner om de preview te zien.';
    return;
  }
  const uitPrijs = parseFloat(uitSel.selectedOptions[0]?.dataset.prijs || 0);
  const inPrijs  = parseFloat(inSel.selectedOptions[0]?.dataset.prijs  || 0);
  const count  = parseInt(state.instellingen.transfer_count  || 0);
  const gratis = parseInt(state.instellingen.transfers_gratis || 3);
  const budget = state.ploeg?.budget_resterend ?? 0;
  const kosten = Math.max(0, count + 1 - gratis);
  const budgetNa = Math.round((budget + uitPrijs - inPrijs - kosten) * 10) / 10;
  const budgetOk = budgetNa >= 0;
  const kostenStr = kosten > 0
    ? `<span style="color:var(--red)">€${kosten}M</span>`
    : `<span style="color:var(--green)">gratis</span>`;
  preview.innerHTML = `
    <div style="color:var(--text)">
      <div>💰 Transferkost: ${kostenStr}</div>
      <div>📊 Budget na transfer: <strong style="color:${budgetOk ? 'var(--green)' : 'var(--red)'}">${fmtPrijs(budgetNa)}</strong>
        ${!budgetOk ? '<span style="color:var(--red)"> ⚠️ Onvoldoende budget!</span>' : ''}
      </div>
    </div>
  `;
}

async function slaGeplandTransferOp() {
  const uitId = parseInt(document.getElementById('plan-uit')?.value);
  const inId  = parseInt(document.getElementById('plan-in')?.value);
  const datum = document.getElementById('plan-datum')?.value;
  if (!uitId || !inId) { toast('Selecteer beide renners', 'error'); return; }
  if (uitId === inId) { toast('Kies een andere renner', 'error'); return; }
  if (!datum) { toast('Kies een datum', 'error'); return; }
  try {
    await post('/api/geplande-transfers', { renner_uit_id: uitId, renner_in_id: inId, datum });
    state.geplandTransfers = await get('/api/geplande-transfers');
    toast('Transfer gepland ✅', 'success');
    closeModal();
    renderPage();
  } catch(e) { toast(e.message, 'error'); }
}

async function uitvoerenGeplandTransfer(id, uitNaam, inNaam) {
  if (!confirm(`Transfer uitvoeren?\n\n${uitNaam} → ${inNaam}\n\nDit is onomkeerbaar.`)) return;
  try {
    const res = await post(`/api/geplande-transfers/${id}/uitvoeren`, {});
    const kostenStr = res.kosten > 0 ? ` (-€${res.kosten}M)` : ' (gratis)';
    toast(`Transfer uitgevoerd: ${uitNaam} → ${inNaam}${kostenStr} ✅`, 'success');
    await loadAll();
    renderPage();
  } catch(e) { toast(e.message, 'error'); }
}

async function verwijderGeplandTransfer(id) {
  try {
    await del(`/api/geplande-transfers/${id}`);
    state.geplandTransfers = state.geplandTransfers.filter(t => t.id !== id);
    renderPage();
  } catch(e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Suggesties & Transfers
// ═══════════════════════════════════════════════════════════════════════════
async function renderSuggesties() {
  const budget = state.ploeg?.budget_resterend ?? 0;
  const [suggesties, transfers, transferInfo, miniTransfers] = await Promise.all([
    get(`/api/suggesties?budget=${budget}`),
    get('/api/transfers'),
    get('/api/transfers/kosten'),
    get('/api/sporza-mini/transfers').catch(() => []),
  ]);

  const volgende_kosten = transferInfo.kosten;
  const gratis_rest = transferInfo.gratis_resterend;

  const miniTransferCard = miniTransfers.length ? `
    <div class="card mt-20">
      <div class="card-title">🏆 Mini-competitie: sluit de kloof</div>
      <div class="suggestie-grid">
        ${miniTransfers.map(s => {
          const budgetTxt = s.budget_delta > 0
            ? `<span class="text-green fs-sm">+${fmtPrijs(s.budget_delta)} terug</span>`
            : s.budget_delta < 0
            ? `<span class="text-red fs-sm">${fmtPrijs(Math.abs(s.budget_delta))} extra</span>`
            : '<span class="text-muted fs-sm">zelfde prijs</span>';
          const achterstandTxt = s.achterstand > 0
            ? `+${s.achterstand}pt voor jou`
            : s.achterstand < 0
            ? `${Math.abs(s.achterstand)}pt achter`
            : 'gelijkstand';
          const hasBtn = s.renner_in.lokale_id;
          return `
            <div class="suggestie-card">
              <div style="font-size:0.75rem;color:var(--muted);margin-bottom:6px">
                🎯 #${s.concurrent_rank} <strong>${s.concurrent}</strong> · ${achterstandTxt}
              </div>
              <div style="margin-bottom:3px">
                <span style="color:var(--red);font-weight:600">↓ ${s.renner_uit.naam}</span>
                <span class="text-muted fs-sm"> ${fmtPrijs(s.renner_uit.prijs)} · ${s.renner_uit.punten}pt</span>
              </div>
              <div style="margin-bottom:8px">
                <span style="color:var(--green);font-weight:600">↑ ${s.renner_in.naam}</span>
                <span class="text-muted fs-sm"> (${s.renner_in.ploeg}) ${fmtPrijs(s.renner_in.prijs)} · ${s.renner_in.punten}pt</span>
              </div>
              <div class="suggestie-meta">
                ${s.punt_winst > 0
                  ? `<span class="suggestie-ratio" style="color:var(--green)">+${s.punt_winst} pt winst</span>`
                  : `<span class="suggestie-ratio" style="color:var(--muted)">${s.punt_winst} pt</span>`}
                ${budgetTxt}
              </div>
              <button class="btn btn-success btn-sm" style="margin-top:8px"
                ${hasBtn
                  ? `onclick="quickAdd(${s.renner_in.lokale_id},'${s.renner_in.naam.replace(/'/g, "\\'")}')"`
                  : 'disabled title="Renner niet gevonden in lokale DB"'}>
                + Toevoegen
              </button>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  ` : '';

  return `
    <div class="page-header">
      <div>
        <div class="page-title">Suggesties & Transfers</div>
        <div class="page-subtitle">Budget: <strong class="text-green">${fmtPrijs(budget)}</strong>
          &nbsp;·&nbsp; Volgende transfer: <strong class="${volgende_kosten > 0 ? 'text-red' : 'text-green'}">${volgende_kosten > 0 ? `€${volgende_kosten}M` : 'gratis'}</strong>
          ${gratis_rest > 0 ? `&nbsp;·&nbsp; <span class="text-green">${gratis_rest} gratis resterend</span>` : ''}
        </div>
      </div>
    </div>

    ${renderGeplandTransfersFull(state.geplandTransfers)}

    ${miniTransferCard}

    <div class="card mt-20">
      <div class="card-title">💡 Beste aankopen (punten/prijs ratio · binnen budget ${fmtPrijs(budget)})</div>
      ${suggesties.length === 0
        ? `<div class="empty-state"><div class="empty-icon">💡</div><div class="empty-title">Geen suggesties</div><div class="empty-text">Zorg dat je budget hebt of voeg koersresultaten in</div></div>`
        : `<div class="suggestie-grid">
            ${suggesties.map(r => `
              <div class="suggestie-card ${r.ploeg_vol ? 'ploeg-vol' : ''}">
                <div style="display:flex;align-items:center;gap:10px">
                  ${avatarHtml(r)}
                  <div>
                    <div class="suggestie-naam">${r.naam}</div>
                    <div class="text-muted fs-sm" style="display:flex;align-items:center;gap:5px">${jerseyHtml(r.ploeg,{size:16})}${r.ploeg}</div>
                  </div>
                </div>
                <div class="suggestie-meta">
                  ${rolBadge(r.rol)}
                  <span class="price-tag">${fmtPrijs(r.prijs)}</span>
                  <span class="suggestie-ratio">${r.totaal_punten} pt</span>
                  ${r.ratio > 0 ? `<span class="suggestie-ratio">⚡ ${r.ratio} p/€M</span>` : ''}
                  ${r.ploeg_vol ? '<span class="badge" style="background:rgba(239,68,68,0.15);color:#f87171">Ploeg vol</span>' : ''}
                </div>
                <button class="btn btn-success btn-sm" ${r.ploeg_vol ? 'disabled' : ''} onclick="quickAdd(${r.id},'${r.naam.replace(/'/g,"\\'")}')">
                  + Toevoegen
                </button>
              </div>
            `).join('')}
          </div>`}
    </div>

    <div class="card mt-20">
      <div class="card-title">🔄 Transfer Kosten (eerste 3 gratis, daarna +€1M per transfer)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        ${[1,2,3,4,5,6,7,8,9,10].map(n => {
          const k = n <= 3 ? 'gratis' : `€${n-3}M`;
          const done = n <= transferInfo.transfer_nummer - 1;
          const next = n === transferInfo.transfer_nummer;
          return `<div style="padding:8px 12px;border-radius:8px;font-size:0.8rem;font-weight:700;border:1px solid var(--border);
            background:${done ? 'rgba(239,68,68,0.1)' : next ? 'rgba(232,185,79,0.15)' : 'var(--bg3)'};
            color:${done ? 'var(--red)' : next ? 'var(--accent2)' : 'var(--muted)'}">
            #${n}: ${k}
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card mt-20">
      <div class="card-title">📋 Transfer Geschiedenis</div>
      ${!transfers.length ? '<div class="text-muted fs-sm mt-12">Nog geen transfers</div>' :
        transfers.map(t => `<div class="transfer-row">
          <span class="transfer-out">↓ ${t.renner_uit || '—'} (${fmtPrijs(t.prijs_uit || 0)})</span>
          <span class="transfer-arrow">→</span>
          <span class="transfer-in">↑ ${t.renner_in || '—'} (${fmtPrijs(t.prijs_in || 0)})</span>
          ${t.kosten > 0 ? `<span style="color:var(--red);font-size:0.78rem">-€${t.kosten}M</span>` : '<span class="text-green fs-sm">gratis</span>'}
          <span class="transfer-date">${fmtDate(t.datum)}</span>
        </div>`).join('')}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Statistieken
// ═══════════════════════════════════════════════════════════════════════════
function renderStatistieken() {
  const { stats, koersen } = state;
  const chartData   = stats?.punten_per_koers  || [];
  const kopmanStats = stats?.kopman_stats       || [];
  const topRenners  = stats?.top_renners        || [];
  const afgelopen   = koersen.filter(k => k.afgelopen === 1);
  const totaal      = stats?.totaal_punten ?? 0;

  // Gemiddelde punten per wedstrijd
  const gemiddeld = afgelopen.length
    ? (totaal / afgelopen.length).toFixed(1)
    : '—';
  // Beste wedstrijd
  const beste = chartData.reduce((b, d) => d.punten > (b?.punten ?? 0) ? d : b, null);

  return `
    <div class="page-header">
      <div class="page-title">Statistieken</div>
      <div class="page-subtitle">${afgelopen.length} wedstrijden gespeeld · ${totaal} punten totaal</div>
    </div>

    <div class="stats-grid stats-grid-4" style="margin-bottom:20px">
      <div class="stat-card">
        <div class="stat-label">Totaal Punten</div>
        <div class="stat-value text-accent">${totaal}</div>
        <div class="stat-sub">dit seizoen</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-label">Wedstrijden</div>
        <div class="stat-value">${afgelopen.length}</div>
        <div class="stat-sub">gespeeld</div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">Gemiddeld</div>
        <div class="stat-value">${gemiddeld}</div>
        <div class="stat-sub">punten per wedstrijd</div>
      </div>
      <div class="stat-card purple">
        <div class="stat-label">Beste Wedstrijd</div>
        <div class="stat-value">${beste?.punten ?? '—'}</div>
        <div class="stat-sub">${beste ? beste.naam : 'nog geen'}</div>
      </div>
    </div>

    ${renderSeizoensgrafiek(chartData)}

    ${renderKopmanOverzicht(kopmanStats)}

    <div class="card mt-20">
      <div class="card-title">🏆 Top Scorers in Ploeg</div>
      ${topRenners.length === 0
        ? '<div class="text-muted fs-sm mt-12">Nog geen resultaten</div>'
        : `<div class="chart-bars">
            ${topRenners.map((r, i) => `
              <div class="chart-row" style="cursor:pointer" ondblclick="openRennerDetail(${r.id})">
                <div class="chart-label" style="display:flex;align-items:center;gap:5px">
                  ${jerseyHtml(r.ploeg, {size:16})}${i+1}. ${r.naam}
                </div>
                <div class="chart-bar-wrap">
                  <div class="chart-bar-fill" style="width:${Math.round(r.punten/topRenners[0].punten*100)}%">
                    ${r.punten}
                  </div>
                </div>
              </div>`).join('')}
          </div>`}
    </div>

    <div class="card mt-20">
      <div class="card-title">📅 Punten per Wedstrijd</div>
      ${afgelopen.length === 0
        ? '<div class="text-muted fs-sm mt-12">Nog geen afgelopen wedstrijden</div>'
        : `<div class="table-wrap"><table>
            <thead><tr>
              <th>Wedstrijd</th>
              <th>Datum</th>
              <th>Type</th>
              <th style="text-align:right">Punten</th>
            </tr></thead>
            <tbody>
              ${[...chartData].reverse().map(d => `
                <tr onclick="openKoersDetail(${afgelopen.find(k=>k.naam===d.naam)?.id})" style="cursor:pointer">
                  <td class="fw-700">${d.naam}</td>
                  <td class="text-muted fs-sm">${fmtDate(d.datum)}</td>
                  <td>${soortBadge(d.soort)}</td>
                  <td style="text-align:right" class="fw-700 ${d.punten > 0 ? 'text-green' : 'text-muted'}">${d.punten}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>`}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Spelregels
// ═══════════════════════════════════════════════════════════════════════════
function renderSpelregels() {
  return `
    <div class="page-header">
      <div class="page-title">Spelregels</div>
      <div class="page-subtitle">Voorjaar Mannen 2026 – Sporza Wielermanager</div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">⚙️ Basisregels</div>
        <table style="margin-top:10px;font-size:0.88rem"><tbody>
          <tr><td class="text-muted" style="padding:5px 0;width:60%">Budget</td><td class="fw-700 price-tag">€120M</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">Totaal renners in ploeg</td><td class="fw-700">20</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">Opstelling per wedstrijd</td><td class="fw-700">12 renners + 1 kopman</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">In de bus (per wedstrijd)</td><td class="fw-700">8 renners (scoren niet)</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">Max per wielerploeg</td><td class="fw-700">4 renners</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">Ploegen</td><td class="fw-700">WorldTeams + ProTeams</td></tr>
        </tbody></table>
      </div>
      <div class="card">
        <div class="card-title">🔄 Transfer Kosten</div>
        <table style="margin-top:10px;font-size:0.88rem"><tbody>
          <tr><td class="text-muted" style="padding:5px 0;width:60%">Vóór 1e wedstrijd</td><td class="fw-700 text-green">Onbeperkt gratis</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">Transfer 1–3</td><td class="fw-700 text-green">Gratis</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">Transfer 4</td><td class="fw-700">€1M</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">Transfer 5</td><td class="fw-700">€2M</td></tr>
          <tr><td class="text-muted" style="padding:5px 0">Transfer N (≥4)</td><td class="fw-700">€(N-3)M</td></tr>
        </tbody></table>
      </div>
    </div>

    <div class="card mt-20">
      <div class="card-title">⭐ Kopman Bonuspunten (per wedstrijd)</div>
      <div class="text-muted fs-sm" style="margin:8px 0 12px">Je kopman (1 per wedstrijd, kies per opstelling) verdient bonuspunten als hij top 6 eindigt:</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${[{p:1,b:30},{p:2,b:25},{p:3,b:20},{p:4,b:15},{p:5,b:10},{p:6,b:5}].map(x =>
          `<div class="stat-card" style="min-width:80px;text-align:center;padding:12px 8px">
            <div class="stat-label">Positie ${x.p}</div>
            <div class="fw-700 text-accent" style="font-size:1.4rem">+${x.b}</div>
          </div>`
        ).join('')}
      </div>
      <div class="text-muted fs-sm" style="margin-top:12px">Ploegmaats van de winnaar verdienen <strong>+10 bonuspunten</strong>, ook als ze niet uitrijden.</div>
    </div>

    <div class="card mt-20">
      <div class="card-title">📊 Puntentelling per Positie</div>
      <div class="table-wrap" style="max-height:400px;overflow-y:auto">
        <table>
          <thead><tr><th>Positie</th><th>Monument</th><th>World Tour</th><th>Niet-WorldTour</th></tr></thead>
          <tbody>
            ${[
              [1,125,100,80],[2,100,80,64],[3,80,65,52],[4,70,55,44],[5,60,48,38],
              [6,55,44,35],[7,50,40,32],[8,45,36,29],[9,40,32,26],[10,37,30,24],
              [11,34,27,22],[12,31,24,20],[13,28,22,18],[14,25,20,16],[15,22,18,14],
              [16,20,16,12],[17,18,14,11],[18,16,12,10],[19,14,10,9],[20,12,9,8],
              [21,10,8,7],[22,9,7,6],[23,8,6,5],[24,7,5,4],[25,6,4,3],
              [26,5,3,3],[27,4,2,2],[28,3,2,2],[29,2,1,1],[30,1,1,1],
            ].map(([pos,m,wt,nwt]) => `<tr>
              <td class="fw-700">${pos}</td>
              <td><span class="text-accent fw-700">${m}</span></td>
              <td><span class="fw-700">${wt}</span></td>
              <td><span class="text-muted">${nwt}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Instellingen
// ═══════════════════════════════════════════════════════════════════════════
async function renderInstellingen() {
  const inst = state.instellingen;

  // Sporza sessie-status ophalen (cookie verlooptijdstip)
  let sporzaSession = { configured: false, vt_configured: false, rt_configured: false, verlopen: false };
  try { sporzaSession = await get('/api/sporza-session'); } catch(e) { /* stil falen */ }
  const { configured: sporzaOk, vt_configured: vtOk, rt_configured: rtOk, verlopen: sporzaVerlopen } = sporzaSession;

  // QR-code ophalen na render
  setTimeout(async () => {
    try {
      const { url, qr } = await get('/api/server-info');
      const urlEl = document.getElementById('qr-url-text');
      const imgEl = document.getElementById('qr-img');
      if (urlEl) urlEl.textContent = url;
      if (imgEl && qr) { imgEl.src = qr; imgEl.style.display = 'block'; }
    } catch(e) { /* stil falen */ }
  }, 50);

  return `
    <div class="page-header"><div class="page-title">Instellingen</div></div>

    <div class="card" style="max-width:480px;margin-bottom:16px">
      <div class="card-title">📱 Open op andere apparaten</div>
      <div style="display:flex;align-items:center;gap:24px;margin-top:12px;flex-wrap:wrap">
        <img id="qr-img" style="width:180px;height:180px;border-radius:10px;flex-shrink:0;display:none" alt="QR-code" />
        <div>
          <div class="text-muted fs-sm" style="margin-bottom:6px">Scan met je iPhone-camera:</div>
          <div id="qr-url-text" style="font-family:monospace;font-size:0.85rem;background:var(--card-bg);padding:6px 10px;border-radius:6px;border:1px solid var(--border)">laden…</div>
          <div class="text-muted fs-sm" style="margin-top:8px">Zorg dat iPhone en Mac op<br>hetzelfde wifi-netwerk zitten.</div>
        </div>
      </div>
    </div>

    <div class="card" style="max-width:480px;margin-bottom:16px">
      <div class="card-title">🔔 Notificaties</div>
      ${'Notification' in window ? (() => {
        const perm = Notification.permission;
        if (perm === 'granted') return `
          <div class="text-muted fs-sm" style="margin:8px 0 10px">Notificaties zijn ingeschakeld. Je ontvangt een melding als de volgende wedstrijd binnen 3 dagen is en je opstelling nog niet is ingesteld.</div>
          <div style="padding:8px 12px;background:rgba(74,222,128,0.1);border-radius:8px;font-size:0.84rem;color:var(--green);font-weight:600">✅ Notificaties ingeschakeld</div>`;
        if (perm === 'denied') return `
          <div class="text-muted fs-sm" style="margin:8px 0">Notificaties zijn geblokkeerd. Pas de instellingen aan in je browser om notificaties toe te staan.</div>
          <div style="padding:8px 12px;background:rgba(239,68,68,0.1);border-radius:8px;font-size:0.84rem;color:var(--red)">🚫 Geblokkeerd in browser</div>`;
        return `
          <div class="text-muted fs-sm" style="margin:8px 0 12px">Ontvang een melding als de volgende wedstrijd nadert en je opstelling nog niet is ingesteld.</div>
          <button class="btn btn-primary" style="width:100%" onclick="vraagNotificatiePermissie()">🔔 Notificaties inschakelen</button>`;
      })() : '<div class="text-muted fs-sm">Notificaties worden niet ondersteund in deze browser.</div>'}
    </div>

    <div class="card" style="max-width:480px;margin-bottom:16px">
      <div class="card-title">🤖 AI Assistent</div>
      <div class="text-muted fs-sm" style="margin:8px 0 12px;line-height:1.6">
        Vul je Groq API-sleutel in om de AI Assistent te gebruiken.
        Gratis sleutel aanmaken op <strong>console.groq.com</strong> (geen creditcard nodig).
      </div>
      <form id="ai-key-form">
        <div class="form-group">
          <label class="form-label">Groq API-sleutel (gratis)</label>
          <input class="form-input" id="ai-key-input" name="groq_api_key" type="password"
            autocomplete="off" spellcheck="false"
            placeholder="gsk_..."
            value="${inst.groq_api_key ? '••••••••' + inst.groq_api_key.slice(-4) : ''}" />
          <div class="text-muted fs-sm" style="margin-top:4px">
            Wordt veilig lokaal opgeslagen in de database.
          </div>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%">💾 API-sleutel opslaan</button>
      </form>
    </div>

    <div class="card" style="max-width:480px;margin-bottom:16px">
      <div class="card-title">🏆 Sporza WM Sessie</div>

      ${sporzaVerlopen ? `
      <div style="padding:10px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.4);
                  border-radius:8px;margin:10px 0 14px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:1.2rem;flex-shrink:0">⏰</span>
        <div>
          <div style="font-weight:700;font-size:0.87rem;color:var(--red);margin-bottom:3px">Sessie verlopen (auto-refresh mislukt)</div>
          <div class="text-muted fs-sm">Kopieer een nieuwe <strong>refresh token</strong> om automatisch te vernieuwen.</div>
        </div>
      </div>` : sporzaOk && rtOk ? `
      <div style="padding:8px 12px;background:rgba(74,222,128,0.08);border-radius:8px;
                  font-size:0.84rem;color:var(--green);font-weight:600;margin:10px 0 14px">
        ✅ Sessie geldig · 🔄 Auto-refresh actief
      </div>` : sporzaOk ? `
      <div style="padding:8px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:8px;
                  font-size:0.84rem;color:var(--text);margin:10px 0 14px">
        ✅ Cookie ingesteld · <span style="color:rgba(245,158,11,0.9)">⚠️ Geen auto-refresh</span>
        <div class="text-muted" style="font-size:0.76rem;margin-top:4px">Voeg de refresh token toe om de sessie permanent automatisch te vernieuwen.</div>
      </div>` : `
      <div class="text-muted fs-sm" style="margin:10px 0 14px;line-height:1.6">
        Stel je Sporza-cookies in om opstelling automatisch door te zetten
        en je mini-competities te bekijken.
      </div>`}

      <div style="background:var(--bg3);border-radius:8px;padding:12px;margin-bottom:12px;font-size:0.82rem;line-height:1.8">
        <strong>Hoe verse cookies ophalen (Chrome op Mac/PC):</strong><br>
        1. Open <a href="https://wielermanager.sporza.be" target="_blank" style="color:var(--accent)">wielermanager.sporza.be</a> → log in → druk <kbd style="background:var(--card-bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px">F5</kbd> (pagina herladen)<br>
        2. Druk <kbd style="background:var(--card-bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px">F12</kbd> → tab <strong>Application</strong> → links: <strong>Cookies</strong><br>
        3. Klik op <strong><code style="font-size:0.79rem">https://sporza.be</code></strong> (⚠️ niet <em>wielermanager</em>.sporza.be!)<br>
        4. Zoek <code style="font-size:0.79rem">sporza-site_profile_at</code> → kopieer de <strong>Value</strong> (lang JWT)<br>
        5. <em>Optioneel:</em> ook <code style="font-size:0.79rem">sporza-site_profile_rt</code> kopiëren → dan werkt auto-refresh 🔄<br>
        <span style="color:var(--orange)">⚠️ Herlaad de Sporza-pagina (F5) vóór het kopiëren — anders kan de cookie al verlopen zijn!</span>
      </div>

      <div class="form-group">
        <label class="form-label">
          Cookie <code>sporza-site_profile_rt</code>
          <span style="margin-left:6px;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);color:var(--green);border-radius:4px;padding:1px 7px;font-size:0.75rem">🔄 auto-refresh</span>
          ${rtOk ? '<span style="color:var(--green);font-size:0.78rem;margin-left:4px">● actief</span>' : ''}
        </label>
        <input id="inst-sporza-rt" type="password" class="form-input"
          placeholder="eyJhbGci… (refresh token — lang)" autocomplete="off"
          value="${rtOk ? '••••••••' : ''}" />
      </div>
      <div class="form-group">
        <label class="form-label">Cookie <code>sporza-site_profile_at</code>
          ${sporzaVerlopen ? '<span style="color:var(--red);font-size:0.78rem;margin-left:4px">● verlopen</span>' : sporzaOk ? '<span style="color:var(--green);font-size:0.78rem;margin-left:4px">● geldig</span>' : ''}
        </label>
        <input id="inst-sporza-at" type="password" class="form-input"
          placeholder="eyJraWQi… (access token)" autocomplete="off"
          value="${sporzaOk ? '••••••••' : ''}" />
      </div>
      <div class="form-group">
        <label class="form-label">Cookie <code>sporza-site_profile_vt</code>
          <span class="text-muted" style="font-size:0.78rem">(optioneel)</span></label>
        <input id="inst-sporza-vt" type="password" class="form-input"
          placeholder="eyJhbGci…" autocomplete="off"
          value="${vtOk ? '••••••••' : ''}" />
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-primary" style="flex:1"
          onclick="slaSporzaCookieOpInstellingen()">💾 Opslaan</button>
        <button class="btn btn-secondary" id="test-sporza-btn"
          onclick="testSporzaVerbinding()">🔌 Test verbinding</button>
      </div>
      <div id="sporza-test-result" style="margin-top:10px;display:none"></div>
    </div>

    <div class="card" style="max-width:480px">
      <div class="card-title">Competitie Instellingen</div>
      <form id="inst-form" style="margin-top:12px">
        <div class="form-group"><label class="form-label">Competitie naam</label>
          <input class="form-input" name="competitie" value="${inst.competitie || 'Voorjaar Mannen 2026'}" /></div>
        <div class="form-group"><label class="form-label">Budget (€M)</label>
          <input class="form-input" name="budget" type="number" min="10" max="200" step="1" value="${inst.budget || 120}" /></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Max Renners in Ploeg</label>
            <input class="form-input" name="max_renners" type="number" min="5" max="30" value="${inst.max_renners || 20}" /></div>
          <div class="form-group"><label class="form-label">Max Opstelling per Koers</label>
            <input class="form-input" name="max_starters" type="number" min="3" max="20" value="${inst.max_starters || 12}" /></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Max per Wielerploeg</label>
            <input class="form-input" name="max_per_ploeg" type="number" min="1" max="10" value="${inst.max_per_ploeg || 4}" /></div>
          <div class="form-group"><label class="form-label">Gratis Transfers</label>
            <input class="form-input" name="transfers_gratis" type="number" min="0" max="10" value="${inst.transfers_gratis || 3}" /></div>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Opslaan</button>
      </form>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Minicompetitie
// ═══════════════════════════════════════════════════════════════════════════

async function renderMiniCompetitie() {
  let data, foutmelding = null;
  try {
    data = await get('/api/sporza-mini');
  } catch(e) {
    foutmelding = e.message;
    data = null;
  }

  const comps = data?.minicompetities || [];

  const renderKlassementRij = (m, compSlug, i) => {
    const isEigen = m.isEigen;
    const posKleur = m.rank === 1 ? '#f59e0b' : m.rank <= 3 ? 'var(--accent)' : m.rank <= 10 ? 'var(--green)' : 'var(--text)';
    const clickAttr = m.teamCode
      ? `onclick="openMiniTeam('${compSlug}','${m.teamCode}','${(m.teamNaam||'').replace(/'/g,'\\\'').replace(/"/g,'&quot;')}','${(m.gebruiker||'').replace(/'/g,'\\\'')}')" style="cursor:pointer"`
      : '';
    return `
      <div ${clickAttr} class="mini-rij${isEigen ? ' mini-rij-eigen' : ''}">
        <span style="font-weight:700;color:${posKleur};min-width:24px;text-align:right;flex-shrink:0">${m.rank || i+1}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:${isEigen ? '700' : '500'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${m.teamNaam || '—'}
            ${isEigen ? '<span style="font-size:0.68rem;background:rgba(99,102,241,0.15);color:#6366f1;border-radius:4px;padding:1px 5px;margin-left:4px">jij</span>' : ''}
          </div>
          <div style="font-size:0.73rem;color:var(--muted)">${m.gebruiker || ''}</div>
        </div>
        <span style="font-weight:700;color:${m.punten > 0 ? 'var(--accent)' : 'var(--muted)'}">
          ${m.punten ?? '—'} pt
        </span>
        ${m.teamCode ? '<span style="font-size:0.75rem;color:var(--muted);flex-shrink:0">›</span>' : ''}
      </div>`;
  };

  const renderComp = (comp) => `
    <div class="card" style="margin-bottom:16px">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span>🏆 ${comp.naam}</span>
        <span class="text-muted" style="font-size:0.78rem;font-weight:normal">${comp.aantalDeelnemers} deelnemer${comp.aantalDeelnemers !== 1 ? 's' : ''}</span>
      </div>
      ${comp.klassement.length === 0
        ? `<div class="text-muted fs-sm" style="padding:8px 0">Klassement niet beschikbaar.</div>`
        : `<div style="margin-top:4px">${comp.klassement.map((m,i) => renderKlassementRij(m, comp.slug, i)).join('')}</div>`
      }
      ${comp.slug ? `
        <div style="margin-top:10px;font-size:0.75rem;text-align:right">
          <a href="https://wielermanager.sporza.be/${window._SPORZA_EDITION || 'vrjr-m-26'}/competitions/${comp.slug}"
             target="_blank" style="color:var(--accent)">↗ Bekijk op Sporza WM</a>
        </div>` : ''}
    </div>`;

  const cookieVerlopen = foutmelding && (foutmelding.includes('verlopen') || foutmelding.includes('Verlopen'));
  const geenCookie = foutmelding && foutmelding.includes('niet ingesteld');

  return `
    <div class="page-header">
      <div>
        <div class="page-title">🏆 Minicompetitie</div>
        <div class="page-subtitle">Jouw Sporza WM mini-competities</div>
      </div>
      <button class="btn btn-sm btn-secondary" onclick="herlaadMiniCompetitie()"
        style="font-size:0.8rem;padding:6px 12px">🔄 Vernieuwen</button>
    </div>

    ${cookieVerlopen || geenCookie ? `
      <div class="card mt-20" style="border:1px solid var(--red);background:rgba(239,68,68,0.05)">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <span style="font-size:1.5rem">${cookieVerlopen ? '⏰' : '🔑'}</span>
          <div>
            <div style="font-weight:700;margin-bottom:4px">${cookieVerlopen ? 'Sporza sessie verlopen' : 'Sporza cookie niet ingesteld'}</div>
            <div class="text-muted fs-sm" style="margin-bottom:12px">
              ${cookieVerlopen
                ? 'Je Sporza-cookie is verlopen. Log opnieuw in op Sporza en kopieer je cookie.'
                : 'Stel je Sporza-cookie in om je mini-competities te kunnen zien.'}
            </div>
            <button class="btn btn-primary" style="font-size:0.82rem"
              onclick="navigate('instellingen')">⚙️ Naar Instellingen</button>
          </div>
        </div>
      </div>` : ''}

    ${foutmelding && !cookieVerlopen && !geenCookie ? `
      <div class="card mt-20">
        <div class="text-muted fs-sm">⚠️ ${foutmelding}</div>
      </div>` : ''}

    ${comps.length === 0 && !foutmelding ? `
      <div class="card mt-20" style="text-align:center;padding:40px 24px">
        <div style="font-size:3rem;margin-bottom:12px">🏆</div>
        <div class="card-title" style="font-size:1rem;margin-bottom:8px">Geen mini-competities gevonden</div>
        <div class="text-muted fs-sm">Je neemt nog niet deel aan een mini-competitie op Sporza WM.</div>
      </div>` : ''}

    ${comps.map(renderComp).join('')}
  `;
}

async function herlaadMiniCompetitie() {
  navigateTo('mini-competitie');
}

async function openMiniTeam(slug, teamCode, teamNaam, gebruiker) {
  openModal(`
    <div class="modal-title">👥 ${teamNaam || gebruiker}</div>
    <div class="text-muted fs-sm" style="margin-bottom:12px">${gebruiker || ''}</div>
    <div id="mini-team-inhoud" style="text-align:center;padding:20px 0;color:var(--muted)">
      <div class="chat-spinner" style="margin:0 auto 8px"></div>
      Ploeg laden…
    </div>
  `);

  try {
    const data = await get(`/api/sporza-mini/team/${slug}/${teamCode}`);
    const renners = data.renners || [];
    const totaalPunten = data.totalScore ?? renners.reduce((s, r) => s + (r.punten || 0), 0);
    const totaalPrijs  = renners.reduce((s, r) => s + (r.prijs  || 0), 0);

    const el = document.getElementById('mini-team-inhoud');
    if (!el) return;

    if (!renners.length) {
      el.innerHTML = '<div class="text-muted fs-sm">Geen ploegdata beschikbaar.</div>';
      return;
    }

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;
                  margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)">
        <span class="text-muted" style="font-size:0.78rem">${renners.length} renners</span>
        <span style="font-size:0.82rem">
          <span style="color:var(--accent);font-weight:700">${totaalPunten} pt totaal</span>
          <span class="text-muted" style="margin-left:8px">${totaalPrijs}M€</span>
        </span>
      </div>
      ${renners.map(r => {
        const isKopman    = r.lineupType === 'CAPTAIN';
        const isSub       = r.lineupType === 'SUBSTITUTE';
        const inEigenPloeg = r.inEigenPloeg;
        const puntKleur = r.punten > 0 ? 'var(--accent)' : 'var(--muted)';
        const badge = isKopman
          ? '<span style="font-size:0.65rem;background:rgba(245,158,11,0.15);color:#f59e0b;border-radius:3px;padding:1px 4px;margin-left:4px;vertical-align:middle">★ kopman</span>'
          : isSub
          ? '<span style="font-size:0.65rem;background:var(--bg3);color:var(--muted);border-radius:3px;padding:1px 4px;margin-left:4px;vertical-align:middle">reserve</span>'
          : '';
        const eigenBadge = inEigenPloeg
          ? '<span style="font-size:0.65rem;background:rgba(74,222,128,0.15);color:var(--green);border-radius:3px;padding:1px 4px;margin-left:4px;vertical-align:middle">✓ mijn ploeg</span>'
          : '';
        const bgStyle = isKopman
          ? 'background:rgba(245,158,11,0.04);margin:0 -4px;padding:5px 4px;border-radius:4px'
          : inEigenPloeg
          ? 'background:rgba(74,222,128,0.06);margin:0 -4px;padding:5px 4px;border-radius:4px'
          : '';
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 0;
                      border-bottom:1px solid var(--border);font-size:0.83rem
                      ${bgStyle ? ';' + bgStyle : ''}">
            <div style="flex:1;min-width:0">
              <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:${isKopman ? '700' : '500'}">
                ${r.naam}${badge}${eigenBadge}
              </div>
              <div style="font-size:0.71rem;color:var(--muted)">${r.ploeg || ''} · ${r.prijs}M€</div>
            </div>
            <span style="font-weight:700;color:${puntKleur};min-width:44px;text-align:right">
              ${r.punten > 0 ? r.punten + ' pt' : '—'}
            </span>
          </div>`;
      }).join('')}
    `;
  } catch(e) {
    const el = document.getElementById('mini-team-inhoud');
    if (el) el.innerHTML = `<div class="text-muted fs-sm">⚠️ ${e.message}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: AI Assistent
// ═══════════════════════════════════════════════════════════════════════════

function renderAiChat() {
  const hasApiKey = !!(state.instellingen.groq_api_key);

  if (!hasApiKey) {
    return `
      <div class="page-header"><div class="page-title">🤖 AI Assistent</div></div>
      <div class="card" style="max-width:520px;text-align:center;padding:40px 24px">
        <div style="font-size:3rem;margin-bottom:16px">🔑</div>
        <div class="card-title" style="font-size:1rem;margin-bottom:8px">API-sleutel vereist</div>
        <div class="text-muted fs-sm" style="margin-bottom:20px;line-height:1.6">
          Om de AI Assistent te gebruiken heb je een gratis Groq API-sleutel nodig.<br>
          Maak er één aan op <strong>console.groq.com</strong> (geen creditcard nodig) en stel hem in via Instellingen.
        </div>
        <button class="btn btn-primary" onclick="navigate('instellingen')">⚙️ Naar Instellingen</button>
      </div>`;
  }

  const messagesHtml = state.chatMessages.length === 0
    ? `<div style="display:flex;align-items:center;justify-content:center;height:100%;
                   flex-direction:column;gap:12px;color:var(--muted)">
         <div style="font-size:2.5rem">🤖</div>
         <div style="font-size:0.9rem;text-align:center;max-width:300px;line-height:1.6">
           Stel een vraag over je renners, transferadvies of de komende wedstrijden.<br>
           <span style="font-size:0.8rem;opacity:0.7">Ik ken je volledige ploeg en budget.</span>
         </div>
       </div>`
    : state.chatMessages.map(m => renderChatMessage(m)).join('');

  return `
    <div class="page-header" style="margin-bottom:16px">
      <div>
        <div class="page-title">🤖 AI Assistent</div>
        <div class="page-subtitle">Gebaseerd op jouw ploeg en seizoen</div>
      </div>
      ${state.chatMessages.length > 0
        ? `<button class="btn btn-secondary" style="font-size:0.8rem;padding:6px 12px"
             onclick="clearChat()">🗑️ Wissen</button>`
        : ''}
    </div>

    <div style="display:flex;flex-direction:column;height:calc(100vh - 210px);min-height:400px;max-height:680px;
                background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
                overflow:hidden;box-shadow:var(--shadow)">

      <!-- Berichtenstroom -->
      <div id="chat-messages"
           style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
        ${messagesHtml}
      </div>

      <!-- Loading indicator -->
      ${state.chatLoading ? `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 20px;
                  border-top:1px solid var(--border);color:var(--muted);font-size:0.82rem;
                  background:var(--bg2)">
        <div class="chat-spinner"></div>
        AI denkt na…
      </div>` : ''}

      <!-- Input -->
      <div style="padding:14px 16px;border-top:1px solid var(--border);
                  display:flex;gap:10px;align-items:flex-end;background:var(--bg2)">
        <textarea id="chat-input"
          placeholder="Stel een vraag… (bijv. 'Welke transfer zou je aanraden voor Parijs-Roubaix?')"
          rows="2"
          style="flex:1;resize:none;background:var(--bg3);border:1px solid var(--border);
                 border-radius:8px;padding:10px 14px;color:var(--text);font-size:0.88rem;
                 font-family:inherit;line-height:1.4;outline:none;transition:border-color 0.15s;
                 scrollbar-width:thin"
          onkeydown="chatKeydown(event)"
          onfocus="this.style.borderColor='var(--accent)'"
          onblur="this.style.borderColor='var(--border)'"
          ${state.chatLoading ? 'disabled' : ''}></textarea>
        <button class="btn btn-primary" onclick="sendChatMessage()"
          ${state.chatLoading ? 'disabled' : ''}
          style="padding:10px 18px;flex-shrink:0;align-self:flex-end;font-size:0.9rem">
          Stuur →
        </button>
      </div>
    </div>`;
}

function renderChatMessage(msg) {
  const isUser = msg.role === 'user';
  const bubbleStyle = isUser
    ? `background:var(--accent);color:#fff;border-radius:16px 16px 4px 16px;align-self:flex-end;max-width:75%`
    : `background:var(--bg3);color:var(--text);border-radius:16px 16px 16px 4px;
       border:1px solid var(--border);align-self:flex-start;max-width:85%`;

  const formatted = (msg.content || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\n/g,'<br>');

  const transferHtml = msg.transfer_suggestion ? renderTransferCard(msg.transfer_suggestion) : '';

  return `
    <div style="display:flex;flex-direction:column;${isUser ? 'align-items:flex-end' : 'align-items:flex-start'}">
      <div style="${bubbleStyle};padding:11px 15px;font-size:0.87rem;line-height:1.65">
        ${formatted}
      </div>
      ${transferHtml}
      <div style="font-size:0.7rem;color:var(--muted);margin-top:3px;padding:0 4px">
        ${isUser ? 'Jij' : '🤖 AI Assistent'}
      </div>
    </div>`;
}

function renderTransferCard(ts) {
  if (!ts) return '';
  const matchOk  = ts.match_gevonden;
  const budgetOk = ts.budget_na !== null && ts.budget_na >= 0;

  const kostenStr = ts.transfer_kosten === 0
    ? `<span style="color:var(--green);font-weight:600">gratis</span>`
    : `<span style="color:var(--accent);font-weight:600">€${ts.transfer_kosten}M</span>`;

  const budgetStr = ts.budget_na !== null
    ? `<span style="color:${budgetOk ? 'var(--green)' : 'var(--red)'};font-weight:600">
        ${fmtPrijs(ts.budget_na)}${!budgetOk ? ' ⚠️' : ''}
       </span>`
    : '<span style="color:var(--muted)">onbekend</span>';

  const warningHtml = !matchOk
    ? `<div style="padding:8px 12px;background:rgba(239,68,68,0.12);border-radius:8px;
                   color:var(--red);font-size:0.79rem;margin-bottom:10px">
         ⚠️ Eén of beide renners niet gevonden in jouw database.
         Controleer de namen en voer de transfer handmatig uit.
       </div>`
    : '';

  const uitId  = ts.renner_uit_id  || 'null';
  const inId   = ts.renner_in_id   || 'null';
  const uitNam = (ts.renner_uit_naam || '').replace(/'/g,"\\'");
  const inNam  = (ts.renner_in_naam  || '').replace(/'/g,"\\'");

  return `
    <div style="margin-top:10px;background:var(--card);border:1px solid var(--border);
                border-radius:12px;padding:16px;max-width:340px;align-self:flex-start">
      <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;
                  color:var(--muted);font-weight:700;margin-bottom:10px">🔄 Voorgestelde Transfer</div>

      ${warningHtml}

      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:26px;height:26px;border-radius:50%;background:rgba(239,68,68,0.15);
                      display:flex;align-items:center;justify-content:center;font-size:0.85rem;flex-shrink:0">↓</div>
          <div>
            <div style="font-weight:700;font-size:0.87rem">${ts.renner_uit_naam || '—'}</div>
            <div style="font-size:0.73rem;color:var(--muted)">
              Verlaat ploeg${ts.renner_uit_prijs ? ' · ' + fmtPrijs(ts.renner_uit_prijs) : ''}
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:26px;height:26px;border-radius:50%;background:rgba(34,197,94,0.15);
                      display:flex;align-items:center;justify-content:center;font-size:0.85rem;flex-shrink:0">↑</div>
          <div>
            <div style="font-weight:700;font-size:0.87rem">${ts.renner_in_naam || '—'}</div>
            <div style="font-size:0.73rem;color:var(--muted)">
              Komt in ploeg${ts.renner_in_prijs ? ' · ' + fmtPrijs(ts.renner_in_prijs) : ''}
            </div>
          </div>
        </div>
      </div>

      ${ts.reden ? `<div style="font-size:0.8rem;color:var(--muted);border-top:1px solid var(--border);
                                padding-top:10px;margin-bottom:12px;line-height:1.5;font-style:italic">
        ${ts.reden.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
      </div>` : ''}

      <div style="display:flex;gap:16px;font-size:0.79rem;margin-bottom:12px;flex-wrap:wrap">
        <div>Transferkost: ${kostenStr}</div>
        <div>Budget na: ${budgetStr}</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" style="font-size:0.82rem;padding:7px 14px"
          ${matchOk ? `onclick="bevestigAiTransfer(${uitId},${inId},'${uitNam}','${inNam}')"` : 'disabled'}
          title="${matchOk ? 'Transfer bevestigen' : 'Renner niet gevonden in database'}">
          ✅ Bevestig Transfer
        </button>
        <button class="btn btn-secondary" style="font-size:0.82rem;padding:7px 12px"
          onclick="this.closest('div[style*=border-radius]').style.display='none'">
          Verberg
        </button>
      </div>
    </div>`;
}

// ── AI Chat event handlers ──────────────────────────────────────────────────

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

async function sendChatMessage() {
  if (state.chatLoading) return;
  const input = document.getElementById('chat-input');
  const msg = (input?.value || '').trim();
  if (!msg) return;

  // Voeg user-bericht toe en toon loading
  state.chatMessages.push({ role: 'user', content: msg });
  state.chatLoading = true;
  renderPage();
  const chatEl = document.getElementById('chat-messages');
  if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;

  // Stuur naar backend (stuur history zonder huidig bericht)
  const history = state.chatMessages.slice(0, -1).map(m => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const res = await post('/api/ai-chat', { message: msg, history });
    state.chatMessages.push({
      role: 'assistant',
      content: res.text || '(geen antwoord ontvangen)',
      transfer_suggestion: res.transfer_suggestion || null,
    });
  } catch(e) {
    state.chatMessages.push({
      role: 'assistant',
      content: `⚠️ Fout: ${e.message}`,
      transfer_suggestion: null,
    });
    toast(e.message, 'error');
  } finally {
    state.chatLoading = false;
    renderPage();
    const chatEl2 = document.getElementById('chat-messages');
    if (chatEl2) chatEl2.scrollTop = chatEl2.scrollHeight;
  }
}

async function bevestigAiTransfer(uitId, inId, uitNaam, inNaam) {
  if (!uitId || !inId) { toast('Renner-ID ontbreekt', 'error'); return; }
  if (!confirm(`Transfer bevestigen?\n\n↓ ${uitNaam}\n↑ ${inNaam}\n\nDeze actie is onomkeerbaar.`)) return;
  try {
    const res = await post('/api/transfers', { renner_uit_id: uitId, renner_in_id: inId });
    const kostenStr = res.kosten > 0 ? ` (-€${res.kosten}M)` : ' (gratis)';
    toast(`Transfer uitgevoerd: ${uitNaam} → ${inNaam}${kostenStr} ✅`, 'success');
    await loadAll();
    state.chatMessages.push({
      role: 'assistant',
      content: `✅ Transfer bevestigd!\n**${uitNaam}** verlaat de ploeg · **${inNaam}** komt erin${kostenStr}.\nNieuw budget: ${fmtPrijs(res.nieuw_budget)}.`,
    });
    renderPage();
  } catch(e) {
    toast(e.message, 'error');
    state.chatMessages.push({
      role: 'assistant',
      content: `❌ Transfer mislukt: ${e.message}`,
    });
    renderPage();
  }
}

function clearChat() {
  if (state.chatMessages.length === 0) return;
  if (!confirm('Gesprek wissen?')) return;
  state.chatMessages = [];
  renderPage();
}

async function laadPcsWedstrijden(rid) {
  const btn = document.getElementById('pcs-btn');
  const resultDiv = document.getElementById('pcs-resultaat');
  if (!btn || !resultDiv) return;

  btn.disabled = true;
  btn.textContent = '⏳ Laden…';
  resultDiv.innerHTML = '<span style="color:var(--muted)">Gegevens ophalen van ProCyclingStats…</span>';

  try {
    const data = await get(`/api/renners/${rid}/pcs-wedstrijden`);
    const lijst = data.wedstrijden || [];
    if (lijst.length === 0) {
      resultDiv.innerHTML = `<span style="color:var(--muted)">Geen wedstrijden uit de competitie gevonden op PCS.</span>`;
    } else {
      const soortLabel = { monument: '🏆', worldtour: '⭐', niet_wt: '•' };
      resultDiv.innerHTML = lijst.map(w => `
        <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--muted);min-width:82px;font-size:0.8rem">${w.datum}</span>
          <span>${soortLabel[w.soort] || '•'} ${w.naam}</span>
          ${w.afgelopen ? '<span style="color:var(--muted);font-size:0.75rem">(gereden)</span>' : '<span style="color:var(--green);font-size:0.75rem">✓ komend</span>'}
        </div>`).join('');
    }
    btn.textContent = '🔄 Vernieuwen';
  } catch (err) {
    resultDiv.innerHTML = `<span style="color:var(--danger)">⚠ ${err.message}</span>`;
    btn.textContent = '🔍 Opvragen';
  } finally {
    btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Renner Detail
// ═══════════════════════════════════════════════════════════════════════════

function renderHistoriek2025Kaart(historiek, rid, naam) {
  const posRij = (h) => {
    const pos = h.positie;
    let kleur = 'var(--text)', label = pos ? `#${pos}` : '—';
    if (pos === 1)      kleur = '#f59e0b';   // goud
    else if (pos <= 3)  kleur = 'var(--accent)';
    else if (pos <= 10) kleur = 'var(--green)';
    else if (!pos)      kleur = 'var(--muted)';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;
                  border-bottom:1px solid var(--border);font-size:0.83rem">
        ${h.datum ? `<span style="color:var(--muted);font-size:0.75rem;min-width:36px">${h.datum}</span>` : '<span style="min-width:36px"></span>'}
        <span style="flex:1">${h.koers}</span>
        <span style="font-weight:700;color:${kleur};min-width:60px;text-align:right">${label}</span>
      </div>`;
  };

  const inhoud = historiek.length === 0
    ? `<div class="text-muted fs-sm" style="padding:6px 0">
         Nog geen data. Klik op <strong>🔄 Update</strong> om de resultaten van 2025 op te halen en op te slaan.
       </div>`
    : historiek.map(posRij).join('');

  return `
    <div class="card" style="margin-top:16px" id="historiek-2025-kaart">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span>📅 Resultaten seizoen 2025</span>
        <button class="btn btn-sm" id="historiek-laden-btn"
          onclick="laadHistoriek2025(${rid})"
          style="font-size:0.72rem;padding:3px 10px">
          ${historiek.length ? '🔄 Herladen' : '📥 Laden'}
        </button>
      </div>
      <div id="historiek-2025-inhoud">${inhoud}</div>
    </div>`;
}

async function laadHistoriek2025(rid) {
  const btn    = document.getElementById('historiek-laden-btn');
  const inhoud = document.getElementById('historiek-2025-inhoud');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '⏳ Bezig…';
  if (inhoud) inhoud.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;color:var(--muted);font-size:0.83rem"><div class="chat-spinner"></div> Ophalen van ProCyclingStats…</div>`;

  try {
    const data = await post(`/api/renners/${rid}/historiek`, {});
    const historiek = data.historiek_2025 || [];

    if (inhoud) {
      if (historiek.length === 0) {
        inhoud.innerHTML = `<div class="text-muted fs-sm" style="padding:6px 0">Geen resultaten gevonden op ProCyclingStats voor 2025.</div>`;
      } else {
        inhoud.innerHTML = historiek.map(h => {
          const pos = h.positie;
          let kleur = 'var(--text)', label = pos ? `#${pos}` : '—';
          if (pos === 1)      kleur = '#f59e0b';
          else if (pos <= 3)  kleur = 'var(--accent)';
          else if (pos <= 10) kleur = 'var(--green)';
          else if (!pos)      kleur = 'var(--muted)';
          return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;
                    border-bottom:1px solid var(--border);font-size:0.83rem">
            ${h.datum ? `<span style="color:var(--muted);font-size:0.75rem;min-width:36px">${h.datum}</span>` : '<span style="min-width:36px"></span>'}
            <span style="flex:1">${h.koers}</span>
            <span style="font-weight:700;color:${kleur};min-width:60px;text-align:right">${label}</span>
          </div>`;
        }).join('');
      }
    }

    btn.textContent = historiek.length ? '🔄 Herladen' : '📥 Laden';
    if (historiek.length) toast(`${historiek.length} resultaten geladen`, 'success');
  } catch(err) {
    if (inhoud) inhoud.innerHTML = `<div class="text-muted fs-sm" style="padding:6px 0">⚠️ Fout: ${err.message}</div>`;
    btn.textContent = '📥 Laden';
    toast('Laden mislukt: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function renderRennerDetail() {
  const rid = state.rennerDetailId;
  const data = await get(`/api/renners/${rid}/detail`);
  const r = data.renner;
  const koersen = data.koersen;
  const transferIn = data.transfer_in;
  const aangeschaft = data.aangeschaft_op;
  const historiek2025 = data.historiek_2025 || [];
  const aliassen = data.aliassen || [];

  const fotoSrc = r.foto || '';
  const fotoEl = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px;flex-shrink:0">
      ${fotoSrc
        ? `<img id="detail-foto-img" src="${fotoSrc}" style="width:100px;height:100px;border-radius:14px;object-fit:cover">`
        : `<div id="detail-foto-img" style="width:100px;height:100px;border-radius:14px;background:var(--card-bg);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:3rem">👤</div>`}
      <button class="btn btn-sm btn-primary" id="update-renner-btn"
        onclick="updateRennerVolledig(${r.id}, '${r.naam.replace(/'/g,"\\'")}')"
        style="width:100px;font-size:0.72rem" title="Foto, ploeg, prijs en wedstrijdresultaten bijwerken">
        🔄 Update
      </button>
      <div id="update-renner-status" style="font-size:0.7rem;color:var(--muted);text-align:center;max-width:100px"></div>
    </div>`;

  const statBox = (label, val, green) => `
    <div style="min-width:70px">
      <div class="text-muted fs-sm">${label}</div>
      <div class="fw-700${green ? ' text-green' : ''}">${val}</div>
    </div>`;

  // Transferbalans
  const koersWithPunten = koersen.filter(k => k.renner_punten > 0);
  const totaalPunten = koersen.reduce((s, k) => s + (k.renner_punten || 0), 0);
  const transferKosten = transferIn ? transferIn.kosten : 0;
  const roi = r.prijs > 0 ? (totaalPunten / r.prijs).toFixed(1) : '—';

  const transferHtml = data.in_ploeg ? `
    <div class="card mt-20">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        💰 Transferbalans
        <button class="btn btn-sm ${r.geblesseerd ? 'btn-primary' : 'btn-secondary'}"
          onclick="toggleGeblesseerd(${r.id},'${r.naam.replace(/'/g,"\\'")}',${r.geblesseerd?1:0})">
          ${r.geblesseerd ? '✅ Fit markeren' : '🤕 Geblesseerd markeren'}
        </button>
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:8px">
        <div style="flex:1;min-width:140px">
          <div class="text-muted fs-sm">Aangeschaft op</div>
          <div class="fw-700">${aangeschaft ? fmtDate(aangeschaft) : '—'}</div>
        </div>
        ${transferIn ? `
        <div style="flex:1;min-width:140px">
          <div class="text-muted fs-sm">Transfer voor</div>
          <div class="fw-700">${transferIn.renner_uit_naam}</div>
        </div>
        <div style="flex:1;min-width:100px">
          <div class="text-muted fs-sm">Transferkost</div>
          <div class="fw-700 ${transferKosten > 0 ? 'text-red' : 'text-green'}">${transferKosten > 0 ? `-€${transferKosten}M` : 'Gratis'}</div>
        </div>` : ''}
        <div style="flex:1;min-width:100px">
          <div class="text-muted fs-sm">Marktwaarde</div>
          <div class="fw-700">${fmtPrijs(r.prijs)}</div>
        </div>
        <div style="flex:1;min-width:100px">
          <div class="text-muted fs-sm">Punten gescoord</div>
          <div class="fw-700 ${totaalPunten > 0 ? 'text-green' : 'text-muted'}">${totaalPunten} pt</div>
        </div>
        <div style="flex:1;min-width:100px">
          <div class="text-muted fs-sm">Ratio (pt/€M)</div>
          <div class="fw-700 ${parseFloat(roi) > 5 ? 'text-green' : parseFloat(roi) > 0 ? '' : 'text-muted'}">⚡ ${roi}</div>
        </div>
      </div>
      ${r.geblesseerd ? `
        <div style="margin-top:12px;padding:8px 12px;background:rgba(239,68,68,0.1);border-radius:8px;font-size:0.83rem;color:var(--red);font-weight:600">
          🤕 Geblesseerd / Start mogelijk niet
        </div>` : ''}
    </div>` : '';

  return `
    <div class="page-header">
      <div>
        <div class="page-title">${r.naam}${r.geblesseerd ? ' 🤕' : ''}</div>
        <div class="page-subtitle">${r.ploeg}</div>
      </div>
    </div>

    <div class="card mt-20">
      <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
        ${fotoEl}
        <div style="flex:1;min-width:200px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
            <span style="font-size:1.25rem;font-weight:700">${r.naam}</span>
            ${rolBadge(r.rol)}
            ${data.in_ploeg ? '<span class="badge" style="background:rgba(74,222,128,0.15);color:var(--green)">In ploeg</span>' : ''}
            ${r.geblesseerd ? '<span class="badge" style="background:rgba(239,68,68,0.15);color:var(--red)">🤕 Geblesseerd</span>' : ''}
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            ${jerseyHtml(r.ploeg, {size:32})}
            <span style="font-size:0.95rem;font-weight:600">${r.ploeg}</span>
          </div>
          <div style="display:flex;gap:24px;flex-wrap:wrap">
            ${statBox('Prijs', fmtPrijs(r.prijs))}
            ${statBox('Totaal punten', r.totaal_punten || 0, r.totaal_punten > 0)}
            ${statBox('Wedstrijden', koersen.length)}
            ${statBox('Ratio', `${roi} pt/€M`, parseFloat(roi) > 5)}
          </div>
        </div>
      </div>
    </div>

    ${transferHtml}

    <div class="card mt-20">
      <div class="card-title">Wedstrijden (${koersen.length})</div>
      ${koersen.length === 0
        ? `<div class="text-muted fs-sm">Nog geen wedstrijden. Voeg deze renner toe aan een opstelling.</div>`
        : `<div class="koers-blokken">
          ${koersen.map(k => {
            const opsStatus = k.is_kopman
              ? `<span style="font-size:0.7rem;color:var(--accent)">⭐ Kopman</span>`
              : `<span style="font-size:0.7rem;color:var(--green)">👥 Opstelling</span>`;
            return `
            <div class="koers-blok ${k.soort}${k.afgelopen === 1 ? ' afgelopen' : ''}"
                 onclick="openKoersDetail(${k.id})" title="${k.naam}">
              <div class="koers-blok-datum">${fmtDate(k.datum)}</div>
              <div class="koers-blok-naam">${k.naam}</div>
              <div class="koers-blok-ops" style="flex-direction:column;align-items:flex-end;gap:2px">
                ${k.afgelopen === 1
                  ? `<span class="koers-blok-done">✓</span>
                     ${k.positie ? `<span style="font-size:0.7rem;color:var(--muted)">#${k.positie}</span>` : ''}
                     <span style="font-size:0.75rem;font-weight:700;color:${k.renner_punten > 0 ? 'var(--accent)' : 'var(--muted)'}">
                       ${k.renner_punten > 0 ? k.renner_punten + ' pt' : '—'}
                     </span>
                     ${k.team_punten > 0 ? `<span style="font-size:0.68rem;color:var(--muted)">👥 ${k.team_punten} pt</span>` : ''}`
                  : k.afgelopen === 2
                    ? `<span style="color:var(--accent);font-size:0.72rem">📤 Doorgezet</span>`
                    : opsStatus}
              </div>
            </div>`;
          }).join('')}
        </div>`}
    </div>

    ${renderHistoriek2025Kaart(historiek2025, r.id, r.naam)}

    <div class="card" style="margin-top:16px">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0">
        <span>🏁 Deelname wedstrijden (PCS)</span>
        <button class="btn btn-sm" id="pcs-btn" onclick="laadPcsWedstrijden(${r.id})">🔍 Opvragen</button>
      </div>
      <div id="pcs-resultaat" class="text-muted fs-sm" style="margin-top:10px;line-height:1.8">
        Klik op "Opvragen" om via ProCyclingStats te zien aan welke wielermanager-wedstrijden deze renner deelneemt.
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span>🏷️ Naam-aliassen <span class="text-muted" style="font-size:0.8rem;font-weight:400">(${aliassen.length})</span></span>
        <button class="btn btn-sm btn-primary" onclick="openAliasToevoegen(${r.id})">+ Alias</button>
      </div>
      <div class="text-muted fs-sm" style="margin-bottom:10px;line-height:1.5">
        Aliassen koppelen alternatieve schrijfwijzen (PCS, Sporza) aan deze renner voor correcte live-markering.<br>
        Bijv. <em>"PIDCOCK Thomas"</em> of <em>"Thomas Pidcock"</em> voor Tom Pidcock.
      </div>
      ${aliassen.length === 0
        ? `<div class="text-muted fs-sm">Geen aliassen geconfigureerd.</div>`
        : `<div style="display:flex;flex-wrap:wrap;gap:6px">
            ${aliassen.map(a => `
              <span style="display:inline-flex;align-items:center;gap:5px;background:var(--bg3);
                           border:1px solid var(--border);padding:3px 10px;border-radius:20px;font-size:0.82rem">
                <code style="font-family:monospace;font-size:0.78rem">${a.alias}</code>
                <button style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:1.1rem;
                               padding:0 0 1px;line-height:1;flex-shrink:0"
                  onclick="verwijderAlias(${a.id},'${a.alias}',${r.id})"
                  title="Alias verwijderen">×</button>
              </span>`).join('')}
          </div>`}
    </div>
  `;
}

function openAliasToevoegen(rid) {
  openModal(`
    <div class="modal-title">🏷️ Naam-alias toevoegen</div>
    <div class="text-muted fs-sm" style="margin-bottom:12px;line-height:1.5">
      Voer de naam in zoals die voorkomt bij PCS of Sporza.<br>
      Bijv. <em>"PIDCOCK Thomas"</em> of <em>"Thomas Pidcock"</em>.<br>
      De naam wordt automatisch genormaliseerd (kleine letters, geen accenten).
    </div>
    <form id="alias-form">
      <div class="form-group">
        <label class="form-label">Alias</label>
        <input class="form-input" id="alias-input" name="alias"
               placeholder="bijv. Thomas Pidcock" required autofocus />
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button type="submit" class="btn btn-primary" style="flex:1">💾 Opslaan</button>
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Annuleren</button>
      </div>
    </form>
  `);
  document.getElementById('alias-form').addEventListener('submit', async e => {
    e.preventDefault();
    const alias = document.getElementById('alias-input').value.trim();
    if (!alias) return;
    try {
      await post(`/api/renners/${rid}/aliassen`, { alias });
      toast('Alias toegevoegd ✅', 'success');
      closeModal();
      renderPage();
    } catch(err) { toast('Fout: ' + err.message, 'error'); }
  });
}

async function verwijderAlias(aid, alias, rid) {
  if (!confirm(`Alias "${alias}" verwijderen?`)) return;
  try {
    await del(`/api/renners/aliassen/${aid}`);
    toast('Alias verwijderd', 'success');
    renderPage();
  } catch(err) { toast('Fout: ' + err.message, 'error'); }
}

async function updateRennerVolledig(rid, naam) {
  const btn    = document.getElementById('update-renner-btn');
  const status = document.getElementById('update-renner-status');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '⏳ Bezig…';
  if (status) status.textContent = 'Ophalen…';

  try {
    const data = await post(`/api/renners/${rid}/update`, {});
    const w = data.wijzigingen || {};

    // ── Foto direct in DOM updaten ──────────────────────────────────────────
    const fotoNieuw = w.foto?.nieuw;
    if (fotoNieuw) {
      const img = document.getElementById('detail-foto-img');
      if (img) {
        if (img.tagName === 'IMG') {
          img.src = fotoNieuw;
        } else {
          const newImg = document.createElement('img');
          newImg.id = 'detail-foto-img';
          newImg.src = fotoNieuw;
          newImg.style.cssText = 'width:100px;height:100px;border-radius:14px;object-fit:cover';
          img.replaceWith(newImg);
        }
      }
    }

    // ── Overzichtsmodal ────────────────────────────────────────────────────
    const badge = (ok, tekst) =>
      `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:0.85rem">
        <span style="color:${ok ? 'var(--green)' : 'var(--muted)'}">${ok ? '✓' : '–'}</span>
        <span>${tekst}</span>
      </div>`;

    const fotoBadge  = w.foto?.gewijzigd
      ? badge(true, `Foto bijgewerkt`)
      : badge(false, `Foto ongewijzigd`);
    const ploegBadge = w.ploeg?.gewijzigd
      ? badge(true, `Ploeg: <del style="opacity:.5">${w.ploeg.oud}</del> → <strong>${w.ploeg.nieuw}</strong>`)
      : badge(false, `Ploeg: ${w.ploeg?.nieuw || '—'}`);
    const prijsBadge = w.prijs?.gewijzigd
      ? badge(true, `Prijs: <del style="opacity:.5">€${w.prijs.oud}M</del> → <strong>€${w.prijs.nieuw}M</strong>`)
      : badge(false, `Prijs: €${w.prijs?.nieuw || '—'}M`);

    // ── Historiek 2025 ─────────────────────────────────────────────────────
    const historiek = data.historiek_2025 || [];
    const historiekHtml = historiek.length === 0
      ? `<div class="text-muted fs-sm" style="padding:8px 0">Geen resultaten gevonden op ProCyclingStats voor 2025.</div>`
      : historiek.map(h => {
          const pos = h.positie;
          let posKleur = 'var(--muted)';
          let posLabel = 'niet geklasseerd';
          if (pos) {
            posLabel = `#${pos}`;
            posKleur = pos === 1 ? 'var(--accent2)' : pos <= 3 ? 'var(--accent)' : pos <= 10 ? 'var(--green)' : 'var(--text)';
          }
          return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:0.83rem">
            ${h.datum ? `<span style="color:var(--muted);font-size:0.75rem;min-width:36px">${h.datum}</span>` : ''}
            <span style="flex:1">${h.koers}</span>
            <span style="font-weight:700;color:${posKleur};min-width:80px;text-align:right">${posLabel}</span>
          </div>`;
        }).join('');

    openModal(`
      <div class="modal-title">🔄 Update — ${naam}</div>
      <div style="margin:12px 0 6px;padding:10px;background:var(--bg3);border-radius:8px">
        ${fotoBadge}${ploegBadge}${prijsBadge}
      </div>
      <div style="font-weight:600;font-size:0.83rem;margin:14px 0 4px">
        📅 Resultaten 2025 — wielermanager-wedstrijden
        ${historiek.length ? `<span class="text-muted" style="font-weight:normal">(${historiek.length} gevonden)</span>` : ''}
      </div>
      <div style="max-height:280px;overflow-y:auto">${historiekHtml}</div>
      ${data.pcs_url ? `<div style="margin-top:8px;font-size:0.75rem;text-align:right">
        <a href="${data.pcs_url}" target="_blank" style="color:var(--accent)">↗ Volledige PCS historiek</a>
      </div>` : ''}
      <button class="btn btn-primary" style="width:100%;margin-top:14px"
        onclick="closeModal();renderPage()">✓ Sluiten &amp; vernieuwen</button>
    `);

    // Refresh state
    state.renners = await get('/api/renners');
    toast(`${naam} bijgewerkt`, 'success');
    if (status) status.textContent = '✓ Bijgewerkt';
    btn.textContent = '🔄 Update';

    // Historiek-kaartje in de pagina bijwerken zonder volledige reload
    const kaartInhoud = document.getElementById('historiek-2025-inhoud');
    if (kaartInhoud && historiek.length > 0) {
      const posRij = (h) => {
        const pos = h.positie;
        let kleur = 'var(--text)', label = pos ? `#${pos}` : '—';
        if (pos === 1)      kleur = '#f59e0b';
        else if (pos <= 3)  kleur = 'var(--accent)';
        else if (pos <= 10) kleur = 'var(--green)';
        else if (!pos)      kleur = 'var(--muted)';
        return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;
                  border-bottom:1px solid var(--border);font-size:0.83rem">
          ${h.datum ? `<span style="color:var(--muted);font-size:0.75rem;min-width:36px">${h.datum}</span>` : '<span style="min-width:36px"></span>'}
          <span style="flex:1">${h.koers}</span>
          <span style="font-weight:700;color:${kleur};min-width:60px;text-align:right">${label}</span>
        </div>`;
      };
      kaartInhoud.innerHTML = historiek.map(posRij).join('');
      // Teller in kaart-titel updaten
      const kaart = document.getElementById('historiek-2025-kaart');
      if (kaart) {
        const teller = kaart.querySelector('.card-title span.text-muted');
        if (teller) teller.textContent = `${historiek.length} wedstrijd${historiek.length !== 1 ? 'en' : ''}`;
      }
    }

  } catch(err) {
    if (status) status.textContent = '⚠ Fout';
    btn.textContent = '🔄 Update';
    toast('Update mislukt: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Render engine
// ═══════════════════════════════════════════════════════════════════════════
async function renderPage() {
  const app = document.getElementById('app');
  try {
    let html;
    // Stop live refresh bij elke paginawissel; herstart alleen op dashboard
    if (state.page !== 'dashboard') stopLiveRefresh();
    switch (state.page) {
      case 'dashboard':    html = renderDashboard(); break;
      case 'ploeg':        html = renderPloeg(); break;
      case 'renners':      html = renderRenners(); break;
      case 'koersen':      html = renderKoersen(); break;
      case 'koers-detail':  html = await renderKoersDetail(); break;
      case 'renner-detail': html = await renderRennerDetail(); break;
      case 'statistieken': html = renderStatistieken(); break;
      case 'suggesties':   html = await renderSuggesties(); break;
      case 'spelregels':   html = renderSpelregels(); break;
      case 'ai-chat':          html = renderAiChat(); break;
      case 'mini-competitie':  html = await renderMiniCompetitie(); break;
      case 'instellingen':     html = await renderInstellingen(); break;
      default: html = renderDashboard();
    }
    app.innerHTML = renderBreadcrumb() + html;
    // Pagina-overgangsanimatie
    app.classList.remove('page-anim');
    void app.offsetWidth; // force reflow
    app.classList.add('page-anim');
    // Start live refresh als er een wedstrijd vandaag is
    if (state.page === 'dashboard') {
      const today = new Date().toISOString().slice(0, 10);
      const vandaag = (state.koersen || []).find(k => k.datum === today && !k.afgelopen);
      if (vandaag) startLiveRefresh(vandaag.id);
    }
    if (state.page === 'instellingen') {
      document.getElementById('inst-form').addEventListener('submit', async e => {
        e.preventDefault();
        try {
          await put('/api/instellingen', Object.fromEntries(new FormData(e.target)));
          toast('Instellingen opgeslagen', 'success');
          await refreshAll();
        } catch(err) { toast(err.message, 'error'); }
      });
      const aiKeyForm = document.getElementById('ai-key-form');
      if (aiKeyForm) {
        aiKeyForm.addEventListener('submit', async e => {
          e.preventDefault();
          const val = (document.getElementById('ai-key-input')?.value || '').trim();
          if (!val || val.startsWith('••')) {
            toast('Geen wijziging gedetecteerd', 'info');
            return;
          }
          try {
            await put('/api/instellingen', { groq_api_key: val });
            state.instellingen = await get('/api/instellingen');
            toast('API-sleutel opgeslagen ✅', 'success');
            renderPage();
          } catch(err) { toast(err.message, 'error'); }
        });
      }
    }
  } catch(e) {
    app.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div>
      <div class="empty-title">Fout bij laden</div><div class="empty-text">${e.message}</div></div>`;
  }
}

// ── Refresh helpers ──────────────────────────────────────────────────────────
async function refreshAll() { await loadAll(); renderPage(); }
async function refreshPloeg() {
  state.ploeg   = await get('/api/mijn-ploeg');
  state.renners = await get('/api/renners');
  renderPage();
}
async function refreshKoersen() {
  state.koersen = await get('/api/koersen');
  state.stats   = await get('/api/stats');
  renderPage();
}

// ── iOS PWA installatiebanner ─────────────────────────────────────────────────
(function() {
  const isIos     = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isSafari  = /safari/i.test(navigator.userAgent) && !/crios|fxios|opios/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  const dismissed = localStorage.getItem('pwa_banner_dismissed');

  if (!isIos || !isSafari || isStandalone || dismissed) return;

  const banner = document.createElement('div');
  banner.id = 'pwa-banner';
  banner.innerHTML = `
    <div style="
      position:fixed;bottom:0;left:0;right:0;z-index:9999;
      background:#1e2535;border-top:2px solid #FF8C00;
      padding:14px 16px 24px;display:flex;align-items:flex-start;gap:12px;
      box-shadow:0 -4px 24px rgba(0,0,0,.45);animation:slideUp .3s ease">
      <img src="/static/img/logo-180.png" style="width:48px;height:48px;border-radius:11px;flex-shrink:0" />
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:0.95rem;color:#fff;margin-bottom:3px">
          Voeg toe aan beginscherm
        </div>
        <div style="font-size:0.82rem;color:#94a3b8;line-height:1.45">
          Tik op
          <span style="display:inline-flex;align-items:center;gap:3px;background:#2d3748;border-radius:5px;padding:1px 6px;font-size:0.8rem;color:#fff">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
              <polyline points="16 6 12 2 8 6"/>
              <line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
            Delen
          </span>
          en kies <strong style="color:#fff">"Zet op beginscherm"</strong>
        </div>
      </div>
      <button onclick="
        document.getElementById('pwa-banner').remove();
        localStorage.setItem('pwa_banner_dismissed','1')
      " style="background:none;border:none;color:#94a3b8;font-size:1.3rem;padding:0;cursor:pointer;flex-shrink:0;line-height:1">✕</button>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = '@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}';
  document.head.appendChild(style);
  document.body.appendChild(banner);
})();

// ── Swipe-navigatie op mobiel ─────────────────────────────────────────────────
(function() {
  let touchStartX = 0, touchStartY = 0, touchStartT = 0;
  document.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartT = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dt = Date.now() - touchStartT;
    // Snelle vege: min 60px horizontaal, max 300ms, 2x meer horizontaal dan verticaal
    if (dt < 300 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
      if (dx > 0 && state.navHistory.length > 0) {
        goBack();  // Swipe rechts = vorige pagina
      }
    }
  }, { passive: true });
})();

// ── PWA Notificaties (opstelling-reminder) ────────────────────────────────────
async function checkOpstellingNotificatie() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const volgende = state.koersen.find(k => !k.afgelopen);
  if (!volgende || volgende.opstelling_aantal > 0) return;

  const daysUntil = Math.round((new Date(volgende.datum) - new Date(new Date().toISOString().slice(0,10))) / 86400000);
  if (daysUntil > 3 || daysUntil < 0) return;

  const notifKey = `notif_ops_${volgende.id}`;
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(notifKey) === today) return;

  const dagTxt = daysUntil === 0 ? 'Vandaag!' : daysUntil === 1 ? 'Morgen!' : `Over ${daysUntil} dagen`;
  new Notification('🚨 Wielermanager – Opstelling instellen!', {
    body: `${volgende.naam} (${dagTxt}) — stel je opstelling in!`,
    icon: '/static/img/logo-180.png',
    tag: `opstelling-${volgende.id}`,
  });
  localStorage.setItem(notifKey, today);
}

async function vraagNotificatiePermissie() {
  if (!('Notification' in window)) { toast('Notificaties worden niet ondersteund in deze browser', 'info'); return; }
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    toast('Notificaties ingeschakeld ✅', 'success');
    checkOpstellingNotificatie();
  } else {
    toast('Notificaties geweigerd', 'info');
  }
  renderPage();  // Refresh instellingen pagina
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadAll();
  renderPage();
  // Check after a short delay (state must be loaded)
  setTimeout(checkOpstellingNotificatie, 1500);
})();
