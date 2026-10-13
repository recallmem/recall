import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import {
  chunkText,
  extractFileText,
  fileProvenance,
  MAX_FILE_BYTES,
  newFileId,
} from "../../core/files.js";
import {
  createMessages,
  getMessage,
  listMessages,
  type NewMessage,
  updateMessageMetadata,
} from "../../core/messages.js";
import { messageBatchCreate, messageConfiguration, metadata } from "../../core/schemas.js";
import { ApiError } from "../../lib/errors.js";
import type { App } from "../app.js";
import { type AppEnv, guard, wsOf } from "../auth.js";
import { FiltersBody, invalid, optionalBody } from "../common.js";
import { normalizeDatetime } from "../filters.js";
import { readPaging, SEQ_KEY_TYPES } from "../pagination.js";
import { parseBody, ValidationError } from "../validate.js";

const MessageUpdate = z.object({ metadata: metadata.nullish() });

/** A form field holding JSON; anything unparsable is silently ignored, as the reference does. */
function jsonField(form: FormData, name: string): unknown {
  const raw = form.get(name);
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function register(app: App, ctx: AppContext): void {
  const create = async (c: Context<AppEnv>) => {
    const workspace = wsOf(c);
    const session = c.req.param("session_id") ?? "";
    const body = await parseBody(c, messageBatchCreate);
    const { messages } = await createMessages(ctx, {
      workspace,
      session,
      messages: body.messages,
      idempotencyKey: c.req.header("idempotency-key"),
    });
    return c.json(messages, 201);
  };
  // Peer tokens cannot write messages: the route declares no peer parameter.
  app.post("/v3/workspaces/:workspace_id/sessions/:session_id/messages", guard(ctx), create);
  app.post("/v3/workspaces/:workspace_id/sessions/:session_id/messages/", guard(ctx), create);

  app.post(
    "/v3/workspaces/:workspace_id/sessions/:session_id/messages/upload",
    guard(ctx),
    // Multipart framing adds a little to the 5 MiB file cap; the file size itself is checked below.
    bodyLimit({
      maxSize: MAX_FILE_BYTES + 256 * 1024,
      onError: (c) => c.json({ detail: "File too large" }, 413),
    }),
    async (c) => {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw new ValidationError([
          {
            type: "value_error",
            loc: ["body"],
            msg: "Expected a multipart/form-data body",
            input: null,
          },
        ]);
      }
      const file = form.get("file");
      if (!(file instanceof File)) throw invalid("body", "file", "Field required");
      const peerId = form.get("peer_id");
      if (typeof peerId !== "string" || !peerId) throw invalid("body", "peer_id", "Field required");
      if (file.size > MAX_FILE_BYTES) throw new ApiError(413, "File too large");

      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text, contentType } = await extractFileText(bytes, file.type);
      const chunks = chunkText(text);
      if (chunks.length === 0) throw invalid("body", "file", "The file contains no text");

      const rawMetadata = jsonField(form, "metadata");
      const parsedMetadata =
        rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
          ? metadata.safeParse(rawMetadata)
          : null;
      if (parsedMetadata && !parsedMetadata.success)
        throw invalid("body", "metadata", parsedMetadata.error.issues[0]!.message);
      const parsedConfig = messageConfiguration.safeParse(jsonField(form, "configuration"));
      const createdRaw = form.get("created_at");
      const iso = typeof createdRaw === "string" ? normalizeDatetime(createdRaw) : null;

      const provenance = fileProvenance({
        fileId: newFileId(),
        filename: file.name || "upload",
        size: file.size,
        contentType,
        chunks,
      });
      const messages: NewMessage[] = chunks.map((chunk, i) => ({
        content: chunk.text,
        peer_id: peerId,
        metadata: parsedMetadata?.success ? parsedMetadata.data : {},
        configuration: parsedConfig.success ? parsedConfig.data : null,
        created_at: iso ? new Date(iso) : null,
        internal: provenance[i]!,
      }));
      const created = await createMessages(ctx, {
        workspace: wsOf(c),
        session: c.req.param("session_id"),
        messages,
        idempotencyKey: c.req.header("idempotency-key"),
      });
      return c.json(created.messages, 201);
    },
  );

  app.post(
    "/v3/workspaces/:workspace_id/sessions/:session_id/messages/list",
    guard(ctx, { memberRead: true }),
    async (c) => {
      const workspace = wsOf(c);
      const session = c.req.param("session_id");
      const body = await optionalBody(c, FiltersBody);
      const paging = readPaging(c, {
        fingerprint: ["messages", workspace, session, body?.filters ?? null],
        keyTypes: SEQ_KEY_TYPES,
      });
      return c.json(await listMessages(ctx, workspace, session, paging, body?.filters));
    },
  );

  app.get(
    "/v3/workspaces/:workspace_id/sessions/:session_id/messages/:message_id",
    guard(ctx, { memberRead: true }),
    async (c) => {
      return c.json(
        await getMessage(ctx, wsOf(c), c.req.param("session_id"), c.req.param("message_id")),
      );
    },
  );

  app.put(
    "/v3/workspaces/:workspace_id/sessions/:session_id/messages/:message_id",
    guard(ctx),
    async (c) => {
      const body = await parseBody(c, MessageUpdate);
      return c.json(
        await updateMessageMetadata(
          ctx,
          wsOf(c),
          c.req.param("session_id"),
          c.req.param("message_id"),
          body.metadata,
        ),
      );
    },
  );
}
