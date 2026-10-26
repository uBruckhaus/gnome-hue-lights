#!/usr/bin/env python3
"""A pretend Hue bridge for the headless tests: CLIP v2 over HTTPS with made-up rooms,
lights and scenes. It never talks to a real bridge.

    mock-bridge.py --ip <private IPv4> --port <n> --cert c.pem --key k.pem [--log commands.log]
                   [--presses N]

PUT /clip/v2/resource/<light|grouped_light|scene>/<id> changes the pretend state and is
appended to --log, so a test can check what the extension sent. POST /api answers
"link button not pressed" N times (--presses), then hands out an app key.
"""
import argparse
import json
import ssl
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BRIDGE_ID = "001788FFFE5A3C21"   # the certificate's CN must match it
APP_KEY = "mock-app-key-1234567890"


def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, "hue-mock." + name))


LIGHTS = {
    # name: (room, on, brightness or None (not dimmable), colour, reachable)
    "Ceiling": ("Living room", True, 70.0, {"mirek": 366}, True),
    "Floor lamp": ("Living room", True, 55.0, {"xy": (0.55, 0.40)}, True),
    "TV strip": ("Living room", True, 80.0, {"xy": (0.17, 0.05)}, True),
    "Spots 1": ("Kitchen", False, 100.0, {"mirek": 300}, True),
    "Spots 2": ("Kitchen", False, 100.0, {"mirek": 300}, True),
    "Bedside": ("Bedroom", True, 20.0, {"mirek": 454}, True),
    "Bedroom ceiling": ("Bedroom", False, 50.0, {"mirek": 370}, False),
    "Desk lamp": ("Office", True, 100.0, {"mirek": 233}, True),
    "Garden plug": (None, False, None, None, True),
}
ROOMS = {"Living room": "living_room", "Kitchen": "kitchen", "Bedroom": "bedroom", "Office": "office"}
ZONES = {"Downstairs": ["Living room", "Kitchen"]}
SCENES = {"Living room": ["Relax", "Read", "Concentrate", "Energize", "Nightlight", "Bright", "Dimmed", "Savanna sunset"],
          "Bedroom": ["Nightlight", "Relax"]}
ACTIVE = {("Living room", "Relax")}


class State:
    def __init__(self, log, presses):
        self.lock = threading.Lock()
        self.log, self.presses = log, presses
        self.lights = {name: {"on": on, "bri": bri} for name, (_, on, bri, _, _) in LIGHTS.items()}
        self.active = set(ACTIVE)

    def record(self, line):
        if self.log:
            with open(self.log, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")

    def resources(self):
        out = []
        with self.lock:
            for name, (room, _, _, colour, reachable) in LIGHTS.items():
                lid, did = uid("light." + name), uid("device." + name)
                light = {"id": lid, "type": "light", "owner": {"rid": did, "rtype": "device"},
                         "metadata": {"name": name}, "on": {"on": self.lights[name]["on"]}}
                if self.lights[name]["bri"] is not None:
                    light["dimming"] = {"brightness": self.lights[name]["bri"]}
                if colour and "mirek" in colour:
                    light["color_temperature"] = {"mirek": colour["mirek"], "mirek_valid": True}
                if colour and "xy" in colour:
                    light["color"] = {"xy": {"x": colour["xy"][0], "y": colour["xy"][1]}}
                out.append(light)
                out.append({"id": did, "type": "device", "services": [{"rid": lid, "rtype": "light"}]})
                out.append({"id": uid("zc." + name), "type": "zigbee_connectivity", "owner": {"rid": did, "rtype": "device"},
                            "status": "connected" if reachable else "connectivity_issue"})
            for room, archetype in ROOMS.items():
                members = [n for n, v in LIGHTS.items() if v[0] == room]
                lit = [self.lights[n]["bri"] for n in members if self.lights[n]["on"]]
                gl = uid("gl." + room)
                out.append({"id": gl, "type": "grouped_light", "on": {"on": bool(lit)},
                            "dimming": {"brightness": round(sum(lit) / len(lit), 1) if lit else 0.0}})
                out.append({"id": uid("room." + room), "type": "room", "metadata": {"name": room, "archetype": archetype},
                            "children": [{"rid": uid("device." + n), "rtype": "device"} for n in members],
                            "services": [{"rid": gl, "rtype": "grouped_light"}]})
            for zone, rooms in ZONES.items():
                members = [n for n, v in LIGHTS.items() if v[0] in rooms]
                gl = uid("gl." + zone)
                lit = [self.lights[n]["bri"] for n in members if self.lights[n]["on"]]
                out.append({"id": gl, "type": "grouped_light", "on": {"on": bool(lit)},
                            "dimming": {"brightness": round(sum(lit) / len(lit), 1) if lit else 0.0}})
                out.append({"id": uid("zone." + zone), "type": "zone", "metadata": {"name": zone, "archetype": "downstairs"},
                            "children": [{"rid": uid("light." + n), "rtype": "light"} for n in members],
                            "services": [{"rid": gl, "rtype": "grouped_light"}]})
            for room, names in SCENES.items():
                for name in names:
                    out.append({"id": uid("scene." + room + "." + name), "type": "scene", "metadata": {"name": name},
                                "group": {"rid": uid("room." + room), "rtype": "room"},
                                "status": {"active": "static" if (room, name) in self.active else "inactive"}})
        return out

    def put(self, kind, rid, body):
        with self.lock:
            targets = []
            if kind == "light":
                targets = [n for n in LIGHTS if uid("light." + n) == rid]
            elif kind == "grouped_light":
                for group, rooms in list(ZONES.items()) + [(r, [r]) for r in ROOMS]:
                    if uid("gl." + group) == rid:
                        targets = [n for n, v in LIGHTS.items() if v[0] in rooms]
            elif kind == "scene":
                for room, names in SCENES.items():
                    for name in names:
                        if uid("scene." + room + "." + name) == rid:
                            self.active = {a for a in self.active if a[0] != room} | {(room, name)}
                            for n, v in LIGHTS.items():
                                if v[0] == room:
                                    self.lights[n]["on"] = True
            for n in targets:
                if "on" in body:
                    self.lights[n]["on"] = bool(body["on"].get("on"))
                if "dimming" in body and self.lights[n]["bri"] is not None:
                    self.lights[n]["bri"] = float(body["dimming"].get("brightness", 100))
            return bool(targets) or kind == "scene"


def handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, data):
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def body(self):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return {}

        def authorised(self):
            return self.headers.get("hue-application-key") == APP_KEY

        def do_GET(self):
            if self.path == "/api/0/config":
                return self.reply(200, {"name": "Mock Hue Bridge", "bridgeid": BRIDGE_ID, "modelid": "BSB002"})
            if self.path == "/clip/v2/resource":
                if not self.authorised():
                    return self.reply(403, {"errors": [{"description": "unauthorized user"}]})
                return self.reply(200, {"errors": [], "data": state.resources()})
            self.reply(404, {})

        def do_POST(self):
            if self.path != "/api":
                return self.reply(404, {})
            body = self.body()
            state.record("POST /api " + json.dumps(body, sort_keys=True))
            with state.lock:
                pressed = state.presses <= 0
                state.presses -= 1
            if not pressed:
                return self.reply(200, [{"error": {"type": 101, "address": "", "description": "link button not pressed"}}])
            self.reply(200, [{"success": {"username": APP_KEY, "clientkey": "00" * 16}}])

        def do_PUT(self):
            parts = self.path.strip("/").split("/")
            if len(parts) != 5 or parts[:3] != ["clip", "v2", "resource"]:
                return self.reply(404, {})
            if not self.authorised():
                return self.reply(403, {"errors": [{"description": "unauthorized user"}]})
            body = self.body()
            state.record("PUT %s %s %s" % (parts[3], parts[4], json.dumps(body, sort_keys=True)))
            ok = state.put(parts[3], parts[4], body)
            self.reply(200 if ok else 404, {"errors": [], "data": [{"rid": parts[4], "rtype": parts[3]}]})
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--log", default="")
    parser.add_argument("--presses", type=int, default=2)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.ip, args.port), handler(State(args.log, args.presses)))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
