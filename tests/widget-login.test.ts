import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLoginTokenFromLink, widgetLoginMessage } from "../src/ui/WidgetLogin";

test("D109 extracts token from TDLib login links without exposing QR rendering", () => {
  assert.equal(extractLoginTokenFromLink("tg://login?token=abc_DEF-123"), "abc_DEF-123");
  assert.equal(extractLoginTokenFromLink("https://t.me/login?x=1&token=a%2Bb"), "a+b");
  assert.equal(extractLoginTokenFromLink("tg://login?token=%zz"), "");
  assert.equal(extractLoginTokenFromLink("tg://login"), "");
});

test("D109 maps delivery state to honest UI states", () => {
  assert.equal(widgetLoginMessage("waiting_token"), "waiting");
  assert.equal(widgetLoginMessage("link_sent"), "sent");
  assert.equal(widgetLoginMessage("send_failed"), "failed");
});
