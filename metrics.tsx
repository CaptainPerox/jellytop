// metrics.tsx: jellytop's transcodes in the Prometheus text format.
//
//   curl http://127.0.0.1:9298/metrics        # once `make up` is running
//   yeet run ./metrics.tsx                    # the same, printed once
//
// Every scrape is a fresh isolate that reads /proc once and exits, so it
// keeps no state: CPU and IO are counters and Grafana takes the rate.
// Every ffmpeg on the box is listed, labelled with the container it runs in,
// so one scrape covers Jellyfin in Docker, in an LXC, or on the host.

import { render, gauge, counter } from "yeet:telemetry";
import { describe } from "./describe.js";

const RENDER_NODE = /^\/dev\/dri\/renderD\d+$/;
const LXC = /(?:^|\/)lxc(?:\/|\.payload\.)([^/]+)/;
const DOCKER = /docker[-/]([0-9a-f]{12})/;

// The container a process lives in, as --container takes it: an LXC name or
// Proxmox vmid, a short Docker id, or "host".
function containerOf(cgroups) {
  for (const c of cgroups ?? []) {
    const m = (c.pathname ?? "").match(LXC) ?? (c.pathname ?? "").match(DOCKER);
    if (m) return m[1];
  }
  return "host";
}

async function main() {
  const { data } = await yeet.graph.query(`{
    host { ticks_per_second }
    procs {
      pid
      stat { comm utime stime num_threads }
      io { read_bytes write_bytes }
      cgroups { pathname }
    }
  }`);
  const hz = data?.host?.ticks_per_second ?? 100;

  const rows = [];
  for (const p of data?.procs ?? []) {
    if (p.stat?.comm !== "ffmpeg") continue;
    const { data: d } = await yeet.graph
      .query(`{ proc(pid: ${p.pid}) { cmdline fds { kind path } } }`)
      .catch(() => ({}));
    if (!d?.proc) continue; // it exited between the walk and the lookup
    rows.push({
      p,
      labels: { pid: p.pid, container: containerOf(p.cgroups) },
      argv: d.proc.cmdline ?? [],
      gpu: (d.proc.fds ?? []).some((x) => x.kind === "PATH" && RENDER_NODE.test(x.path ?? "")),
    });
  }
  const each = (f) => rows.map((r) => [r.labels, f(r)]);

  console.log(await render({
    jellytop_transcode: {
      info: gauge({
        help: "One series per running ffmpeg; the labels say what it is doing.",
        value: rows.map((r) => {
          const x = describe(r.argv);
          return [{ ...r.labels, mode: x.mode, decode: x.hwaccel, encode: x.vcodec, target: x.target, kbps: x.kbps, file: x.file }, 1];
        }),
      }),
      cpu_seconds_total: counter({
        help: "CPU time billed to the ffmpeg, user plus system.",
        value: each((r) => (r.p.stat.utime + r.p.stat.stime) / hz),
      }),
      // A number rather than the kbps label, so Grafana can divide the
      // ffmpeg's output rate by it: under 1 means it is not keeping up.
      target_bits_per_second: gauge({
        help: "Video bitrate the ffmpeg was told to produce (-b:v or -maxrate).",
        value: each((r) => {
          const kbps = describe(r.argv).kbps;
          return kbps ? kbps * 1000 : null; // no bitrate given: no sample
        }),
      }),
      threads: gauge({ help: "Threads in the ffmpeg.", value: each((r) => r.p.stat.num_threads) }),
      render_node_open: gauge({
        help: "1 if the ffmpeg holds a /dev/dri/renderD* descriptor.",
        value: each((r) => r.gpu),
      }),
      read_bytes_total: counter({ help: "Bytes read from storage.", value: each((r) => r.p.io?.read_bytes ?? 0) }),
      write_bytes_total: counter({ help: "Bytes written to storage.", value: each((r) => r.p.io?.write_bytes ?? 0) }),
    },
  }));
}

main().catch((e) => console.error(`jellytop metrics: ${e?.message ?? e}`));
