import sqlite3
import os

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    os.path.join(os.path.dirname(__file__), "wielermanager.db")
)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    c = conn.cursor()

    c.executescript("""
        CREATE TABLE IF NOT EXISTS renners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            naam TEXT NOT NULL,
            ploeg TEXT NOT NULL,
            rol TEXT NOT NULL CHECK(rol IN ('sprinter','klimmer','allrounder','tijdrijder','helper')),
            prijs REAL NOT NULL,
            totaal_punten INTEGER DEFAULT 0,
            actief INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS mijn_ploeg (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            renner_id INTEGER NOT NULL UNIQUE,
            positie TEXT DEFAULT 'bus' CHECK(positie IN ('starter','bus')),
            is_kopman INTEGER DEFAULT 0,
            aangeschaft_op TEXT DEFAULT (date('now')),
            FOREIGN KEY (renner_id) REFERENCES renners(id)
        );

        CREATE TABLE IF NOT EXISTS koersen (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            naam TEXT NOT NULL,
            datum TEXT NOT NULL,
            soort TEXT NOT NULL CHECK(soort IN ('monument','worldtour','niet_wt')),
            afgelopen INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS resultaten (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            koers_id INTEGER NOT NULL,
            renner_id INTEGER NOT NULL,
            positie INTEGER,
            punten INTEGER NOT NULL DEFAULT 0,
            bonuspunten_kopman INTEGER DEFAULT 0,
            bonuspunten_ploegmaat INTEGER DEFAULT 0,
            UNIQUE(koers_id, renner_id),
            FOREIGN KEY (koers_id) REFERENCES koersen(id),
            FOREIGN KEY (renner_id) REFERENCES renners(id)
        );

        CREATE TABLE IF NOT EXISTS instellingen (
            sleutel TEXT PRIMARY KEY,
            waarde TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            datum TEXT DEFAULT (date('now')),
            renner_uit_id INTEGER,
            renner_in_id INTEGER,
            kosten REAL DEFAULT 0,
            FOREIGN KEY (renner_uit_id) REFERENCES renners(id),
            FOREIGN KEY (renner_in_id) REFERENCES renners(id)
        );

        CREATE TABLE IF NOT EXISTS opstelling (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            koers_id INTEGER NOT NULL,
            renner_id INTEGER NOT NULL,
            is_kopman INTEGER DEFAULT 0,
            UNIQUE(koers_id, renner_id),
            FOREIGN KEY (koers_id) REFERENCES koersen(id),
            FOREIGN KEY (renner_id) REFERENCES renners(id)
        );

        CREATE TABLE IF NOT EXISTS geplande_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            renner_uit_id INTEGER NOT NULL,
            renner_in_id INTEGER NOT NULL,
            datum TEXT NOT NULL,
            aangemaakt_op TEXT DEFAULT (date('now')),
            FOREIGN KEY (renner_uit_id) REFERENCES renners(id),
            FOREIGN KEY (renner_in_id) REFERENCES renners(id)
        );
    """)

    # Echte spelregels Sporza Wielermanager Voorjaar Mannen 2026
    c.execute("""
        INSERT OR IGNORE INTO instellingen (sleutel, waarde) VALUES
        ('budget', '120'),
        ('max_renners', '20'),
        ('max_starters', '12'),
        ('max_bus', '8'),
        ('max_per_ploeg', '4'),
        ('transfers_gratis', '3'),
        ('transfer_count', '0'),
        ('seizoen', '2026'),
        ('competitie', 'Voorjaar Mannen 2026')
    """)

    # Migraties: kolommen toevoegen als ze nog niet bestaan
    try:
        conn.execute("ALTER TABLE renners ADD COLUMN foto TEXT")
        conn.commit()
    except Exception:
        pass  # Kolom bestaat al

    try:
        conn.execute("ALTER TABLE renners ADD COLUMN geblesseerd INTEGER DEFAULT 0")
        conn.commit()
    except Exception:
        pass  # Kolom bestaat al

    # Migratie: afstand, hoogtemeters, profiel_url, favorieten_json, winnaar_id op koersen
    for col_sql in [
        "ALTER TABLE koersen ADD COLUMN afstand REAL",
        "ALTER TABLE koersen ADD COLUMN hoogtemeters INTEGER",
        "ALTER TABLE koersen ADD COLUMN profiel_url TEXT",
        "ALTER TABLE koersen ADD COLUMN favorieten_json TEXT",
        "ALTER TABLE koersen ADD COLUMN winnaar_id INTEGER REFERENCES renners(id)",
    ]:
        try:
            conn.execute(col_sql)
            conn.commit()
        except Exception:
            pass  # kolom bestaat al

    # ── Multi-user: users tabel ───────────────────────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (date('now'))
        )
    """)

    # ── Multi-user: user_id toevoegen aan mijn_ploeg ──────────────────────────
    # SQLite ondersteunt geen DROP CONSTRAINT, dus we recreëren de tabel.
    _ploeg_cols = {row[1] for row in conn.execute("PRAGMA table_info(mijn_ploeg)").fetchall()}
    if 'user_id' not in _ploeg_cols:
        conn.execute("ALTER TABLE mijn_ploeg RENAME TO mijn_ploeg_old")
        conn.execute("""
            CREATE TABLE mijn_ploeg (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                renner_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL DEFAULT 1,
                positie TEXT DEFAULT 'bus' CHECK(positie IN ('starter','bus')),
                is_kopman INTEGER DEFAULT 0,
                aangeschaft_op TEXT DEFAULT (date('now')),
                UNIQUE(renner_id, user_id),
                FOREIGN KEY (renner_id) REFERENCES renners(id)
            )
        """)
        conn.execute("""
            INSERT INTO mijn_ploeg (id, renner_id, user_id, positie, is_kopman, aangeschaft_op)
            SELECT id, renner_id, 1, positie, is_kopman, aangeschaft_op FROM mijn_ploeg_old
        """)
        conn.execute("DROP TABLE mijn_ploeg_old")
        conn.commit()

    # ── Multi-user: user_id toevoegen aan opstelling ──────────────────────────
    _ops_cols = {row[1] for row in conn.execute("PRAGMA table_info(opstelling)").fetchall()}
    if 'user_id' not in _ops_cols:
        conn.execute("ALTER TABLE opstelling RENAME TO opstelling_old")
        conn.execute("""
            CREATE TABLE opstelling (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                koers_id INTEGER NOT NULL,
                renner_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL DEFAULT 1,
                is_kopman INTEGER DEFAULT 0,
                UNIQUE(koers_id, renner_id, user_id),
                FOREIGN KEY (koers_id) REFERENCES koersen(id),
                FOREIGN KEY (renner_id) REFERENCES renners(id)
            )
        """)
        conn.execute("""
            INSERT INTO opstelling (id, koers_id, renner_id, user_id, is_kopman)
            SELECT id, koers_id, renner_id, 1, is_kopman FROM opstelling_old
        """)
        conn.execute("DROP TABLE opstelling_old")
        conn.commit()

    # ── Multi-user: user_id toevoegen aan resultaten ──────────────────────────
    _res_cols = {row[1] for row in conn.execute("PRAGMA table_info(resultaten)").fetchall()}
    if 'user_id' not in _res_cols:
        conn.execute("ALTER TABLE resultaten RENAME TO resultaten_old")
        conn.execute("""
            CREATE TABLE resultaten (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                koers_id INTEGER NOT NULL,
                renner_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL DEFAULT 1,
                positie INTEGER,
                punten INTEGER NOT NULL DEFAULT 0,
                bonuspunten_kopman INTEGER DEFAULT 0,
                bonuspunten_ploegmaat INTEGER DEFAULT 0,
                UNIQUE(koers_id, renner_id, user_id),
                FOREIGN KEY (koers_id) REFERENCES koersen(id),
                FOREIGN KEY (renner_id) REFERENCES renners(id)
            )
        """)
        conn.execute("""
            INSERT INTO resultaten
                (id, koers_id, renner_id, user_id, positie, punten, bonuspunten_kopman, bonuspunten_ploegmaat)
            SELECT id, koers_id, renner_id, 1, positie, punten, bonuspunten_kopman, bonuspunten_ploegmaat
            FROM resultaten_old
        """)
        conn.execute("DROP TABLE resultaten_old")
        conn.commit()

    # ── Multi-user: user_id toevoegen aan transfers + geplande_transfers ──────
    for _col_sql in [
        "ALTER TABLE transfers ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE geplande_transfers ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1",
    ]:
        try:
            conn.execute(_col_sql)
            conn.commit()
        except Exception:
            pass  # Kolom bestaat al

    # ── Multi-user bootstrap: eerste admin aanmaken ───────────────────────────
    _user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if _user_count == 0:
        try:
            from werkzeug.security import generate_password_hash as _gen_hash
            _app_password = os.environ.get('APP_PASSWORD', 'admin')
            _admin_hash = _gen_hash(_app_password, method='pbkdf2:sha256')
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)",
                ('admin', _admin_hash)
            )
            conn.commit()
        except Exception:
            pass  # werkzeug niet beschikbaar → skip bootstrap

    # Migratie: historiek_renner tabel (uitslagen vorig seizoen, display-only)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS historiek_renner (
            renner_id INTEGER NOT NULL,
            seizoen   INTEGER NOT NULL,
            koers_naam TEXT NOT NULL,
            positie   INTEGER,
            datum     TEXT,
            PRIMARY KEY (renner_id, seizoen, koers_naam),
            FOREIGN KEY (renner_id) REFERENCES renners(id)
        )
    """)

    # Migratie: geplande_transfers tabel (voor bestaande databases)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS geplande_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            renner_uit_id INTEGER NOT NULL,
            renner_in_id INTEGER NOT NULL,
            datum TEXT NOT NULL,
            aangemaakt_op TEXT DEFAULT (date('now')),
            FOREIGN KEY (renner_uit_id) REFERENCES renners(id),
            FOREIGN KEY (renner_in_id) REFERENCES renners(id)
        )
    """)

    # Migratie: renner_aliassen tabel (naam-aliassen voor PCS/Sporza matching)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS renner_aliassen (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            renner_id INTEGER NOT NULL,
            alias     TEXT    NOT NULL UNIQUE,
            FOREIGN KEY (renner_id) REFERENCES renners(id) ON DELETE CASCADE
        )
    """)

    # Pre-populate bekende aliassen (idempotent via INSERT OR IGNORE)
    seed_aliassen = [
        # Tom Pidcock: volledige naam is Thomas, PCS toont "PIDCOCK Thomas"
        ('Tom Pidcock',    'thomas pidcock'),
        ('Tom Pidcock',    'pidcock thomas'),
        # A.W. Philipsen: PCS toont "Withen Philipsen Albert"
        ('A.W. Philipsen', 'albert withen philipsen'),
        ('A.W. Philipsen', 'withen philipsen albert'),
        ('A.W. Philipsen', 'philipsen albert withen'),
        ('A.W. Philipsen', 'a.w. philipsen'),
    ]
    for db_naam, alias in seed_aliassen:
        row = conn.execute(
            "SELECT id FROM renners WHERE lower(trim(naam))=lower(trim(?))", (db_naam,)
        ).fetchone()
        if row:
            conn.execute(
                "INSERT OR IGNORE INTO renner_aliassen (renner_id, alias) VALUES (?,?)",
                (row['id'], alias)
            )

    conn.commit()
    conn.close()


# ── Puntentelling per koerssoort ──────────────────────────────────────────────
PUNTEN = {
    'monument': {
        1: 125, 2: 100, 3: 80,  4: 70,  5: 60,  6: 55,  7: 50,
        8: 45,  9: 40,  10: 37, 11: 34, 12: 31, 13: 28, 14: 25,
        15: 22, 16: 20, 17: 18, 18: 16, 19: 14, 20: 12, 21: 10,
        22: 9,  23: 8,  24: 7,  25: 6,  26: 5,  27: 4,  28: 3,
        29: 2,  30: 1,
    },
    'worldtour': {
        1: 100, 2: 80,  3: 65,  4: 55,  5: 48,  6: 44,  7: 40,
        8: 36,  9: 32,  10: 30, 11: 27, 12: 24, 13: 22, 14: 20,
        15: 18, 16: 16, 17: 14, 18: 12, 19: 10, 20: 9,  21: 8,
        22: 7,  23: 6,  24: 5,  25: 4,  26: 3,  27: 2,  28: 2,
        29: 1,  30: 1,
    },
    'niet_wt': {
        1: 80,  2: 64,  3: 52,  4: 44,  5: 38,  6: 35,  7: 32,
        8: 29,  9: 26,  10: 24, 11: 22, 12: 20, 13: 18, 14: 16,
        15: 14, 16: 12, 17: 11, 18: 10, 19: 9,  20: 8,  21: 7,
        22: 6,  23: 5,  24: 4,  25: 3,  26: 3,  27: 2,  28: 2,
        29: 1,  30: 1,
    },
}

KOPMAN_BONUS = {1: 30, 2: 25, 3: 20, 4: 15, 5: 10, 6: 5}


def punten_voor_positie(soort, positie):
    tabel = PUNTEN.get(soort, PUNTEN['niet_wt'])
    return tabel.get(positie, 0)


def kopman_bonus(positie):
    return KOPMAN_BONUS.get(positie, 0)


def transfer_kosten(transfer_nummer, gratis=3):
    """Bereken de kost van een transfer op basis van het volgnummer."""
    if transfer_nummer <= gratis:
        return 0
    return transfer_nummer - gratis


def seed_renners():
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) FROM renners").fetchone()[0]
    if count > 0:
        conn.close()
        return

    renners = [
        # (naam, ploeg, rol, prijs)
        ("Tadej Pogacar",        "UAE Team Emirates",            "allrounder",  28.0),
        ("Mathieu van der Poel", "Alpecin-Deceuninck",           "allrounder",  24.0),
        ("Wout van Aert",        "Visma-Lease a Bike",           "allrounder",  23.0),
        ("Remco Evenepoel",      "Soudal Quick-Step",            "allrounder",  22.0),
        ("Jonas Vingegaard",     "Visma-Lease a Bike",           "klimmer",     20.0),
        ("Mads Pedersen",        "Lidl-Trek",                    "sprinter",    16.0),
        ("Jasper Philipsen",     "Alpecin-Deceuninck",           "sprinter",    15.0),
        ("Tom Pidcock",          "Q36.5",                        "allrounder",  15.0),
        ("Julian Alaphilippe",   "Tudor Pro Cycling",            "allrounder",  14.0),
        ("Filippo Ganna",        "Ineos Grenadiers",             "tijdrijder",  13.0),
        ("Biniam Girmay",        "Intermarché-Wanty",            "sprinter",    13.0),
        ("Primoz Roglic",        "Red Bull-Bora-Hansgrohe",      "allrounder",  12.0),
        ("Christophe Laporte",   "Visma-Lease a Bike",           "sprinter",    12.0),
        ("Maxim Van Gils",       "Lotto Dstny",                  "allrounder",  11.0),
        ("Quinten Hermans",      "Alpecin-Deceuninck",           "allrounder",  11.0),
        ("Dylan van Baarle",     "Visma-Lease a Bike",           "allrounder",  10.0),
        ("Mattias Skjelmose",    "Lidl-Trek",                    "klimmer",     10.0),
        ("Arnaud De Lie",        "Lotto Dstny",                  "sprinter",     9.0),
        ("Tim Merlier",          "Soudal Quick-Step",            "sprinter",     9.0),
        ("Oliver Naesen",        "Decathlon AG2R",               "allrounder",   8.0),
        ("Sep Vanmarcke",        "Israel-Premier Tech",          "allrounder",   8.0),
        ("Søren Kragh Andersen", "Alpecin-Deceuninck",           "allrounder",   8.0),
        ("Tiesj Benoot",         "Visma-Lease a Bike",           "allrounder",   8.0),
        ("Alex Aranburu",        "Movistar",                     "allrounder",   7.0),
        ("Stefan Küng",          "Groupama-FDJ",                 "tijdrijder",   7.0),
        ("Yves Lampaert",        "Soudal Quick-Step",            "tijdrijder",   7.0),
        ("Nils Politt",          "UAE Team Emirates",            "allrounder",   6.0),
        ("Gianni Vermeersch",    "Alpecin-Deceuninck",           "helper",       5.0),
        ("Dries De Bondt",       "Decathlon AG2R",               "helper",       5.0),
        ("Xandro Meurisse",      "Alpecin-Deceuninck",           "helper",       4.0),
        ("Lawrence Naesen",      "Decathlon AG2R",               "allrounder",   5.0),
        ("Florian Vermeersch",   "Lotto Dstny",                  "allrounder",   6.0),
        ("Stan Van Tricht",      "Soudal Quick-Step",            "helper",       4.0),
        ("Jenno Berckmoes",      "Visma-Lease a Bike",           "helper",       4.0),
        ("Rein Taaramäe",        "Intermarché-Wanty",            "klimmer",      5.0),
        ("Guillaume Martin",     "Cofidis",                      "klimmer",      6.0),
        ("Ben Healy",            "EF Education-EasyPost",        "allrounder",   8.0),
        ("Valentin Madouas",     "Groupama-FDJ",                 "allrounder",   7.0),
        ("Anthony Turgis",       "Lidl-Trek",                    "allrounder",   7.0),
        ("Fred Wright",          "Bahrain Victorious",           "allrounder",   6.0),
    ]

    conn.executemany(
        "INSERT INTO renners (naam, ploeg, rol, prijs) VALUES (?,?,?,?)",
        renners
    )
    conn.commit()
    conn.close()


def seed_koersen():
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) FROM koersen").fetchone()[0]
    if count > 0:
        conn.close()
        return

    # Echte Sporza Wielermanager Voorjaar 2026 kalender (19 koersen)
    koersen = [
        # (naam, datum, soort, afgelopen)
        ("Omloop Het Nieuwsblad",    "2026-02-28", "worldtour", 1),
        ("Kuurne-Brussel-Kuurne",    "2026-03-01", "niet_wt",   1),
        ("Samyn Classic",            "2026-03-03", "niet_wt",   0),
        ("Strade Bianche",           "2026-03-07", "worldtour", 0),
        ("Nokere Koerse",            "2026-03-18", "niet_wt",   0),
        ("Bredene Koksijde Classic", "2026-03-20", "niet_wt",   0),
        ("Milaan-Sanremo",           "2026-03-21", "monument",  0),
        ("Ronde van Brugge",         "2026-03-25", "worldtour", 0),
        ("E3 Saxo Classic",          "2026-03-27", "worldtour", 0),
        ("Dwars door Vlaanderen",    "2026-04-01", "worldtour", 0),
        ("Ronde van Vlaanderen",     "2026-04-05", "monument",  0),
        ("Scheldeprijs",             "2026-04-08", "niet_wt",   0),
        ("Parijs-Roubaix",           "2026-04-12", "monument",  0),
        ("Ronde van Limburg",        "2026-04-15", "niet_wt",   0),
        ("Brabantse Pijl",           "2026-04-17", "niet_wt",   0),
        ("Amstel Gold Race",         "2026-04-19", "worldtour", 0),
        ("Waalse Pijl",              "2026-04-22", "worldtour", 0),
        ("Luik-Bastenaken-Luik",     "2026-04-26", "monument",  0),
        ("Eschborn-Frankfurt",       "2026-05-01", "worldtour", 0),
    ]

    conn.executemany(
        "INSERT INTO koersen (naam, datum, soort, afgelopen) VALUES (?,?,?,?)",
        koersen
    )
    conn.commit()
    conn.close()
