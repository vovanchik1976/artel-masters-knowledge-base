/**
 * T8 — заголовок баланса без мигания (D-BP-5).
 *
 * Правило: «⏳ loading…» показывается ТОЛЬКО пока значение не известно ни разу.
 * Повторные опросы (WS-доставка, 15-секундный polling, ретраи) НЕ трогают текст —
 * иначе заголовок мигает между значением и плейсхолдером (живой дефект: App.ts
 * писал `t("header.loading_balance")` первым делом в каждом fetchAndShowBalance).
 *
 * Сценарии:
 *  H1  новое состояние → hint="loading".
 *  H2  дедуп запроса: второй begin во время in-flight → started=false.
 *  H3  settle сбрасывает флаг → следующий begin проходит; без значения hint остаётся loading.
 *  H4  end устанавливает значение (changed=true); то же значение повторно → changed=false.
 *  H5  ошибка запроса (settle) сохраняет прежнее значение → hint="value".
 *  H6  push: без значения → changed=true; равное → changed=false; новое → changed=true.
 *  H7  reset (logout) → снова loading.
 *  H8  push во время in-flight: значение применяется сразу (hint=value).
 *
 * Ранер: npm run test:ui
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  newHeaderBalance,
  beginHeaderFetch,
  settleHeaderFetch,
  endHeaderFetch,
  applyHeaderPush,
  headerHint,
  resetHeaderBalance,
} from "../src/ui/headerBalance";

test("H1: новое состояние — hint=loading", () => {
  const s = newHeaderBalance();
  assert.equal(headerHint(s), "loading");
  assert.equal(s.value, null);
  assert.equal(s.inFlight, false);
});

test("H2: дедуп — второй begin во время in-flight не стартует", () => {
  let s = newHeaderBalance();
  const first = beginHeaderFetch(s);
  assert.equal(first.started, true);
  s = first.state;
  assert.equal(s.inFlight, true);

  const second = beginHeaderFetch(s);
  assert.equal(second.started, false, "параллельный запрос должен отсекаться");
  assert.equal(second.state.inFlight, true);
  assert.equal(second.state.value, null);
});

test("H3: settle сбрасывает in-flight, но не даёт значения без ответа", () => {
  let s = newHeaderBalance();
  s = beginHeaderFetch(s).state;
  s = settleHeaderFetch(s);
  assert.equal(s.inFlight, false);

  const again = beginHeaderFetch(s);
  assert.equal(again.started, true, "после settle новый запрос должен стартовать");
  s = again.state;
  assert.equal(headerHint(s), "loading", "значения нет — показываем ⏳");
});

test("H4: end устанавливает значение; повтор того же значения — без перерисовки", () => {
  let s = newHeaderBalance();
  s = beginHeaderFetch(s).state;

  const first = endHeaderFetch(s, 50);
  assert.equal(first.state.value, 50);
  assert.equal(first.state.inFlight, false);
  assert.equal(first.changed, true);
  s = first.state;
  assert.equal(headerHint(s), "value");

  const same = endHeaderFetch(s, 50);
  assert.equal(same.changed, false, "одинаковое значение не должно дёргать текст");
});

test("H5: ошибка запроса не теряет прежнее значение (нет дребезга)", () => {
  let s = newHeaderBalance();
  s = endHeaderFetch(beginHeaderFetch(s).state, 50).state;

  s = beginHeaderFetch(s).state;
  s = settleHeaderFetch(s); // fetch упал → значение сохранено

  assert.equal(s.value, 50);
  assert.equal(headerHint(s), "value", "после ошибки текст остаётся прежним");
  assert.equal(s.inFlight, false);
});

test("H6: push применяется мгновенно и без лишней перерисовки", () => {
  let s = newHeaderBalance();

  const pushed = applyHeaderPush(s, 42);
  assert.equal(pushed.changed, true);
  assert.equal(pushed.state.value, 42);
  s = pushed.state;

  const equal = applyHeaderPush(s, 42);
  assert.equal(equal.changed, false, "повтор того же баланса — no-op");

  const next = applyHeaderPush(equal.state, 35);
  assert.equal(next.changed, true);
  assert.equal(next.state.value, 35);
  assert.equal(headerHint(next.state), "value");
});

test("H7: reset (logout) возвращает состояние к loading", () => {
  let s = newHeaderBalance();
  s = endHeaderFetch(beginHeaderFetch(s).state, 50).state;

  s = resetHeaderBalance();
  assert.equal(headerHint(s), "loading");
  assert.equal(s.value, null);
  assert.equal(s.inFlight, false);
});

test("H8: push во время in-flight снимает «loading» сразу", () => {
  let s = beginHeaderFetch(newHeaderBalance()).state;
  s = applyHeaderPush(s, 77).state;

  assert.equal(headerHint(s), "value", "сервер уже прислал значение — ⏳ не нужен");
  assert.equal(s.value, 77);
});
