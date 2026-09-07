import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { config } from "../config/index.ts";

/**
 * The docs are generated from the same Zod schemas that validate requests, so
 * they cannot drift: changing a field changes validation, serialization, the
 * TypeScript type and this page in one edit.
 */
export default fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "API",
          description: "Fastify + TypeScript + PostgreSQL boilerplate",
          version: "1.0.0",
        },
        components: {
          /**
           * Two transports for one session. `cookieAuth` is what a browser uses
           * and is set automatically by the sign-in endpoints; `bearerAuth`
           * carries the very same session token for clients that cannot hold
           * cookies. Neither is a JWT — the token is an opaque key into the
           * sessions table.
           */
          securitySchemes: {
            cookieAuth: {
              type: "apiKey",
              in: "cookie",
              name: "better-auth.session_token",
            },
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
    });

    app.log.info(
      `API docs available at http://${config.server.host}:${config.server.port}/docs`
    );
  },
  { name: "swagger" }
);
