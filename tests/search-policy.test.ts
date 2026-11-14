/**
 * SearchPolicy — порог поиска от 3 символов (BUG-SEARCH-SCOPE-002).
 *
 * Тестируем: пустая строка → empty; 1–2 символа → too_short; 3+ → search;
 * пробелы по краям обрезаются; дефолт MIN_SEARCH_CHARS = 3.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_SEARCH_CHARS, decideSearch } from "../src/search/SearchPolicy";

test("decideSearch: empty string → empty", () => {
  assert.equal(decideSearch(""), "empty");
});

test("decideSearch: whitespace-only → empty", () => {
  assert.equal(decideSearch("   "), "empty");
});

test("decideSearch: 1 and 2 chars → too_short", () => {
  assert.equal(decideSearch("K"), "too_short");
  assert.equal(decideSearch("KD"), "too_short");
  assert.equal(decideSearch(" т"), "too_short");
});

test("decideSearch: 3 chars → search (включая '-' как символ)", () => {
  assert.equal(decideSearch("KD-"), "search");
  assert.equal(decideSearch("тест"), "search");
});

test("decideSearch: trims leading/trailing spaces before counting", () => {
  assert.equal(decideSearch("  te  "), "too_short");
  assert.equal(decideSearch("  tes "), "search");
});

test("MIN_SEARCH_CHARS defaults to 3", () => {
  assert.equal(MIN_SEARCH_CHARS, 3);
});
