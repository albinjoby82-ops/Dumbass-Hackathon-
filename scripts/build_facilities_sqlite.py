import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "facilities.json"
TARGET = ROOT / "data" / "facilities.sqlite"

payload = json.loads(SOURCE.read_text(encoding="utf-8"))
connection = sqlite3.connect(TARGET)
connection.executescript("""
DROP TABLE IF EXISTS facility_services;
DROP TABLE IF EXISTS opening_periods;
DROP TABLE IF EXISTS facilities;
CREATE TABLE facilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  postcode TEXT NOT NULL,
  borough TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  urgent_care_type TEXT,
  urgent_access TEXT,
  urgent_hours_status TEXT,
  urgent_hours_label TEXT,
  minimum_age_years REAL,
  appointment_required INTEGER,
  walk_in INTEGER,
  co_located_with_ed INTEGER,
  urgent_notes TEXT,
  source_url TEXT NOT NULL,
  verified_date TEXT NOT NULL
);
CREATE TABLE facility_services (
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  service_code TEXT NOT NULL,
  PRIMARY KEY (facility_id, service_code)
);
CREATE TABLE opening_periods (
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  iso_weekday INTEGER NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7),
  opens TEXT NOT NULL,
  closes TEXT NOT NULL,
  PRIMARY KEY (facility_id, iso_weekday, opens)
);
CREATE INDEX facilities_postcode_idx ON facilities(postcode);
CREATE INDEX facilities_borough_idx ON facilities(borough);
CREATE INDEX facility_services_code_idx ON facility_services(service_code);
""")

for item in payload["facilities"]:
    urgent = item.get("urgentCare") or {}
    connection.execute(
        "INSERT INTO facilities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (item["id"], item["name"], item.get("address"), item["postcode"], item.get("borough"),
         item["lat"], item["lng"], urgent.get("type"), urgent.get("access"), urgent.get("hoursStatus"),
         urgent.get("hoursLabel"), urgent.get("ageMinYears"),
         int(urgent.get("appointmentRequired", False)) if urgent else None,
         int(urgent.get("walkIn", False)) if urgent else None,
         int(urgent.get("coLocatedWithEd", False)) if urgent else None, urgent.get("notes"),
         item["source"], item["verified"]),
    )
    connection.executemany(
        "INSERT INTO facility_services VALUES (?, ?)",
        [(item["id"], code) for code in item["services"]],
    )
    for period in urgent.get("weekly", []):
        connection.executemany(
            "INSERT INTO opening_periods VALUES (?, ?, ?, ?)",
            [(item["id"], day, period["open"], period["close"]) for day in period["days"]],
        )

connection.commit()
connection.close()
print(f"Created {TARGET} with {len(payload['facilities'])} facilities")
