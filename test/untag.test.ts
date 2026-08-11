import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseUntagArgs,
  buildUntagUrl,
  describeUntagResult,
  formatStoredTags,
  TAG_FIELDS,
} from "../reporter/untag";

const HOST = "https://api.example.com";
const CTX = { field: "tools", tag: "WhsprFlow", host: "api.example.com" } as const;

// ---- argument parsing -------------------------------------------------------

test("parses a field and a badge", () => {
  assert.deepEqual(parseUntagArgs(["tools", "Warp"]), {
    mode: "remove",
    field: "tools",
    tag: "Warp",
  });
});

test("every declared field is accepted", () => {
  for (const field of TAG_FIELDS) {
    assert.deepEqual(parseUntagArgs([field, "x"]), { mode: "remove", field, tag: "x" });
  }
});

test("--list and -l both ask for the stored lists", () => {
  assert.deepEqual(parseUntagArgs(["--list"]), { mode: "list" });
  assert.deepEqual(parseUntagArgs(["-l"]), { mode: "list" });
});

// A badge whose text has meaningful inner spacing must survive intact —
// trimming the ends is a convenience, collapsing the middle would change which
// badge gets removed.
test("outer whitespace is trimmed, inner spacing is preserved", () => {
  assert.deepEqual(parseUntagArgs(["tools", "  Wispr Flow  "]), {
    mode: "remove",
    field: "tools",
    tag: "Wispr Flow",
  });
});

// Each rejection pins the reason it fails FOR — a bare assert.throws would pass
// on any error, so a value rejected for the wrong reason would look correct.
for (const [name, argv, reason] of [
  ["no arguments", [], /usage:/],
  ["field but no badge", ["tools"], /usage:/],
  ["too many arguments", ["tools", "a", "b"], /usage:/],
  ["a field that isn't a badge list", ["about", "x"], /must be one of/],
  ["a misspelled field", ["tool", "x"], /must be one of/],
  ["an empty badge", ["tools", ""], /usage:/],
  ["a whitespace-only badge", ["tools", "   "], /empty/],
] as const) {
  test(`rejected — ${name}`, () => {
    assert.throws(() => parseUntagArgs(argv as readonly string[]), reason);
  });
}

// ---- URL construction -------------------------------------------------------

test("builds the documented delete path", () => {
  const url = buildUntagUrl(HOST, "DROdio", "tools", "Warp");
  assert.equal(url.toString(), "https://api.example.com/api/user/DROdio/tools/Warp");
});

// The real badges that need removing are full of spaces, quotes and parens.
// If any of them reached the path raw, the request would be malformed or would
// address a different tag than the one asked for.
test("encodes spaces, quotes and parens in the badge text", () => {
  const url = buildUntagUrl(HOST, "DROdio", "tools", 'Sparkle.ai ("Cockpit"-style CLI)');
  assert.equal(
    url.pathname,
    "/api/user/DROdio/tools/Sparkle.ai%20(%22Cockpit%22-style%20CLI)",
  );
  // Decoding the segment must give back exactly what was asked for.
  assert.equal(
    decodeURIComponent(url.pathname.split("/").pop() as string),
    'Sparkle.ai ("Cockpit"-style CLI)',
  );
});

test("encodes the username too", () => {
  const url = buildUntagUrl(HOST, "a b", "tools", "Warp");
  assert.equal(url.pathname, "/api/user/a%20b/tools/Warp");
});

// A slash can't survive as a path segment through the proxy in front of the
// API, and a request that silently routes elsewhere would report a cheerful
// no-op. Refusing is the honest answer.
test("refuses a badge containing a slash rather than sending an unaddressable request", () => {
  assert.throws(() => buildUntagUrl(HOST, "DROdio", "tools", "a/b"), /can't be addressed/);
});

// ---- response interpretation ------------------------------------------------

test("200 with removed:true reports the removal", () => {
  const out = describeUntagResult(200, '{"ok":true,"removed":true}', CTX);
  assert.equal(out.ok, true);
  assert.match(out.message, /Removed "WhsprFlow" from tools/);
});

// The server answers 200 whether or not anything matched, so removed:false is
// the case most likely to be misread as success. It must not report ok.
test("200 with removed:false is a miss, not a success", () => {
  const out = describeUntagResult(200, '{"ok":true,"removed":false}', CTX);
  assert.equal(out.ok, false);
  assert.match(out.message, /nothing was removed/);
  // The near-miss that actually happens is spacing, so the message says so.
  assert.match(out.message, /not spacing/);
});

for (const [name, status, body, reason] of [
  ["401 points at the key", 401, '{"ok":false,"error":"Authorization: Bearer <key> required"}', /API key/],
  ["403 points at the key", 403, '{"ok":false,"error":"invalid key for this username"}', /API key/],
  ["500 surfaces the server error text", 500, '{"ok":false,"error":"boom"}', /boom/],
] as const) {
  test(`failure — ${name}`, () => {
    const out = describeUntagResult(status, body, CTX);
    assert.equal(out.ok, false);
    assert.match(out.message, reason);
  });
}

// A 404 here is far more likely to be the wrong host than a missing user: the
// public Builder Index host proxies GET and POST to the API but drops DELETE,
// and answers with an HTML error page rather than JSON.
test("404 blames the host's routing and names the fix", () => {
  const out = describeUntagResult(404, "The page could not be found\n\nNOT_FOUND", CTX);
  assert.equal(out.ok, false);
  assert.match(out.message, /does not route DELETE/);
  assert.match(out.message, /SERVER_URL/);
  // The host it actually reached, so the message is actionable.
  assert.match(out.message, /api\.example\.com/);
});

test("a non-JSON body on an unexpected status still reports the status", () => {
  const out = describeUntagResult(502, "<html>bad gateway</html>", CTX);
  assert.equal(out.ok, false);
  assert.match(out.message, /502/);
});

// ---- stored-list formatting -------------------------------------------------

test("lists every badge field with its count", () => {
  const out = formatStoredTags(
    JSON.stringify({ tools: "Warp, Ghostty ,Hex", projects: "tkmx", communities: "" }),
  );
  assert.match(out, /tools \(3\):/);
  assert.match(out, /^ {2}Warp$/m);
  // Stored values carry stray spacing; the listing shows the trimmed text that
  // a removal actually has to match.
  assert.match(out, /^ {2}Ghostty$/m);
  assert.match(out, /projects \(1\):/);
  assert.match(out, /communities \(0\):/);
  assert.match(out, /^ {2}\(none\)$/m);
});

test("a field the server omits entirely reads as empty, not as a crash", () => {
  const out = formatStoredTags(JSON.stringify({ tools: "Warp" }));
  assert.match(out, /tools \(1\):/);
  assert.match(out, /projects \(0\):/);
  assert.match(out, /communities \(0\):/);
});
