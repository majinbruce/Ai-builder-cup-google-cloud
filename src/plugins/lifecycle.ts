import fp from "fastify-plugin";

/**
 * One boolean, shared between the signal handler in server.ts and the readiness
 * probe in health.routes.ts.
 *
 * It exists because "the process is going away" and "the process is broken" are
 * different answers to /health/ready, and only the process itself knows which
 * one is true. See the drain in server.ts for why the gap matters.
 */
export interface Lifecycle {
  /** True once shutdown has begun and readiness has started reporting 503. */
  readonly draining: boolean;
  /** Start reporting not-ready. Idempotent — repeat signals are harmless. */
  beginDraining(): void;
}

declare module "fastify" {
  interface FastifyInstance {
    lifecycle: Lifecycle;
  }
}

export default fp(
  async (app) => {
    let draining = false;

    app.decorate("lifecycle", {
      get draining() {
        return draining;
      },
      beginDraining() {
        draining = true;
      },
    });
  },
  { name: "lifecycle" }
);
