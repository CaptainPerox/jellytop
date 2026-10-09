// What an ffmpeg command line Jellyfin spawned says it is doing. Shared by
// the live view (main.tsx) and the Prometheus exporter (metrics.tsx).

export function describe(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const input = argv.find((a) => a.startsWith("file:"))?.slice(5) ?? "?";
  const vcodec = flag("-codec:v:0") ?? flag("-c:v") ?? "copy";
  const hwaccel = flag("-hwaccel") ?? "none";
  const vf = flag("-vf") ?? "";
  // hardware filters say scale_vaapi=w=1280:h=720; the software path says
  // scale=trunc(min(max(iw\,ih*a)\,1280)/2)*2:... so take whichever appears.
  const hw = vf.match(/scale(?:_vaapi|_qsv|_cuda)?=w=(\d+):h=(\d+)/);
  const sw = vf.match(/scale=trunc\(min\(max\(iw\\,ih\*a\)\\,(\d+)\)/);
  const bitrate = Number(flag("-b:v") ?? flag("-maxrate") ?? 0);
  const hwEncode = /_(qsv|vaapi|nvenc|amf|v4l2m2m|videotoolbox)$/.test(vcodec);
  const hwDecode = hwaccel !== "none";
  const mode = hwDecode && hwEncode ? "hw" : hwEncode || hwDecode ? "mixed" : "sw";
  return {
    file: input.split("/").pop(),
    vcodec,
    hwaccel,
    mode,
    target: hw ? `${hw[1]}x${hw[2]}` : sw ? `${sw[1]}w` : "source",
    kbps: bitrate ? Math.round(bitrate / 1000) : null,
  };
}
