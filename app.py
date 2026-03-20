import os
import re
import json
import unicodedata
import requests as _requests
import cloudscraper
from bs4 import BeautifulSoup
import hashlib
import secrets
from functools import wraps
from flask import Flask, jsonify, request, render_template, abort, make_response, redirect, url_for, session
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash
from werkzeug.security import generate_password_hash as _gen_pw_hash
def generate_password_hash(pw): return _gen_pw_hash(pw, method='pbkdf2:sha256')
from database import (
    get_db, init_db, seed_renners, seed_koersen,
    punten_voor_positie, kopman_bonus, transfer_kosten, PUNTEN
)

try:
    import anthropic as _anthropic
except ImportError:
    _anthropic = None

# ── ProCyclingStats slug helpers (DB-driven) ───────────────────────────────────
# PCS_SLUGS is verwijderd — slugs worden nu uit de koersen-tabel gehaald (kolom pcs_slug).
# Gebruik _get_pcs_slug_map() voor {slug: naam} lookups,
# en _get_pcs_slug_list() voor een geordende lijst van slugs.
# Voor enkelvoudige lookups: koers.get('pcs_slug') na SELECT uit DB.

def _get_pcs_slug_map(conn, sid=None):
    """Geeft {pcs_slug: koers_naam} dict op basis van DB voor het actieve seizoen."""
    if sid is None:
        sid = current_seizoen_id(conn)
    rows = conn.execute(
        "SELECT naam, pcs_slug FROM koersen WHERE seizoen_id=? AND pcs_slug IS NOT NULL AND pcs_slug != ''",
        (sid,)
    ).fetchall()
    return {r['pcs_slug']: r['naam'] for r in rows}


def _get_pcs_slug_list(conn, sid=None):
    """Geeft geordende lijst van pcs_slugs voor het actieve seizoen."""
    if sid is None:
        sid = current_seizoen_id(conn)
    rows = conn.execute(
        "SELECT pcs_slug FROM koersen WHERE seizoen_id=? AND pcs_slug IS NOT NULL AND pcs_slug != '' ORDER BY datum ASC",
        (sid,)
    ).fetchall()
    return [r['pcs_slug'] for r in rows]


SPORZA_BASE = 'https://wielermanager.sporza.be'


def _get_sporza_edition(conn, sid=None):
    """Haal de Sporza edition-ID op voor een seizoen (dynamisch uit DB)."""
    if sid is None:
        sid = current_seizoen_id(conn)
    row = conn.execute(
        "SELECT sporza_edition FROM seizoenen WHERE id=?", (sid,)
    ).fetchone()
    return row['sporza_edition'] if row else 'vrjr-m-26'


def _find_wm_match_id(data_text, gracenote_id):
    """Zoek het WM match-nummer (1-50) bij een Gracenote race-ID in RSC team.data."""
    gid = str(gracenote_id)
    pos = data_text.find(gid)
    if pos < 0:
        return None
    context = data_text[max(0, pos - 500):pos]
    matches = re.findall(r'},(\d{1,3}),', context)
    candidates = [int(m) for m in matches if 1 <= int(m) <= 50]
    if candidates:
        return candidates[-1]
    return None


def _parse_sporza_riders(data_text):
    """Extract rider ID → fullName from a Sporza WM .data (React Flight) response."""
    riders = {}
    kv = re.compile(r'\},(\d+),"firstName","([^"]+)","lastName","([^"]+)","fullName","([^"]+)"')
    for m in kv.finditer(data_text):
        riders[int(m.group(1))] = m.group(4)
    val = re.compile(r'\},(\d+),((?:"[^"]*",?){1,6})')
    for m in val.finditer(data_text):
        rid = int(m.group(1))
        if rid in riders:
            continue
        strings = re.findall(r'"([^"]*)"', m.group(2))
        multi = sorted([s for s in strings if ' ' in s], key=len, reverse=True)
        if multi:
            riders[rid] = multi[0]
    return riders


def _fetch_foto_wikipedia(naam):
    """Haal een thumbnailfoto op via de Wikipedia Pageimages API (met zoek-fallback)."""
    headers = {'User-Agent': 'WielerManager/1.0 (wielermanager; python-requests)'}

    def _wiki_img(title):
        try:
            r = _requests.get(
                'https://en.wikipedia.org/w/api.php',
                params={
                    'action': 'query', 'titles': title,
                    'prop': 'pageimages', 'format': 'json',
                    'pithumbsize': 300, 'redirects': 1,
                },
                headers=headers, timeout=10
            )
            if r.status_code != 200:
                return None
            pages = r.json().get('query', {}).get('pages', {})
            for page in pages.values():
                src = page.get('thumbnail', {}).get('source')
                if src:
                    return src
        except Exception:
            pass
        return None

    foto = _wiki_img(naam)
    if foto:
        return foto

    try:
        r = _requests.get(
            'https://en.wikipedia.org/w/api.php',
            params={
                'action': 'query', 'list': 'search',
                'srsearch': f"{naam} cyclist", 'format': 'json',
                'srlimit': 3,
            },
            headers=headers, timeout=10
        )
        if r.status_code == 200:
            hits = r.json().get('query', {}).get('search', [])
            for hit in hits:
                foto = _wiki_img(hit['title'])
                if foto:
                    return foto
    except Exception:
        pass

    return None


def _fetch_foto_pcs(naam):
    """Haal een foto op via ProCyclingStats (fallback)."""
    try:
        slug = _norm(naam).replace(' ', '-')
        url = f"https://www.procyclingstats.com/rider/{slug}"
        r = cloudscraper.create_scraper().get(url, timeout=10)
        if r.status_code != 200:
            return None
        soup = BeautifulSoup(r.text, 'html.parser')
        img = soup.select_one('img.main-rider-img') or soup.select_one('.rdr-img-cont img')
        if img and img.get('src'):
            src = img['src']
            if src.startswith('/'):
                src = f"https://www.procyclingstats.com{src}"
            return src
    except Exception:
        pass
    return None


def _parse_sporza_riders_full(data_text):
    """Extract {id: {naam, ploeg, prijs}} from a Sporza WM .data (React Flight) response."""
    riders = {}
    node_pat = re.compile(
        r'\},(\d+),"firstName","[^"]+","lastName","[^"]+","fullName","([^"]+)"(.*?)(?=\},\d+,|\Z)',
        re.DOTALL
    )
    for m in node_pat.finditer(data_text):
        rid  = int(m.group(1))
        naam = m.group(2)
        rest = m.group(3)

        ploeg = ''
        tm = re.search(r'"(?:teamName|team|clubName)","([^"]+)"', rest)
        if tm:
            ploeg = tm.group(1)

        prijs = 0.0
        vm = re.search(r'"(?:value|price)",(\d+(?:[.,]\d+)?)', rest)
        if vm:
            prijs = float(vm.group(1).replace(',', '.'))
        else:
            vq = re.search(r'"(?:value|price)","([^"]+)"', rest)
            if vq:
                try:
                    prijs = float(vq.group(1).replace(',', '.'))
                except ValueError:
                    pass

        riders[rid] = {'naam': naam, 'ploeg': ploeg, 'prijs': prijs}
    return riders


_PARTICLES = {'van', 'de', 'der', 'den', 'del', 'di', 'du', 'von', 'le', 'la'}

def _norm(name):
    nfkd = unicodedata.normalize('NFKD', name)
    return nfkd.encode('ascii', 'ignore').decode('ascii').lower().strip()

def _name_match(db_naam, pcs_set, aliases=None):
    """
    db_naam : naam uit lokale DB (bijv. 'Tom Pidcock')
    pcs_set : set van genormaliseerde externe namen (bijv. {'pidcock thomas'})
    aliases : optionele set van genormaliseerde aliassen voor db_naam

    Achternaam-vergelijking werkt op de LAATSTE token na particle-filtering,
    zodat 'Matteo Milan' niet matcht op 'Milan De Ceuster' (waarbij 'milan'
    de voornaam is, niet de achternaam).

    PCS startlijsten gebruiken soms 'LASTNAME Firstname' volgorde. In dat geval
    is de achternaam de EERSTE token — maar alleen als er ook voornaam-overlap is
    (anders zou 'Milan Menten' fout matchen op 'Matteo Milan').
    """
    if aliases:
        for pcs_norm in pcs_set:
            if pcs_norm in aliases:
                return True

    db_norm = _norm(db_naam)
    db_tokens = [t for t in db_norm.split() if t not in _PARTICLES]
    if not db_tokens:
        return False
    db_surname = db_tokens[-1]
    db_set = set(db_tokens)

    for pcs_norm in pcs_set:
        pcs_tokens_list = [t for t in pcs_norm.split() if t not in _PARTICLES]
        if not pcs_tokens_list:
            continue
        pcs_tokens_set = set(pcs_tokens_list)

        # ── Geval 1: normale volgorde — achternaam is laatste PCS-token ──────
        pcs_surname = pcs_tokens_list[-1]
        if db_surname == pcs_surname:
            if len(db_tokens) == 1:
                return True
            other_db = db_set - {db_surname}
            if other_db & pcs_tokens_set:
                return True
            pcs_firstnames = pcs_tokens_set - {db_surname}
            if other_db and pcs_firstnames:
                db_initials  = {t[0] for t in other_db}
                pcs_initials = {t[0] for t in pcs_firstnames}
                if db_initials & pcs_initials:
                    return True

        # ── Geval 2: omgekeerde volgorde (PCS startlijst: LASTNAME Firstname) ─
        # Alleen van toepassing als de achternaam de EERSTE token is én er
        # voornaam-overlap is — om false positives te vermijden.
        # Initiaal-fallback is toegestaan TENZIJ de voornaam-initiaal gelijk is
        # aan de beginletter van de achternaam (dan te ambigu: 'm' voor 'Milan'
        # zou matchen op 'Menten').
        if len(pcs_tokens_list) >= 2:
            pcs_surname_rev = pcs_tokens_list[0]
            if db_surname == pcs_surname_rev and db_surname != pcs_tokens_list[-1]:
                if len(db_tokens) == 1:
                    return True
                other_db = db_set - {db_surname}
                if other_db & pcs_tokens_set:
                    return True
                pcs_firstnames = pcs_tokens_set - {db_surname}
                if other_db and pcs_firstnames:
                    db_initials  = {t[0] for t in other_db}
                    pcs_initials = {t[0] for t in pcs_firstnames}
                    # Alleen initiaal-match toestaan als de initiaal NIET gelijk is
                    # aan de beginletter van de achternaam (vermijdt Matteo→Milan→Menten)
                    unambiguous = db_initials & pcs_initials - {db_surname[0]}
                    if unambiguous:
                        return True

    return False


def _get_alias_map(conn):
    """Laad alle aliassen als dict: {db_naam (lower) → set(alias_norm)}."""
    rows = conn.execute("""
        SELECT r.naam, a.alias
        FROM renner_aliassen a
        JOIN renners r ON r.id = a.renner_id
    """).fetchall()
    result = {}
    for row in rows:
        result.setdefault(row['naam'], set()).add(row['alias'])
    return result

_PLOEG_SKIP = {'team', 'cycling', 'pro', 'professional', 'continental', 'the', 'and', 'a'}

def _ploeg_match(pcs_norm, db_norm):
    """True als ploegnamen voldoende overlappen."""
    def words(s):
        return {w for w in re.split(r'[\s\-|]+', s) if len(w) > 2 and w not in _PLOEG_SKIP}
    return bool(words(pcs_norm) & words(db_norm))


app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-change-in-production')
app.config['JSON_AS_ASCII'] = False
app.config['PERMANENT_SESSION_LIFETIME'] = __import__('datetime').timedelta(days=365)
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = True

APP_PASSWORD = os.environ.get('APP_PASSWORD', '')

_USER_INST_KEYS = frozenset([
    'budget', 'transfer_count',
    'sporza_cookie', 'sporza_cookie_vt', 'sporza_cookie_rt',
])

def current_user_id():
    uid = session.get('user_id')
    if uid:
        return uid
    if not APP_PASSWORD:
        return 1
    return None

def current_seizoen_id(conn=None):
    sid = session.get('seizoen_id')
    if sid:
        return sid
    _own = conn is None
    c = conn if conn else get_db()
    try:
        row = c.execute(
            "SELECT id FROM seizoenen WHERE actief=1 ORDER BY id LIMIT 1"
        ).fetchone()
        return row['id'] if row else 1
    finally:
        if _own:
            c.close()

def _check_auth():
    return current_user_id() is not None

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not _check_auth():
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Niet ingelogd', 'login_required': True}), 401
            return redirect('/login')
        return f(*args, **kwargs)
    return decorated

@app.before_request
def require_login():
    if request.path in ('/login', '/logout') or request.path.startswith('/static/'):
        return None
    if not APP_PASSWORD and not session.get('user_id'):
        session['user_id'] = 1
        session['username'] = 'admin'
        session['is_admin'] = True
    if not _check_auth():
        if request.path.startswith('/api/'):
            return jsonify({'error': 'Niet ingelogd', 'login_required': True}), 401
        return redirect('/login')

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        conn = get_db()
        user = conn.execute(
            "SELECT * FROM users WHERE username=?", (username,)
        ).fetchone()
        conn.close()
        if user and check_password_hash(user['password_hash'], password):
            session['user_id'] = user['id']
            session['username'] = user['username']
            session['is_admin'] = bool(user['is_admin'])
            session.permanent = True
            return redirect('/')
        error = 'Onbekende gebruiker of verkeerd wachtwoord'
    bg = '#131720'
    accent = '#FF8C00'
    return f'''<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Wielermanager – Inloggen</title>
  <link rel="apple-touch-icon" href="/static/img/logo-180.png">
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{background:{bg};display:flex;align-items:center;justify-content:center;
          min-height:100vh;font-family:-apple-system,sans-serif;padding:20px}}
    .card{{background:#1c2333;border-radius:16px;padding:36px 32px;width:100%;
           max-width:340px;box-shadow:0 8px 32px rgba(0,0,0,.4)}}
    .logo{{text-align:center;margin-bottom:28px}}
    .logo img{{width:72px;height:72px;border-radius:16px}}
    .logo h1{{color:#fff;font-size:1.4rem;margin-top:12px;font-weight:700}}
    .logo p{{color:#6b7a99;font-size:0.85rem;margin-top:4px}}
    input{{width:100%;padding:13px 16px;border-radius:10px;border:1px solid #2d3a52;
           background:#0f1623;color:#fff;font-size:1rem;outline:none;margin-top:6px}}
    input:focus{{border-color:{accent}}}
    button{{width:100%;padding:13px;border-radius:10px;border:none;
             background:{accent};color:#fff;font-size:1rem;font-weight:600;
             cursor:pointer;margin-top:16px}}
    .error{{color:#f87171;font-size:0.85rem;margin-top:12px;text-align:center}}
    label{{color:#a0aec0;font-size:0.85rem;display:block;margin-top:14px}}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <img src="/static/img/logo-180.png" alt="logo">
      <h1>Wielermanager</h1>
      <p>Log in om verder te gaan</p>
    </div>
    <form method="POST">
      <label>Gebruikersnaam</label>
      <input type="text" name="username" autofocus placeholder="gebruikersnaam" autocomplete="username">
      <label>Wachtwoord</label>
      <input type="password" name="password" placeholder="••••••••" autocomplete="current-password">
      <button type="submit">Inloggen</button>
      {'<p class="error">⚠️ ' + error + '</p>' if error else ''}
    </form>
  </div>
</body>
</html>'''

@app.route('/logout')
def logout():
    session.clear()
    return redirect('/login')


@app.route('/api/me')
def api_me():
    uid = current_user_id()
    if not uid:
        return jsonify({'error': 'Niet ingelogd'}), 401
    conn = get_db()
    sid = current_seizoen_id(conn)
    sz = conn.execute(
        "SELECT id, naam, sporza_edition FROM seizoenen WHERE id=?", (sid,)
    ).fetchone()
    conn.close()
    return jsonify({
        'user_id': uid,
        'username': session.get('username', 'admin'),
        'is_admin': session.get('is_admin', False),
        'seizoen_id': sid,
        'seizoen_naam': sz['naam'] if sz else 'Onbekend',
        'sporza_edition': sz['sporza_edition'] if sz else 'vrjr-m-26',
    })


# ── API: Admin gebruikersbeheer ────────────────────────────────────────────────

def _require_admin():
    uid = current_user_id()
    if not uid:
        return jsonify({'error': 'Niet ingelogd'}), 401
    if not session.get('is_admin'):
        return jsonify({'error': 'Geen admin-rechten'}), 403
    return None, None


@app.route('/api/admin/users', methods=['GET'])
def admin_list_users():
    err, code = _require_admin()
    if err:
        return err, code
    conn = get_db()
    users = conn.execute(
        "SELECT id, username, is_admin, created_at FROM users ORDER BY id"
    ).fetchall()
    conn.close()
    return jsonify([dict(u) for u in users])


@app.route('/api/admin/users', methods=['POST'])
def admin_create_user():
    err, code = _require_admin()
    if err:
        return err, code
    d = request.json or {}
    username = (d.get('username') or '').strip()
    password = (d.get('password') or '').strip()
    is_admin = int(bool(d.get('is_admin', False)))
    if not username or not password:
        return jsonify({'error': 'username en password zijn verplicht'}), 400
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash, is_admin) VALUES (?,?,?)",
            (username, generate_password_hash(password), is_admin)
        )
        conn.commit()
        new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.close()
        return jsonify({'ok': True, 'id': new_id, 'username': username}), 201
    except Exception as e:
        conn.close()
        return jsonify({'error': f'Gebruikersnaam al in gebruik: {str(e)}'}), 409


@app.route('/api/admin/users/<int:uid>', methods=['PUT'])
def admin_update_user(uid):
    err, code = _require_admin()
    if err:
        return err, code
    d = request.json or {}
    conn = get_db()
    if 'password' in d and d['password']:
        conn.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (generate_password_hash(d['password']), uid)
        )
    if 'is_admin' in d:
        if uid != current_user_id():
            conn.execute("UPDATE users SET is_admin=? WHERE id=?", (int(bool(d['is_admin'])), uid))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/admin/users/<int:uid>', methods=['DELETE'])
def admin_delete_user(uid):
    err, code = _require_admin()
    if err:
        return err, code
    if uid == current_user_id():
        return jsonify({'error': 'Je kan jezelf niet verwijderen'}), 400
    conn = get_db()
    conn.execute("DELETE FROM users WHERE id=?", (uid,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


# ── API: Seizoenbeheer ──────────────────────────────────────────────────────────

@app.route('/api/seizoenen', methods=['GET'])
def get_seizoenen():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, naam, sporza_edition, actief FROM seizoenen WHERE actief=1 ORDER BY id"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/switch-seizoen', methods=['POST'])
def switch_seizoen():
    d = request.json or {}
    sid = d.get('seizoen_id')
    if not sid:
        return jsonify({'error': 'seizoen_id is verplicht'}), 400
    conn = get_db()
    sz = conn.execute(
        "SELECT id, naam, sporza_edition FROM seizoenen WHERE id=? AND actief=1", (sid,)
    ).fetchone()
    conn.close()
    if not sz:
        return jsonify({'error': 'Seizoen niet gevonden of niet actief'}), 404
    session['seizoen_id'] = sz['id']
    return jsonify({'ok': True, 'seizoen_id': sz['id'], 'seizoen_naam': sz['naam']})


@app.route('/api/admin/seizoenen', methods=['GET'])
def admin_list_seizoenen():
    err, code = _require_admin()
    if err: return err, code
    conn = get_db()
    rows = conn.execute("SELECT * FROM seizoenen ORDER BY id").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/admin/seizoenen', methods=['POST'])
def admin_create_seizoen():
    err, code = _require_admin()
    if err: return err, code
    d = request.json or {}
    naam = (d.get('naam') or '').strip()
    edition = (d.get('sporza_edition') or '').strip()
    if not naam:
        return jsonify({'error': 'naam is verplicht'}), 400
    conn = get_db()
    conn.execute(
        "INSERT INTO seizoenen (naam, sporza_edition, actief) VALUES (?,?,1)",
        (naam, edition or 'onbekend')
    )
    conn.commit()
    new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return jsonify({'ok': True, 'id': new_id}), 201


@app.route('/api/admin/seizoenen/<int:sid>', methods=['PUT'])
def admin_update_seizoen(sid):
    err, code = _require_admin()
    if err: return err, code
    d = request.json or {}
    conn = get_db()
    if 'naam' in d and d['naam']:
        conn.execute("UPDATE seizoenen SET naam=? WHERE id=?", (d['naam'].strip(), sid))
    if 'sporza_edition' in d:
        conn.execute("UPDATE seizoenen SET sporza_edition=? WHERE id=?", (d['sporza_edition'].strip(), sid))
    if 'actief' in d:
        conn.execute("UPDATE seizoenen SET actief=? WHERE id=?", (int(bool(d['actief'])), sid))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/admin/seizoenen/<int:sid>', methods=['DELETE'])
def admin_delete_seizoen(sid):
    err, code = _require_admin()
    if err: return err, code
    conn = get_db()
    has_data = conn.execute(
        "SELECT 1 FROM mijn_ploeg WHERE seizoen_id=? LIMIT 1", (sid,)
    ).fetchone()
    if has_data:
        conn.close()
        return jsonify({'error': 'Kan seizoen niet verwijderen: er zijn al ploegen aangemaakt'}), 409
    conn.execute("DELETE FROM seizoenen WHERE id=?", (sid,))
    conn.execute("DELETE FROM renners WHERE seizoen_id=?", (sid,))
    conn.execute("DELETE FROM koersen WHERE seizoen_id=?", (sid,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/admin/seizoenen/<int:sid>/seed', methods=['POST'])
def admin_seed_seizoen(sid):
    err, code = _require_admin()
    if err: return err, code
    conn = get_db()
    sz = conn.execute("SELECT * FROM seizoenen WHERE id=?", (sid,)).fetchone()
    if not sz:
        conn.close()
        return jsonify({'error': 'Seizoen niet gevonden'}), 404

    r_count_before = conn.execute(
        "SELECT COUNT(*) FROM renners WHERE seizoen_id=?", (sid,)
    ).fetchone()[0]

    sporza_renners_loaded = False
    if r_count_before == 0:
        edition = sz['sporza_edition']
        if edition and edition not in ('', 'onbekend'):
            try:
                url = f"{SPORZA_BASE}/api/{edition}/cyclists"
                scraper = cloudscraper.create_scraper()
                resp = scraper.get(url, timeout=20)
                if resp.status_code == 200:
                    cyclists = resp.json().get('cyclists', [])
                    if cyclists:
                        def _sporza_rol(c):
                            spec = (c.get('speciality') or c.get('specialty') or '').lower()
                            if 'climb' in spec or 'grimpeur' in spec:
                                return 'klimmer'
                            if 'sprint' in spec:
                                return 'sprinter'
                            if 'time' in spec or 'chrono' in spec or 'tt' in spec:
                                return 'tijdrijder'
                            return 'allrounder'

                        rows = [
                            (
                                (c.get('fullName') or '').strip(),
                                (c.get('team') or {}).get('name') or '',
                                _sporza_rol(c),
                                float(c.get('price') or 0),
                                int(c.get('totalBasePoints') or 0),
                                sid,
                            )
                            for c in cyclists
                            if (c.get('fullName') or '').strip()
                        ]
                        if rows:
                            conn.executemany(
                                "INSERT INTO renners "
                                "(naam, ploeg, rol, prijs, totaal_punten, seizoen_id) "
                                "VALUES (?,?,?,?,?,?)",
                                rows,
                            )
                            conn.commit()
                            sporza_renners_loaded = True
                            app.logger.info(
                                f"Seed seizoen {sid}: {len(rows)} renners opgehaald van "
                                f"Sporza edition '{edition}'"
                            )
            except Exception as e:
                app.logger.warning(f"Sporza cyclists API fout bij seed (edition={edition}): {e}")

        if not sporza_renners_loaded:
            app.logger.warning(
                f"Seed seizoen {sid}: Sporza API niet beschikbaar, gebruik statische fallback"
            )
            seed_renners(conn, sid)

    seed_koersen(conn, sid)

    r_count = conn.execute("SELECT COUNT(*) FROM renners WHERE seizoen_id=?", (sid,)).fetchone()[0]
    k_count = conn.execute("SELECT COUNT(*) FROM koersen WHERE seizoen_id=?", (sid,)).fetchone()[0]
    conn.close()
    return jsonify({
        'ok': True,
        'renners': r_count,
        'koersen': k_count,
        'bron': 'sporza_api' if sporza_renners_loaded else 'statische_lijst',
    })


@app.route('/api/admin/renners/sync-sporza', methods=['POST'])
def admin_sync_renners_sporza():
    err, code = _require_admin()
    if err: return err, code

    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)

    if not edition or edition in ('', 'onbekend'):
        conn.close()
        return jsonify({'error': f'Geen geldig Sporza edition ingesteld voor dit seizoen'}), 400

    try:
        scraper = cloudscraper.create_scraper()
        url = f"{SPORZA_BASE}/api/{edition}/cyclists"
        resp = scraper.get(url, timeout=25)
        if resp.status_code != 200:
            conn.close()
            return jsonify({'error': f'Sporza WM antwoordde met HTTP {resp.status_code}'}), 502
        cyclists = resp.json().get('cyclists', [])
    except Exception as e:
        conn.close()
        return jsonify({'error': f'Netwerkfout bij ophalen van Sporza: {e}'}), 503

    if not cyclists:
        conn.close()
        return jsonify({'error': 'Sporza stuurde een lege rennerlijst terug'}), 404

    bestaande = conn.execute(
        "SELECT id, naam, ploeg, prijs, totaal_punten FROM renners WHERE seizoen_id=?", (sid,)
    ).fetchall()

    norm_to_id = {_norm(r['naam']): r['id'] for r in bestaande}
    id_to_row  = {r['id']: r for r in bestaande}

    def _sporza_rol(c):
        spec = (c.get('speciality') or c.get('specialty') or '').lower()
        if 'climb' in spec or 'grimpeur' in spec: return 'klimmer'
        if 'sprint' in spec:                       return 'sprinter'
        if 'time' in spec or 'chrono' in spec or 'tt' in spec: return 'tijdrijder'
        return 'allrounder'

    aangemaakt  = 0
    bijgewerkt  = 0
    ongewijzigd = 0

    for c in cyclists:
        naam = (c.get('fullName') or '').strip()
        if not naam:
            continue
        ploeg  = (c.get('team') or {}).get('name') or ''
        prijs  = float(c.get('price') or 0)
        punten = int(c.get('totalBasePoints') or 0)

        norm = _norm(naam)
        renner_id = norm_to_id.get(norm)

        if renner_id is None:
            sporza_set = {norm}
            for db_r in bestaande:
                if _name_match(db_r['naam'], sporza_set):
                    renner_id = db_r['id']
                    break

        if renner_id is not None:
            oud = id_to_row[renner_id]
            if oud['ploeg'] != ploeg or float(oud['prijs']) != prijs or int(oud['totaal_punten'] or 0) != punten:
                conn.execute(
                    "UPDATE renners SET ploeg=?, prijs=?, totaal_punten=? WHERE id=?",
                    (ploeg, prijs, punten, renner_id),
                )
                bijgewerkt += 1
            else:
                ongewijzigd += 1
        else:
            conn.execute(
                "INSERT INTO renners (naam, ploeg, rol, prijs, totaal_punten, seizoen_id) "
                "VALUES (?,?,?,?,?,?)",
                (naam, ploeg, _sporza_rol(c), prijs, punten, sid),
            )
            aangemaakt += 1

    conn.commit()
    conn.close()

    app.logger.info(
        f"Sync Sporza seizoen {sid} (edition={edition}): "
        f"{aangemaakt} aangemaakt, {bijgewerkt} bijgewerkt, {ongewijzigd} ongewijzigd"
    )
    return jsonify({
        'ok':           True,
        'totaal_sporza': len(cyclists),
        'aangemaakt':   aangemaakt,
        'bijgewerkt':   bijgewerkt,
        'ongewijzigd':  ongewijzigd,
    })


@app.route('/api/admin/ploeg/budget-debug', methods=['GET'])
def admin_ploeg_budget_debug():
    err, code = _require_admin()
    if err: return err, code

    conn = get_db()
    rows = conn.execute("""
        SELECT
            u.username,
            sz.naam  AS seizoen,
            r.naam   AS renner,
            r.prijs  AS huidige_prijs,
            COALESCE(m.aangeschaft_prijs, r.prijs) AS aangeschaft_prijs,
            m.user_id, m.seizoen_id, m.renner_id
        FROM mijn_ploeg m
        JOIN renners r  ON r.id  = m.renner_id
        JOIN users u    ON u.id  = m.user_id
        JOIN seizoenen sz ON sz.id = m.seizoen_id
        ORDER BY u.username, sz.naam, r.prijs DESC
    """).fetchall()

    uit = {}
    for row in rows:
        key = f"{row['username']} — {row['seizoen']}"
        uid = row['user_id']
        sid = row['seizoen_id']
        inst = _get_inst(conn, uid, sid=sid)
        budget = float(inst.get('budget', 120))
        if key not in uit:
            uit[key] = {
                'user_id': uid,
                'seizoen_id': sid,
                'budget': budget,
                'renners': [],
                'totaal_aangeschaft': 0.0,
                'totaal_huidig': 0.0,
            }
        uit[key]['renners'].append({
            'renner_id': row['renner_id'],
            'naam': row['renner'],
            'huidige_prijs': row['huidige_prijs'],
            'aangeschaft_prijs': row['aangeschaft_prijs'],
            'verschil': round(row['huidige_prijs'] - row['aangeschaft_prijs'], 2),
        })
        uit[key]['totaal_aangeschaft'] += row['aangeschaft_prijs']
        uit[key]['totaal_huidig']      += row['huidige_prijs']

    for k in uit:
        uit[k]['totaal_aangeschaft'] = round(uit[k]['totaal_aangeschaft'], 2)
        uit[k]['totaal_huidig']      = round(uit[k]['totaal_huidig'], 2)
        uit[k]['budget_rest']        = round(uit[k]['budget'] - uit[k]['totaal_aangeschaft'], 2)

    conn.close()
    return jsonify(list(uit.values()))


@app.route('/api/admin/ploeg/normalize-budget', methods=['POST'])
def admin_ploeg_normalize_budget():
    err, code = _require_admin()
    if err: return err, code

    data = request.get_json(silent=True) or {}
    conn = get_db()
    sid = int(data.get('seizoen_id') or current_seizoen_id(conn))
    uid_filter = data.get('user_id')

    if uid_filter:
        users = [uid_filter]
    else:
        users = [r['user_id'] for r in conn.execute(
            "SELECT DISTINCT user_id FROM mijn_ploeg WHERE seizoen_id=?", (sid,)
        ).fetchall()]

    resultaten = []
    for uid in users:
        inst = _get_inst(conn, uid, sid=sid)
        budget = float(inst.get('budget', 120))

        ploeg = conn.execute("""
            SELECT m.renner_id, COALESCE(m.aangeschaft_prijs, r.prijs) AS aangeschaft_prijs
            FROM mijn_ploeg m JOIN renners r ON r.id = m.renner_id
            WHERE m.user_id=? AND m.seizoen_id=?
        """, (uid, sid)).fetchall()

        if not ploeg:
            continue

        totaal = sum(r['aangeschaft_prijs'] for r in ploeg)
        if totaal == 0:
            continue

        factor = budget / totaal
        for r in ploeg:
            nieuwe_prijs = round(r['aangeschaft_prijs'] * factor, 2)
            conn.execute(
                "UPDATE mijn_ploeg SET aangeschaft_prijs=? WHERE renner_id=? AND user_id=? AND seizoen_id=?",
                (nieuwe_prijs, r['renner_id'], uid, sid)
            )

        conn.commit()
        resultaten.append({
            'user_id': uid,
            'oud_totaal': round(totaal, 2),
            'nieuw_totaal': budget,
            'factor': round(factor, 4),
            'n_renners': len(ploeg),
        })

    conn.close()
    return jsonify({'ok': True, 'resultaten': resultaten})


@app.route('/api/admin/ploeg/set-aangeschaft-prijs', methods=['POST'])
def admin_set_aangeschaft_prijs():
    err, code = _require_admin()
    if err: return err, code

    data = request.get_json(silent=True) or {}
    uid = data.get('user_id')
    sid = data.get('seizoen_id')
    rid = data.get('renner_id')
    prijs = data.get('prijs')

    if None in (uid, sid, rid, prijs):
        return jsonify({'error': 'user_id, seizoen_id, renner_id en prijs zijn verplicht'}), 400

    conn = get_db()
    conn.execute(
        "UPDATE mijn_ploeg SET aangeschaft_prijs=? WHERE renner_id=? AND user_id=? AND seizoen_id=?",
        (float(prijs), int(rid), int(uid), int(sid))
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/sw.js')
def service_worker():
    import flask
    resp = flask.send_from_directory(app.static_folder, 'sw.js',
                                     mimetype='application/javascript')
    resp.headers['Service-Worker-Allowed'] = '/'
    resp.headers['Cache-Control'] = 'no-cache'
    return resp


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get('Origin', '')
    if 'sporza.be' in origin or 'localhost' in origin:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    if response.content_type.startswith('application/json'):
        data = response.get_data(as_text=True)
        response.set_data(data.encode('utf-8'))
        response.content_type = 'application/json; charset=utf-8'
    # Security headers
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()'
    return response

@app.route('/api/sporza-session', methods=['OPTIONS'])
def sporza_session_preflight():
    resp = make_response('', 204)
    origin = request.headers.get('Origin', '')
    resp.headers['Access-Control-Allow-Origin'] = origin
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return resp

def _static_version():
    base = os.path.dirname(__file__)
    files = [
        os.path.join(base, 'static', 'js', 'app.js'),
        os.path.join(base, 'static', 'js', 'teams.js'),
        os.path.join(base, 'static', 'css', 'style.css'),
    ]
    try:
        mtime = max(os.path.getmtime(f) for f in files if os.path.exists(f))
        return str(int(mtime))
    except Exception:
        return '1'

@app.context_processor
def inject_static_version():
    return {'sv': _static_version()}

UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'static', 'uploads', 'renners')
ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'webp'}
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# ── Initialisatie ──────────────────────────────────────────────────────────────

@app.before_request
def startup():
    app.before_request_funcs[None].remove(startup)
    init_db()
    seed_renners()
    seed_koersen()


# ── Frontend ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── API: Server info ──────────────────────────────────────────────────────────

@app.route("/api/server-info")
def server_info():
    import socket, io, base64
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lan_ip = s.getsockname()[0]
        s.close()
    except Exception:
        lan_ip = "127.0.0.1"
    url = f"http://{lan_ip}:5050"

    try:
        import qrcode
        qr = qrcode.QRCode(box_size=6, border=2)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="white", back_color="#1e2535")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        qr_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        qr_b64 = None

    return jsonify({"url": url, "qr": qr_b64})


# ── API: Instellingen ──────────────────────────────────────────────────────────

@app.route("/api/instellingen")
def get_instellingen():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    result = _get_inst(conn, uid, sid=sid)
    conn.close()
    return jsonify(result)


@app.route("/api/instellingen", methods=["PUT"])
def update_instellingen():
    data = request.json
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    for k, v in data.items():
        if k in _USER_INST_KEYS:
            _set_user_inst_val(conn, k, v, uid=uid, sid=sid)
        else:
            conn.execute(
                "INSERT OR REPLACE INTO instellingen (sleutel, waarde) VALUES (?,?)",
                (k, str(v))
            )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── API: Puntentelling ─────────────────────────────────────────────────────────

@app.route("/api/puntentelling")
def get_puntentelling():
    return jsonify(PUNTEN)


# ── API: Renners ───────────────────────────────────────────────────────────────

@app.route("/api/renners/opzoeken")
def opzoeken_renner():
    zoek = request.args.get("naam", "").strip()
    if len(zoek) < 2:
        return jsonify({"error": "Zoekterm te kort (min. 2 tekens)"}), 400

    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)
    cookie_at = _get_sporza_at(conn, sid=sid)
    conn.close()
    headers = {}
    if cookie_at:
        headers = {"Cookie": f"sporza-site_profile_at={cookie_at}"}

    url = f"{SPORZA_BASE}/api/{edition}/cyclists"
    try:
        scraper = cloudscraper.create_scraper()
        resp = scraper.get(url, headers=headers, timeout=20)
    except Exception as e:
        return jsonify({"error": f"Netwerkfout: {str(e)}"}), 503

    if resp.status_code != 200:
        return jsonify({"error": f"Sporza WM niet bereikbaar (HTTP {resp.status_code})"}), 503

    try:
        cyclists = resp.json().get("cyclists", [])
    except Exception:
        return jsonify({"error": "Ongeldig antwoord van Sporza WM"}), 503

    zoek_norm = _norm(zoek)
    resultaten = []
    for c in cyclists:
        naam = c.get("fullName", "")
        if zoek_norm in _norm(naam):
            team = c.get("team") or {}
            foto = (c.get('photo') or c.get('image') or c.get('profileImage') or
                    c.get('profilePicture') or c.get('picture') or c.get('photoUrl') or '')
            resultaten.append({
                "naam":  naam,
                "ploeg": team.get("name", ""),
                "prijs": c.get("price", 0),
                "foto":  foto,
            })

    resultaten.sort(key=lambda r: r["naam"])
    return jsonify(resultaten[:8])


@app.route("/api/renners/opzoeken-foto")
def opzoeken_renner_foto():
    naam = request.args.get("naam", "").strip()
    if not naam:
        return jsonify({"foto": None})
    foto = _fetch_foto_wikipedia(naam)
    if not foto:
        foto = _fetch_foto_pcs(naam)
    return jsonify({"foto": foto})


@app.route("/api/renners/<int:rid>/update", methods=["POST"])
def update_renner_volledig(rid):
    """Update foto/ploeg/prijs en geef historiek terug (geen impact op punten)."""
    conn = get_db()
    renner = conn.execute("SELECT * FROM renners WHERE id=?", (rid,)).fetchone()
    if not renner:
        conn.close()
        return jsonify({"error": "Renner niet gevonden"}), 404

    naam      = renner["naam"]
    oud_foto  = renner["foto"]
    oud_ploeg = renner["ploeg"]
    oud_prijs = renner["prijs"]

    # Haal pcs_slug_map op voor historiek matching
    sid = current_seizoen_id(conn)
    wm_slug_to_naam = _get_pcs_slug_map(conn, sid)
    pcs_slug_list   = _get_pcs_slug_list(conn, sid)
    conn.close()

    wijzigingen = {}
    scraper = cloudscraper.create_scraper()

    # ── 1. Foto via Wikipedia / PCS ───────────────────────────────────────────
    nieuwe_foto = _fetch_foto_wikipedia(naam) or _fetch_foto_pcs(naam)
    wijzigingen["foto"] = {
        "oud": oud_foto, "nieuw": nieuwe_foto or oud_foto,
        "gewijzigd": bool(nieuwe_foto and nieuwe_foto != oud_foto),
    }

    # ── 2. Ploeg + prijs via Sporza cyclists API ──────────────────────────────
    nieuwe_ploeg = oud_ploeg
    nieuwe_prijs = oud_prijs
    _conn2 = get_db()
    _sid2 = current_seizoen_id(_conn2)
    _edition2 = _get_sporza_edition(_conn2, _sid2)
    _conn2.close()
    try:
        cyl_resp = scraper.get(
            f"https://wielermanager.sporza.be/api/{_edition2}/cyclists", timeout=20
        )
        if cyl_resp.status_code == 200:
            for c in cyl_resp.json().get("cyclists", []):
                if _name_match(naam, {_norm(c.get("fullName", ""))}):
                    nieuwe_ploeg = c.get("team", {}).get("name", oud_ploeg) or oud_ploeg
                    nieuwe_prijs = float(c.get("price", oud_prijs))
                    break
    except Exception:
        pass

    wijzigingen["ploeg"] = {"oud": oud_ploeg, "nieuw": nieuwe_ploeg,
                             "gewijzigd": nieuwe_ploeg != oud_ploeg}
    wijzigingen["prijs"] = {"oud": oud_prijs, "nieuw": nieuwe_prijs,
                             "gewijzigd": nieuwe_prijs != oud_prijs}

    # ── 3. Historiek 2025 via PCS rider-pagina ────────────────────────────────
    historiek_2025 = []
    pcs_slug = _norm(naam).replace(' ', '-')
    pcs_rider_url = f"https://www.procyclingstats.com/rider/{pcs_slug}/2025"

    def _is_pcs_not_found(s):
        title = s.title.string if s.title else ""
        return "not found" in title.lower() or "404" in title

    def _pcs_zoek_slug(db_naam):
        tokens = _norm(db_naam).split()
        if not tokens:
            return None
        achternaam = tokens[-1]
        initiaal   = tokens[0][0] if len(tokens) > 1 else None

        for race_slug in pcs_slug_list[:8]:
            try:
                race_url = f"https://www.procyclingstats.com/race/{race_slug}/2025"
                r = scraper.get(race_url, timeout=15)
                if r.status_code != 200:
                    continue
                ss = BeautifulSoup(r.text, "html.parser")
                for a in ss.find_all("a", href=True):
                    href = a["href"]
                    if not href.startswith("rider/"):
                        continue
                    slug_delen = href.replace("rider/", "").split("/")[0].split("-")
                    if achternaam not in slug_delen:
                        continue
                    if initiaal and not any(
                        p.startswith(initiaal) for p in slug_delen if p != achternaam
                    ):
                        continue
                    return href.replace("rider/", "").split("/")[0]
            except Exception:
                continue
        return None

    try:
        resp = scraper.get(pcs_rider_url, timeout=20)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, "html.parser")
            if _is_pcs_not_found(soup):
                gevonden_slug = _pcs_zoek_slug(naam)
                if gevonden_slug and gevonden_slug != pcs_slug:
                    pcs_slug = gevonden_slug
                    pcs_rider_url = f"https://www.procyclingstats.com/rider/{pcs_slug}/2025"
                    resp = scraper.get(pcs_rider_url, timeout=20)
                    soup = BeautifulSoup(resp.text, "html.parser") if resp.status_code == 200 else soup
            race_re = re.compile(r"^/?race/([^/]+)/2025")

            for row in soup.select("ul.results li, table.results tr, .rdrResults tr, table tr"):
                cells = row.find_all(["td", "li"])
                if not cells:
                    cells = [row]

                race_naam = None
                for cell in cells:
                    for a in cell.find_all("a", href=True):
                        m = race_re.match(a["href"])
                        if m and m.group(1) in wm_slug_to_naam:
                            race_naam = wm_slug_to_naam[m.group(1)]
                            break
                    if race_naam:
                        break

                if not race_naam:
                    continue

                positie = None
                for cell in cells:
                    txt = cell.get_text(strip=True)
                    try:
                        val = int(txt)
                        if 1 <= val <= 300:
                            positie = val
                            break
                    except ValueError:
                        pass

                datum_str = None
                for cell in cells:
                    txt = cell.get_text(strip=True)
                    if re.match(r'^\d{2}[.\-]\d{2}$', txt):
                        datum_str = txt
                        break

                historiek_2025.append({
                    "koers":   race_naam,
                    "positie": positie,
                    "datum":   datum_str,
                })

    except Exception:
        pass

    seen = set()
    historiek_uniek = []
    for h in historiek_2025:
        if h["koers"] not in seen:
            seen.add(h["koers"])
            historiek_uniek.append(h)
    historiek_2025 = sorted(historiek_uniek,
                            key=lambda h: pcs_slug_list.index(wm_slug_to_naam.get(h["koers"], ''))
                            if h["koers"] in wm_slug_to_naam.values() else 99)

    # ── 4. Renner bijwerken in DB ─────────────────────────────────────────────
    conn2 = get_db()
    update_fields, update_vals = [], []
    foto_opslaan = nieuwe_foto or oud_foto
    if foto_opslaan:
        update_fields.append("foto=?");  update_vals.append(foto_opslaan)
    if nieuwe_ploeg != oud_ploeg:
        update_fields.append("ploeg=?"); update_vals.append(nieuwe_ploeg)
    if nieuwe_prijs != oud_prijs:
        update_fields.append("prijs=?"); update_vals.append(nieuwe_prijs)
    if update_fields:
        update_vals.append(rid)
        conn2.execute(f"UPDATE renners SET {','.join(update_fields)} WHERE id=?", update_vals)

    if historiek_2025:
        conn2.execute(
            "DELETE FROM historiek_renner WHERE renner_id=? AND seizoen=2025", (rid,)
        )
        for h in historiek_2025:
            conn2.execute(
                "INSERT INTO historiek_renner (renner_id, seizoen, koers_naam, positie, datum) "
                "VALUES (?, 2025, ?, ?, ?)",
                (rid, h["koers"], h["positie"], h["datum"])
            )

    conn2.commit()
    conn2.close()

    return jsonify({
        "ok": True, "naam": naam,
        "pcs_url": pcs_rider_url,
        "wijzigingen": wijzigingen,
        "historiek_2025": historiek_2025,
    })


@app.route("/api/renners/<int:rid>/historiek", methods=["POST"])
def laad_renner_historiek(rid):
    """Haal alleen de 2025-historiek op van PCS en sla op in DB."""
    conn = get_db()
    renner = conn.execute("SELECT naam FROM renners WHERE id=?", (rid,)).fetchone()
    if not renner:
        conn.close()
        return jsonify({"error": "Renner niet gevonden"}), 404
    naam = renner["naam"]
    sid = current_seizoen_id(conn)
    wm_slug_to_naam = _get_pcs_slug_map(conn, sid)
    pcs_slug_list   = _get_pcs_slug_list(conn, sid)
    conn.close()

    scraper = cloudscraper.create_scraper()
    pcs_slug = _norm(naam).replace(' ', '-')
    pcs_rider_url = f"https://www.procyclingstats.com/rider/{pcs_slug}/2025"
    historiek_2025 = []

    def _is_pcs_not_found(s):
        title = s.title.string if s.title else ""
        return "not found" in title.lower() or "404" in title

    def _pcs_zoek_slug_licht(db_naam):
        tokens = _norm(db_naam).split()
        if not tokens:
            return None
        achternaam = tokens[-1]
        initiaal   = tokens[0][0] if len(tokens) > 1 else None
        for race_slug in pcs_slug_list[:8]:
            try:
                r = scraper.get(f"https://www.procyclingstats.com/race/{race_slug}/2025", timeout=15)
                if r.status_code != 200:
                    continue
                ss = BeautifulSoup(r.text, "html.parser")
                for a in ss.find_all("a", href=True):
                    href = a["href"]
                    if not href.startswith("rider/"):
                        continue
                    slug_delen = href.replace("rider/", "").split("/")[0].split("-")
                    if achternaam not in slug_delen:
                        continue
                    if initiaal and not any(p.startswith(initiaal) for p in slug_delen if p != achternaam):
                        continue
                    return href.replace("rider/", "").split("/")[0]
            except Exception:
                continue
        return None

    try:
        resp = scraper.get(pcs_rider_url, timeout=20)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, "html.parser")
            if _is_pcs_not_found(soup):
                gevonden_slug = _pcs_zoek_slug_licht(naam)
                if gevonden_slug and gevonden_slug != pcs_slug:
                    pcs_slug = gevonden_slug
                    pcs_rider_url = f"https://www.procyclingstats.com/rider/{pcs_slug}/2025"
                    resp = scraper.get(pcs_rider_url, timeout=20)
                    soup = BeautifulSoup(resp.text, "html.parser") if resp.status_code == 200 else soup
            race_re = re.compile(r"^/?race/([^/]+)/2025")
            for row in soup.select("ul.results li, table.results tr, .rdrResults tr, table tr"):
                cells = row.find_all(["td", "li"]) or [row]
                race_naam = None
                for cell in cells:
                    for a in cell.find_all("a", href=True):
                        m = race_re.match(a["href"])
                        if m and m.group(1) in wm_slug_to_naam:
                            race_naam = wm_slug_to_naam[m.group(1)]
                            break
                    if race_naam:
                        break
                if not race_naam:
                    continue
                positie = None
                for cell in cells:
                    txt = cell.get_text(strip=True)
                    try:
                        val = int(txt)
                        if 1 <= val <= 300:
                            positie = val
                            break
                    except ValueError:
                        pass
                datum_str = None
                for cell in cells:
                    txt = cell.get_text(strip=True)
                    if re.match(r'^\d{2}[.\-]\d{2}$', txt):
                        datum_str = txt
                        break
                historiek_2025.append({"koers": race_naam, "positie": positie, "datum": datum_str})
    except Exception:
        pass

    seen = set()
    historiek_uniek = []
    for h in historiek_2025:
        if h["koers"] not in seen:
            seen.add(h["koers"])
            historiek_uniek.append(h)
    historiek_2025 = sorted(historiek_uniek,
                            key=lambda h: pcs_slug_list.index(
                                next((s for s, n in wm_slug_to_naam.items() if n == h["koers"]), '')
                            ) if h["koers"] in wm_slug_to_naam.values() else 99)

    if historiek_2025:
        conn2 = get_db()
        conn2.execute("DELETE FROM historiek_renner WHERE renner_id=? AND seizoen=2025", (rid,))
        for h in historiek_2025:
            conn2.execute(
                "INSERT INTO historiek_renner (renner_id, seizoen, koers_naam, positie, datum) VALUES (?,2025,?,?,?)",
                (rid, h["koers"], h["positie"], h["datum"])
            )
        conn2.commit()
        conn2.close()

    return jsonify({"ok": True, "historiek_2025": historiek_2025, "pcs_url": pcs_rider_url})


@app.route("/api/renners")
def get_renners():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    renners = conn.execute("""
        SELECT r.*,
               CASE WHEN m.renner_id IS NOT NULL THEN 1 ELSE 0 END as in_ploeg
        FROM renners r
        LEFT JOIN mijn_ploeg m ON r.id = m.renner_id AND m.user_id = ? AND m.seizoen_id = ?
        WHERE r.actief = 1 AND r.seizoen_id = ?
        ORDER BY r.totaal_punten DESC, r.prijs DESC
    """, (uid, sid, sid)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in renners])


@app.route("/api/renners", methods=["POST"])
def add_renner():
    d = request.json
    required = ["naam", "ploeg", "rol", "prijs"]
    if not all(k in d for k in required):
        abort(400, "Verplichte velden: naam, ploeg, rol, prijs")
    foto = (d.get("foto") or "").strip()
    conn = get_db()
    bestaand = conn.execute(
        "SELECT id FROM renners WHERE lower(trim(naam)) = lower(trim(?)) AND actief = 1",
        (d["naam"],)
    ).fetchone()
    if bestaand:
        conn.close()
        return jsonify({"error": f"'{d['naam']}' staat al in de database."}), 409
    cur = conn.execute(
        "INSERT INTO renners (naam, ploeg, rol, prijs, foto) VALUES (?,?,?,?,?)",
        (d["naam"], d["ploeg"], d["rol"], float(d["prijs"]), foto or None)
    )
    conn.commit()
    renner = dict(conn.execute("SELECT * FROM renners WHERE id=?", (cur.lastrowid,)).fetchone())
    conn.close()
    return jsonify(renner), 201


@app.route("/api/renners/<int:rid>", methods=["PUT"])
def update_renner(rid):
    d = request.json
    conn = get_db()
    fields, values = [], []
    for k in ["naam", "ploeg", "rol", "prijs", "totaal_punten", "actief", "foto"]:
        if k in d:
            fields.append(f"{k}=?")
            values.append(d[k])
    if not fields:
        abort(400)
    values.append(rid)
    conn.execute(f"UPDATE renners SET {','.join(fields)} WHERE id=?", values)
    conn.commit()
    renner = dict(conn.execute("SELECT * FROM renners WHERE id=?", (rid,)).fetchone())
    conn.close()
    return jsonify(renner)


@app.route("/api/renners/<int:rid>", methods=["DELETE"])
def delete_renner(rid):
    conn = get_db()
    conn.execute("UPDATE renners SET actief=0 WHERE id=?", (rid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/renners/<int:rid>/foto", methods=["POST"])
def upload_renner_foto(rid):
    if 'foto' not in request.files:
        abort(400, "Geen bestand")
    f = request.files['foto']
    if f.filename == '':
        abort(400, "Geen bestand geselecteerd")
    if not allowed_file(f.filename):
        abort(400, "Ongeldig bestandstype (gebruik jpg, png, gif of webp)")
    ext = f.filename.rsplit('.', 1)[1].lower()
    filename = f"{rid}.{ext}"
    for old_ext in ALLOWED_EXTENSIONS:
        old_path = os.path.join(UPLOAD_FOLDER, f"{rid}.{old_ext}")
        if os.path.exists(old_path) and old_ext != ext:
            os.remove(old_path)
    f.save(os.path.join(UPLOAD_FOLDER, filename))
    foto_url = f"/static/uploads/renners/{filename}"
    conn = get_db()
    conn.execute("UPDATE renners SET foto=? WHERE id=?", (foto_url, rid))
    conn.commit()
    conn.close()
    return jsonify({"foto": foto_url})


@app.route("/api/renners/<int:rid>/detail")
def get_renner_detail(rid):
    conn = get_db()
    renner = conn.execute("SELECT * FROM renners WHERE id=?", (rid,)).fetchone()
    if not renner:
        conn.close()
        return jsonify({"error": "Renner niet gevonden"}), 404

    uid = current_user_id()
    sid = current_seizoen_id(conn)
    in_ploeg = conn.execute(
        "SELECT 1 FROM mijn_ploeg WHERE renner_id=? AND user_id=? AND seizoen_id=?", (rid, uid, sid)
    ).fetchone()

    koersen = conn.execute("""
        SELECT k.id, k.naam, k.datum, k.soort, k.afgelopen,
               o.is_kopman,
               res.positie,
               COALESCE(res.punten, 0) as renner_punten,
               (SELECT COALESCE(SUM(r2.punten), 0)
                FROM resultaten r2
                JOIN opstelling o2 ON o2.renner_id=r2.renner_id AND o2.koers_id=r2.koers_id AND o2.user_id=r2.user_id
                WHERE r2.koers_id=k.id AND r2.user_id=?) as team_punten
        FROM koersen k
        LEFT JOIN opstelling o ON o.koers_id=k.id AND o.renner_id=? AND o.user_id=?
        LEFT JOIN resultaten res ON res.koers_id=k.id AND res.renner_id=? AND res.user_id=?
        WHERE o.renner_id IS NOT NULL OR res.renner_id IS NOT NULL
        ORDER BY k.datum ASC
    """, (uid, rid, uid, rid, uid)).fetchall()

    transfer_in = conn.execute("""
        SELECT t.datum, t.kosten,
               ruit.naam as renner_uit_naam, ruit.prijs as prijs_uit
        FROM transfers t
        JOIN renners ruit ON ruit.id = t.renner_uit_id
        WHERE t.renner_in_id = ? AND t.user_id = ?
        ORDER BY t.datum DESC LIMIT 1
    """, (rid, uid)).fetchone()

    aangeschaft = conn.execute(
        "SELECT aangeschaft_op FROM mijn_ploeg WHERE renner_id = ? AND user_id = ?", (rid, uid)
    ).fetchone()

    historiek_rows = conn.execute("""
        SELECT koers_naam, positie, datum
        FROM historiek_renner
        WHERE renner_id=? AND seizoen=2025
        ORDER BY ROWID ASC
    """, (rid,)).fetchall()

    # Sorteer op volgorde van pcs_slug_list (seizoensvolgorde)
    pcs_slug_list = _get_pcs_slug_list(conn, sid)
    wm_slug_to_naam = _get_pcs_slug_map(conn, sid)
    naam_to_slug = {v: k for k, v in wm_slug_to_naam.items()}
    historiek_2025 = sorted(
        [{"koers": r["koers_naam"], "positie": r["positie"], "datum": r["datum"]}
         for r in historiek_rows],
        key=lambda h: pcs_slug_list.index(naam_to_slug[h["koers"]])
        if h["koers"] in naam_to_slug and naam_to_slug[h["koers"]] in pcs_slug_list else 99
    )

    aliassen = conn.execute(
        "SELECT id, alias FROM renner_aliassen WHERE renner_id=? ORDER BY id", (rid,)
    ).fetchall()

    conn.close()
    return jsonify({
        "renner": dict(renner),
        "in_ploeg": bool(in_ploeg),
        "koersen": [dict(k) for k in koersen],
        "transfer_in": dict(transfer_in) if transfer_in else None,
        "aangeschaft_op": aangeschaft["aangeschaft_op"] if aangeschaft else None,
        "historiek_2025": historiek_2025,
        "aliassen": [dict(a) for a in aliassen],
    })


# ── API: Renner naam-aliassen ─────────────────────────────────────────────────

@app.route("/api/renners/<int:rid>/aliassen", methods=["GET"])
def get_renner_aliassen(rid):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, alias FROM renner_aliassen WHERE renner_id=? ORDER BY id", (rid,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/renners/<int:rid>/aliassen", methods=["POST"])
def add_renner_alias(rid):
    d = request.json or {}
    alias_raw = (d.get("alias") or "").strip()
    if not alias_raw:
        return jsonify({"error": "alias mag niet leeg zijn"}), 400
    alias_norm = _norm(alias_raw)
    conn = get_db()
    if not conn.execute("SELECT 1 FROM renners WHERE id=?", (rid,)).fetchone():
        conn.close()
        return jsonify({"error": "Renner niet gevonden"}), 404
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO renner_aliassen (renner_id, alias) VALUES (?,?)",
            (rid, alias_norm)
        )
        conn.commit()
        new_id = cur.lastrowid
    except Exception as e:
        conn.close()
        return jsonify({"error": str(e)}), 409
    conn.close()
    return jsonify({"id": new_id, "alias": alias_norm}), 201


@app.route("/api/renners/aliassen/<int:aid>", methods=["DELETE"])
def delete_renner_alias(aid):
    conn = get_db()
    conn.execute("DELETE FROM renner_aliassen WHERE id=?", (aid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/renners/<int:rid>/pcs-wedstrijden", methods=["GET"])
def renner_pcs_wedstrijden(rid):
    """Haal via PCS op aan welke wedstrijden een renner deelneemt."""
    conn = get_db()
    renner = conn.execute("SELECT naam FROM renners WHERE id=?", (rid,)).fetchone()
    if not renner:
        conn.close()
        return jsonify({"error": "Renner niet gevonden"}), 404
    naam = renner["naam"]

    sid = current_seizoen_id(conn)
    koersen = conn.execute(
        "SELECT naam, datum, soort, afgelopen, pcs_slug FROM koersen WHERE seizoen_id=? ORDER BY datum",
        (sid,)
    ).fetchall()
    conn.close()

    slug = _norm(naam).replace(" ", "-")
    pcs_url = f"https://www.procyclingstats.com/rider/{slug}/2026"

    try:
        scraper = cloudscraper.create_scraper()
        resp = scraper.get(pcs_url, timeout=15)
    except Exception as e:
        return jsonify({"error": f"Netwerkfout: {str(e)}"}), 503

    if resp.status_code == 404:
        return jsonify({"error": f"Renner niet gevonden op ProCyclingStats (probeer naam aan te passen)."}), 404
    if resp.status_code != 200:
        return jsonify({"error": f"ProCyclingStats niet bereikbaar (HTTP {resp.status_code})."}), 503

    soup = BeautifulSoup(resp.text, "html.parser")

    rider_in_race_re = re.compile(r"rider-in-race/[^/]+/([^/]+)/2026")
    race_2026_re     = re.compile(r"^/?race/([^/]+)/2026")
    pcs_slugs_gevonden = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        m = rider_in_race_re.search(href)
        if m:
            pcs_slugs_gevonden.add(m.group(1))
            continue
        m = race_2026_re.match(href)
        if m:
            pcs_slugs_gevonden.add(m.group(1))

    wedstrijden = []
    for k in koersen:
        koers_pcs_slug = k["pcs_slug"]
        if koers_pcs_slug and koers_pcs_slug in pcs_slugs_gevonden:
            wedstrijden.append({
                "naam":      k["naam"],
                "datum":     k["datum"],
                "soort":     k["soort"],
                "afgelopen": bool(k["afgelopen"]),
            })

    return jsonify({
        "renner":      naam,
        "pcs_url":     pcs_url,
        "wedstrijden": wedstrijden,
        "totaal_pcs":  len(pcs_slugs_gevonden),
    })


@app.route("/api/renners/<int:rid>/toggle-geblesseerd", methods=["POST"])
def toggle_geblesseerd(rid):
    conn = get_db()
    renner = conn.execute("SELECT geblesseerd FROM renners WHERE id=?", (rid,)).fetchone()
    if not renner:
        conn.close()
        return jsonify({"error": "Renner niet gevonden"}), 404
    nieuw = 0 if renner["geblesseerd"] else 1
    conn.execute("UPDATE renners SET geblesseerd=? WHERE id=?", (nieuw, rid))
    conn.commit()
    conn.close()
    return jsonify({"geblesseerd": nieuw})


# ── API: Mijn ploeg ────────────────────────────────────────────────────────────

@app.route("/api/mijn-ploeg")
def get_mijn_ploeg():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    inst = _get_inst(conn, uid, sid=sid)
    budget = float(inst.get("budget", 120))

    ploeg = conn.execute("""
        SELECT r.id, r.naam, r.ploeg as renner_ploeg, r.rol, r.prijs, r.totaal_punten,
               r.foto, r.geblesseerd, m.aangeschaft_op,
               COALESCE(m.aangeschaft_prijs, r.prijs) as aangeschaft_prijs
        FROM mijn_ploeg m
        JOIN renners r ON r.id = m.renner_id
        WHERE m.user_id = ? AND m.seizoen_id = ?
        ORDER BY COALESCE(m.aangeschaft_prijs, r.prijs) DESC, r.totaal_punten DESC
    """, (uid, sid)).fetchall()

    uitgegeven = sum(r["aangeschaft_prijs"] for r in ploeg)
    resterend = round(budget - uitgegeven, 2)

    conn.close()
    return jsonify({
        "renners": [dict(r) for r in ploeg],
        "budget_totaal": budget,
        "budget_uitgegeven": round(uitgegeven, 2),
        "budget_resterend": resterend,
        "aantal": len(ploeg),
    })


def _get_user_inst_val(conn, key, uid=None, default=None, sid=None):
    if uid is None: uid = current_user_id() or 1
    if sid is None: sid = current_seizoen_id(conn)
    for sleutel in [f'{key}_{uid}_{sid}', f'{key}_{uid}', key]:
        row = conn.execute("SELECT waarde FROM instellingen WHERE sleutel=?", (sleutel,)).fetchone()
        if row:
            return row['waarde']
    return default


def _set_user_inst_val(conn, key, val, uid=None, sid=None):
    if uid is None: uid = current_user_id() or 1
    if sid is None: sid = current_seizoen_id(conn)
    sleutel = f'{key}_{uid}_{sid}'
    conn.execute("INSERT OR REPLACE INTO instellingen (sleutel, waarde) VALUES (?,?)", (sleutel, str(val)))


def _get_inst(conn, uid=None, sid=None):
    if uid is None:
        uid = current_user_id() or 1
    if sid is None:
        sid = current_seizoen_id(conn)
    all_rows = {r['sleutel']: r['waarde'] for r in conn.execute("SELECT sleutel, waarde FROM instellingen").fetchall()}
    result = {}
    for key, val in all_rows.items():
        skip = False
        for base_key in _USER_INST_KEYS:
            if key.startswith(f"{base_key}_"):
                skip = True
                break
        if skip:
            continue
        result[key] = val
    for k in _USER_INST_KEYS:
        val = _get_user_inst_val(conn, k, uid, sid=sid)
        if val is not None:
            result[k] = val
    return result


@app.route("/api/mijn-ploeg/add", methods=["POST"])
def add_to_ploeg():
    uid = current_user_id()
    rid = request.json.get("renner_id")
    conn = get_db()
    sid = current_seizoen_id(conn)
    inst = _get_inst(conn, uid, sid=sid)

    budget = float(inst.get("budget", 120))
    max_renners = int(inst.get("max_renners", 20))
    max_per_ploeg = int(inst.get("max_per_ploeg", 4))

    ploeg = conn.execute("""
        SELECT COALESCE(m.aangeschaft_prijs, r.prijs) as aangeschaft_prijs, r.ploeg
        FROM mijn_ploeg m JOIN renners r ON r.id=m.renner_id
        WHERE m.user_id=? AND m.seizoen_id=?
    """, (uid, sid)).fetchall()

    if len(ploeg) >= max_renners:
        conn.close()
        return jsonify({"error": f"Ploeg is al vol ({max_renners} renners)"}), 400

    renner = conn.execute("SELECT * FROM renners WHERE id=? AND seizoen_id=?", (rid, sid)).fetchone()
    if not renner:
        conn.close()
        return jsonify({"error": "Renner niet gevonden"}), 404

    zelfde_ploeg = sum(1 for r in ploeg if r["ploeg"] == renner["ploeg"])
    if zelfde_ploeg >= max_per_ploeg:
        conn.close()
        return jsonify({"error": f"Max {max_per_ploeg} renners van {renner['ploeg']} al in ploeg"}), 400

    uitgegeven = sum(r["aangeschaft_prijs"] for r in ploeg)
    if uitgegeven + renner["prijs"] > budget:
        conn.close()
        return jsonify({"error": f"Onvoldoende budget (€{budget - uitgegeven:.1f}M beschikbaar)"}), 400

    try:
        conn.execute(
            "INSERT INTO mijn_ploeg (renner_id, user_id, seizoen_id, aangeschaft_prijs) VALUES (?,?,?,?)",
            (rid, uid, sid, renner["prijs"])
        )
        conn.commit()
    except Exception:
        conn.close()
        return jsonify({"error": "Renner zit al in je ploeg"}), 400

    conn.close()
    return jsonify({"ok": True})


@app.route("/api/mijn-ploeg/remove", methods=["POST"])
def remove_from_ploeg():
    uid = current_user_id()
    rid = request.json.get("renner_id")
    conn = get_db()
    sid = current_seizoen_id(conn)
    conn.execute("DELETE FROM mijn_ploeg WHERE renner_id=? AND user_id=? AND seizoen_id=?", (rid, uid, sid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── API: Transfers ─────────────────────────────────────────────────────────────

@app.route("/api/transfers/kosten")
def get_transfer_kosten():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    inst = _get_inst(conn, uid, sid=sid)
    count = int(inst.get("transfer_count", 0))
    gratis = int(inst.get("transfers_gratis", 3))
    volgende = count + 1
    kosten = transfer_kosten(volgende, gratis)
    budget_rest = float(inst.get("budget", 120))
    ploeg = conn.execute(
        "SELECT COALESCE(m.aangeschaft_prijs, r.prijs) as aangeschaft_prijs "
        "FROM mijn_ploeg m JOIN renners r ON r.id=m.renner_id WHERE m.user_id=? AND m.seizoen_id=?",
        (uid, sid)
    ).fetchall()
    uitgegeven = sum(r["aangeschaft_prijs"] for r in ploeg)
    budget_rest = round(budget_rest - uitgegeven, 2)
    conn.close()
    return jsonify({
        "transfer_nummer": volgende,
        "kosten": kosten,
        "gratis_resterend": max(0, gratis - count),
        "budget_resterend": budget_rest,
    })


@app.route("/api/transfers", methods=["POST"])
def do_transfer():
    uid = current_user_id()
    d = request.json
    rid_uit = d.get("renner_uit_id")
    rid_in  = d.get("renner_in_id")

    conn = get_db()
    sid = current_seizoen_id(conn)
    inst = _get_inst(conn, uid, sid=sid)
    budget = float(inst.get("budget", 120))
    count = int(inst.get("transfer_count", 0))
    gratis = int(inst.get("transfers_gratis", 3))

    volgende = count + 1
    kosten = transfer_kosten(volgende, gratis)

    ploeg_rest = conn.execute(
        "SELECT COALESCE(m.aangeschaft_prijs, r.prijs) as aangeschaft_prijs, r.ploeg "
        "FROM mijn_ploeg m JOIN renners r ON r.id=m.renner_id "
        "WHERE m.user_id=? AND m.seizoen_id=? AND m.renner_id!=?",
        (uid, sid, rid_uit)
    ).fetchall()

    renner_in = conn.execute("SELECT * FROM renners WHERE id=?", (rid_in,)).fetchone()
    if not renner_in:
        conn.close()
        return jsonify({"error": "Renner niet gevonden"}), 404

    max_per_ploeg = int(inst.get("max_per_ploeg", 4))
    zelfde_ploeg = sum(1 for r in ploeg_rest if r["ploeg"] == renner_in["ploeg"])
    if zelfde_ploeg >= max_per_ploeg:
        conn.close()
        return jsonify({"error": f"Max {max_per_ploeg} renners van {renner_in['ploeg']} al in ploeg"}), 400

    uitgegeven = sum(r["aangeschaft_prijs"] for r in ploeg_rest)
    totaal_nodig = uitgegeven + renner_in["prijs"] + kosten
    if totaal_nodig > budget:
        conn.close()
        return jsonify({"error": f"Onvoldoende budget (transfer kost €{kosten}M + rennerprijs €{renner_in['prijs']}M)"}), 400

    conn.execute("DELETE FROM mijn_ploeg WHERE renner_id=? AND user_id=? AND seizoen_id=?", (rid_uit, uid, sid))
    conn.execute(
        "INSERT OR REPLACE INTO mijn_ploeg (renner_id, user_id, seizoen_id, aangeschaft_prijs) VALUES (?,?,?,?)",
        (rid_in, uid, sid, renner_in["prijs"])
    )
    conn.execute(
        "INSERT INTO transfers (renner_uit_id, renner_in_id, kosten, user_id, seizoen_id) VALUES (?,?,?,?,?)",
        (rid_uit, rid_in, kosten, uid, sid)
    )
    new_budget = round(budget - kosten, 2)
    _set_user_inst_val(conn, 'transfer_count', str(volgende), uid=uid, sid=sid)
    if kosten > 0:
        _set_user_inst_val(conn, 'budget', str(new_budget), uid=uid, sid=sid)
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "kosten": kosten, "nieuw_budget": new_budget})


@app.route("/api/transfers")
def get_transfers():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    transfers = conn.execute("""
        SELECT t.id, t.datum, t.kosten,
               ri.naam as renner_in,  ri.prijs as prijs_in,
               ru.naam as renner_uit, ru.prijs as prijs_uit
        FROM transfers t
        LEFT JOIN renners ri ON ri.id = t.renner_in_id
        LEFT JOIN renners ru ON ru.id = t.renner_uit_id
        WHERE t.user_id = ? AND t.seizoen_id = ?
        ORDER BY t.datum DESC, t.id DESC
        LIMIT 50
    """, (uid, sid)).fetchall()
    conn.close()
    return jsonify([dict(t) for t in transfers])


# ── API: Geplande Transfers ────────────────────────────────────────────────────

@app.route("/api/geplande-transfers")
def get_geplande_transfers():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    rows = conn.execute("""
        SELECT gt.id, gt.datum, gt.aangemaakt_op,
               r_uit.id as uit_id, r_uit.naam as uit_naam, r_uit.ploeg as uit_ploeg,
               r_uit.prijs as uit_prijs, r_uit.foto as uit_foto, r_uit.rol as uit_rol,
               r_in.id as in_id, r_in.naam as in_naam, r_in.ploeg as in_ploeg,
               r_in.prijs as in_prijs, r_in.foto as in_foto, r_in.rol as in_rol
        FROM geplande_transfers gt
        JOIN renners r_uit ON r_uit.id = gt.renner_uit_id
        JOIN renners r_in  ON r_in.id  = gt.renner_in_id
        WHERE gt.user_id = ? AND gt.seizoen_id = ?
        ORDER BY gt.datum ASC
    """, (uid, sid)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/geplande-transfers", methods=["POST"])
def add_gepland_transfer():
    uid = current_user_id()
    data = request.get_json()
    renner_uit_id = data.get("renner_uit_id")
    renner_in_id  = data.get("renner_in_id")
    datum         = data.get("datum")
    if not all([renner_uit_id, renner_in_id, datum]):
        return jsonify({"error": "Ontbrekende velden"}), 400
    conn = get_db()
    sid = current_seizoen_id(conn)
    conn.execute(
        "INSERT INTO geplande_transfers (renner_uit_id, renner_in_id, datum, user_id, seizoen_id) VALUES (?,?,?,?,?)",
        (renner_uit_id, renner_in_id, datum, uid, sid)
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/geplande-transfers/<int:gtid>", methods=["DELETE"])
def delete_gepland_transfer(gtid):
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    conn.execute("DELETE FROM geplande_transfers WHERE id=? AND user_id=? AND seizoen_id=?", (gtid, uid, sid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/geplande-transfers/<int:gtid>/uitvoeren", methods=["POST"])
def uitvoeren_gepland_transfer(gtid):
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    gt = conn.execute("SELECT * FROM geplande_transfers WHERE id=? AND user_id=? AND seizoen_id=?", (gtid, uid, sid)).fetchone()
    if not gt:
        conn.close()
        return jsonify({"error": "Geplande transfer niet gevonden"}), 404

    rid_uit = gt["renner_uit_id"]
    rid_in  = gt["renner_in_id"]

    inst = _get_inst(conn, uid, sid=sid)
    budget = float(inst.get("budget", 120))
    count  = int(inst.get("transfer_count", 0))
    gratis = int(inst.get("transfers_gratis", 3))
    volgende = count + 1
    kosten = transfer_kosten(volgende, gratis)

    ploeg_rest = conn.execute(
        "SELECT COALESCE(m.aangeschaft_prijs, r.prijs) as aangeschaft_prijs, r.ploeg "
        "FROM mijn_ploeg m JOIN renners r ON r.id=m.renner_id "
        "WHERE m.user_id=? AND m.seizoen_id=? AND m.renner_id!=?",
        (uid, sid, rid_uit)
    ).fetchall()

    renner_in = conn.execute("SELECT * FROM renners WHERE id=?", (rid_in,)).fetchone()
    if not renner_in:
        conn.close()
        return jsonify({"error": "Nieuw in te kopen renner niet gevonden"}), 404

    in_ploeg = conn.execute("SELECT 1 FROM mijn_ploeg WHERE renner_id=? AND user_id=? AND seizoen_id=?", (rid_uit, uid, sid)).fetchone()
    if not in_ploeg:
        conn.close()
        return jsonify({"error": "Te vervangen renner zit niet meer in jouw ploeg"}), 400

    max_per_ploeg = int(inst.get("max_per_ploeg", 4))
    zelfde_ploeg = sum(1 for r in ploeg_rest if r["ploeg"] == renner_in["ploeg"])
    if zelfde_ploeg >= max_per_ploeg:
        conn.close()
        return jsonify({"error": f"Max {max_per_ploeg} renners van {renner_in['ploeg']} al in ploeg"}), 400

    uitgegeven = sum(r["aangeschaft_prijs"] for r in ploeg_rest)
    totaal_nodig = uitgegeven + renner_in["prijs"] + kosten
    if totaal_nodig > budget:
        conn.close()
        return jsonify({"error": f"Onvoldoende budget (transfer kost €{kosten}M + rennerprijs €{renner_in['prijs']}M)"}), 400

    new_budget = round(budget - kosten, 2)
    conn.execute("DELETE FROM mijn_ploeg WHERE renner_id=? AND user_id=? AND seizoen_id=?", (rid_uit, uid, sid))
    conn.execute(
        "INSERT OR REPLACE INTO mijn_ploeg (renner_id, user_id, seizoen_id, aangeschaft_prijs) VALUES (?,?,?,?)",
        (rid_in, uid, sid, renner_in["prijs"])
    )
    conn.execute(
        "INSERT INTO transfers (renner_uit_id, renner_in_id, kosten, user_id, seizoen_id) VALUES (?,?,?,?,?)",
        (rid_uit, rid_in, kosten, uid, sid)
    )
    _set_user_inst_val(conn, 'transfer_count', str(volgende), uid=uid, sid=sid)
    if kosten > 0:
        _set_user_inst_val(conn, 'budget', str(new_budget), uid=uid, sid=sid)
    conn.execute("DELETE FROM geplande_transfers WHERE id=?", (gtid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "kosten": kosten, "nieuw_budget": new_budget})


# ── API: Suggesties ────────────────────────────────────────────────────────────

@app.route("/api/suggesties")
def get_suggesties():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    inst = _get_inst(conn, uid, sid=sid)
    budget_rest = float(request.args.get("budget", 10))
    max_per_ploeg = int(inst.get("max_per_ploeg", 4))

    ploeg_ploegen = conn.execute("""
        SELECT r.ploeg, COUNT(*) as cnt
        FROM mijn_ploeg m JOIN renners r ON r.id=m.renner_id
        WHERE m.user_id=? AND m.seizoen_id=?
        GROUP BY r.ploeg
    """, (uid, sid)).fetchall()
    volle_ploegen = {r["ploeg"] for r in ploeg_ploegen if r["cnt"] >= max_per_ploeg}

    suggesties = conn.execute("""
        SELECT r.id, r.naam, r.ploeg, r.rol, r.prijs, r.totaal_punten, r.foto,
               ROUND(CAST(r.totaal_punten AS REAL) / NULLIF(r.prijs, 0), 2) as ratio
        FROM renners r
        WHERE r.actief = 1 AND r.seizoen_id = ?
          AND r.id NOT IN (SELECT renner_id FROM mijn_ploeg WHERE user_id=? AND seizoen_id=?)
          AND r.prijs <= ?
          AND r.totaal_punten > 0
        ORDER BY ratio DESC
        LIMIT 30
    """, (sid, uid, sid, budget_rest,)).fetchall()

    if not suggesties:
        suggesties = conn.execute("""
            SELECT r.id, r.naam, r.ploeg, r.rol, r.prijs, r.totaal_punten,
                   0.0 as ratio
            FROM renners r
            WHERE r.actief = 1 AND r.seizoen_id = ?
              AND r.id NOT IN (SELECT renner_id FROM mijn_ploeg WHERE user_id=? AND seizoen_id=?)
              AND r.prijs <= ?
            ORDER BY r.prijs DESC
            LIMIT 30
        """, (sid, uid, sid, budget_rest,)).fetchall()

    result = []
    for s in suggesties:
        d = dict(s)
        d["ploeg_vol"] = s["ploeg"] in volle_ploegen
        result.append(d)

    conn.close()
    return jsonify(result)


# ── API: Koersen ───────────────────────────────────────────────────────────────

@app.route("/api/koersen")
def get_koersen():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    koersen = conn.execute("""
        SELECT k.*,
               COUNT(DISTINCT o.renner_id) as opstelling_aantal,
               COALESCE(SUM(res.punten), 0) as mijn_punten,
               (SELECT re.foto FROM renners re WHERE re.id = k.winnaar_id) as winnaar_foto,
               (SELECT re.naam FROM renners re WHERE re.id = k.winnaar_id) as winnaar_naam,
               (SELECT re.foto FROM opstelling op2
                JOIN renners re ON re.id = op2.renner_id
                WHERE op2.koers_id = k.id AND op2.is_kopman = 1 AND op2.user_id = ?
                LIMIT 1) as kopman_foto,
               (SELECT re.naam FROM opstelling op2
                JOIN renners re ON re.id = op2.renner_id
                WHERE op2.koers_id = k.id AND op2.is_kopman = 1 AND op2.user_id = ?
                LIMIT 1) as kopman_naam
        FROM koersen k
        LEFT JOIN opstelling o ON o.koers_id = k.id AND o.user_id = ?
        LEFT JOIN resultaten res ON res.koers_id = k.id AND res.renner_id = o.renner_id AND res.user_id = ?
        WHERE k.seizoen_id = ?
        GROUP BY k.id
        ORDER BY k.datum ASC
    """, (uid, uid, uid, uid, sid)).fetchall()
    conn.close()
    return jsonify([dict(k) for k in koersen])


@app.route("/api/koersen", methods=["POST"])
def add_koers():
    d = request.json
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO koersen (naam, datum, soort) VALUES (?,?,?)",
        (d["naam"], d["datum"], d.get("soort", "niet_wt"))
    )
    conn.commit()
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (cur.lastrowid,)).fetchone())
    conn.close()
    return jsonify(koers), 201


@app.route("/api/koersen/<int:kid>", methods=["PUT"])
def update_koers(kid):
    d = request.json
    conn = get_db()
    fields, values = [], []
    for k in ["naam", "datum", "soort", "afgelopen"]:
        if k in d:
            fields.append(f"{k}=?")
            values.append(d[k])
    values.append(kid)
    conn.execute(f"UPDATE koersen SET {','.join(fields)} WHERE id=?", values)
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/koersen/<int:kid>", methods=["DELETE"])
def delete_koers(kid):
    conn = get_db()
    conn.execute("DELETE FROM resultaten WHERE koers_id=?", (kid,))
    conn.execute("DELETE FROM opstelling WHERE koers_id=?", (kid,))
    conn.execute("DELETE FROM koersen WHERE id=?", (kid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── API: Opstelling per koers ──────────────────────────────────────────────────

@app.route("/api/koersen/<int:kid>/opstelling")
def get_opstelling(kid):
    uid = current_user_id()
    conn = get_db()
    inst = _get_inst(conn)
    max_opstelling = int(inst.get("max_starters", 12))

    renners = conn.execute("""
        SELECT r.id, r.naam, r.ploeg as renner_ploeg, r.rol, r.prijs, r.totaal_punten, r.foto,
               CASE WHEN o.renner_id IS NOT NULL THEN 1 ELSE 0 END as in_opstelling,
               COALESCE(o.is_kopman, 0) as is_kopman
        FROM mijn_ploeg m
        JOIN renners r ON r.id = m.renner_id
        LEFT JOIN opstelling o ON o.renner_id = r.id AND o.koers_id = ? AND o.user_id = ?
        WHERE m.user_id = ?
        ORDER BY r.prijs DESC
    """, (kid, uid, uid)).fetchall()

    cnt = sum(1 for r in renners if r["in_opstelling"])
    conn.close()
    return jsonify({
        "renners": [dict(r) for r in renners],
        "max_opstelling": max_opstelling,
        "huidig_aantal": cnt,
    })


@app.route("/api/koersen/<int:kid>/opstelling", methods=["POST"])
def set_opstelling(kid):
    uid = current_user_id()
    data = request.json
    renner_ids = data.get("renner_ids", [])
    kopman_id = data.get("kopman_id")

    conn = get_db()
    inst = _get_inst(conn)
    max_opstelling = int(inst.get("max_starters", 12))

    if len(renner_ids) > max_opstelling:
        conn.close()
        return jsonify({"error": f"Max {max_opstelling} renners in de opstelling"}), 400

    conn.execute("DELETE FROM opstelling WHERE koers_id=? AND user_id=?", (kid, uid))
    for rid in renner_ids:
        is_kop = 1 if rid == kopman_id else 0
        conn.execute(
            "INSERT INTO opstelling (koers_id, renner_id, user_id, is_kopman) VALUES (?,?,?,?)",
            (kid, rid, uid, is_kop)
        )

    conn.commit()
    conn.close()
    return jsonify({"ok": True, "aantal": len(renner_ids)})


# ── API: Deelnemers (PCS startlijst) ──────────────────────────────────────────

@app.route("/api/koersen/<int:kid>/deelnemers")
def get_deelnemers(kid):
    conn = get_db()
    sid = current_seizoen_id(conn)
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify({"error": "Koers niet gevonden"}), 404

    slug = koers['pcs_slug']
    if not slug:
        conn.close()
        return jsonify({"error": f"Geen ProCyclingStats koppeling voor '{koers['naam']}'"}), 404

    uid = current_user_id()
    ploeg = conn.execute("""
        SELECT r.id, r.naam, r.ploeg as renner_ploeg, r.rol, r.prijs, r.totaal_punten, r.foto
        FROM mijn_ploeg m JOIN renners r ON r.id = m.renner_id
        WHERE m.user_id = ? AND m.seizoen_id = ?
        ORDER BY r.prijs DESC
    """, (uid, sid)).fetchall()
    conn.close()

    year = koers['datum'][:4]
    is_past = bool(koers['afgelopen'])
    if is_past:
        url = f"https://www.procyclingstats.com/race/{slug}/{year}/result"
        bron_label = "uitslag"
    else:
        url = f"https://www.procyclingstats.com/race/{slug}/{year}/startlist"
        bron_label = "startlijst"

    try:
        scraper = cloudscraper.create_scraper()
        resp = scraper.get(url, timeout=20)
    except Exception as e:
        return jsonify({"error": f"Netwerkfout bij ophalen {bron_label}: {str(e)}"}), 503

    if resp.status_code == 404:
        return jsonify({"error": f"Pagina niet gevonden op ProCyclingStats. Mogelijk is de koers nog niet ingepland."}), 404
    if resp.status_code == 500:
        return jsonify({"error": f"ProCyclingStats heeft nog geen {bron_label} voor deze koers (wordt later gepubliceerd)."}), 404
    if resp.status_code == 403:
        return jsonify({"error": f"Toegang geweigerd door ProCyclingStats. Probeer later opnieuw."}), 503
    if resp.status_code != 200:
        return jsonify({"error": f"ProCyclingStats gaf een fout terug (HTTP {resp.status_code})."}), 503

    soup = BeautifulSoup(resp.text, 'html.parser')
    pcs_names_norm = set()
    for a in soup.select('a[href^="rider/"]'):
        text = a.get_text(strip=True)
        if not text or len(text) < 3:
            continue
        first_word = text.split()[0]
        first_word_ascii = first_word.encode('ascii', 'ignore').decode('ascii')
        if not first_word_ascii or not first_word_ascii.isupper():
            continue
        pcs_names_norm.add(_norm(text))

    results = []
    for r in ploeg:
        bevestigd = _name_match(r['naam'], pcs_names_norm)
        results.append({**dict(r), 'bevestigd': bevestigd})

    bevestigd_ids = [r['id'] for r in results if r['bevestigd']]
    suggestie_ids = bevestigd_ids[:12]
    kopman_id = suggestie_ids[0] if suggestie_ids else None

    return jsonify({
        'koers': dict(koers),
        'url': url,
        'bron': bron_label,
        'totaal_pcs': len(pcs_names_norm),
        'renners': results,
        'suggestie_opstelling': suggestie_ids,
        'suggestie_kopman': kopman_id,
    })


# ── API: Uitslag PCS ───────────────────────────────────────────────────────────

@app.route("/api/koersen/<int:kid>/uitslag-pcs")
def get_uitslag_pcs(kid):
    conn = get_db()
    sid = current_seizoen_id(conn)
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify({"error": "Koers niet gevonden"}), 404

    slug = koers['pcs_slug']
    if not slug:
        conn.close()
        return jsonify({"error": f"Geen ProCyclingStats koppeling voor '{koers['naam']}'"}), 404

    uid = current_user_id()
    ploeg = conn.execute("""
        SELECT r.id, r.naam, r.ploeg as renner_ploeg, r.rol, r.prijs, r.foto
        FROM mijn_ploeg m JOIN renners r ON r.id = m.renner_id
        WHERE m.user_id = ? AND m.seizoen_id = ?
    """, (uid, sid)).fetchall()

    opstelling_rows = conn.execute(
        "SELECT renner_id, is_kopman FROM opstelling WHERE koers_id=? AND user_id=?", (kid, uid)
    ).fetchall()
    opstelling_ids = {r["renner_id"] for r in opstelling_rows}
    kopman_id = next((r["renner_id"] for r in opstelling_rows if r["is_kopman"]), None)
    conn.close()

    year = koers['datum'][:4]
    url = f"https://www.procyclingstats.com/race/{slug}/{year}/result"

    try:
        scraper = cloudscraper.create_scraper()
        resp = scraper.get(url, timeout=20)
    except Exception as e:
        return jsonify({"error": f"Netwerkfout: {str(e)}"}), 503

    if resp.status_code == 404:
        return jsonify({"error": "Uitslag niet gevonden op ProCyclingStats."}), 404
    if resp.status_code == 500:
        return jsonify({"error": "ProCyclingStats heeft nog geen uitslag (wordt later gepubliceerd)."}), 404
    if resp.status_code == 403:
        return jsonify({"error": "Toegang geweigerd door ProCyclingStats. Probeer later opnieuw."}), 503
    if resp.status_code != 200:
        return jsonify({"error": f"ProCyclingStats gaf fout HTTP {resp.status_code}."}), 503

    soup = BeautifulSoup(resp.text, 'html.parser')

    pcs_top30 = []
    for row in soup.select('table tr'):
        cells = row.find_all('td')
        if len(cells) < 2:
            continue
        try:
            pos = int(cells[0].get_text(strip=True))
        except ValueError:
            continue
        if pos > 30:
            continue
        rider_link = row.find('a', href=lambda h: h and h.startswith('rider/'))
        if not rider_link:
            continue
        rider_name = rider_link.get_text(separator=' ', strip=True)
        # PCS toont namen soms als "LASTNAME Firstname" (bijv. "Menten Milan").
        # De rider-slug in href="rider/milan-menten" heeft altijd Firstname-Lastname
        # volgorde (slug = genormaliseerde naam in correcte volgorde).
        # Gebruik de slug voor matching zodat achternaam altijd de laatste token is.
        rider_href = rider_link.get('href', '')
        slug_part = rider_href.replace('rider/', '').split('/')[0]
        rider_name_norm = slug_part.replace('-', ' ')  # "milan-menten" -> "milan menten"
        team_name = ''
        for cell in cells[1:]:
            tl = cell.find('a', href=lambda h: h and h.startswith('team/'))
            if tl:
                team_name = tl.get_text(strip=True)
                break
        pcs_top30.append({
            'positie': pos,
            'naam': rider_name,          # weergavenaam voor UI
            'naam_norm': rider_name_norm, # slug-gebaseerd voor matching
            'ploeg_pcs': team_name,
        })

    if not pcs_top30:
        return jsonify({"error": "Geen uitslag gevonden op de PCS-pagina (koers mogelijk nog niet gereden)."}), 404

    winnaar_ploeg_pcs = _norm(pcs_top30[0]['ploeg_pcs']) if pcs_top30 else ''
    soort = koers['soort']

    matched = []
    for r in ploeg:
        pos = None
        for pcs in pcs_top30:
            # Gebruik naam_norm (uit rider-slug) voor matching — correct Firstname Lastname
            # Dit voorkomt dat "Menten Milan" (weergavenaam) matcht op db "Matteo Milan"
            if _name_match(r['naam'], {pcs['naam_norm']}):
                app.logger.warning(
                    f"[UITSLAG MATCH] db='{r['naam']}' -> pcs='{pcs['naam']}' (slug: {pcs['naam_norm']}) pos={pcs['positie']}"
                )
                pos = pcs['positie']
                break
        if pos is None:
            app.logger.warning(
                f"[UITSLAG GEEN MATCH] db='{r['naam']}' niet gevonden in top30"
            )
        in_ops = r['id'] in opstelling_ids
        is_kop = r['id'] == kopman_id

        punten_basis = punten_voor_positie(soort, pos) if pos and in_ops else 0
        bns_kop = kopman_bonus(pos) if pos and is_kop and in_ops else 0

        renner_ploeg_norm = _norm(r['renner_ploeg'])
        is_ploegmaat = bool(
            winnaar_ploeg_pcs and pos != 1 and in_ops and
            _ploeg_match(winnaar_ploeg_pcs, renner_ploeg_norm)
        )
        bns_ploeg = 10 if is_ploegmaat else 0

        matched.append({
            **dict(r),
            'positie': pos,
            'in_opstelling': in_ops,
            'is_kopman': is_kop,
            'is_ploegmaat_winnaar': is_ploegmaat,
            'punten_basis': punten_basis,
            'bonus_kopman': bns_kop,
            'bonus_ploegmaat': bns_ploeg,
            'totaal': punten_basis + bns_kop + bns_ploeg,
        })

    matched.sort(key=lambda r: (
        0 if r['in_opstelling'] else 1,
        r['positie'] if r['positie'] else 999
    ))

    return jsonify({
        'koers': dict(koers),
        'url': url,
        'pcs_top30': pcs_top30,
        'renners': matched,
        'winnaar': pcs_top30[0]['naam'] if pcs_top30 else None,
        'winnaar_ploeg': pcs_top30[0]['ploeg_pcs'] if pcs_top30 else None,
    })


# ── API: Wedstrijdprofiel ophalen van PCS ──────────────────────────────────────

@app.route("/api/koersen/<int:kid>/fetch-profiel", methods=["POST"])
def fetch_profiel(kid):
    conn = get_db()
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify({"error": "Koers niet gevonden"}), 404

    slug = koers['pcs_slug']
    if not slug:
        conn.close()
        return jsonify({"error": f"Geen PCS-koppeling voor '{koers['naam']}'"}), 404

    year = koers['datum'][:4]
    url = f"https://www.procyclingstats.com/race/{slug}/{year}"

    try:
        scraper = cloudscraper.create_scraper()
        resp = scraper.get(url, timeout=20)
    except Exception as e:
        conn.close()
        return jsonify({"error": f"Netwerkfout: {str(e)}"}), 503

    if resp.status_code != 200:
        conn.close()
        return jsonify({"error": f"PCS gaf HTTP {resp.status_code} terug."}), 503

    soup = BeautifulSoup(resp.text, 'html.parser')
    afstand = None
    hoogtemeters = None
    profiel_url = None

    for li in soup.find_all('li'):
        title_div = li.find('div', class_='title')
        if not title_div:
            continue
        parts = li.get_text(separator='|', strip=True).split('|')
        if len(parts) < 2:
            continue
        label = parts[0].lower()
        raw   = parts[1]
        if 'distance' in label and afstand is None:
            m = re.search(r'([\d]+(?:[.,]\d+)?)', raw)
            if m:
                try:
                    afstand = float(m.group(1).replace(',', '.'))
                except ValueError:
                    pass
        elif ('vert' in label or 'elevation' in label) and hoogtemeters is None:
            m = re.search(r'([\d]+(?:[.,]\d+)?)', raw.replace(',', ''))
            if m:
                try:
                    hoogtemeters = int(float(m.group(1)))
                except ValueError:
                    pass

    if afstand is None:
        m = re.search(r'[Dd]istance[:\s]{0,5}([\d]+(?:[.,]\d+)?)(?:\s*km?)?', resp.text)
        if m:
            try:
                afstand = float(m.group(1).replace(',', '.'))
            except ValueError:
                pass
    if hoogtemeters is None:
        m = re.search(r'[Vv]ert(?:ical)?\s*[Mm]eters?[:\s]{0,5}([\d,]+)', resp.text)
        if m:
            try:
                hoogtemeters = int(m.group(1).replace(',', ''))
            except ValueError:
                pass

    map_url = None
    for img in soup.find_all('img'):
        src = img.get('src', '') or img.get('data-src', '')
        if not src:
            continue
        filename = src.split('/')[-1].lower()
        if not src.startswith('http'):
            src = 'https://www.procyclingstats.com/' + src.lstrip('/')
        if 'profile' in filename:
            profiel_url = src
            break
        elif 'map' in filename and not map_url:
            map_url = src
    if not profiel_url and map_url:
        profiel_url = map_url

    conn.execute(
        "UPDATE koersen SET afstand=?, hoogtemeters=?, profiel_url=? WHERE id=?",
        (afstand, hoogtemeters, profiel_url, kid)
    )
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "afstand": afstand,
        "hoogtemeters": hoogtemeters,
        "profiel_url": profiel_url,
    })


# ── API: Favorieten ophalen van PCS ───────────────────────────────────────────

def _get_pcs_favorieten(slug, year):
    scraper = cloudscraper.create_scraper()
    pcs_headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"}
    url = f"https://www.procyclingstats.com/race/{slug}/{year}/live"
    try:
        resp = scraper.get(url, headers=pcs_headers, timeout=15)
    except Exception:
        return []
    if resp.status_code != 200:
        return []
    soup = BeautifulSoup(resp.text, 'html.parser')
    namen = []
    for ul in soup.find_all('ul', class_=True):
        classes = ul.get('class', [])
        if 'fs14' in classes and 'keyvalueList' not in classes:
            for li in ul.find_all('li'):
                naam = li.get_text(strip=True)
                if naam and len(naam) > 3:
                    namen.append(naam)
            if namen:
                break
    return namen[:15]


@app.route("/api/koersen/<int:kid>/favorieten")
def get_koers_favorieten(kid):
    conn = get_db()
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify([])

    try:
        raw = koers['favorieten_json']
    except (IndexError, KeyError):
        conn.close()
        return jsonify([])
    if not raw:
        conn.close()
        return jsonify([])

    try:
        namen = json.loads(raw)
    except (ValueError, TypeError):
        conn.close()
        return jsonify([])

    uid = current_user_id()
    ploeg = conn.execute(
        "SELECT r.naam FROM mijn_ploeg m JOIN renners r ON r.id = m.renner_id WHERE m.user_id=?", (uid,)
    ).fetchall()
    opstelling = conn.execute(
        "SELECT r.naam FROM opstelling o JOIN renners r ON r.id = o.renner_id WHERE o.koers_id=? AND o.user_id=?",
        (kid, uid)
    ).fetchall()
    alias_map = _get_alias_map(conn)
    conn.close()

    ploeg_namen     = [r['naam'] for r in ploeg]
    opstelling_namen = [r['naam'] for r in opstelling]

    resultaat = []
    for naam in namen:
        in_ploeg = any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in ploeg_namen)
        in_ops   = any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in opstelling_namen)
        resultaat.append({"naam": naam, "inPloeg": in_ploeg, "inOpstelling": in_ops})
    return jsonify(resultaat)


@app.route("/api/koersen/<int:kid>/fetch-favorieten", methods=["POST"])
def fetch_koers_favorieten(kid):
    conn = get_db()
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify({"error": "Koers niet gevonden"}), 404

    slug = koers['pcs_slug']
    if not slug:
        conn.close()
        return jsonify({"error": f"Geen PCS-koppeling voor '{koers['naam']}'"}), 404

    year = koers['datum'][:4]
    namen = _get_pcs_favorieten(slug, year)

    if not namen:
        conn.close()
        return jsonify({"error": "Geen favorieten gevonden op PCS (koers mogelijk nog niet gepubliceerd)."}), 404

    conn.execute(
        "UPDATE koersen SET favorieten_json=? WHERE id=?",
        (json.dumps(namen, ensure_ascii=False), kid)
    )
    conn.commit()

    uid = current_user_id()
    ploeg = conn.execute(
        "SELECT r.naam FROM mijn_ploeg m JOIN renners r ON r.id = m.renner_id WHERE m.user_id=?", (uid,)
    ).fetchall()
    opstelling = conn.execute(
        "SELECT r.naam FROM opstelling o JOIN renners r ON r.id = o.renner_id WHERE o.koers_id=? AND o.user_id=?",
        (kid, uid)
    ).fetchall()
    alias_map = _get_alias_map(conn)
    conn.close()

    ploeg_namen      = [r['naam'] for r in ploeg]
    opstelling_namen = [r['naam'] for r in opstelling]

    resultaat = []
    for naam in namen:
        in_ploeg = any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in ploeg_namen)
        in_ops   = any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in opstelling_namen)
        resultaat.append({"naam": naam, "inPloeg": in_ploeg, "inOpstelling": in_ops})

    return jsonify({"ok": True, "favorieten": resultaat, "aantal": len(resultaat)})


# ── API: Beste opstelling achteraf ────────────────────────────────────────────

@app.route("/api/koersen/<int:kid>/beste-opstelling")
def beste_opstelling(kid):
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    inst = _get_inst(conn, uid, sid=sid)
    max_opstelling = int(inst.get("max_starters", 12))

    resultaten = conn.execute("""
        SELECT re.id, re.naam, re.ploeg as renner_ploeg, re.rol, re.prijs, re.foto,
               COALESCE(r.punten, 0) as punten,
               COALESCE(r.bonuspunten_kopman, 0) as bonuspunten_kopman,
               r.positie,
               CASE WHEN o.renner_id IS NOT NULL THEN 1 ELSE 0 END as in_opstelling
        FROM mijn_ploeg m
        JOIN renners re ON re.id = m.renner_id
        LEFT JOIN resultaten r ON r.renner_id = re.id AND r.koers_id = ? AND r.user_id = ?
        LEFT JOIN opstelling o ON o.renner_id = re.id AND o.koers_id = ? AND o.user_id = ?
        WHERE m.user_id = ? AND m.seizoen_id = ?
        ORDER BY COALESCE(r.punten, 0) DESC, re.prijs DESC
    """, (kid, uid, kid, uid, uid, sid)).fetchall()
    conn.close()

    alle = [dict(r) for r in resultaten]
    beste = alle[:max_opstelling]
    beste_punten = sum(r["punten"] for r in beste)

    return jsonify({
        "max": max_opstelling,
        "beste": beste,
        "beste_punten": beste_punten,
    })


# ── API: Resultaten ────────────────────────────────────────────────────────────

@app.route("/api/koersen/<int:kid>/resultaten")
def get_resultaten(kid):
    uid = current_user_id()
    conn = get_db()
    resultaten = conn.execute("""
        SELECT r.*, re.naam, re.ploeg as renner_ploeg, re.rol, re.prijs, re.foto,
               CASE WHEN m.renner_id IS NOT NULL THEN 1 ELSE 0 END as in_mijn_ploeg,
               CASE WHEN o.renner_id IS NOT NULL THEN 1 ELSE 0 END as in_opstelling,
               COALESCE(o.is_kopman, 0) as is_kopman
        FROM resultaten r
        JOIN renners re ON re.id = r.renner_id
        LEFT JOIN mijn_ploeg m ON m.renner_id = r.renner_id AND m.user_id = ?
        LEFT JOIN opstelling o ON o.renner_id = r.renner_id AND o.koers_id = r.koers_id AND o.user_id = ?
        WHERE r.koers_id = ? AND r.user_id = ?
        ORDER BY r.positie ASC NULLS LAST, r.punten DESC
    """, (uid, uid, kid, uid)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in resultaten])


def _zoek_of_maak_winnaar(conn, winnaar_naam, winnaar_ploeg=''):
    alle_renners = conn.execute("SELECT id, naam FROM renners").fetchall()
    for r in alle_renners:
        if _name_match(winnaar_naam, {_norm(r['naam'])}):
            return r['id']

    app.logger.info(f"Winnaar '{winnaar_naam}' niet gevonden, wordt aangemaakt.")
    foto = _fetch_foto_wikipedia(winnaar_naam) or _fetch_foto_pcs(winnaar_naam)
    cur = conn.execute(
        "INSERT INTO renners (naam, ploeg, rol, prijs, actief, foto) VALUES (?,?,?,?,0,?)",
        (winnaar_naam, winnaar_ploeg or '—', 'allrounder', 0.0, foto)
    )
    conn.commit()
    new_id = cur.lastrowid
    app.logger.info(f"Winnaar aangemaakt: id={new_id}, naam={winnaar_naam}, foto={'ja' if foto else 'nee'}")
    return new_id


@app.route("/api/koersen/<int:kid>/resultaten/bulk", methods=["POST"])
def add_resultaten_bulk(kid):
    payload = request.json
    if isinstance(payload, list):
        data = payload
        winnaar_naam = None
        winnaar_ploeg = ''
    else:
        data = payload.get('renners', [])
        winnaar_naam = (payload.get('winnaar_naam') or '').strip()
        winnaar_ploeg = (payload.get('winnaar_ploeg') or '').strip()

    uid = current_user_id()
    conn = get_db()

    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify({"error": "Koers niet gevonden"}), 404

    soort = koers["soort"]

    opstelling_rows = conn.execute(
        "SELECT renner_id, is_kopman FROM opstelling WHERE koers_id=? AND user_id=?", (kid, uid)
    ).fetchall()
    opstelling_ids = {r["renner_id"] for r in opstelling_rows}
    kopman_id = next((r["renner_id"] for r in opstelling_rows if r["is_kopman"]), None)

    try:
        for r in data:
            rid = r["renner_id"]
            pos = r.get("positie")

            if rid in opstelling_ids or not opstelling_ids:
                punten_basis = punten_voor_positie(soort, pos) if pos else 0
                bonus_kopman = kopman_bonus(pos) if rid == kopman_id and pos else 0
                bonus_ploegmaat = 10 if r.get("is_ploegmaat_winnaar") else 0
            else:
                punten_basis = 0
                bonus_kopman = 0
                bonus_ploegmaat = 0

            totaal = punten_basis + bonus_kopman + bonus_ploegmaat

            conn.execute("""
                INSERT OR REPLACE INTO resultaten
                  (koers_id, renner_id, user_id, positie, punten, bonuspunten_kopman, bonuspunten_ploegmaat)
                VALUES (?,?,?,?,?,?,?)
            """, (kid, rid, uid, pos, totaal, bonus_kopman, bonus_ploegmaat))

        for r in data:
            conn.execute("""
                UPDATE renners SET totaal_punten = (
                    SELECT COALESCE(SUM(punten), 0)
                    FROM resultaten WHERE renner_id = ?
                ) WHERE id = ?
            """, (r["renner_id"], r["renner_id"]))

        conn.execute("UPDATE koersen SET afgelopen=1 WHERE id=?", (kid,))
        conn.commit()
    except Exception as e:
        conn.close()
        return jsonify({"error": str(e)}), 400

    if winnaar_naam:
        try:
            winnaar_id = _zoek_of_maak_winnaar(conn, winnaar_naam, winnaar_ploeg)
            if winnaar_id:
                conn.execute("UPDATE koersen SET winnaar_id=? WHERE id=?", (winnaar_id, kid))
                conn.commit()
        except Exception as e:
            app.logger.warning(f"Kon winnaar niet opslaan: {e}")

    conn.close()
    return jsonify({"ok": True})


# ── API: Sporza WM sessie ──────────────────────────────────────────────────────

@app.route("/api/sporza-session", methods=["GET"])
def get_sporza_session():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    for sleutel_base in ('sporza_cookie_vt', 'sporza_cookie_rt', 'sporza_cookie'):
        sleutel = f"{sleutel_base}_{uid}"
        row = conn.execute(
            "SELECT waarde FROM instellingen WHERE sleutel=?", (sleutel,)
        ).fetchone()
        if not row:
            row = conn.execute(
                "SELECT waarde FROM instellingen WHERE sleutel=?", (sleutel_base,)
            ).fetchone()
        if row and row['waarde'] and not _sanitize_cookie(row['waarde']):
            conn.execute(
                "UPDATE instellingen SET waarde='' WHERE sleutel=?", (sleutel,)
            )
            conn.commit()
    at = _get_sporza_at(conn)
    vt = _get_user_inst_val(conn, 'sporza_cookie_vt', sid=sid)
    rt = _get_user_inst_val(conn, 'sporza_cookie_rt', sid=sid)
    conn.close()
    verlopen = _jwt_verlopen(at) if at else False
    return jsonify({
        "configured": bool(at),
        "vt_configured": bool(vt),
        "rt_configured": bool(rt),
        "verlopen": verlopen,
    })


def _sanitize_cookie(val):
    if not val:
        return ''
    ascii_val = val.encode('ascii', errors='ignore').decode('ascii').strip()
    if all(c == '\x95' or c == chr(8226) for c in val.strip()):
        return ''
    return ascii_val


@app.route("/api/sporza-session", methods=["POST"])
def set_sporza_session():
    data = request.json or {}
    cookie    = _sanitize_cookie(data.get("cookie", ""))
    cookie_vt = _sanitize_cookie(data.get("cookie_vt", ""))
    cookie_rt = _sanitize_cookie(data.get("cookie_rt", ""))
    if not cookie and not cookie_rt:
        return jsonify({"error": "Geen cookie opgegeven"}), 400
    conn = get_db()
    sid = current_seizoen_id(conn)
    if cookie:
        _set_user_inst_val(conn, 'sporza_cookie', cookie, sid=sid)
    if cookie_vt:
        _set_user_inst_val(conn, 'sporza_cookie_vt', cookie_vt, sid=sid)
    if cookie_rt:
        _set_user_inst_val(conn, 'sporza_cookie_rt', cookie_rt, sid=sid)
    conn.commit()
    if cookie_rt and not cookie:
        new_at = _refresh_sporza_at(conn)
        conn.close()
        if new_at:
            return jsonify({"ok": True, "auto_refreshed": True})
        return jsonify({"error": "RT opgeslagen maar AT-refresh mislukt. Geef ook de AT op."}), 400
    conn.close()
    return jsonify({"ok": True})


# ── API: Sporza WM mini-competities ───────────────────────────────────────────

def _jwt_verlopen(token):
    import base64, time
    try:
        payload_b64 = token.split('.')[1]
        payload_b64 += '=' * (-len(payload_b64) % 4)
        payload = json.loads(base64.b64decode(payload_b64).decode('utf-8'))
        return payload.get('exp', 0) < time.time()
    except Exception:
        return False


def _refresh_sporza_at(conn, sid=None):
    """Vernieuw de Sporza AT via de opgeslagen RT cookie.
    Geeft de nieuwe AT-waarde terug, of None als refresh mislukt.

    Probeert meerdere varianten: met/zonder expired AT, GET/POST, cloudscraper/requests.
    """
    if sid is None: sid = current_seizoen_id(conn)
    rt = (_get_user_inst_val(conn, 'sporza_cookie_rt', sid=sid) or '').strip()
    if not rt:
        app.logger.warning("_refresh_sporza_at: geen RT opgeslagen")
        return None

    # Haal ook de (mogelijk verlopen) AT op — sommige SSO's vereisen beide cookies
    at_oud = (_get_user_inst_val(conn, 'sporza_cookie', sid=sid) or '').strip()

    app.logger.info(
        f"_refresh_sporza_at: RT lengte={len(rt)}, begin={rt[:12]}… | "
        f"AT_oud aanwezig={bool(at_oud)}, lengte={len(at_oud)}"
    )

    def _extract_at(resp):
        """Haal AT uit cookies of Set-Cookie header van een response."""
        new_at = resp.cookies.get('sporza-site_profile_at') or ''
        if not new_at:
            raw_hdrs = getattr(resp.raw, 'headers', None)
            if raw_hdrs:
                set_cookie_vals = raw_hdrs.getlist('Set-Cookie') if hasattr(raw_hdrs, 'getlist') else [
                    v for k, v in raw_hdrs.items() if k.lower() == 'set-cookie'
                ]
                for hdr in set_cookie_vals:
                    if 'sporza-site_profile_at=' in hdr:
                        val = hdr.split('sporza-site_profile_at=')[1].split(';')[0].strip()
                        if val and val != 'deleted':
                            new_at = val
                            break
        return new_at or ''

    common_headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8',
        'Origin': 'https://sporza.be',
        'Referer': 'https://sporza.be/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
    }

    # Cookie-combinaties om te proberen: RT alleen, RT+AT samen
    cookie_rt_only    = f'sporza-site_profile_rt={rt}'
    cookie_rt_plus_at = f'sporza-site_profile_rt={rt}; sporza-site_profile_at={at_oud}' if at_oud else cookie_rt_only

    # (library, method, cookie_string)
    pogingen = [
        ('cloudscraper', 'GET',  cookie_rt_plus_at),   # RT + verlopen AT samen
        ('cloudscraper', 'GET',  cookie_rt_only),       # alleen RT
        ('cloudscraper', 'POST', cookie_rt_plus_at),
        ('cloudscraper', 'POST', cookie_rt_only),
        ('requests',     'GET',  cookie_rt_plus_at),
        ('requests',     'GET',  cookie_rt_only),
    ]

    last_status = None
    for lib, method, cookie_str in pogingen:
        try:
            headers = {**common_headers, 'Cookie': cookie_str}
            if lib == 'cloudscraper':
                scraper = cloudscraper.create_scraper()
                fn = scraper.get if method == 'GET' else scraper.post
                resp = fn('https://sporza.be/sso/refresh', headers=headers, timeout=15, allow_redirects=True)
            else:
                import requests as _req
                fn = _req.get if method == 'GET' else _req.post
                resp = fn('https://sporza.be/sso/refresh', headers=headers, timeout=15, allow_redirects=True)

            last_status = resp.status_code
            app.logger.info(
                f"_refresh_sporza_at [{lib} {method} cookie={cookie_str[:30]}…]: "
                f"HTTP {resp.status_code}, body={resp.text[:150]}, "
                f"cookies={list(resp.cookies.keys())}"
            )

            new_at = _extract_at(resp)
            if new_at and new_at != 'deleted':
                _set_user_inst_val(conn, 'sporza_cookie', new_at, sid=sid)
                conn.commit()
                app.logger.info(f"_refresh_sporza_at: nieuwe AT opgeslagen ✅ via [{lib} {method}]")
                return new_at

        except Exception as e:
            app.logger.error(f"_refresh_sporza_at [{lib} {method}]: fout: {e}")

    app.logger.warning(
        f"_refresh_sporza_at: alle pogingen mislukt (laatste HTTP {last_status}). "
        "RT vernieuwen in Instellingen of opnieuw inloggen op sporza.be."
    )
    return None


def _get_sporza_at(conn, sid=None):
    if sid is None: sid = current_seizoen_id(conn)
    at = (_get_user_inst_val(conn, 'sporza_cookie', sid=sid) or '').strip()
    if (not at) or _jwt_verlopen(at):
        new_at = _refresh_sporza_at(conn, sid=sid)
        if new_at:
            at = new_at
    return at


def _rsc_decode(node, arr, depth=0):
    if depth > 50:
        return node
    if isinstance(node, (str, int, float, bool)) or node is None:
        return node
    if isinstance(node, dict):
        result = {}
        for k, v in node.items():
            real_key = _rsc_decode(arr[int(k[1:])], arr, depth + 1) if k.startswith("_") else k
            real_val = _rsc_decode(arr[v], arr, depth + 1) if isinstance(v, int) else _rsc_decode(v, arr, depth + 1)
            if real_key is not None:
                result[real_key] = real_val
        return result
    if isinstance(node, list):
        return [
            _rsc_decode(arr[item] if isinstance(item, int) else item, arr, depth + 1)
            for item in node
        ]
    return node


def _rsc_find(obj, target, depth=0):
    if depth > 20 or obj is None:
        return None
    if isinstance(obj, dict):
        if target in obj:
            return obj[target]
        for v in obj.values():
            r = _rsc_find(v, target, depth + 1)
            if r is not None:
                return r
    if isinstance(obj, list):
        for item in obj:
            r = _rsc_find(item, target, depth + 1)
            if r is not None:
                return r
    return None


def _find_lineup_with_riders(obj, depth=0):
    if depth > 15 or obj is None:
        return None
    if isinstance(obj, dict):
        if "riders" in obj and "score" in obj:
            return obj
        for v in obj.values():
            r = _find_lineup_with_riders(v, depth + 1)
            if r is not None:
                return r
    if isinstance(obj, list):
        for item in obj:
            r = _find_lineup_with_riders(item, depth + 1)
            if r is not None:
                return r
    return None


@app.route("/api/sporza-mini", methods=["GET"])
def sporza_mini_competities():
    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)
    cookie_at = _get_sporza_at(conn, sid=sid)
    conn.close()

    if not cookie_at:
        return jsonify({"error": "Sporza cookie niet ingesteld. Ga naar Instellingen."}), 400

    if _jwt_verlopen(cookie_at):
        return jsonify({"error": "Sporza sessie verlopen. Vernieuw je cookie via Instellingen.", "verlopen": True}), 401

    headers = {
        "Cookie": f"sporza-site_profile_at={cookie_at}",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "*/*",
    }

    try:
        resp = _requests.get(
            f"{SPORZA_BASE}/{edition}/competitions.data",
            headers=headers, timeout=20
        )
    except Exception as e:
        return jsonify({"error": f"Netwerkfout: {str(e)}"}), 503

    if resp.status_code in (401, 403):
        return jsonify({"error": "Sporza sessie verlopen. Vernieuw je cookie.", "verlopen": True}), 401
    if resp.status_code != 200:
        return jsonify({"error": f"Sporza WM fout (HTTP {resp.status_code})."}), 502

    try:
        arr = resp.json()
        decoded = _rsc_decode(arr[0], arr)
    except Exception as e:
        return jsonify({"error": f"Kan Sporza-data niet verwerken: {str(e)}"}), 503

    mijn_comps = _rsc_find(decoded, "miniCompetitions") or []

    resultaat = []
    for comp in mijn_comps:
        slug = comp.get("slug", "")
        top  = comp.get("topRankings") or []

        eigen_user_id = next(
            (m.get("userId") for m in top if m.get("isMyTeam")), None
        )

        klassement = []
        if slug:
            try:
                det = _requests.get(
                    f"{SPORZA_BASE}/{edition}/competitions/{slug}.data",
                    headers=headers, timeout=15
                )
                if det.status_code == 200:
                    det_arr = det.json()
                    det_decoded = _rsc_decode(det_arr[0], det_arr)
                    members = _rsc_find(det_decoded, "members") or []
                    for m in members:
                        is_eigen = (m.get("userId") == eigen_user_id) if eigen_user_id else False
                        klassement.append({
                            "rank":      m.get("rank", 0),
                            "teamNaam":  m.get("teamName", ""),
                            "gebruiker": m.get("userName", ""),
                            "punten":    m.get("points", 0),
                            "teamCode":  m.get("teamCode", ""),
                            "isEigen":   is_eigen,
                        })
            except Exception:
                pass

        if not klassement:
            klassement = [
                {
                    "rank":      m.get("rank", 0),
                    "teamNaam":  m.get("teamName", ""),
                    "gebruiker": m.get("userName", ""),
                    "punten":    m.get("points", 0),
                    "teamCode":  m.get("teamCode", ""),
                    "isEigen":   m.get("isMyTeam", False),
                }
                for m in top
            ]

        resultaat.append({
            "naam":            comp.get("name", ""),
            "slug":            slug,
            "aantalDeelnemers": comp.get("memberCount", 0),
            "klassement":      klassement,
        })

    return jsonify({"minicompetities": resultaat})


@app.route("/api/sporza-mini/team/<slug>/<team_code>", methods=["GET"])
def sporza_mini_team(slug, team_code):
    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)
    cookie_at = _get_sporza_at(conn, sid=sid)
    conn.close()

    if not cookie_at:
        return jsonify({"error": "Sporza cookie niet ingesteld."}), 400

    if _jwt_verlopen(cookie_at):
        return jsonify({"error": "Sporza sessie verlopen."}), 401

    headers = {
        "Cookie": f"sporza-site_profile_at={cookie_at}",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        "Accept": "*/*",
    }

    try:
        resp = _requests.get(
            f"{SPORZA_BASE}/{edition}/competitions/{slug}/team/{team_code}.data",
            headers=headers, timeout=15
        )
    except Exception as e:
        return jsonify({"error": f"Netwerkfout: {str(e)}"}), 503

    if resp.status_code in (401, 403):
        return jsonify({"error": "Sporza sessie verlopen."}), 401
    if resp.status_code != 200:
        return jsonify({"error": f"Sporza WM fout (HTTP {resp.status_code})."}), 502

    try:
        arr = resp.json()
        decoded = _rsc_decode(arr[0], arr)
    except Exception as e:
        return jsonify({"error": f"Kan ploegdata niet verwerken: {str(e)}"}), 503

    lineup = _find_lineup_with_riders(decoded)
    if not lineup:
        return jsonify({"error": "Geen ploegdata gevonden."}), 404

    riders = lineup.get("riders") or []
    total_score = (lineup.get("score") or {}).get("overallScore", 0)

    try:
        cyl_resp = _requests.get(
            f"{SPORZA_BASE}/api/{edition}/cyclists",
            headers=headers, timeout=15
        )
        cyclist_punten = {}
        if cyl_resp.status_code == 200:
            for c in cyl_resp.json().get("cyclists", []):
                cyclist_punten[c["id"]] = c.get("totalBasePoints", 0)
    except Exception:
        cyclist_punten = {}

    eigen_roster = _rsc_find(decoded, "roster") or []
    eigen_ids = {r.get("id") for r in eigen_roster if isinstance(r, dict) and r.get("id")}

    renners = []
    for r in riders:
        rid = r.get("id")
        renners.append({
            "naam":         r.get("fullName", ""),
            "ploeg":        (r.get("team") or {}).get("shortName", ""),
            "prijs":        r.get("price", 0),
            "punten":       cyclist_punten.get(rid, 0),
            "lineupType":   r.get("lineupType", ""),
            "inEigenPloeg": rid in eigen_ids,
        })
    renners.sort(key=lambda x: (0 if x["lineupType"] == "CAPTAIN" else 1 if x["lineupType"] == "SUBSTITUTE" else 2, -x["punten"]))

    return jsonify({"renners": renners, "totalScore": total_score})


@app.route("/api/sporza-mini/transfers", methods=["GET"])
def sporza_mini_transfer_tips():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)

    eigen_ploeg = conn.execute("""
        SELECT r.id, r.naam, r.prijs, r.totaal_punten,
               COALESCE(m.aangeschaft_prijs, r.prijs) as aangeschaft_prijs
        FROM mijn_ploeg m JOIN renners r ON r.id = m.renner_id
        WHERE m.user_id = ? AND m.seizoen_id = ?
    """, (uid, sid)).fetchall()
    eigen_lijst = [dict(r) for r in eigen_ploeg]
    eigen_namen_norm = {_norm(r["naam"]) for r in eigen_lijst}

    inst = _get_inst(conn, uid, sid=sid)
    budget = float(inst.get("budget", 100.0))
    uitgegeven = sum(r["aangeschaft_prijs"] for r in eigen_ploeg)
    budget_rest = round(budget - uitgegeven, 2)

    alle_renners_list = [dict(r) for r in conn.execute(
        "SELECT id, naam, prijs FROM renners WHERE actief=1 AND seizoen_id=?", (sid,)
    ).fetchall()]

    cookie_at = _get_sporza_at(conn, sid=sid)
    conn.close()

    if not cookie_at:
        return jsonify([])
    if _jwt_verlopen(cookie_at):
        return jsonify([])

    headers = {
        "Cookie": f"sporza-site_profile_at={cookie_at}",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        "Accept": "*/*",
    }

    try:
        cyl_resp = _requests.get(
            f"{SPORZA_BASE}/api/{edition}/cyclists", headers=headers, timeout=15
        )
        cyclist_punten = (
            {c["id"]: c.get("totalBasePoints", 0) for c in cyl_resp.json().get("cyclists", [])}
            if cyl_resp.status_code == 200 else {}
        )
    except Exception:
        cyclist_punten = {}

    try:
        resp = _requests.get(
            f"{SPORZA_BASE}/{edition}/competitions.data", headers=headers, timeout=20
        )
        if resp.status_code != 200:
            return jsonify([])
        arr = resp.json()
        decoded = _rsc_decode(arr[0], arr)
        mijn_comps = _rsc_find(decoded, "miniCompetitions") or []
    except Exception:
        return jsonify([])

    alle_suggesties = []

    for comp in mijn_comps[:1]:
        slug = comp.get("slug", "")
        top = comp.get("topRankings") or []
        eigen_user_id = next((m.get("userId") for m in top if m.get("isMyTeam")), None)

        try:
            det = _requests.get(
                f"{SPORZA_BASE}/{edition}/competitions/{slug}.data",
                headers=headers, timeout=15
            )
            if det.status_code != 200:
                continue
            det_arr = det.json()
            det_decoded = _rsc_decode(det_arr[0], det_arr)
            members = _rsc_find(det_decoded, "members") or []
        except Exception:
            continue

        eigen_lid = next((m for m in members if m.get("userId") == eigen_user_id), None)
        eigen_punten = eigen_lid.get("points", 0) if eigen_lid else 0

        renner_kandidaten = {}

        for member in sorted(members, key=lambda x: x.get("rank", 999)):
            if member.get("userId") == eigen_user_id:
                continue
            if member.get("rank", 999) > 5:
                continue
            team_code = member.get("teamCode", "")
            if not team_code:
                continue
            try:
                t_resp = _requests.get(
                    f"{SPORZA_BASE}/{edition}/competitions/{slug}/team/{team_code}.data",
                    headers=headers, timeout=15
                )
                if t_resp.status_code != 200:
                    continue
                t_arr = t_resp.json()
                t_decoded = _rsc_decode(t_arr[0], t_arr)
                lineup = _find_lineup_with_riders(t_decoded)
                if not lineup:
                    continue
                riders = lineup.get("riders") or []
            except Exception:
                continue

            achterstand = member.get("points", 0) - eigen_punten

            for r in riders:
                naam = r.get("fullName", "")
                rid = r.get("id")
                if not naam:
                    continue
                if _name_match(naam, eigen_namen_norm):
                    continue
                punten = cyclist_punten.get(rid, 0) if rid else 0
                naam_norm = _norm(naam)
                if naam_norm not in renner_kandidaten or punten > renner_kandidaten[naam_norm]["punten"]:
                    renner_kandidaten[naam_norm] = {
                        "naam": naam,
                        "ploeg": (r.get("team") or {}).get("shortName", ""),
                        "prijs": r.get("price", 0),
                        "punten": punten,
                        "concurrent": member.get("userName", ""),
                        "concurrent_rank": member.get("rank", 0),
                        "achterstand": achterstand,
                    }

        for kandidaat in renner_kandidaten.values():
            lokale_match = None
            for r in alle_renners_list:
                if _name_match(r["naam"], {_norm(kandidaat["naam"])}):
                    lokale_match = r
                    break
            kandidaat["lokale_id"] = lokale_match["id"] if lokale_match else None

        eigen_gesorteerd = sorted(eigen_lijst, key=lambda x: x["totaal_punten"])

        for kandidaat in sorted(renner_kandidaten.values(), key=lambda x: -x["punten"]):
            prijs_in = kandidaat["prijs"]
            for eigen_r in eigen_gesorteerd:
                prijs_uit = eigen_r["prijs"]
                if budget_rest + (prijs_uit - prijs_in) >= 0:
                    alle_suggesties.append({
                        "renner_uit": {
                            "naam": eigen_r["naam"],
                            "prijs": prijs_uit,
                            "punten": eigen_r["totaal_punten"],
                        },
                        "renner_in": {
                            "naam": kandidaat["naam"],
                            "ploeg": kandidaat["ploeg"],
                            "prijs": prijs_in,
                            "punten": kandidaat["punten"],
                            "lokale_id": kandidaat["lokale_id"],
                        },
                        "punt_winst": kandidaat["punten"] - eigen_r["totaal_punten"],
                        "concurrent": kandidaat["concurrent"],
                        "concurrent_rank": kandidaat["concurrent_rank"],
                        "achterstand": kandidaat["achterstand"],
                        "budget_delta": round(prijs_uit - prijs_in, 2),
                    })
                    break

    alle_suggesties.sort(key=lambda x: -x["punt_winst"])
    return jsonify(alle_suggesties[:10])


@app.route("/api/koersen/<int:kid>/doorzetten-sporza", methods=["POST"])
def doorzetten_sporza(kid):
    import traceback
    try:
        return _doorzetten_sporza_impl(kid)
    except UnicodeEncodeError as e:
        tb = traceback.format_exc()
        print(f"[UNICODE ERROR] {e}\n{tb}", flush=True)
        return make_response(
            '{"error":"Encoding fout - zie Railway logs","detail":"' +
            repr(str(e)).replace('"', "'") + '"}',
            500,
            {'Content-Type': 'application/json; charset=utf-8'}
        )
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[DOORZETTEN CRASH] {e}\n{tb}", flush=True)
        return jsonify({
            "error": f"Server-fout bij doorzetten: {str(e)[:200]}",
            "traceback": tb[:500]
        }), 500


def _doorzetten_sporza_impl(kid):
    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify({"error": "Koers niet gevonden"}), 404

    match_id = koers.get('sporza_match_id')
    if not match_id:
        conn.close()
        return jsonify({"error": f"Geen Sporza WM koppeling voor '{koers['naam']}'"}), 404

    uid = current_user_id()
    opstelling_rows = conn.execute(
        "SELECT renner_id, is_kopman FROM opstelling WHERE koers_id=? AND user_id=?", (kid, uid)
    ).fetchall()
    opstelling_ids = {r["renner_id"] for r in opstelling_rows}
    kopman_id = next((r["renner_id"] for r in opstelling_rows if r["is_kopman"]), None)

    if len(opstelling_ids) < 12:
        conn.close()
        return jsonify({"error": f"Opstelling bevat slechts {len(opstelling_ids)} renners. Minstens 12 nodig."}), 400

    mijn_ploeg = conn.execute("""
        SELECT r.id, r.naam FROM mijn_ploeg m JOIN renners r ON r.id = m.renner_id
        WHERE m.user_id = ? AND m.seizoen_id = ?
    """, (uid, sid)).fetchall()

    sporza_cookie = _get_sporza_at(conn, sid=sid)
    sporza_cookie_vt_val = (_get_user_inst_val(conn, 'sporza_cookie_vt', sid=sid) or '').strip()
    conn.close()

    if not sporza_cookie:
        return jsonify({"error": "Sporza WM sessie niet ingesteld. Stel eerst je cookie in."}), 401

    if _jwt_verlopen(sporza_cookie):
        return jsonify({"error": "Sporza sessie verlopen. Stel je cookie opnieuw in via Instellingen.", "verlopen": True}), 401

    sporza_cookie_vt = sporza_cookie_vt_val

    def _base_headers(content_type=None):
        h = {
            "Origin": SPORZA_BASE,
            "Referer": f"{SPORZA_BASE}/{edition}/team",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
        if content_type:
            h["Content-Type"] = content_type
        return h

    scraper = cloudscraper.create_scraper()
    scraper.cookies.set('sporza-site_profile_at', sporza_cookie,
                        domain='wielermanager.sporza.be', path='/')
    if sporza_cookie_vt:
        scraper.cookies.set('sporza-site_profile_vt', sporza_cookie_vt,
                            domain='wielermanager.sporza.be', path='/')

    try:
        scraper.get(
            f"{SPORZA_BASE}/{edition}/team",
            headers={**_base_headers(), "Accept": "text/html,application/xhtml+xml,*/*;q=0.9"},
            timeout=15,
        )
    except Exception:
        pass

    sporza_riders = {}
    bron_label_riders = "onbekend"

    team_data_url = f"{SPORZA_BASE}/{edition}/team.data"
    wm_match_id = None
    try:
        team_resp = scraper.get(team_data_url, headers=_base_headers(), timeout=20)
        if team_resp.status_code in (401, 403):
            return jsonify({"error": "Sessie verlopen. Stel je Sporza WM cookie opnieuw in."}), 401
        if team_resp.status_code == 200:
            sporza_riders = _parse_sporza_riders(team_resp.text)
            bron_label_riders = "team.data"
            wm_match_id = _find_wm_match_id(team_resp.text, match_id)
    except Exception:
        pass

    if not sporza_riders:
        cyclists_url = f"{SPORZA_BASE}/api/{edition}/cyclists"
        try:
            cyl_resp = scraper.get(cyclists_url, headers=_base_headers(), timeout=20)
            if cyl_resp.status_code in (401, 403):
                return jsonify({"error": "Sessie verlopen. Stel je Sporza WM cookie opnieuw in."}), 401
            if cyl_resp.status_code == 200:
                cyclists_data = cyl_resp.json().get('cyclists', [])
                sporza_riders = {c['id']: c['fullName'] for c in cyclists_data if c.get('fullName')}
                bron_label_riders = "cyclists API"
        except Exception as e:
            return jsonify({"error": f"Netwerkfout bij ophalen renners: {str(e)}"}), 503

    if not sporza_riders:
        return jsonify({"error": "Kon geen renners vinden in Sporza WM. Controleer je cookie."}), 503

    naam_to_id = {_norm(naam): sporza_id for sporza_id, naam in sporza_riders.items()}

    def _sporza_match(db_naam, sporza_naam_norm):
        if _name_match(db_naam, {sporza_naam_norm}):
            return True
        db_norm = _norm(db_naam)
        db_tokens = [t for t in db_norm.split() if t not in _PARTICLES]
        if not db_tokens:
            return False
        db_surname = db_tokens[-1]
        sp_tokens = [t for t in sporza_naam_norm.split() if t not in _PARTICLES]
        if not sp_tokens:
            return False
        sp_surname = sp_tokens[-1]
        if db_surname != sp_surname:
            return False
        db_first = db_tokens[0]
        sp_first = sp_tokens[0]
        initials = [c for c in db_first if c.isalpha()]
        if initials and sp_first.startswith(initials[0]):
            return True
        return False

    lineup = []
    niet_gevonden = []
    for r in mijn_ploeg:
        norm_naam = _norm(r["naam"])
        sporza_id = naam_to_id.get(norm_naam)
        if not sporza_id:
            for snaam, snorm in [(naam, _norm(naam)) for naam in sporza_riders.values()]:
                if _sporza_match(r["naam"], snorm):
                    sporza_id = next(k for k, v in sporza_riders.items() if _norm(v) == snorm)
                    break
        if not sporza_id:
            niet_gevonden.append(r["naam"])
            continue
        if r["id"] == kopman_id and r["id"] in opstelling_ids:
            lineup.append({"id": sporza_id, "lineupType": "CAPTAIN"})
        elif r["id"] in opstelling_ids:
            lineup.append({"id": sporza_id, "lineupType": "NORMAL"})
        else:
            lineup.append({"id": sporza_id, "lineupType": "SUBSTITUTE"})

    if niet_gevonden:
        return jsonify({
            "error": f"Kon volgende renners niet koppelen aan Sporza WM: {', '.join(niet_gevonden)}"
        }), 400

    captains = [x for x in lineup if x["lineupType"] == "CAPTAIN"]
    normals   = [x for x in lineup if x["lineupType"] == "NORMAL"]
    subs      = [x for x in lineup if x["lineupType"] == "SUBSTITUTE"]

    if len(captains) != 1 or len(normals) != 11 or len(subs) != 8:
        return jsonify({
            "error": f"Ongeldige lineup: {len(captains)} captain(s), {len(normals)} normal, {len(subs)} substitute. Verwacht: 1/11/8."
        }), 400

    actual_match_id = wm_match_id if wm_match_id else match_id
    post_url = f"{SPORZA_BASE}/api/{edition}/gameteams/lineups/{actual_match_id}.data"
    app.logger.info(f"Sporza POST: gracenote={match_id}, wm_match_id={wm_match_id}, url={post_url}")
    try:
        post_resp = scraper.post(
            post_url,
            headers=_base_headers("application/json"),
            json={"action": "SAVE_LINEUP", "lineup": lineup},
            timeout=20
        )
    except Exception as e:
        return jsonify({"error": f"Netwerkfout bij opslaan: {str(e)}"}), 503

    if post_resp.status_code == 401 or post_resp.status_code == 403:
        return jsonify({"error": "Sessie verlopen. Stel je Sporza WM cookie opnieuw in."}), 401

    raw_body = post_resp.text[:500]
    app.logger.info(f"Sporza POST response: status={post_resp.status_code}, body={raw_body[:200]}")

    try:
        result = post_resp.json()
    except Exception:
        result = None

    is_success = False
    if post_resp.status_code in (200, 204):
        if result and isinstance(result, dict):
            is_success = result.get("success", True)
        else:
            is_success = True
    elif result and isinstance(result, dict) and result.get("success"):
        is_success = True

    if is_success:
        return jsonify({
            "ok": True,
            "lineup_count": len(lineup),
            "niet_gevonden": niet_gevonden,
            "bron_riders": bron_label_riders,
            "wm_match_id": actual_match_id,
        })

    sporza_error = ""
    if result and isinstance(result, dict):
        sporza_error = result.get('error') or result.get('message') or result.get('detail') or str(result)[:200]
    else:
        sporza_error = raw_body[:200]
    verlopen = (post_resp.status_code == 500 and 'fout gelopen' in sporza_error)

    import json as _json
    lineup_json = _json.dumps({"action": "SAVE_LINEUP", "lineup": lineup}, ensure_ascii=False)
    console_cmd = (
        f"fetch('/api/{edition}/gameteams/lineups/{actual_match_id}.data',"
        f"{{method:'POST',headers:{{'Content-Type':'application/json'}},"
        f"body:JSON.stringify({lineup_json})}}).then(r=>r.text())"
        f".then(d=>{{try{{let j=JSON.parse(d);alert(j.success?'✅ Opgeslagen!':'❌ '+(j.error||d))}}catch(e){{alert('Response: '+d.substring(0,200))}}}}))"
        f".catch(e=>alert('Fout: '+e))"
    )

    return jsonify({
        "error": (
            "Sporza sessie verlopen. Stel je cookie opnieuw in via Instellingen."
            if verlopen else
            "Sporza WM blokkeert server-requests. Gebruik het console-commando hieronder."
        ),
        "verlopen": verlopen,
        "console_command": None if verlopen else console_cmd,
        "debug_status": post_resp.status_code,
        "debug_body": raw_body,
        "bron_riders": bron_label_riders,
        "lineup_verstuurd": lineup,
        "wm_match_id": actual_match_id,
    }), 401 if verlopen else 400


# ── API: Live wedstrijd ────────────────────────────────────────────────────────

@app.route("/api/koersen/<int:kid>/live-debug", methods=["GET"])
def get_koers_live_debug(kid):
    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    cookie_at = _get_sporza_at(conn, sid=sid)
    conn.close()
    slug = koers['pcs_slug']
    year = koers['datum'][:4]
    match_id = koers.get('sporza_match_id')
    scraper = cloudscraper.create_scraper()
    ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
    results = {}

    sporza_urls = [
        f"{SPORZA_BASE}/api/{edition}/matches/{match_id}/scores",
        f"{SPORZA_BASE}/api/{edition}/matches/{match_id}",
        f"{SPORZA_BASE}/api/{edition}/races/{match_id}/standings",
        f"{SPORZA_BASE}/api/{edition}/matches/{match_id}/riders",
    ]
    for url in sporza_urls:
        try:
            r = _requests.get(url, headers={"User-Agent": ua, "Accept": "application/json"}, timeout=8)
            results[url] = {"status": r.status_code, "length": len(r.text), "preview": r.text[:400]}
        except Exception as e:
            results[url] = {"error": str(e)}

    rsc_urls = [
        f"{SPORZA_BASE}/{edition}/match/{match_id}.data",
        f"{SPORZA_BASE}/{edition}/races/{match_id}/results.data",
        f"{SPORZA_BASE}/api/{edition}/races/{match_id}/results",
    ]
    for url in rsc_urls:
        try:
            r = _requests.get(url, headers={"User-Agent": ua, "Accept": "*/*", "Next-Url": f"/{edition}/match/{match_id}"}, timeout=8)
            results[url] = {"status": r.status_code, "length": len(r.text), "preview": r.text[:500]}
        except Exception as e:
            results[url] = {"error": str(e)}

    fc_race_ids = {'Strade Bianche': 953, 'Omloop Het Nieuwsblad': 834, 'Milaan-Sanremo': 19,
                   'Ronde van Vlaanderen': 9, 'Parijs-Roubaix': 11, 'Amstel Gold Race': 4,
                   'Waalse Pijl': 13, 'Luik-Bastenaken-Luik': 14}
    fc_rid = fc_race_ids.get(koers['naam'])
    if fc_rid:
        fc_url = f"https://firstcycling.com/race.php?r={fc_rid}&y={year}"
        try:
            r = scraper.get(fc_url, headers={"User-Agent": ua}, timeout=12)
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, 'html.parser')
                tables = soup.find_all('table')
                t_info = []
                for t in tables[:5]:
                    hdrs = [th.get_text(strip=True) for th in t.find_all('th')]
                    rows = t.find_all('tr')
                    samples = []
                    for row in rows[1:6]:
                        cells = [td.get_text(strip=True) for td in row.find_all(['td','th'])]
                        if cells: samples.append(cells)
                    if hdrs or samples:
                        t_info.append({"headers": hdrs, "samples": samples, "total": len(rows)})
                results[fc_url] = {"status": 200, "length": len(r.text), "tables": t_info,
                                   "title": soup.title.string if soup.title else ""}
            else:
                results[fc_url] = {"status": r.status_code}
        except Exception as e:
            results[fc_url] = {"error": str(e)}

    if slug:
        result_url = f"https://www.procyclingstats.com/race/{slug}/{year}/result"
        try:
            r = scraper.get(result_url, headers={"User-Agent": ua}, timeout=12)
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, 'html.parser')
                tables = soup.find_all('table')
                tbl_debug = []
                for tbl in tables:
                    hdrs = [th.get_text(strip=True) for th in tbl.find_all('th')]
                    rows = tbl.find_all('tr')
                    row_debug = []
                    for row in rows[1:4]:
                        cells = row.find_all('td')
                        links = [(a.get('href',''), a.get_text(strip=True)) for a in row.find_all('a')]
                        cell_texts = [c.get_text(strip=True) for c in cells]
                        row_html = str(row)[:500]
                        row_debug.append({"texts": cell_texts, "links": links, "html": row_html})
                    tbl_debug.append({"headers": hdrs, "rows": row_debug})
                results[result_url] = {"status": 200, "length": len(r.text), "tables": tbl_debug}
            else:
                results[result_url] = {"status": r.status_code}
        except Exception as e:
            results[result_url] = {"error": str(e)}

    return jsonify(results)


@app.route("/api/koersen/<int:kid>/live", methods=["GET"])
def get_koers_live(kid):
    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify({"error": "Koers niet gevonden"}), 404

    uid = current_user_id()
    opstelling_namen = {
        r["naam"] for r in conn.execute("""
            SELECT r.naam FROM opstelling o
            JOIN renners r ON r.id = o.renner_id
            WHERE o.koers_id = ? AND o.user_id = ?
        """, (kid, uid)).fetchall()
    }
    ploeg_namen = {
        r["naam"] for r in conn.execute(
            "SELECT r.naam FROM mijn_ploeg m JOIN renners r ON r.id=m.renner_id WHERE m.user_id=? AND m.seizoen_id=?",
            (uid, sid)
        ).fetchall()
    }

    match_id = koers.get('sporza_match_id')
    pcs_slug = koers.get('pcs_slug')

    cookie_at = _get_sporza_at(conn, sid=sid)
    alias_map = _get_alias_map(conn)
    conn.close()

    headers_sporza = {
        "Cookie": f"sporza-site_profile_at={cookie_at}",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        "Accept": "*/*",
    }

    klassement = []
    bron = None

    if match_id and cookie_at and not _jwt_verlopen(cookie_at):
        try:
            for url_tmpl in [
                f"{SPORZA_BASE}/api/{edition}/matches/{match_id}/scores",
                f"{SPORZA_BASE}/api/{edition}/matches/{match_id}",
                f"{SPORZA_BASE}/{edition}/match/{match_id}.data",
            ]:
                r = _requests.get(url_tmpl, headers=headers_sporza, timeout=10)
                if r.status_code == 200:
                    try:
                        data = r.json()
                    except Exception:
                        continue
                    scores = (
                        data.get("scores") or data.get("standings") or
                        data.get("results") or data.get("rankings") or
                        (data if isinstance(data, list) else None)
                    )
                    if scores and isinstance(scores, list) and len(scores) > 0:
                        for i, entry in enumerate(scores[:30]):
                            naam = (entry.get("fullName") or entry.get("name") or
                                    entry.get("riderName") or "")
                            punten = entry.get("points") or entry.get("score") or 0
                            if not naam:
                                continue
                            klassement.append({
                                "pos": entry.get("rank") or entry.get("position") or (i + 1),
                                "naam": naam,
                                "ploeg": entry.get("teamShortName") or entry.get("team") or "",
                                "punten": punten,
                                "inPloeg": any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in ploeg_namen),
                                "inOpstelling": any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in opstelling_namen),
                            })
                        if klassement:
                            bron = "Sporza WM"
                            break
        except Exception:
            pass

    if not klassement and match_id and cookie_at and not _jwt_verlopen(cookie_at):
        try:
            r = _requests.get(
                f"{SPORZA_BASE}/{edition}/match/{match_id}.data",
                headers=headers_sporza, timeout=10
            )
            if r.status_code == 200:
                arr = r.json()
                decoded = _rsc_decode(arr[0], arr)
                scores = _rsc_find(decoded, "scores") or _rsc_find(decoded, "standings") or []
                if isinstance(scores, list):
                    for i, entry in enumerate(scores[:30]):
                        naam = (entry.get("fullName") or entry.get("riderName") or
                                entry.get("name") or "")
                        if not naam:
                            continue
                        klassement.append({
                            "pos": entry.get("rank") or (i + 1),
                            "naam": naam,
                            "ploeg": entry.get("teamShortName") or "",
                            "punten": entry.get("points") or 0,
                            "inPloeg": any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in ploeg_namen),
                            "inOpstelling": any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in opstelling_namen),
                        })
                    if klassement:
                        bron = "Sporza WM RSC"
        except Exception:
            pass

    commentaar = []
    pcs_status = None
    uitvallers = []
    favorieten = []
    race_klaar = False

    if pcs_slug:
        year = koers['datum'][:4]
        scraper = cloudscraper.create_scraper()
        pcs_headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"}

        try:
            result_url = f"https://www.procyclingstats.com/race/{pcs_slug}/{year}/result"
            resp = scraper.get(result_url, headers=pcs_headers, timeout=15)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, 'html.parser')
                tables = soup.find_all('table')
                for tbl in tables:
                    hdrs = [th.get_text(strip=True) for th in tbl.find_all('th')]
                    if 'Rider' not in hdrs and 'Rnk' not in hdrs:
                        continue
                    rows = tbl.find_all('tr')
                    for row in rows:
                        cells = row.find_all('td')
                        if len(cells) < 4:
                            continue
                        rank_txt = cells[0].get_text(strip=True)
                        rider_a = row.find('a', href=lambda h: h and 'rider/' in (h or ''))
                        if not rider_a:
                            continue
                        naam = ' '.join(rider_a.stripped_strings)
                        team_a = row.find('a', href=lambda h: h and 'team/' in (h or ''))
                        ploeg_naam = team_a.get_text(strip=True) if team_a else ""
                        tijd = ""
                        for c in reversed(cells):
                            t = c.get_text(strip=True)
                            if t and t not in (naam, ploeg_naam, rank_txt) and len(t) > 1:
                                tijd = t
                                break

                        in_ploeg = any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in ploeg_namen)
                        in_ops   = any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in opstelling_namen)

                        if rank_txt in ('DNF', 'DNS', 'OTL', 'DSQ'):
                            uitvallers.append({
                                "pos": rank_txt, "naam": naam, "ploeg": ploeg_naam,
                                "inPloeg": in_ploeg, "inOpstelling": in_ops,
                            })
                        else:
                            try:
                                pos_int = int(rank_txt)
                            except ValueError:
                                continue
                            if not klassement:
                                bron = "PCS einduitslag"
                                race_klaar = True
                            klassement.append({
                                "pos": pos_int, "naam": naam, "ploeg": ploeg_naam,
                                "tijd": tijd,
                                "inPloeg": in_ploeg, "inOpstelling": in_ops,
                            })
                    if klassement or uitvallers:
                        break
        except Exception:
            pass

        try:
            live_url = f"https://www.procyclingstats.com/race/{pcs_slug}/{year}/live"
            resp_l = scraper.get(live_url, headers=pcs_headers, timeout=15)
            if resp_l.status_code == 200:
                soup_l = BeautifulSoup(resp_l.text, 'html.parser')
                for ul in soup_l.find_all('ul', class_=True):
                    classes = ul.get('class', [])
                    if 'fs14' in classes and 'keyvalueList' not in classes:
                        for li in ul.find_all('li'):
                            naam = li.get_text(strip=True)
                            if naam and len(naam) > 3:
                                in_ploeg = any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in ploeg_namen)
                                in_ops   = any(_name_match(n, {_norm(naam)}, alias_map.get(n)) for n in opstelling_namen)
                                favorieten.append({
                                    "naam": naam,
                                    "inPloeg": in_ploeg, "inOpstelling": in_ops,
                                })
                        break
        except Exception:
            pass

    cookie_verlopen = bool(cookie_at) and _jwt_verlopen(cookie_at)
    geen_cookie = not bool(cookie_at)

    return jsonify({
        "koers": koers['naam'],
        "klassement": klassement[:20],
        "uitvallers": uitvallers[:20],
        "favorieten": favorieten[:10],
        "commentaar": commentaar[:15],
        "bron": bron,
        "status": pcs_status,
        "race_klaar": race_klaar,
        "cookie_verlopen": cookie_verlopen,
        "geen_cookie": geen_cookie,
    })


# ── API: Stats / Dashboard ─────────────────────────────────────────────────────

@app.route("/api/koersen/<int:kid>/debug-sporza")
def debug_sporza(kid):
    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)
    koers = dict(conn.execute("SELECT * FROM koersen WHERE id=?", (kid,)).fetchone() or {})
    if not koers:
        conn.close()
        return jsonify({"error": "Koers niet gevonden"}), 404
    match_id = koers.get('sporza_match_id')
    cookie_at = _get_sporza_at(conn, sid=sid)
    conn.close()
    if not match_id or not cookie_at:
        return jsonify({"error": "Geen match_id of cookie"}), 400
    scraper = cloudscraper.create_scraper()
    get_url = f"{SPORZA_BASE}/api/{edition}/gameteams/lineups/{match_id}"
    try:
        r = scraper.get(get_url, headers={"Cookie": f"sporza-site_profile_at={cookie_at}"}, timeout=15)
        return jsonify({"url": get_url, "status": r.status_code, "body": r.text[:1000]})
    except Exception as e:
        return jsonify({"error": str(e)})


@app.route("/api/sporza-lineup-debug/<int:match_id>")
def sporza_lineup_debug(match_id):
    conn = get_db()
    sid = current_seizoen_id(conn)
    edition = _get_sporza_edition(conn, sid)
    at = _get_sporza_at(conn, sid=sid)
    vt_row = conn.execute(
        "SELECT waarde FROM instellingen WHERE sleutel='sporza_cookie_vt'"
    ).fetchone()
    conn.close()
    vt = (vt_row['waarde'] if vt_row and vt_row['waarde'] else '').strip()

    if not at:
        return jsonify({"error": "Geen AT cookie beschikbaar"})

    ua = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    base_h = {
        "User-Agent": ua,
        "Origin": SPORZA_BASE,
        "Referer": f"{SPORZA_BASE}/{edition}/team",
    }

    scraper = cloudscraper.create_scraper()
    scraper.cookies.set('sporza-site_profile_at', at,
                        domain='wielermanager.sporza.be', path='/')
    if vt:
        scraper.cookies.set('sporza-site_profile_vt', vt,
                            domain='wielermanager.sporza.be', path='/')

    stappen = []

    try:
        r = scraper.get(
            f"{SPORZA_BASE}/{edition}/team",
            headers={**base_h, "Accept": "text/html,application/xhtml+xml,*/*;q=0.9"},
            timeout=15,
        )
        nieuwe_cookies = [k for k in scraper.cookies.keys()
                          if k not in ('sporza-site_profile_at', 'sporza-site_profile_vt')]
        stappen.append({
            "stap": "1. GET /team (sessie opbouwen)",
            "status": r.status_code,
            "nieuwe_cookies_ontvangen": nieuwe_cookies,
        })
    except Exception as e:
        stappen.append({"stap": "1. GET /team", "error": str(e)})

    try:
        r = scraper.get(
            f"{SPORZA_BASE}/api/{edition}/gameteams",
            headers={**base_h, "Accept": "application/json"},
            timeout=15,
        )
        stappen.append({
            "stap": "2. GET /api/gameteams",
            "status": r.status_code,
            "response": r.text[:400],
        })
    except Exception as e:
        stappen.append({"stap": "2. GET /api/gameteams", "error": str(e)})

    lineup_url = f"{SPORZA_BASE}/api/{edition}/gameteams/lineups/{match_id}"

    try:
        r = scraper.get(
            lineup_url,
            headers={**base_h, "Accept": "application/json"},
            timeout=15,
        )
        stappen.append({
            "stap": f"3. GET lineups/{match_id}",
            "status": r.status_code,
            "response": r.text[:400],
        })
    except Exception as e:
        stappen.append({"stap": f"3. GET lineups/{match_id}", "error": str(e)})

    test_body = {"action": "SAVE_LINEUP", "lineup": []}

    try:
        r = scraper.post(
            lineup_url,
            headers={**base_h, "Content-Type": "application/json", "Accept": "*/*"},
            json=test_body,
            timeout=15,
        )
        stappen.append({
            "stap": f"4a. POST {lineup_url} (Accept: */*)",
            "status": r.status_code,
            "response": r.text[:400],
        })
    except Exception as e:
        stappen.append({"stap": "4a. POST /api/lineups (Accept */*)", "error": str(e)})

    try:
        r = scraper.post(
            lineup_url,
            headers={**base_h, "Content-Type": "application/json",
                     "Accept": "text/x-component"},
            json=test_body,
            timeout=15,
        )
        stappen.append({
            "stap": f"4b. POST {lineup_url} (Accept: text/x-component)",
            "status": r.status_code,
            "response": r.text[:400],
        })
    except Exception as e:
        stappen.append({"stap": "4b. POST /api/lineups (RSC)", "error": str(e)})

    edition_url = f"{SPORZA_BASE}/{edition}"
    try:
        r = scraper.post(
            edition_url,
            headers={**base_h, "Content-Type": "application/json",
                     "Accept": "text/x-component",
                     "Referer": f"{SPORZA_BASE}/{edition}"},
            json=test_body,
            timeout=15,
        )
        stappen.append({
            "stap": f"5. POST {edition_url} (hoofdpagina, RSC accept)",
            "status": r.status_code,
            "response": r.text[:400],
        })
    except Exception as e:
        stappen.append({"stap": "5. POST hoofdpagina", "error": str(e)})

    team_url = f"{SPORZA_BASE}/{edition}/team"
    try:
        r = scraper.post(
            team_url,
            headers={**base_h, "Content-Type": "application/json",
                     "Accept": "text/x-component",
                     "Referer": team_url},
            json=test_body,
            timeout=15,
        )
        stappen.append({
            "stap": f"6. POST {team_url} (teampagina, RSC accept)",
            "status": r.status_code,
            "response": r.text[:400],
        })
    except Exception as e:
        stappen.append({"stap": "6. POST teampagina", "error": str(e)})

    import re as _re
    team_data_text = None
    try:
        r = scraper.get(
            f"{SPORZA_BASE}/{edition}/team.data",
            headers={**base_h, "Accept": "*/*"},
            timeout=15,
        )
        team_data_text = r.text
        gevonden = list(dict.fromkeys(_re.findall(r'3305\d{3}', r.text)))
        wm_ids = {}
        for gid in gevonden:
            wm_id = _find_wm_match_id(r.text, gid)
            wm_ids[gid] = wm_id
        stappen.append({
            "stap": "7. team.data — match IDs + WM mapping",
            "status": r.status_code,
            "alle_3305xxx_ids": gevonden,
            "gracenote_to_wm_id": wm_ids,
            "ons_match_id_3305415_aanwezig": "3305415" in r.text,
        })
    except Exception as e:
        stappen.append({"stap": "7. team.data match IDs", "error": str(e)})

    wm_id_for_test = None
    if team_data_text:
        wm_id_for_test = _find_wm_match_id(team_data_text, str(match_id))
    data_lineup_url = f"{SPORZA_BASE}/api/{edition}/gameteams/lineups/{wm_id_for_test or match_id}.data"
    try:
        r = scraper.post(
            data_lineup_url,
            headers={**base_h, "Content-Type": "application/json", "Accept": "*/*"},
            json=test_body,
            timeout=15,
        )
        stappen.append({
            "stap": f"8. POST {data_lineup_url} (.data suffix, wm_id={wm_id_for_test})",
            "status": r.status_code,
            "response": r.text[:400],
        })
    except Exception as e:
        stappen.append({"stap": "8. POST .data URL", "error": str(e)})

    return jsonify({"lineup_url": lineup_url, "data_lineup_url": data_lineup_url, "wm_match_id": wm_id_for_test, "stappen": stappen})


@app.route("/api/sporza-refresh-debug")
def sporza_refresh_debug():
    import requests as _req
    conn = get_db()
    rt_row = conn.execute(
        "SELECT waarde FROM instellingen WHERE sleutel='sporza_cookie_rt'"
    ).fetchone()
    conn.close()
    rt = (rt_row['waarde'] if rt_row and rt_row['waarde'] else '').strip()
    if not rt:
        return jsonify({"ok": False, "bericht": "Geen RT opgeslagen in de app."})
    try:
        resp = _req.get(
            'https://sporza.be/sso/refresh',
            headers={
                'Cookie': f'sporza-site_profile_rt={rt}',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Origin': 'https://sporza.be',
                'Referer': 'https://wielermanager.sporza.be/',
            },
            timeout=15, allow_redirects=True,
        )
        nieuwe_at = resp.cookies.get('sporza-site_profile_at') or ''
        if not nieuwe_at:
            for hdr in resp.raw.headers.getlist('Set-Cookie'):
                if 'sporza-site_profile_at=' in hdr:
                    val = hdr.split('sporza-site_profile_at=')[1].split(';')[0].strip()
                    if val and val != 'deleted':
                        nieuwe_at = val
                        break
        return jsonify({
            "ok": bool(nieuwe_at),
            "http_status": resp.status_code,
            "nieuwe_at_ontvangen": bool(nieuwe_at),
            "response_body": resp.text[:400],
            "set_cookie_headers": resp.raw.headers.getlist('Set-Cookie'),
            "rt_lengte": len(rt),
            "rt_begin": rt[:20] + "…",
        })
    except Exception as e:
        return jsonify({"ok": False, "fout": str(e)})


@app.route("/api/sporza-at-status")
def sporza_at_status():
    """Lichtgewicht check: is de Sporza AT nog geldig en hoelang nog?
    Gebruikt door de client-side watchdog om een verloopwaarschuwing te tonen."""
    import base64, time as _time
    uid = current_user_id()
    if not uid:
        return jsonify({"verlopen": True, "minuten_resterend": 0, "at_aanwezig": False})
    conn = get_db()
    sid = current_seizoen_id(conn)
    at = (_get_user_inst_val(conn, 'sporza_cookie', sid=sid) or '').strip()
    conn.close()
    if not at:
        return jsonify({"verlopen": True, "minuten_resterend": 0, "at_aanwezig": False})
    try:
        payload_b64 = at.split('.')[1]
        payload_b64 += '=' * (-len(payload_b64) % 4)
        payload = json.loads(base64.b64decode(payload_b64).decode('utf-8'))
        exp = payload.get('exp', 0)
        nu  = int(_time.time())
        verlopen = exp < nu
        minuten  = round((exp - nu) / 60, 1)
        return jsonify({"verlopen": verlopen, "minuten_resterend": minuten, "at_aanwezig": True})
    except Exception:
        return jsonify({"verlopen": True, "minuten_resterend": 0, "at_aanwezig": True})


@app.route("/api/instellingen/sporza-at", methods=["POST"])
def sla_sporza_at_op():
    """Sla enkel de Sporza AT op (gebruikt door de 'Vernieuw AT'-modal)."""
    uid = current_user_id()
    if not uid:
        return jsonify({"error": "Niet ingelogd"}), 401
    data = request.get_json(silent=True) or {}
    at = (data.get("at") or "").strip()
    if not at:
        return jsonify({"error": "Geen AT meegegeven"}), 400
    conn = get_db()
    sid = current_seizoen_id(conn)
    _set_user_inst_val(conn, 'sporza_cookie', at, sid=sid)
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/sporza-verbinding-test")
def sporza_verbinding_test():
    import base64, time as _time
    conn = get_db()
    # Gebruik _get_user_inst_val zodat de user+seizoen-specifieke waarde gevonden wordt
    # (zelfde fallback-keten als _get_sporza_at)
    at = (_get_user_inst_val(conn, 'sporza_cookie') or '').strip()
    rt = (_get_user_inst_val(conn, 'sporza_cookie_rt') or '').strip()
    conn.close()

    rt_aanwezig = bool(rt)

    def _jwt_info(token):
        try:
            payload_b64 = token.split('.')[1]
            payload_b64 += '=' * (-len(payload_b64) % 4)
            payload = json.loads(base64.b64decode(payload_b64).decode('utf-8'))
            exp = payload.get('exp', 0)
            nu  = int(_time.time())
            return {"exp": exp, "nu": nu, "verlopen": exp < nu,
                    "minuten_resterend": round((exp - nu) / 60, 1) if exp > nu else 0}
        except Exception as e:
            return {"jwt_parse_fout": str(e)}

    rt_info = {"aanwezig": rt_aanwezig, "lengte": len(rt) if rt_aanwezig else 0,
               "begin": rt[:8] + "…" if rt_aanwezig and len(rt) > 8 else rt}

    if not at:
        if rt_aanwezig:
            conn2 = get_db()
            new_at = _refresh_sporza_at(conn2)
            conn2.close()
            if new_at:
                at = new_at
            else:
                return jsonify({
                    "ok": False, "stap": "refresh_mislukt",
                    "bericht": "⚠️ Sporza-sessie verlopen. Klik op de knop hieronder om te vernieuwen.",
                })
        else:
            return jsonify({
                "ok": False, "stap": "geen_at",
                "bericht": "⚠️ Geen Sporza-sessie ingesteld. Klik op de knop hieronder.",
            })

    jwt = _jwt_info(at)
    if "jwt_parse_fout" in jwt:
        return jsonify({"ok": False, "stap": "refresh_mislukt",
                        "bericht": "⚠️ Sporza-sessie verlopen. Klik op de knop hieronder om te vernieuwen."})

    if jwt.get("verlopen"):
        # Probeer auto-refresh — als dat mislukt, simpele boodschap
        if rt_aanwezig:
            conn2 = get_db()
            new_at = _refresh_sporza_at(conn2)
            conn2.close()
            if new_at:
                at = new_at
                jwt = _jwt_info(at)
            else:
                return jsonify({
                    "ok": False, "stap": "refresh_mislukt",
                    "bericht": "⚠️ Sporza-sessie verlopen. Klik op de knop hieronder om te vernieuwen.",
                })
        else:
            return jsonify({
                "ok": False, "stap": "verlopen",
                "bericht": "⚠️ Sporza-sessie verlopen. Klik op de knop hieronder om te vernieuwen.",
            })
    jwt_info = jwt

    scraper = cloudscraper.create_scraper()
    _conn_test = get_db()
    _sid_test = current_seizoen_id(_conn_test)
    _edition_test = _get_sporza_edition(_conn_test, _sid_test)
    _conn_test.close()
    test_url = f"{SPORZA_BASE}/api/{_edition_test}/cyclists"
    try:
        r = scraper.get(
            test_url,
            headers={
                "Cookie": f"sporza-site_profile_at={at}",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Accept": "application/json",
            },
            timeout=12,
        )
        if r.status_code == 200:
            return jsonify({
                "ok": True,
                "bericht": f"✅ Cookie is geldig! Verbinding met Sporza WM werkt. Verloopt over {jwt_info.get('minuten_resterend','?')} min.",
                **jwt_info,
            })
        elif r.status_code in (401, 403):
            return jsonify({
                "ok": False,
                "stap": "sporza_weigering",
                "bericht": f"Sporza weigerde de cookie (HTTP {r.status_code}). Sessie verlopen of ongeldige waarde.",
                "sporza_body": r.text[:200],
                **jwt_info,
            })
        else:
            return jsonify({
                "ok": False,
                "stap": "sporza_fout",
                "bericht": f"Sporza antwoordde onverwacht met HTTP {r.status_code}.",
                "sporza_body": r.text[:200],
                **jwt_info,
            })
    except Exception as e:
        return jsonify({"ok": False, "stap": "netwerk", "bericht": f"Netwerkfout: {e}"})


@app.route("/api/stats")
def get_stats():
    uid = current_user_id()
    conn = get_db()
    sid = current_seizoen_id(conn)

    totaal = conn.execute("""
        SELECT COALESCE(SUM(r.punten), 0) as punten
        FROM resultaten r
        JOIN koersen k ON k.id = r.koers_id AND k.seizoen_id = ?
        JOIN opstelling o ON o.renner_id = r.renner_id AND o.koers_id = r.koers_id AND o.user_id = ?
        WHERE r.user_id = ?
    """, (sid, uid, uid)).fetchone()["punten"]

    punten_per_koers = conn.execute("""
        SELECT k.naam, k.datum, k.soort,
               COALESCE(SUM(r.punten), 0) as punten
        FROM koersen k
        LEFT JOIN opstelling o ON o.koers_id = k.id AND o.user_id = ?
        LEFT JOIN resultaten r ON r.koers_id = k.id AND r.renner_id = o.renner_id AND r.user_id = ?
        WHERE k.afgelopen = 1 AND k.seizoen_id = ?
        GROUP BY k.id
        ORDER BY k.datum ASC
    """, (uid, uid, sid)).fetchall()

    top_renners = conn.execute("""
        SELECT re.id, re.naam, re.ploeg, re.rol,
               SUM(r.punten) as punten
        FROM resultaten r
        JOIN renners re ON re.id = r.renner_id
        JOIN opstelling o ON o.renner_id = r.renner_id AND o.koers_id = r.koers_id AND o.user_id = ?
        WHERE r.user_id = ?
          AND r.renner_id IN (SELECT renner_id FROM mijn_ploeg WHERE user_id = ? AND seizoen_id = ?)
        GROUP BY r.renner_id
        HAVING SUM(r.punten) > 0
        ORDER BY punten DESC
    """, (uid, uid, uid, sid)).fetchall()

    kopman_stats = conn.execute("""
        SELECT re.id, re.naam, re.ploeg, re.foto,
               COUNT(DISTINCT o.koers_id) as keren_kopman,
               COALESCE(SUM(r.bonuspunten_kopman), 0) as bonus_punten
        FROM opstelling o
        JOIN renners re ON re.id = o.renner_id
        LEFT JOIN resultaten r ON r.renner_id = o.renner_id AND r.koers_id = o.koers_id AND r.user_id = ?
        WHERE o.is_kopman = 1
          AND o.user_id = ?
          AND o.renner_id IN (SELECT renner_id FROM mijn_ploeg WHERE user_id = ? AND seizoen_id = ?)
        GROUP BY re.id
        ORDER BY bonus_punten DESC
    """, (uid, uid, uid, sid)).fetchall()

    inst = _get_inst(conn, uid, sid=sid)
    conn.close()
    return jsonify({
        "totaal_punten": totaal,
        "punten_per_koers": [dict(r) for r in punten_per_koers],
        "top_renners": [dict(r) for r in top_renners],
        "kopman_stats": [dict(r) for r in kopman_stats],
        "transfer_count": int(inst.get("transfer_count", 0)),
        "transfers_gratis": int(inst.get("transfers_gratis", 3)),
    })


# ── AI Chat helpers ────────────────────────────────────────────────────────────

def _build_ai_context(conn):
    uid = current_user_id()
    sid = current_seizoen_id(conn)
    seizoen_row = conn.execute("SELECT naam FROM seizoenen WHERE id=?", (sid,)).fetchone()
    seizoen_naam = seizoen_row["naam"] if seizoen_row else "Seizoen"
    inst = _get_inst(conn, uid, sid=sid)
    budget = float(inst.get("budget", 120))
    max_renners = int(inst.get("max_renners", 20))
    transfers_gratis = int(inst.get("transfers_gratis", 3))
    transfer_count = int(inst.get("transfer_count", 0))
    kosten_volgend = transfer_kosten(transfer_count + 1, transfers_gratis)

    ploeg = conn.execute("""
        SELECT r.id, r.naam, r.ploeg as renner_ploeg, r.rol, r.prijs,
               r.totaal_punten, r.geblesseerd,
               COALESCE(m.aangeschaft_prijs, r.prijs) as aangeschaft_prijs
        FROM mijn_ploeg m
        JOIN renners r ON r.id = m.renner_id
        WHERE m.user_id = ? AND m.seizoen_id = ?
        ORDER BY r.prijs DESC
    """, (uid, sid)).fetchall()

    uitgegeven = sum(r["aangeschaft_prijs"] for r in ploeg)
    budget_resterend = round(budget - uitgegeven, 2)

    koersen = conn.execute(
        "SELECT naam, datum, soort, afgelopen FROM koersen WHERE seizoen_id=? ORDER BY datum ASC", (sid,)
    ).fetchall()

    beschikbaar = conn.execute("""
        SELECT naam, ploeg, rol, prijs, totaal_punten
        FROM renners
        WHERE actief = 1 AND seizoen_id = ?
          AND id NOT IN (SELECT renner_id FROM mijn_ploeg WHERE user_id = ? AND seizoen_id = ?)
        ORDER BY totaal_punten DESC
        LIMIT 20
    """, (sid, uid, sid)).fetchall()

    ploeg_lines = "\n".join(
        f"  - {r['naam']} ({r['renner_ploeg']}, {r['rol']}, "
        f"€{r['prijs']}M, {r['totaal_punten']} pt"
        f"{', GEBLESSEERD' if r['geblesseerd'] else ''})"
        for r in ploeg
    ) or "  (leeg)"

    komende = [k for k in koersen if not k["afgelopen"]]
    afgelopen = [k for k in koersen if k["afgelopen"]]
    komende_lines = "\n".join(
        f"  - {k['naam']} ({k['datum']}, {k['soort']})"
        for k in komende[:8]
    ) or "  (geen)"

    beschikbaar_lines = "\n".join(
        f"  - {r['naam']} ({r['ploeg']}, {r['rol']}, "
        f"€{r['prijs']}M, {r['totaal_punten']} pt)"
        for r in beschikbaar
    ) or "  (geen)"

    return f"""WIELERMANAGER CONTEXT — Sporza {seizoen_naam}

MIJN PLOEG ({len(ploeg)}/{max_renners} renners):
{ploeg_lines}

BUDGET:
  - Totaal seizoen: €{budget}M
  - Uitgegeven: €{uitgegeven:.1f}M
  - Resterend: €{budget_resterend}M
  - Transfers gedaan: {transfer_count}
  - Gratis transfers: {transfers_gratis}
  - Kosten volgende transfer: {'gratis' if kosten_volgend == 0 else f'€{kosten_volgend}M'}

KOMENDE WEDSTRIJDEN ({len(komende)} nog te rijden, {len(afgelopen)} gereden):
{komende_lines}

BESTE BESCHIKBARE RENNERS (buiten jouw ploeg, gesorteerd op punten):
{beschikbaar_lines}"""


_TRANSFER_TOOL = {
    "name": "voer_transfer_uit",
    "description": (
        "Stel een specifieke transfer voor aan de gebruiker. "
        "Gebruik deze tool ALLEEN als de gebruiker expliciet om transferadvies vraagt "
        "of als je een concrete wissel aanbeveelt. "
        "Geef exacte namen op zoals ze in de spelersdata voorkomen. "
        "De gebruiker zal de transfer zelf moeten bevestigen."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "renner_uit_naam": {
                "type": "string",
                "description": "Volledige naam van de renner die de ploeg verlaat (moet in mijn ploeg zitten)"
            },
            "renner_in_naam": {
                "type": "string",
                "description": "Volledige naam van de renner die de ploeg inkomt (moet beschikbaar zijn)"
            },
            "reden": {
                "type": "string",
                "description": "Korte motivering voor de transfer (1-2 zinnen)"
            }
        },
        "required": ["renner_uit_naam", "renner_in_naam", "reden"]
    }
}


# ── API: AI Chat ───────────────────────────────────────────────────────────────

@app.route("/api/ai-chat", methods=["POST"])
def ai_chat():
    data = request.json or {}
    user_message = (data.get("message") or "").strip()
    history = data.get("history") or []

    if not user_message:
        return jsonify({"error": "Geen bericht meegegeven"}), 400

    conn = get_db()

    api_key_row = conn.execute(
        "SELECT waarde FROM instellingen WHERE sleutel='groq_api_key'"
    ).fetchone()
    if not api_key_row or not (api_key_row["waarde"] or "").strip():
        conn.close()
        return jsonify({"error": "Groq API-sleutel niet ingesteld. Ga naar Instellingen → 🤖 AI Assistent."}), 400

    api_key = api_key_row["waarde"].strip()
    context = _build_ai_context(conn)

    system_prompt = f"""Je bent een slimme assistent voor Sporza Wielermanager, een fantasiewielercompetitie voor het voorjaar 2026.
Je helpt de gebruiker met:
- Analyse van renners, ploegen en wedstrijden
- Transferadvies (wie kopen/verkopen en waarom)
- Budgetbeheer en transferkostenstrategie
- Tactiek en opstellingsadvies voor komende wedstrijden

Antwoord altijd in het NEDERLANDS. Wees bondig maar concreet.
Gebruik de onderstaande context om gepersonaliseerde adviezen te geven over de exacte ploeg van de gebruiker.

Als je een CONCRETE transferaanbeveling doet (een specifieke renner eruit en een andere erin), voeg dan enkel op het einde van je antwoord dit blok toe:
TRANSFER_JSON:{{"renner_uit":"Volledige naam renner die eruit gaat","renner_in":"Volledige naam renner die erin komt","reden":"Korte reden"}}
Voeg dit blok NIET toe bij algemene vragen of analyses zonder specifieke wissel.

{context}"""

    messages = [{"role": "system", "content": system_prompt}]
    for msg in history[-20:]:
        role = msg.get("role")
        content = msg.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)})
    messages.append({"role": "user", "content": user_message})

    GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
    groq_url = "https://api.groq.com/openai/v1/chat/completions"
    groq_headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    resp = None
    last_error = ""
    for model_id in GROQ_MODELS:
        payload = {
            "model": model_id,
            "messages": messages,
            "max_tokens": 1024,
            "temperature": 0.7,
        }
        try:
            resp = _requests.post(groq_url, headers=groq_headers, json=payload, timeout=30)
        except Exception as e:
            conn.close()
            return jsonify({"error": f"Netwerkfout: {str(e)}"}), 503
        if resp.status_code == 429:
            try:
                last_error = resp.json().get("error", {}).get("message", "rate limit")
            except Exception:
                last_error = "rate limit"
            continue
        break

    if resp.status_code == 401:
        conn.close()
        return jsonify({"error": "Ongeldige Groq API-sleutel. Controleer je sleutel in de Instellingen."}), 400
    if resp.status_code == 429:
        conn.close()
        return jsonify({"error": "Rate limit bereikt. Probeer het over een moment opnieuw."}), 429
    if resp.status_code != 200:
        conn.close()
        try:
            detail = resp.json().get("error", {}).get("message", resp.text[:200])
        except Exception:
            detail = resp.text[:200]
        return jsonify({"error": f"Groq API fout (HTTP {resp.status_code}): {detail}"}), 503

    try:
        raw_text = resp.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, Exception) as e:
        conn.close()
        return jsonify({"error": f"Ongeldig antwoord van Groq: {str(e)}"}), 503

    transfer_suggestion = None
    clean_text = raw_text
    transfer_match = re.search(r'TRANSFER_JSON:\s*(\{.*?\})', raw_text, re.DOTALL)
    if transfer_match:
        clean_text = raw_text[:transfer_match.start()].strip()
        try:
            tj = json.loads(transfer_match.group(1))
            uit_naam = tj.get("renner_uit", "")
            in_naam  = tj.get("renner_in", "")
            reden    = tj.get("reden", "")

            _ai_uid = current_user_id()
            _ai_sid = current_seizoen_id(conn)
            ploeg_renners = conn.execute("""
                SELECT r.id, r.naam, r.prijs,
                       COALESCE(m.aangeschaft_prijs, r.prijs) as aangeschaft_prijs
                FROM mijn_ploeg m JOIN renners r ON r.id = m.renner_id
                WHERE m.user_id = ? AND m.seizoen_id = ?
            """, (_ai_uid, _ai_sid)).fetchall()

            alle_renners = conn.execute("""
                SELECT id, naam, prijs FROM renners
                WHERE actief = 1 AND id NOT IN (SELECT renner_id FROM mijn_ploeg WHERE user_id = ? AND seizoen_id = ?)
            """, (_ai_uid, _ai_sid)).fetchall()

            renner_uit = next((r for r in ploeg_renners if _name_match(r["naam"], {_norm(uit_naam)})), None)
            renner_in  = next((r for r in alle_renners  if _name_match(r["naam"], {_norm(in_naam)})),  None)

            inst   = _get_inst(conn, _ai_uid, sid=_ai_sid)
            count  = int(inst.get("transfer_count", 0))
            gratis = int(inst.get("transfers_gratis", 3))
            budget = float(inst.get("budget", 120))
            kosten = transfer_kosten(count + 1, gratis)

            budget_na = None
            if renner_uit and renner_in:
                ploeg_rest_prijs = sum(r["aangeschaft_prijs"] for r in ploeg_renners if r["id"] != renner_uit["id"])
                budget_na = round(budget - ploeg_rest_prijs - renner_in["prijs"] - kosten, 2)

            transfer_suggestion = {
                "renner_uit_naam":  uit_naam,
                "renner_uit_id":    renner_uit["id"]    if renner_uit else None,
                "renner_uit_prijs": renner_uit["prijs"]  if renner_uit else None,
                "renner_in_naam":   in_naam,
                "renner_in_id":     renner_in["id"]     if renner_in else None,
                "renner_in_prijs":  renner_in["prijs"]   if renner_in else None,
                "reden":            reden,
                "transfer_kosten":  kosten,
                "budget_na":        budget_na,
                "match_gevonden":   renner_uit is not None and renner_in is not None,
            }
        except Exception:
            pass

    conn.close()
    return jsonify({"text": clean_text, "transfer_suggestion": transfer_suggestion})


if __name__ == "__main__":
    port = int(os.environ.get('PORT', 5050))
    debug = os.environ.get('FLASK_ENV', 'development') == 'development'
    app.run(debug=debug, host='0.0.0.0', port=port)
