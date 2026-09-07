import fp from "fastify-plugin";
import { config, type Config } from "../config/index.ts";

/**
 * Config is already a module-level import, so decorating with it looks
 * redundant — until a test wants to build an app with a different config, or a
 * route in another package needs it without reaching across directories.
 * `app.config` is reachable from any instance, hook or handler via
 * `request.server.config`.
 */
declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}

export default fp(
  async (app) => {
    app.decorate("config", config);
  },
  { name: "config" }
);
