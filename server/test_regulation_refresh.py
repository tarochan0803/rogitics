import json
import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import HTTPServer
from pathlib import Path
from urllib import error, request

# Allow both `python3 -m server.test_regulation_refresh` (run from the project root) and
# `python3 server/test_regulation_refresh.py` (which otherwise only puts server/ on the
# path) by self-inserting the project root so `web_server` and `server.*` both import.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import web_server  # noqa: E402
from server.regulation_refresh import (  # noqa: E402
    JARTIC_OPEN_DATA_URL,
    JARTIC_CATALOG_URL,
    NPA_SPEC_URL,
    OVERPASS_ENDPOINTS,
    RegulationFetchError,
    RegulationInputError,
    RegulationRefreshService,
    _overpass_query,
    validate_bbox,
)


BBOX = [139.7000, 35.6000, 139.7100, 35.6100]


class Clock:
    def __init__(self):
        self.value = datetime(2026, 7, 13, tzinfo=timezone.utc)

    def now(self):
        return self.value

    def advance(self, **kwargs):
        self.value += timedelta(**kwargs)


class FakeUpstream:
    def __init__(self):
        self.osm = b'{"version":0.6,"elements":[{"type":"way","id":7}]}'
        self.npa = b"npa-v1"
        self.jartic = json.dumps([{
            "type": "typeD",
            "targetMonth": "2026年05月",
            "releaseDay": "2026年07月01日",
            "targetList": [{"id": "R13", "link": "/202607010000/typeD_tokyo.zip"}],
        }]).encode("utf-8")
        self.fail_overpass = False
        self.calls = []

    def __call__(self, url, method, data, timeout, max_bytes):
        self.calls.append((url, method, data))
        if url in OVERPASS_ENDPOINTS:
            if self.fail_overpass:
                raise RegulationFetchError("offline")
            return self.osm, {"content-type": "application/json"}
        if url == NPA_SPEC_URL:
            return self.npa, {"last-modified": "Mon, 13 Jul 2026 00:00:00 GMT"}
        if url == JARTIC_CATALOG_URL:
            return self.jartic, {"last-modified": "Mon, 13 Jul 2026 00:00:00 GMT"}
        raise AssertionError(url)


class BlockingUpstream:
    """Signals when a refresh has entered a network fetch, then blocks until released.

    Used to deterministically reproduce a refresh holding the service lock across slow
    network I/O so a concurrent status() poll can be timed.
    """

    def __init__(self):
        self.base = FakeUpstream()
        self.entered = threading.Event()
        self.release = threading.Event()

    def __call__(self, url, method, data, timeout, max_bytes):
        self.entered.set()
        if not self.release.wait(timeout=10):
            raise RegulationFetchError("blocking upstream was never released")
        return self.base(url, method, data, timeout, max_bytes)


class RegulationRefreshServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.upstream = FakeUpstream()
        self.service = RegulationRefreshService(Path(self.temp.name), fetch=self.upstream, now=self.clock.now)

    def tearDown(self):
        self.temp.cleanup()

    def test_refresh_persists_raw_data_and_public_change_metadata(self):
        result = self.service.refresh(BBOX, force=True)
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["overall"], "stale")
        self.assertEqual(result["sources"]["osm"]["elementCount"], 1)
        self.assertFalse(result["sources"]["npaSpec"]["reviewRequired"])
        jartic = result["sources"]["jarticOpenData"]
        self.assertEqual(jartic["sourceUrl"], JARTIC_OPEN_DATA_URL)
        self.assertEqual(jartic["lastModified"], "Mon, 13 Jul 2026 00:00:00 GMT")
        self.assertTrue(jartic["notConfigured"])
        self.assertEqual(jartic["dataStatus"], "catalogAvailable")
        self.assertEqual(jartic["targetMonth"], "2026年05月")
        self.assertEqual(jartic["artifactCount"], 1)
        self.assertFalse(jartic["changeDetected"])
        self.assertFalse(jartic["reviewRequired"])
        self.assertTrue(any(Path(self.temp.name).glob("osm-*.json")))
        self.assertTrue((Path(self.temp.name) / "index.json").exists())
        audit = (Path(self.temp.name) / "audit.jsonl").read_text(encoding="utf-8")
        self.assertIn("osm_refresh_succeeded", audit)
        self.assertNotIn("elements", json.dumps(self.service.status(BBOX)))
        self.assertEqual(result["overpass"]["elements"][0]["id"], 7)

    def test_overpass_query_covers_all_supported_regulation_shapes(self):
        query = _overpass_query(tuple(BBOX))
        self.assertIn('relation["type"~"^restriction"]', query)
        self.assertIn('node["barrier"]', query)
        self.assertIn('node["highway"~"^(stop|give_way)$"]', query)
        self.assertIn('way["highway"~', query)
        self.assertIn('out meta geom', query)

    def test_failed_refresh_keeps_last_known_good_and_changed_references_require_review(self):
        self.service.refresh(BBOX, force=True)
        raw_file = next(Path(self.temp.name).glob("osm-*.json"))
        original_raw = raw_file.read_bytes()
        self.upstream.fail_overpass = True
        self.upstream.npa = b"npa-v2"
        self.upstream.jartic = json.dumps([{
            "type": "typeD",
            "targetMonth": "2026年06月",
            "releaseDay": "2026年08月01日",
            "targetList": [{"id": "R13", "link": "/202608010000/typeD_tokyo.zip"}],
        }]).encode("utf-8")
        self.clock.advance(minutes=16)
        result = self.service.refresh(BBOX, force=True)
        # A transient fetch failure over a still-fresh LKG stays "fresh" (not "error"),
        # but the failure is surfaced via degraded/error so it never fails open silently.
        self.assertEqual(result["sources"]["osm"]["state"], "fresh")
        self.assertTrue(result["sources"]["osm"]["degraded"])
        self.assertIsNotNone(result["sources"]["osm"]["error"])
        self.assertTrue(result["sources"]["osm"]["hasLastKnownGood"])
        self.assertEqual(raw_file.read_bytes(), original_raw)
        self.assertTrue(result["sources"]["npaSpec"]["reviewRequired"])
        self.assertTrue(result["sources"]["jarticOpenData"]["changeDetected"])
        self.assertTrue(result["sources"]["jarticOpenData"]["reviewRequired"])

    def test_stale_and_expired_metadata_do_not_return_payload(self):
        self.service.refresh(BBOX, force=True)
        self.clock.advance(hours=7)
        stale = self.service.status(BBOX)
        self.assertEqual(stale["sources"]["osm"]["freshness"], "stale")
        self.assertTrue(stale["sources"]["osm"]["stale"])
        self.clock.advance(hours=73)
        expired = self.service.status(BBOX)
        self.assertEqual(expired["sources"]["osm"]["freshness"], "expired")
        self.assertNotIn("elements", json.dumps(expired))

    def test_scheduled_refresh_updates_registered_aoi(self):
        self.service.refresh(BBOX, force=True)
        self.upstream.osm = b'{"version":0.6,"elements":[{"type":"way","id":8},{"type":"node","id":9}]}'
        self.clock.advance(minutes=16)
        self.service.run_scheduled_once()
        self.assertEqual(self.service.status(BBOX)["sources"]["osm"]["elementCount"], 2)

    def test_bbox_validation_rejects_oversized_and_invalid_inputs(self):
        with self.assertRaises(RegulationInputError):
            validate_bbox([139.0, 35.0, 139.0, 35.1])
        with self.assertRaises(RegulationInputError):
            validate_bbox([139.0, 35.0, 140.0, 36.0])
        with self.assertRaises(RegulationInputError):
            self.service.refresh(BBOX, force="yes")

    def test_fresh_lkg_survives_transient_error_with_degraded_visibility(self):
        # Bug 1: a single Overpass timeout over a still-fresh last-known-good must NOT
        # flip the source to "error" (which would fail closed to "requires confirmation").
        self.service.refresh(BBOX, force=True)  # establish LKG
        self.upstream.fail_overpass = True
        self.clock.advance(minutes=24)          # well inside the 6h stale window
        result = self.service.refresh(BBOX, force=True)
        osm = result["sources"]["osm"]
        self.assertEqual(osm["freshness"], "fresh")
        self.assertEqual(osm["state"], "fresh")
        self.assertTrue(osm["degraded"])
        self.assertEqual(osm["error"], "offline")
        self.assertTrue(osm["hasLastKnownGood"])
        self.assertEqual(osm["elementCount"], 1)
        # A degraded-but-fresh source must not drag `overall` into "error": overall of a
        # degraded OSM alongside otherwise-fresh sources is "fresh".
        fresh = {"state": "fresh", "freshness": "fresh"}
        self.assertEqual(self.service._overall((osm, dict(fresh), dict(fresh))), "fresh")
        # End-to-end, jartic is intentionally notConfigured -> "stale", so overall is a
        # fail-open "stale" (WARNING), crucially no longer "error"/UNKNOWN.
        self.assertEqual(result["overall"], "stale")

    def test_missing_lkg_with_error_is_overall_error(self):
        # Bug 1: with no last-known-good at all, an error IS authoritative.
        self.upstream.fail_overpass = True
        result = self.service.refresh(BBOX, force=True)
        osm = result["sources"]["osm"]
        self.assertFalse(osm["hasLastKnownGood"])
        self.assertEqual(osm["state"], "error")
        self.assertFalse(osm["degraded"])  # nothing to serve, so not "degraded"
        self.assertEqual(result["overall"], "error")

    def test_continuing_error_escalates_to_stale_after_threshold(self):
        # Bug 1: a persistent error lets the LKG age past the stale threshold, which is the
        # correct escalation (fresh -> stale -> expired), independent of lastError.
        self.service.refresh(BBOX, force=True)
        self.upstream.fail_overpass = True
        self.clock.advance(hours=7)  # beyond the 6h stale threshold
        result = self.service.refresh(BBOX, force=True)
        osm = result["sources"]["osm"]
        self.assertEqual(osm["freshness"], "stale")
        self.assertEqual(osm["state"], "stale")
        self.assertTrue(osm["hasLastKnownGood"])
        self.assertIsNotNone(osm["error"])
        self.assertEqual(result["overall"], "stale")

    def test_status_poll_is_not_blocked_by_in_flight_refresh(self):
        # Bug 2: status() must stay responsive while a refresh holds the service lock
        # across slow network I/O.
        blocker = BlockingUpstream()
        service = RegulationRefreshService(Path(self.temp.name), fetch=blocker, now=self.clock.now)
        worker = threading.Thread(target=lambda: service.refresh(BBOX, force=True), daemon=True)
        worker.start()
        self.assertTrue(blocker.entered.wait(timeout=5), "refresh never reached a network fetch")
        started = time.monotonic()
        status = service.status(BBOX)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.0, f"status() blocked {elapsed:.2f}s behind a locked refresh")
        self.assertIn("overall", status)
        blocker.release.set()
        worker.join(timeout=10)
        self.assertFalse(worker.is_alive())


class RegulationHttpContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.upstream = FakeUpstream()
        self.original_service = web_server.REGULATION_SERVICE
        web_server.REGULATION_SERVICE = RegulationRefreshService(Path(self.temp.name), fetch=self.upstream, now=self.clock.now)
        self.httpd = HTTPServer(("127.0.0.1", 0), web_server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.thread.join(timeout=2)
        self.httpd.server_close()
        web_server.REGULATION_SERVICE = self.original_service
        self.temp.cleanup()

    def test_refresh_and_status_contract(self):
        payload = json.dumps({"bbox": BBOX, "force": True}).encode("utf-8")
        req = request.Request(self.base_url + "/api/regulations/refresh", data=payload, headers={"Content-Type": "application/json"})
        with request.urlopen(req) as response:
            refreshed = json.loads(response.read())
        self.assertEqual(set(refreshed["sources"]), {"osm", "npaSpec", "jarticOpenData", "jarticJSystem"})
        self.assertEqual(refreshed["sources"]["jarticJSystem"]["state"], "not_configured")
        self.assertIn("overpass", refreshed)
        self.assertIsInstance(refreshed["overpass"], dict)
        with request.urlopen(self.base_url + "/api/regulations/status?bbox=139.7,35.6,139.71,35.61") as response:
            status = json.loads(response.read())
        self.assertEqual(status["schemaVersion"], refreshed["schemaVersion"])
        self.assertNotIn("overpass", status)
        self.assertNotIn("elements", json.dumps(status))

    def test_request_size_limit_and_invalid_bbox_return_client_errors(self):
        huge = b"{" + b"x" * (web_server.MAX_REGULATION_REQUEST_BYTES + 1) + b"}"
        req = request.Request(self.base_url + "/api/regulations/refresh", data=huge, headers={"Content-Type": "application/json"})
        with self.assertRaises(error.HTTPError) as caught:
            request.urlopen(req)
        self.assertEqual(caught.exception.code, 413)
        with self.assertRaises(error.HTTPError) as caught:
            request.urlopen(self.base_url + "/api/regulations/status?bbox=0,0,180,80")
        self.assertEqual(caught.exception.code, 400)
        with self.assertRaises(error.HTTPError) as caught:
            request.urlopen(self.base_url + "/api/regulations/status?bbox=" + "0" * (web_server.MAX_REGULATION_QUERY_BYTES + 1))
        self.assertEqual(caught.exception.code, 414)


if __name__ == "__main__":
    unittest.main()
