// QuizPhoto — reads a photographed vocabulary sheet with Claude.
//
// Serves the app from public/ and exposes one endpoint, POST /read, which
// forwards the photos to the Claude API with your own key. This is the piece
// the hosted version could not do: an artifact page can only ask its runtime
// to carry an image, and that runtime may refuse. Here nothing is gated.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const PORT = Number(process.env.PORT) || 3000;

const MODEL = "claude-opus-5";
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const OK_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/* ---------------------------------------------------------------------
   Credentials. The SDK also resolves an `ant auth login` profile, so an
   unset ANTHROPIC_API_KEY does not necessarily mean no credentials — but
   a .env file next to this script is the simplest local setup.
--------------------------------------------------------------------- */
function loadDotEnv() {
  const file = path.join(HERE, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadDotEnv();

const hasCredentials = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
);
const client = new Anthropic();

/* ---------------------------------------------------------------------
   The extraction prompt. Written for a vocabulary sheet specifically —
   the sheet's own pairings are the answer key, not Claude's opinion of
   what the words mean.
--------------------------------------------------------------------- */
const PROMPT = [
  "These images are a language-class vocabulary sheet, photographed by a student.",
  "Extract the vocabulary.",
  "",
  "Rules:",
  "- If the sheet already pairs each term with a meaning (two columns, dashes, equals signs, numbering), use the sheet's OWN pairings verbatim. Do not substitute your own translation.",
  "- If the sheet lists terms with no meanings given, supply the translation yourself.",
  "- Keep accents and diacritics exactly as written.",
  "- Keep infinitive markers: the Spanish infinitive 'decir' means 'to say', not 'say'.",
  "- Put genuinely interchangeable answers in 'alt' ('to say' / 'to tell'), not loose synonyms.",
  "- 'note' is for gender, part of speech or irregularity, at most four words. Use an empty string when there is nothing worth saying.",
  "- Skip headings, page numbers, student names, dates, instructions and exercise prompts.",
  "- Skip anything you cannot read confidently rather than guessing.",
  "- If there is no vocabulary on the page at all, return an empty pairs array.",
].join("\n");

const DECK_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short deck name, from a heading on the sheet if there is one" },
    langA: { type: "string", description: "Language of the foreign-language side, in English" },
    langB: { type: "string", description: "Language of the meaning side, in English" },
    pairs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          a: { type: "string", description: "The foreign-language term exactly as written" },
          b: { type: "string", description: "Its meaning" },
          alt: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
        required: ["a", "b", "alt", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "langA", "langB", "pairs"],
  additionalProperties: false,
};

async function readSheet(images) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      format: { type: "json_schema", name: "vocabulary_deck", schema: DECK_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.media_type, data: img.data },
          })),
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  // Safety classifiers can decline a request: HTTP 200, no usable content.
  // Always check stop_reason before reading content.
  if (response.stop_reason === "refusal") {
    const err = new Error("refused");
    err.code = "refused";
    err.detail = response.stop_details?.category || "";
    throw err;
  }

  if (response.parsed_output) return response.parsed_output;

  // Fall back to parsing the text, in case the schema round-trip was skipped.
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("no_json");
    err.code = "no_json";
    err.detail = text.slice(0, 200);
    throw err;
  }
}

/* ---------------------------------------------------------------------
   HTTP
--------------------------------------------------------------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("too_large"), { code: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  // Resolve, then confirm the result is still inside public/.
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, "index.html")) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ready: hasCredentials, model: MODEL, maxImages: MAX_IMAGES });
  }

  if (req.method === "POST" && req.url === "/read") {
    if (!hasCredentials) return sendJson(res, 500, { error: "no_api_key" });

    let payload;
    try {
      payload = JSON.parse(await readBody(req, 64 * 1024 * 1024));
    } catch (e) {
      return sendJson(res, 400, { error: e.code === "too_large" ? "bad_image" : "bad_request" });
    }

    const images = Array.isArray(payload?.images) ? payload.images : [];
    if (!images.length) return sendJson(res, 400, { error: "bad_image" });
    if (images.length > MAX_IMAGES) return sendJson(res, 400, { error: "too_many" });
    for (const img of images) {
      if (!OK_TYPES.includes(img?.media_type) || typeof img?.data !== "string") {
        return sendJson(res, 400, { error: "bad_image" });
      }
      if (Buffer.byteLength(img.data, "base64") > MAX_IMAGE_BYTES) {
        return sendJson(res, 400, { error: "bad_image" });
      }
    }

    try {
      const started = Date.now();
      const deck = await readSheet(images);
      console.log(
        `read ${images.length} image(s) -> ${deck?.pairs?.length ?? 0} pairs in ${
          ((Date.now() - started) / 1000).toFixed(1)
        }s`,
      );
      return sendJson(res, 200, deck);
    } catch (e) {
      // Most specific first: a rate limit is retryable, a 400 is not.
      let error = e.code || "unknown";
      if (e instanceof Anthropic.RateLimitError) error = "rate_limited";
      else if (e instanceof Anthropic.AuthenticationError) error = "no_api_key";
      else if (e instanceof Anthropic.BadRequestError) error = "bad_image";
      else if (e instanceof Anthropic.APIConnectionError) error = "offline";
      console.error("read failed:", error, e.message);
      return sendJson(res, 502, { error, detail: e.detail || e.message });
    }
  }

  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405).end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`\n  QuizPhoto  →  http://localhost:${PORT}`);
  console.log(`  model: ${MODEL}`);
  console.log(
    hasCredentials
      ? "  API key: found\n"
      : "  API key: MISSING — put ANTHROPIC_API_KEY in .env next to this file\n",
  );
});
