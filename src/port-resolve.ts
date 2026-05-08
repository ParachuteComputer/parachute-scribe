import { readServiceEntry, type ServiceEntry } from "./services-manifest.ts";
import { DEFAULT_PORT, SERVICE_NAME } from "./parachute-info.ts";

/**
 * Resolve the port scribe should bind on boot.
 *
 * Precedence (services.json wins, then env, then canonical default):
 *   1. The `port` field on scribe's existing entry in `~/.parachute/services.json`,
 *      when it parses as a valid TCP port. This is the contract between the
 *      operator (or hub) and the service. Scribe must respect it on boot —
 *      otherwise services.json is write-only-by-scribe and the operator can't
 *      pin or correct the port from outside the service.
 *   2. `SCRIBE_PORT` env (process-scope explicit override).
 *   3. `PORT` env (PaaS back-compat; what hub's port-assigner writes to
 *      `~/.parachute/scribe/.env`).
 *   4. Canonical `DEFAULT_PORT` (1943).
 *
 * Why services.json wins over env: scribe#40. Hub's port-assigner walked the
 * canonical slot to 1944 once and stamped `PORT=1944` into scribe's `.env`.
 * Scribe's old code read env-first and rewrote services.json to 1944 on
 * every boot, ignoring whatever the operator put there. With services.json
 * winning over env, an operator can correct the port (or hub#195's recovery
 * tool can correct it) and scribe will respect it across restarts.
 */
export interface ResolvePortOpts {
  /**
   * Lookup for the existing entry in services.json. Pure for tests; defaults
   * to `readServiceEntry` against the resolved manifest path.
   */
  readonly readEntry?: (name: string) => ServiceEntry | undefined;
  /**
   * Process env. Defaulted to `process.env`. Pure for tests.
   */
  readonly env?: Record<string, string | undefined>;
  /**
   * Service name to look up in the manifest. Defaults to `SERVICE_NAME`
   * ("parachute-scribe").
   */
  readonly serviceName?: string;
  /**
   * Canonical default. Defaults to `DEFAULT_PORT` (1943).
   */
  readonly canonicalDefault?: number;
}

export interface ResolvedPort {
  readonly port: number;
  readonly source: "services.json" | "SCRIBE_PORT" | "PORT" | "default";
}

function parsePort(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw < 65536) {
    return raw;
  }
  if (typeof raw === "string" && /^[1-9]\d{0,4}$/.test(raw)) {
    const n = Number(raw);
    if (n > 0 && n < 65536) return n;
  }
  return null;
}

export function resolvePort(opts: ResolvePortOpts = {}): ResolvedPort {
  const env = opts.env ?? process.env;
  const serviceName = opts.serviceName ?? SERVICE_NAME;
  const canonical = opts.canonicalDefault ?? DEFAULT_PORT;
  const readEntry = opts.readEntry ?? ((name: string) => readServiceEntry(name));

  // 1. services.json — operator-set / persisted state wins.
  let entry: ServiceEntry | undefined;
  try {
    entry = readEntry(serviceName);
  } catch {
    // Malformed manifest: don't crash boot here. `upsertService` will throw
    // loudly when it tries to write, which is the right surface for that
    // error. For port resolution, treat it as "no entry".
    entry = undefined;
  }
  if (entry) {
    const port = parsePort(entry.port);
    if (port !== null) return { port, source: "services.json" };
  }

  // 2. SCRIBE_PORT — explicit process-scope override.
  const scribePort = parsePort(env.SCRIBE_PORT);
  if (scribePort !== null) return { port: scribePort, source: "SCRIBE_PORT" };

  // 3. PORT — PaaS back-compat / hub's port-assigner.
  const port = parsePort(env.PORT);
  if (port !== null) return { port, source: "PORT" };

  // 4. Canonical default.
  return { port: canonical, source: "default" };
}
