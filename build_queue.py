#!/usr/bin/env python3
"""Builds queue.json (your call list) from the free FMCSA Company Census File.

  python build_queue.py                    download census (first run only) and build the queue
  python build_queue.py --columns          print the census column names and stop
  python build_queue.py --start-mc 1290000 start the queue at this MC number
  python build_queue.py --max-fleet 200    optional build-time cap (the side panel controls the live limit)
  python build_queue.py --census file.csv  use a census CSV you downloaded yourself
"""
import argparse, csv, json, os, re, sys, urllib.request
from collections import Counter

URL = "https://data.transportation.gov/api/v3/views/az4n-8mr2/export.csv?accessType=DOWNLOAD"
LOWER48 = set("AL AR AZ CA CO CT DE FL GA IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT "
              "NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY".split())

# Column-name aliases (lowercase). The script matches whichever one exists in the file.
ALIASES = {
    "dot": ["dot_number", "dotnumber", "usdot_number"],
    "name": ["legal_name", "legalname"],
    "dba": ["dba_name", "dbaname"],
    "status": ["status_code", "statuscode"],
    "operation": ["carrier_operation", "carrieroperation"],
    "cls": ["classdef", "carrier_class", "carrierclass"],
    "street": ["phy_street", "physical_street"], "city": ["phy_city"], "state": ["phy_state"],
    "zip": ["phy_zip"], "country": ["phy_country"],
    "phone": ["telephone", "phone"], "cell": ["cell_phone", "cellphone"],
    "email": ["email_address", "email"],
    "units": ["nbr_power_unit", "power_units", "powerunits"],
    "drivers": ["driver_total", "total_drivers", "totaldrivers"],
    "added": ["add_date", "added_date", "adddate"], "mcs150": ["mcs150_date", "mcs150date"],
    "off1": ["company_officer_1", "officer_1"], "off2": ["company_officer_2", "officer_2"],
    "genfreight": ["crgo_genfreight", "general_freight"],
    "hm": ["hm_flag", "hm_ind", "hazmat"],
}


def pick(headers, key):
    for a in ALIASES[key]:
        if a in headers:
            return headers[a]
    return None


def norm_phone(v):
    d = re.sub(r"\D", "", v or "")
    if len(d) == 11 and d[0] == "1":
        d = d[1:]
    if len(d) != 10 or d[0] in "01" or d[3] in "01" or len(set(d)) == 1:
        return None
    return d


def norm_date(v):
    v = (v or "").strip()
    m = re.match(r"^(\d{4})-?(\d{2})-?(\d{2})", v)
    if m:
        return f"{m[1]}-{m[2]}-{m[3]}"
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", v)
    if m:
        return f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}"
    return v


def active(v):
    return (v or "").strip().upper()[:1] == "A"


def truthy(v):
    return (v or "").strip().upper() in ("X", "Y", "1", "TRUE", "T")


def download(path, insecure=False):
    import shutil, ssl, subprocess
    print("Downloading the FMCSA census (large file, a few minutes)...")
    ctx = None
    if insecure:
        ctx = ssl._create_unverified_context()
        ctx.options |= getattr(ssl, "OP_IGNORE_UNEXPECTED_EOF", 0)
    req = urllib.request.Request(URL, headers={"User-Agent": "dispatch-dialer/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as r, open(path, "wb") as f:
            total, done = int(r.headers.get("Content-Length") or 0), 0
            while chunk := r.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
                print(f"\r  {done >> 20} MB" + (f" / {total >> 20} MB" if total else ""), end="")
        print()
        return
    except PermissionError:
        sys.exit("\nWindows will not let this folder be written to (Program Files is protected).\n"
                 "Move the whole dispatch-dialer folder to your Desktop or Documents and run again.")
    except Exception as e:
        err = str(e)
    if os.path.exists(path):
        os.remove(path)
    if "CERTIFICATE_VERIFY_FAILED" in err and shutil.which("curl"):
        print("\nPython could not verify the website certificate. Retrying with Windows' own downloader (curl)...")
        part = path + ".part"
        rc = subprocess.call(["curl", "-L", "--fail", "--ssl-no-revoke", "-o", part, URL])
        size = os.path.getsize(part) if os.path.exists(part) else 0
        # curl error 56 at the very end ("server closed abruptly") is common on Windows and the file is
        # normally complete, so a big file is kept. Any half-written last line is cut off.
        if (rc == 0 and size > 1_000_000) or (rc == 56 and size > 500_000_000):
            with open(part, "rb+") as f:
                f.seek(0, 2)
                end = f.tell()
                f.seek(max(0, end - 1_000_000))
                tail = f.read()
                if not tail.endswith(b"\n"):
                    f.truncate(end - len(tail) + tail.rfind(b"\n") + 1)
            os.replace(part, path)
            print(f"\nDownloaded {size >> 20} MB." + ("" if rc == 0 else " (Windows reported a closing error, the file was kept.)"))
            return
        if os.path.exists(part):
            os.remove(part)
    sys.exit(f"\nDownload failed: {err}\n"
             "Option 1: download the CSV in Chrome from https://data.transportation.gov/d/az4n-8mr2 "
             "(Export > CSV), save it in this folder as census.csv, then run: python build_queue.py\n"
             "Option 2: run: python build_queue.py --insecure   (skips the certificate check; the data is public)")


def safe_rows(rd):
    """Yield rows; a damaged line becomes an empty row instead of stopping the run."""
    while True:
        try:
            yield next(rd)
        except StopIteration:
            return
        except csv.Error:
            yield {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--census", default="census.csv")
    ap.add_argument("--refresh", action="store_true", help="re-download the census")
    ap.add_argument("--insecure", action="store_true", help="skip the SSL certificate check when downloading")
    ap.add_argument("--out", default="queue.json")
    ap.add_argument("--columns", action="store_true")
    ap.add_argument("--start-mc", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0, help="stop after this many leads (0 = all)")
    ap.add_argument("--max-fleet", type=int, default=9999, help="build-time cap; the side panel sets the live limit")
    ap.add_argument("--min-fleet", type=int, default=0)
    ap.add_argument("--no-cell-fallback", action="store_true", help="never use the cell phone field")
    a = ap.parse_args()

    if a.refresh or not os.path.exists(a.census):
        download(a.census, a.insecure)
    csv.field_size_limit(1 << 24)
    f = open(a.census, newline="", encoding="utf-8", errors="replace")
    rd = csv.DictReader(f)
    H = {h.strip().lower(): h for h in rd.fieldnames or []}
    if a.columns:
        print("\n".join(rd.fieldnames))
        return

    C = {k: pick(H, k) for k in ALIASES}
    need = ["dot", "name", "state", "phone", "units", "genfreight"]
    miss = [k for k in need if not C[k]]
    # Docket / authority columns
    dock = {n: (H.get(f"docket{n}prefix") or H.get(f"docket{n}_prefix"), H.get(f"docket{n}"),
                [h for l, h in H.items() if re.match(rf"docket{n}.*stat", l)]) for n in (1, 2, 3)}
    auth = {k: [h for l, h in H.items() if k in l and ("stat" in l or "auth" in l)]
            for k in ("common", "contract", "broker")}
    has_dock_status = any(d[2] for d in dock.values())
    if not any(d[1] for d in dock.values()) or not (has_dock_status or auth["common"] or auth["contract"]):
        miss.append("docket/authority status")
    if miss:
        sys.exit("Could not find these columns in the census file: " + ", ".join(miss) +
                 "\nRun with --columns and send me that list so I can map them.")
    if not auth["broker"]:
        print("WARNING: no broker-authority column found, so broker-only/carrier+broker records "
              "cannot be excluded. Check the SAFER link before dialing.")

    why, leads, seen = Counter(), [], set()
    g = lambda row, k: (row.get(C[k]) or "").strip() if C[k] else ""
    for row in safe_rows(rd):
        try:
            why["rows read"] += 1
            if C["status"] and not active(g(row, "status")):
                why["rejected: USDOT not active"] += 1; continue
            # MC number = first docket with prefix MC
            mc, mcn = None, None
            for n, (pre, num, sts) in dock.items():
                if pre and num and (row.get(pre) or "").strip().upper() == "MC" and (row.get(num) or "").strip():
                    mc, mcn = re.sub(r"\D", "", row[num]), n
                    break
            if not mc:
                why["rejected: no MC number"] += 1; continue
            if any((row.get(p) or "").strip().upper() == "FF" for p, _, _ in dock.values() if p):
                why["rejected: freight forwarder"] += 1; continue
            # Authority
            if dock[mcn][2]:
                ok = any(active(row.get(h)) for h in dock[mcn][2])
            else:
                ok = any(active(row.get(h)) for h in auth["common"] + auth["contract"])
            if not ok:
                why["rejected: MC not authorized"] += 1; continue
            if any(active(row.get(h)) for h in auth["broker"]):
                why["rejected: broker / carrier+broker"] += 1; continue
            if not truthy(g(row, "genfreight")):
                why["rejected: no General Freight"] += 1; continue
            country = g(row, "country").upper()
            st = g(row, "state").upper()
            if (country and country != "US") or st not in LOWER48:
                why["rejected: outside the 48 states"] += 1; continue
            try:
                units = int(float(g(row, "units") or 0))
            except ValueError:
                units = -1
            if units < a.min_fleet or units > a.max_fleet:
                why[f"rejected: fleet not {a.min_fleet}-{a.max_fleet}"] += 1; continue
            ph = norm_phone(g(row, "phone"))
            alt = norm_phone(g(row, "cell"))
            if not ph and alt and not a.no_cell_fallback:
                ph, alt = alt, None
            if not ph:
                why["rejected: no valid phone"] += 1; continue
            if mc in seen:
                why["rejected: duplicate MC"] += 1; continue
            seen.add(mc)
            if int(mc) < a.start_mc:
                why["skipped: below --start-mc"] += 1; continue
            try:
                drivers = int(float(g(row, "drivers") or 0))
            except ValueError:
                drivers = None
            leads.append({
                "mc": mc, "dot": g(row, "dot"), "name": g(row, "name"), "dba": g(row, "dba"),
                "phone": ph, "phone2": alt if alt != ph else None, "email": g(row, "email").lower(),
                "owner": " / ".join(x for x in (g(row, "off1"), g(row, "off2")) if x),
                "street": g(row, "street"), "city": g(row, "city"), "state": st, "zip": g(row, "zip"),
                "units": units, "drivers": drivers, "added": norm_date(g(row, "added")),
                "mcs150": norm_date(g(row, "mcs150")), "op": g(row, "operation"), "cls": g(row, "cls"),
                "hazmat": truthy(g(row, "hm")),
            })
        except Exception:
            why["rejected: unreadable row"] += 1
            continue

    leads.sort(key=lambda c: int(c["mc"]))
    if a.limit:
        leads = leads[: a.limit]
    with open(a.out, "w", encoding="utf-8") as o:
        json.dump(leads, o)
    print("\n--- Filter funnel ---")
    for k, v in why.items():
        print(f"{v:>10,}  {k}")
    print(f"\nQueue ready: {len(leads):,} carriers -> {a.out}")
    if leads:
        print(f"MC range: {leads[0]['mc']} to {leads[-1]['mc']}")


if __name__ == "__main__":
    main()
