// Portable receipts for successful root-MCP tool results.
//
// "Durable" here means the receipt survives being copied out of the HTTPS
// response and can still be verified. It does NOT mean the server stores every
// call. Persisting a receipt for every public read would turn all 24 tools into
// writes, grow an attacker-controlled D1 table, and make their readOnlyHint
// metadata false. Instead the receipt binds a portable record to:
//
//   origin + issue time + tool + request digest + result digest + Worker version
//
// Production signs that record with the Ed25519 identity key the site already
// publishes for AadharshBot. Local development has no .dev.vars by design, so a
// missing key produces an EXPLICIT unsigned receipt rather than making every
// local tool unusable. The production deploy gate requires the key.

export const RESULT_RECEIPT_FIELD = "_receipt";
export const RESULT_RECEIPT_SCHEMA_URL = "https://aadhar.sh/.well-known/result-receipt-v1.json";
export const RESULT_RECEIPT_KEY_DIRECTORY = "https://aadhar.sh/.well-known/http-message-signatures-directory";

const encoder = new TextEncoder();

function assertUnicode(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("result receipt contains an unpaired high surrogate");
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("result receipt contains an unpaired low surrogate");
    }
  }
}

// RFC 8785 JSON Canonicalization Scheme. Inputs here have already crossed a
// JSON boundary (request arguments or structured tool output), so JSON's own
// primitive serialization supplies the RFC's ECMAScript number/string rules;
// the remaining operation is recursive UTF-16 property sorting.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("result receipt requires finite JSON numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => {
      assertUnicode(key);
      return JSON.stringify(key) + ":" + canonicalJson(value[key]);
    }).join(",") + "}";
  }
  throw new TypeError("result receipt can only canonicalize JSON values");
}

function jsonValue(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("result receipt value is not JSON-serializable");
  return JSON.parse(serialized);
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function resultReceiptDigest(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(jsonValue(value)))));
  return "sha256:" + hex(digest);
}

function receiptOutputSchema(schema) {
  const required = new Set([...(Array.isArray(schema.required) ? schema.required : []), RESULT_RECEIPT_FIELD]);
  return {
    ...schema,
    type: "object",
    properties: {
      ...(schema.properties || {}),
      [RESULT_RECEIPT_FIELD]: { $ref: RESULT_RECEIPT_SCHEMA_URL },
    },
    required: [...required],
    additionalProperties: schema.additionalProperties ?? true,
  };
}

// Root-MCP only. mcpTool() is shared with Serendipity, whose results do not use
// this extension, so the receipt contract is applied where the signed transport
// implementation actually lives rather than in the shared decorator.
export function withResultReceiptSchema(tool) {
  return { ...tool, outputSchema: receiptOutputSchema(tool.outputSchema || {}) };
}

export function declaresResultReceipt(tool) {
  const schema = tool && tool.outputSchema;
  return !!(
    schema && schema.type === "object" && Array.isArray(schema.required) &&
    schema.required.includes(RESULT_RECEIPT_FIELD) &&
    schema.properties && schema.properties[RESULT_RECEIPT_FIELD] &&
    schema.properties[RESULT_RECEIPT_FIELD].$ref === RESULT_RECEIPT_SCHEMA_URL
  );
}

function parseSigningJwk(env) {
  const raw = env && env.RN_SIGNING_KEY_JWK;
  if (!raw) return null;
  const jwk = JSON.parse(raw);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string") {
    throw new Error("Result receipt signing key is malformed: expected a private Ed25519 JWK");
  }
  return jwk;
}

export async function createResultReceipt({ request, tool, args, result, env, producer }) {
  const url = new URL(request.url);
  const issuedAt = new Date().toISOString();
  const core = {
    schema: RESULT_RECEIPT_SCHEMA_URL,
    version: 1,
    origin: url.origin,
    issuedAt,
    provenance: {
      kind: "mcp-tool-result",
      endpoint: url.origin + url.pathname,
      protocol: "mcp",
      operation: "tools/call",
      tool,
      requestDigest: await resultReceiptDigest(args),
      resultDigest: await resultReceiptDigest(result),
      producer: {
        name: producer.name,
        version: producer.version,
        workerVersion: env && env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id || null,
      },
    },
  };

  const jwk = parseSigningJwk(env);
  if (!jwk) {
    return {
      ...core,
      proof: {
        status: "unsigned",
        algorithm: null,
        keyId: null,
        canonicalization: "RFC8785",
        signature: null,
        reason: "signing key unavailable (expected in local development only)",
      },
    };
  }

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  // Bind the proof configuration as well as the receipt body. A verifier removes
  // only `proof.signature`; if the algorithm, key directory, status, or
  // canonicalization label is changed in transit, verification fails with it.
  const proof = {
    status: "signed",
    algorithm: "Ed25519",
    keyId: RESULT_RECEIPT_KEY_DIRECTORY + "#" + (jwk.kid || "rn"),
    canonicalization: "RFC8785",
  };
  const signedReceipt = { ...core, proof };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, encoder.encode(canonicalJson(signedReceipt))));
  return {
    ...signedReceipt,
    proof: {
      ...proof,
      signature: base64url(signature),
    },
  };
}

export async function resultWithReceipt({ out, request, tool, args, env, producer }) {
  const structured = out && out._mcp ? out._mcp.structured : out;
  const receipt = await createResultReceipt({ request, tool, args, result: structured, env, producer });
  const structuredContent = { ...structured, [RESULT_RECEIPT_FIELD]: receipt };
  if (!out || !out._mcp) {
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  }

  // Image tools already return one JSON text block plus image blocks. Replace
  // that text with the receipt-bearing structured object and leave the actual
  // image bytes untouched; their SHA-256 values are already inside the result
  // whose digest this receipt binds.
  const content = [...out._mcp.content];
  const textIndex = content.findIndex((block) => block && block.type === "text");
  const textBlock = { type: "text", text: JSON.stringify(structuredContent, null, 2) };
  if (textIndex === -1) content.unshift(textBlock);
  else content[textIndex] = textBlock;
  return { content, structuredContent };
}
