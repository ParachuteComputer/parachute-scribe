/**
 * Unit tests for the runnable local-backend install routine.
 *
 * Every subprocess + platform probe goes through the injected `InstallDeps`
 * seam, so these tests exercise the orchestration logic, the RAM guard, the
 * privilege split, and idempotency WITHOUT ever apt/pip-installing anything.
 */
import { describe, expect, test } from "bun:test";
import {
  installBackend,
  platformLocalProvider,
  pipTargetFor,
  DEFAULT_MODEL,
  MIN_RAM_MIB,
  type InstallDeps,
  type RunResult,
} from "./install-backend.ts";

/** A recorded subprocess invocation. */
type Recorded = { cmd: string[]; cwd?: string };

type Overrides = Partial<InstallDeps> & {
  /** Bins reported present by `which`. */
  present?: string[];
  /** Per-command-prefix scripted exit codes (matched by join(" ").startsWith). */
  scripted?: Array<{ match: string; result: RunResult }>;
};

function ok(stdout = ""): RunResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr = "boom", exitCode = 1): RunResult {
  return { exitCode, stdout: "", stderr };
}

/** Build deps with a recording run() and a which() over the `present` set. */
function makeDeps(o: Overrides = {}): { deps: InstallDeps; calls: Recorded[] } {
  const present = new Set(o.present ?? []);
  const calls: Recorded[] = [];
  const run: InstallDeps["run"] = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts?.cwd });
    const joined = cmd.join(" ");
    const scripted = (o.scripted ?? []).find((s) => joined.includes(s.match));
    if (scripted) return scripted.result;
    return ok();
  };
  const deps: InstallDeps = {
    run: o.run ?? run,
    which: o.which ?? ((bin) => (present.has(bin) ? `/usr/local/bin/${bin}` : null)),
    platform: o.platform ?? "linux",
    availableRamMib: o.availableRamMib ?? (() => 4096),
    uid: o.uid ?? (() => 0),
    homeDir: o.homeDir ?? (() => "/home/op"),
    log: o.log ?? (() => {}),
    // Hermetic verify: never read the host's ~/.parachute config.
    loadScribeConfig: o.loadScribeConfig ?? (async () => ({})),
  };
  return { deps, calls };
}

describe("platformLocalProvider", () => {
  test("linux → onnx-asr", () => {
    expect(platformLocalProvider("linux")).toBe("onnx-asr");
  });
  test("darwin → parakeet-mlx", () => {
    expect(platformLocalProvider("darwin")).toBe("parakeet-mlx");
  });
  test("other → null", () => {
    expect(platformLocalProvider("win32")).toBeNull();
  });
});

describe("RAM guard", () => {
  test("refuses below the floor and steers to cloud", async () => {
    const { deps, calls } = makeDeps({ availableRamMib: () => MIN_RAM_MIB - 1 });
    const out = await installBackend(deps);
    expect(out.ok).toBe(false);
    const guard = out.steps.find((s) => s.name === "ram-guard")!;
    expect(guard.status).toBe("refused");
    expect(out.summary.toLowerCase()).toContain("groq");
    // Refusal happens BEFORE any install command runs.
    expect(calls.length).toBe(0);
  });

  test("proceeds at exactly the floor", async () => {
    const { deps } = makeDeps({
      availableRamMib: () => MIN_RAM_MIB,
      // already installed so the run is a clean no-op success path
      present: ["python3", "ffmpeg", "onnx-asr"],
    });
    const out = await installBackend(deps, { skipModel: true });
    const guard = out.steps.find((s) => s.name === "ram-guard")!;
    expect(guard.status).toBe("ok");
    expect(out.ok).toBe(true);
  });

  test("unknown RAM → proceeds (no refusal)", async () => {
    const { deps } = makeDeps({
      availableRamMib: () => null,
      present: ["python3", "ffmpeg", "onnx-asr"],
    });
    const out = await installBackend(deps, { skipModel: true });
    const guard = out.steps.find((s) => s.name === "ram-guard")!;
    expect(guard.status).toBe("skipped");
    expect(out.ok).toBe(true);
  });
});

describe("idempotency", () => {
  test("everything present → all skips, no install commands, verifies ok", async () => {
    const { deps, calls } = makeDeps({
      present: ["python3", "ffmpeg", "onnx-asr"],
    });
    const out = await installBackend(deps, { skipModel: true });
    expect(out.ok).toBe(true);
    expect(out.steps.find((s) => s.name === "system-deps")!.status).toBe("skipped");
    expect(out.steps.find((s) => s.name === "backend-package")!.status).toBe("skipped");
    // No apt/pip/uv invocations when nothing needs installing.
    const installCmds = calls.filter((c) =>
      ["apt-get", "apt", "pip", "uv", "python3"].some((t) => c.cmd[0]?.endsWith(t) || c.cmd[1] === t),
    );
    expect(installCmds.length).toBe(0);
  });

  test("re-running after a partial install does not error", async () => {
    // First run: nothing present, full install path.
    const first = makeDeps({ present: [], availableRamMib: () => 4096 });
    await installBackend(first.deps, { skipModel: true });
    // Second run: now binary present → idempotent skip.
    const second = makeDeps({ present: ["python3", "ffmpeg", "onnx-asr"] });
    const out = await installBackend(second.deps, { skipModel: true });
    expect(out.ok).toBe(true);
  });
});

describe("Linux install path (onnx-asr)", () => {
  test("installs apt deps + venv pip when nothing present", async () => {
    const { deps, calls } = makeDeps({
      present: ["apt-get"], // apt available, nothing else
      // verify needs onnx-asr present after install — simulate via a which that
      // flips to present after the pip step. Simpler: override which to report
      // onnx-asr present (post-install state) for the verify call.
      which: (() => {
        let installed = false;
        return (bin: string) => {
          if (bin === "apt-get") return "/usr/bin/apt-get";
          if (bin === "onnx-asr" && installed) return "/home/op/.venvs/scribe-asr/bin/onnx-asr";
          if (bin === "ffmpeg") return installed ? "/usr/bin/ffmpeg" : null;
          if (bin === "python3") return installed ? "/usr/bin/python3" : null;
          // Flip after first apt/pip activity is recorded.
          return null;
        };
      })(),
    });
    // Drive the "installed" flip by scripting: after apt install + pip install,
    // the which above won't auto-flip; instead assert the commands ran.
    const out = await installBackend(deps, { skipModel: true });
    const aptUpdate = calls.find((c) => c.cmd.includes("update"));
    const aptInstall = calls.find((c) => c.cmd.includes("install") && c.cmd.includes("ffmpeg"));
    const venv = calls.find((c) => c.cmd.includes("venv"));
    const pip = calls.find((c) => c.cmd.some((a) => a.endsWith("/pip")) && c.cmd.includes("install"));
    expect(aptUpdate).toBeTruthy();
    expect(aptInstall).toBeTruthy();
    expect(venv).toBeTruthy();
    expect(pip).toBeTruthy();
    // apt install includes python3-venv (the venv prerequisite).
    expect(aptInstall!.cmd).toContain("python3-venv");
    // pip target carries the [cpu,hub] extras from the single-source spec.
    expect(pip!.cmd.some((a) => a.includes("onnx-asr[cpu,hub]"))).toBe(true);
    // Did not verify available (which never flipped) → not ok, but non-throwing.
    expect(out.ok).toBe(false);
  });

  test("prefers `uv tool install` over a venv when uv is present", async () => {
    const { deps, calls } = makeDeps({
      present: ["apt-get", "python3", "ffmpeg", "uv"],
    });
    await installBackend(deps, { skipModel: true });
    const uv = calls.find((c) => c.cmd[0] === "uv" && c.cmd[1] === "tool");
    const venv = calls.find((c) => c.cmd.includes("venv"));
    expect(uv).toBeTruthy();
    expect(uv!.cmd).toContain("onnx-asr[cpu,hub]");
    expect(venv).toBeUndefined(); // venv fallback not taken
  });

  test("falls back to venv when uv tool install fails", async () => {
    const { deps, calls } = makeDeps({
      present: ["apt-get", "python3", "ffmpeg", "uv"],
      scripted: [{ match: "uv tool install", result: fail("uv exploded") }],
    });
    await installBackend(deps, { skipModel: true });
    const venv = calls.find((c) => c.cmd.includes("venv"));
    expect(venv).toBeTruthy();
  });
});

describe("privilege split (apt)", () => {
  test("uses sudo when not root and sudo present", async () => {
    const { deps, calls } = makeDeps({
      uid: () => 1000,
      present: ["apt-get", "sudo"],
    });
    await installBackend(deps, { skipModel: true });
    const aptInstall = calls.find((c) => c.cmd.includes("install") && c.cmd.includes("ffmpeg"));
    expect(aptInstall!.cmd[0]).toBe("sudo");
  });

  test("no sudo + not root → system-deps fails with an instruct, no apt run", async () => {
    const { deps, calls } = makeDeps({
      uid: () => 1000,
      present: ["apt-get"], // no sudo, not root
    });
    const out = await installBackend(deps, { skipModel: true });
    const sys = out.steps.find((s) => s.name === "system-deps")!;
    expect(sys.status).toBe("failed");
    expect(sys.detail).toContain("sudo");
    expect(out.ok).toBe(false);
    // Did not attempt apt without privilege.
    expect(calls.some((c) => c.cmd.includes("apt-get"))).toBe(false);
  });

  test("root needs no sudo prefix", async () => {
    const { deps, calls } = makeDeps({
      uid: () => 0,
      present: ["apt-get"],
    });
    await installBackend(deps, { skipModel: true });
    const aptInstall = calls.find((c) => c.cmd.includes("install") && c.cmd.includes("ffmpeg"));
    expect(aptInstall!.cmd[0]).toBe("apt-get");
  });
});

describe("platform mismatch + unsupported", () => {
  test("parakeet-mlx requested on linux → refused, no install", async () => {
    const { deps, calls } = makeDeps({ platform: "linux" });
    const out = await installBackend(deps, { provider: "parakeet-mlx" });
    expect(out.ok).toBe(false);
    const step = out.steps.find((s) => s.name === "resolve-backend")!;
    expect(step.status).toBe("refused");
    expect(step.detail).toContain("onnx-asr"); // steers to the right one
    expect(calls.length).toBe(0);
  });

  test("unknown provider → failed resolve", async () => {
    const { deps } = makeDeps();
    const out = await installBackend(deps, { provider: "nope" });
    expect(out.ok).toBe(false);
    expect(out.steps[0]!.status).toBe("failed");
  });

  test("unsupported platform, no provider → failed with cloud steer", async () => {
    const { deps } = makeDeps({ platform: "win32" });
    const out = await installBackend(deps);
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("win32");
  });
});

describe("macOS path (parakeet-mlx)", () => {
  test("does not apt-install; instructs brew for ffmpeg when missing", async () => {
    const { deps, calls } = makeDeps({
      platform: "darwin",
      present: ["python3"], // no ffmpeg, no parakeet-mlx
    });
    const out = await installBackend(deps, { skipModel: true });
    expect(calls.some((c) => c.cmd.includes("apt-get"))).toBe(false);
    const sys = out.steps.find((s) => s.name === "system-deps")!;
    expect(sys.detail).toContain("brew install ffmpeg");
  });

  test("uses pip/venv (or uv) for parakeet-mlx, model step skipped (no warm-pull verb)", async () => {
    const { deps, calls } = makeDeps({
      platform: "darwin",
      present: ["ffmpeg", "python3", "uv"],
    });
    const out = await installBackend(deps, { skipModel: false });
    const uv = calls.find((c) => c.cmd[0] === "uv" && c.cmd[1] === "tool");
    expect(uv!.cmd).toContain("parakeet-mlx");
    const model = out.steps.find((s) => s.name === "model-warm-pull")!;
    expect(model.status).toBe("skipped"); // parakeet has no separate pull
  });
});

describe("model warm-pull (onnx-asr)", () => {
  test("warm-pulls the default model when not skipped", async () => {
    const { deps, calls } = makeDeps({
      present: ["python3", "ffmpeg", "onnx-asr"],
    });
    const out = await installBackend(deps, { skipModel: false });
    const pull = calls.find((c) => c.cmd.includes(DEFAULT_MODEL));
    expect(pull).toBeTruthy();
    const step = out.steps.find((s) => s.name === "model-warm-pull")!;
    expect(step.status).toBe("ok");
  });

  test("warm-pull failure is non-fatal (skipped, not failed)", async () => {
    const { deps } = makeDeps({
      present: ["python3", "ffmpeg", "onnx-asr"],
      scripted: [{ match: DEFAULT_MODEL, result: fail("model server down") }],
    });
    const out = await installBackend(deps, { skipModel: false });
    const step = out.steps.find((s) => s.name === "model-warm-pull")!;
    expect(step.status).toBe("skipped");
    // Backend still verifies available → overall ok despite the model miss.
    expect(out.ok).toBe(true);
  });

  test("skipModel records a skipped step and runs no model command", async () => {
    const { deps, calls } = makeDeps({ present: ["python3", "ffmpeg", "onnx-asr"] });
    const out = await installBackend(deps, { skipModel: true });
    expect(out.steps.find((s) => s.name === "model-warm-pull")!.detail).toContain("Skipped by request");
    expect(calls.some((c) => c.cmd.includes(DEFAULT_MODEL))).toBe(false);
  });
});

describe("apt failure is reported, non-throwing", () => {
  test("apt install failure → system-deps failed, overall not ok", async () => {
    const { deps } = makeDeps({
      present: ["apt-get"],
      uid: () => 0,
      scripted: [{ match: "apt-get install", result: fail("E: unable to locate package", 100) }],
    });
    const out = await installBackend(deps, { skipModel: true });
    const sys = out.steps.find((s) => s.name === "system-deps")!;
    expect(sys.status).toBe("failed");
    expect(out.ok).toBe(false);
    // Did not proceed to pip after a hard system-dep failure.
    expect(out.steps.find((s) => s.name === "backend-package")).toBeUndefined();
  });
});

describe("verify: installed-but-ffmpeg-missing is a partial success, not a hard fail", () => {
  test("onnx-asr present, ffmpeg absent → detector warning → ok=true with caveat", async () => {
    // Linux, root, apt present. python3 + onnx-asr present so package step skips;
    // ffmpeg ABSENT throughout so apt would try to install it — script that apt
    // to succeed but keep ffmpeg absent in `which`, so the verify sees a warning.
    const { deps } = makeDeps({
      platform: "linux",
      uid: () => 0,
      present: ["apt-get", "python3", "onnx-asr"], // no ffmpeg
      scripted: [{ match: "apt-get install", result: ok() }], // apt "succeeds" but which still lacks ffmpeg
    });
    const out = await installBackend(deps, { skipModel: true });
    const verify = out.steps.find((s) => s.name === "verify")!;
    expect(verify.status).toBe("skipped");
    expect(out.ok).toBe(true); // installed; ffmpeg is an operator follow-up, not a fail
    expect(out.summary).toContain("ffmpeg");
  });

  test("macOS parakeet present, ffmpeg absent → ok=true (brew instructed, exit 0)", async () => {
    const { deps } = makeDeps({
      platform: "darwin",
      present: ["python3", "parakeet-mlx"], // no ffmpeg
    });
    const out = await installBackend(deps, { skipModel: true });
    expect(out.ok).toBe(true);
    const verify = out.steps.find((s) => s.name === "verify")!;
    expect(verify.status).toBe("skipped");
  });
});

describe("whisper backend (explicit --provider only)", () => {
  test("install-backend whisper installs whisper-ctranslate2 via uv", async () => {
    const { deps, calls } = makeDeps({
      platform: "linux",
      uid: () => 0,
      present: ["apt-get", "python3", "ffmpeg", "uv", "whisper-ctranslate2"],
    });
    const out = await installBackend(deps, { provider: "whisper", skipModel: true });
    // already-present binary → idempotent skip; verify available.
    expect(out.steps.find((s) => s.name === "backend-package")!.status).toBe("skipped");
    expect(out.ok).toBe(true);
    // No uv/pip run since the binary was already present.
    expect(calls.some((c) => c.cmd[0] === "uv")).toBe(false);
  });

  test("whisper not present → installs via uv with the bare package name", async () => {
    const { deps, calls } = makeDeps({
      platform: "linux",
      uid: () => 0,
      present: ["apt-get", "python3", "ffmpeg", "uv"], // whisper-ctranslate2 absent
    });
    await installBackend(deps, { provider: "whisper", skipModel: true });
    const uv = calls.find((c) => c.cmd[0] === "uv" && c.cmd[1] === "tool");
    expect(uv!.cmd).toContain("whisper-ctranslate2");
  });
});

describe("summary carries the venv PATH caveat", () => {
  test("venv fallback (no uv) → summary mentions adding the venv bin to PATH", async () => {
    // No uv → venv+pip path. After install, the binary lands in the venv but
    // `which` won't find it (not on PATH) → detector reports unavailable →
    // verify failed. To exercise the OK+caveat summary we need verify to pass,
    // so flip `which` to report onnx-asr present (post-install) for the verify.
    let installed = false;
    const { deps } = makeDeps({
      platform: "linux",
      uid: () => 0,
      which: (bin) => {
        if (["apt-get", "python3", "ffmpeg"].includes(bin)) return `/usr/bin/${bin}`;
        if (bin === "onnx-asr" && installed) return "/home/op/.venvs/scribe-asr/bin/onnx-asr";
        return null; // uv absent, onnx-asr absent until installed
      },
      scripted: [
        // mark "installed" once the venv pip install runs
        { match: "/pip install", result: ok() },
      ],
    });
    // Drive the flip: the run() in makeDeps records calls; we toggle via a custom run.
    const calls: string[] = [];
    deps.run = async (cmd) => {
      calls.push(cmd.join(" "));
      if (cmd.join(" ").includes("/pip install")) installed = true;
      return ok();
    };
    const out = await installBackend(deps, { skipModel: true });
    expect(out.ok).toBe(true);
    expect(out.summary).toContain(".venvs/scribe-asr/bin");
  });
});

describe("pipTargetFor", () => {
  test("onnx-asr carries the [cpu,hub] extras", () => {
    expect(pipTargetFor("onnx-asr")).toBe("onnx-asr[cpu,hub]");
  });
  test("parakeet-mlx is bare", () => {
    expect(pipTargetFor("parakeet-mlx")).toBe("parakeet-mlx");
  });
});
