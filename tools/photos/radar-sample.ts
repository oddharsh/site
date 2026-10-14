#!/usr/bin/env node
// radar-sample.ts — the SENSOR half of /radar.
//
// Both come from `system_profiler`, which needs NO SUDO — the older `airport -I`
// route was removed in macOS 14.4 and `wdutil info` requires root, so this is the
// one that still works unattended. Verified on darwin 27:
//
//   SPAirPortDataType   spairport_signal_noise  "-58 dBm / -94 dBm" per network,
//                       for the joined network AND every other one in range.
//   SPBluetoothDataType device_rssi             per paired/nearby device.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { asRecord } from "../../src/worker/lib/parse.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ANON = has("--anonymize");
const label = (name) => (ANON ? `#${createHash("sha256").update(name).digest("hex").slice(0, 6)}` : name);

const dbm = (text) => {
  const m = /(-?\d+)\s*dBm/.exec(String(text || ""));
  return m ? Number(m[1]) : null;
};

async function profiler(type) {
  try {
    const { stdout } = await run("system_profiler", ["-json", type], { maxBuffer: 24 * 1024 * 1024, timeout: 20000 });
    return JSON.parse(stdout);
  } catch { return null; }
}

async function wifi() {
  const data = await profiler("SPAirPortDataType");
  const out = [];
  // Deduped on NAME + STRENGTH, not name alone. A mesh broadcasts one SSID from
  // several access points, and macOS reports each separately at its own dBm —
  // which is exactly the reading a radar wants ("the near node is the one in the
  // kitchen"). Collapsing by name threw all but one away and made a four-AP
  // office look like a single router. BSSID is not exposed here, so repeats are
  // disambiguated by a counter rather than by address.
  const seen = new Set();
  const counts = new Map();
  const push = (rawName, rssi, kind) => {
    if (rssi === null) return;
    const key = `${rawName}|${rssi}`;
    if (seen.has(key)) return;
    seen.add(key);
    const n = (counts.get(rawName) || 0) + 1;
    counts.set(rawName, n);
    out.push({ name: label(rawName) + (n > 1 ? ` (${n})` : ""), rssi, kind });
  };

  for (const iface of data?.SPAirPortDataType?.[0]?.spairport_airport_interfaces || []) {
    const current = iface.spairport_current_network_information;
    if (current?._name) push(current._name, dbm(current.spairport_signal_noise), "wifi*");
    for (const net of iface.spairport_airport_other_local_wireless_networks || []) {
      if (net?._name) push(net._name, dbm(net.spairport_signal_noise), "wifi");
    }
  }
  return out;
}

async function bluetooth() {
  const data = await profiler("SPBluetoothDataType");
  const out = [];
  // The shape here is a list of single-key objects ({ "Device Name": {...} })
  // nested under connected/not-connected groups, and it has moved between OS
  // versions. Walk for `device_rssi` rather than pinning a path.
  const walk = (node, name = "") => {
    if (Array.isArray(node)) return node.forEach((item) => walk(item, name));
    if (!asRecord(node)) return;
    if (node.device_rssi !== undefined) {
      const rssi = Number(node.device_rssi);
      if (Number.isFinite(rssi) && rssi < 0) out.push({ name: label(name || "bluetooth device"), rssi, kind: "ble" });
    }
    for (const [key, value] of Object.entries(node)) {
      if (asRecord(value)) walk(value, key.startsWith("device_") || key.startsWith("spbluetooth") ? name : key);
    }
  };
  walk(data);
  return out;
}

const history = new Map();
function withHistory(samples) {
  return samples.map((sample) => {
    const past = history.get(sample.name) || [];
    const next = [...past, sample.rssi].slice(-32);
    history.set(sample.name, next);
    return { ...sample, history: next };
  });
}

async function sample() {
  const [w, b] = await Promise.all([wifi(), bluetooth()]);
  return withHistory([...w, ...b]);
}

async function draw(base, samples) {
  const res = await fetch(`${base.replace(/\/+$/, "")}/radar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ samples, source: ANON ? "radar-sample (anonymized)" : "radar-sample" }),
  });
  return res.text();
}

const base = valueOf("--at", "https://aadhar.sh");

if (has("--json")) {
  console.log(JSON.stringify({ samples: await sample() }, null, 2));
} else if (has("--watch")) {
  process.stdout.write("\x1b[?25l");   // hide the cursor; a blinking one on a redraw is noise
  const stop = () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); };
  process.on("SIGINT", stop);
  for (;;) {
    const frame = await draw(base, await sample());
    process.stdout.write("\x1b[H\x1b[2J" + frame);
    await new Promise((r) => setTimeout(r, 2000));
  }
} else {
  console.log(await draw(base, await sample()));
}
