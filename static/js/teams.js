// Gracenote shirt IDs per wielerploeg (Sporza Wielermanager)
// Basis-URL: https://images.sports.gracenote.com/images/lib/basic/sport/TimeJudgeSports/club/shirt/medium/{ID}.png

const TEAM_SHIRT_IDS = {
  // WorldTour ploegen
  'Alpecin-Deceuninck':       46420,
  'Bahrain Victorious':       431902,
  'Cofidis':                  44245,
  'Decathlon AG2R':           45647,
  'EF Education-EasyPost':    46342,
  'Groupama-FDJ':             44246,
  'Ineos Grenadiers':         48612,
  'Intermarché-Wanty':        46268,  // gefuseerd met Lotto Dstny → Lotto-Intermarché
  'Israel-Premier Tech':      null,   // hernoemd naar NSN Cycling Team 2026 – ID nog niet gevonden
  'Jayco AlUla':              61617,
  'Lidl-Trek':                59902,
  'Lotto Dstny':              46268,  // gefuseerd met Intermarché-Wanty → Lotto-Intermarché
  'Movistar':                 46063,
  'Picnic PostNL':            46066,
  'Q36.5':                    484217,
  'Red Bull-Bora-Hansgrohe':  48539,
  'Soudal Quick-Step':        45844,
  'Tudor Pro Cycling':        null,   // ID nog niet gevonden
  'UAE Team Emirates':        45599,
  'UnoX Mobility':            432471,
  'Visma-Lease a Bike':       43809,
  'XDS Astana':               46140,
};

const GRACENOTE_BASE = 'https://images.sports.gracenote.com/images/lib/basic/sport/TimeJudgeSports/club/shirt/medium/';

/**
 * Geeft een <img> element terug met het truitje van de opgegeven ploeg.
 * Als het ID onbekend is, wordt alleen de ploegnaam als tekst getoond.
 * @param {string} ploegNaam  - naam van de ploeg (zoals in de DB)
 * @param {object} [opts]     - optionele opties: size (px, default 20), title (boolean)
 * @returns {string} HTML-string
 */
function jerseyHtml(ploegNaam, opts = {}) {
  const size = opts.size || 20;
  const showTitle = opts.title !== false;

  // Normaliseer: verwijder diacrieten en kleine letters voor fuzzy match
  function norm(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  const normNaam = norm(ploegNaam);
  let id = null;

  // Exacte match eerst
  if (TEAM_SHIRT_IDS.hasOwnProperty(ploegNaam)) {
    id = TEAM_SHIRT_IDS[ploegNaam];
  } else {
    // Fuzzy match op genormaliseerde naam
    for (const [key, val] of Object.entries(TEAM_SHIRT_IDS)) {
      if (norm(key) === normNaam) { id = val; break; }
    }
    // Gedeeltelijke match als fallback
    if (id === undefined) {
      for (const [key, val] of Object.entries(TEAM_SHIRT_IDS)) {
        if (normNaam.includes(norm(key)) || norm(key).includes(normNaam)) {
          id = val; break;
        }
      }
    }
  }

  if (!id) {
    // Geen ID gevonden: toon kleine gekleurde badge met afkorting
    const afk = (ploegNaam || '?').split(/[\s-]/)[0].substring(0, 3).toUpperCase();
    return `<span class="jersey-placeholder" title="${ploegNaam || ''}" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:3px;background:var(--card-bg);border:1px solid var(--border);font-size:${Math.round(size*0.45)}px;font-weight:700;color:var(--muted);flex-shrink:0">${afk}</span>`;
  }

  const titleAttr = showTitle && ploegNaam ? ` title="${ploegNaam}"` : '';
  return `<img src="${GRACENOTE_BASE}${id}.png"${titleAttr} style="width:${size}px;height:${size}px;object-fit:contain;flex-shrink:0" loading="lazy" />`;
}
