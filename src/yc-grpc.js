"use strict";

/* ── Мини-gRPC поверх встроенного http2 и свой protobuf ────────────────────
   Почему свой, а не пакет. Набор обновления (OTA) возит ТОЛЬКО код самого
   приложения: поставить на машину пользователя grpc-js или protobufjs некому,
   а тянуть их в бандл — значит удвоить его ради двух методов. Поэтому здесь
   лежит ровно тот минимум, которого REST не покрывает вовсе:

     • чтение записей Cloud Logging — у LogReadingService.Read нет HTTP-привязки,
       только gRPC (пакет yandex.cloud.logging.v1);
     • запросы YQL к базе YDB — Ydb.Query.V1.QueryService (сессии + ExecuteQuery).

   Модуль чистый: состояния уровня файла нет, транспорт подменяется пятым
   аргументом grpcCall (его и подставляют проверки). Раньше этот разбор жил
   внутри src/yc-logs.js; вынесен, чтобы второй потребитель не завёл копию.
*/

const http2 = require("http2");

// ── varint / теги ──────────────────────────────────────────────────────────
function varint(n) {
  const out = [];
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  while (v > 127n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((Number(field) << 3) | wire);
}

// Поле типа string (wire 2): длина + байты UTF-8.
function pbString(field, value) {
  const b = Buffer.from(String(value == null ? "" : value), "utf8");
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}

// Поле типа bytes (wire 2): длина + сырые байты.
function pbBytes(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}

// Вложенное сообщение (wire 2).
function pbMessage(field, buf) {
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

// Целое (varint).
function pbInt(field, n) {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

// Логическое (varint 0/1).
function pbBool(field, v) {
  return pbInt(field, v ? 1 : 0);
}

// google.protobuf.Timestamp { int64 seconds = 1; int32 nanos = 2; }
function pbTimestamp(field, ms) {
  const t = Number(ms) || 0;
  const seconds = Math.floor(t / 1000);
  const nanos = Math.max(0, Math.round((t - seconds * 1000) * 1e6));
  return pbMessage(field, Buffer.concat([pbInt(1, seconds), pbInt(2, nanos)]));
}

function readVarint(buf, pos) {
  let shift = 0n;
  let val = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    val |= BigInt(b & 127) << shift;
    if (!(b & 128)) return { value: val, pos };
    shift += 7n;
    if (shift > 70n) break;
  }
  return { value: val, pos };
}

// Разбирает сообщение в плоский список полей:
//   { field, wire, num }        — для wire 0 (varint);
//   { field, wire, buf }        — для wire 2 (длина + байты);
//   { field, wire, num, raw }   — для wire 1/5 (64/32 бита: num как BigInt, raw — сырые байты).
// raw нужен там, где значение — не целое, а float/double или знаковое: одних бит
// в виде BigInt для этого мало, а повторно резать буфер снаружи неудобно.
function pbDecode(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const t = readVarint(buf, pos);
    pos = t.pos;
    const field = Number(t.value >> 3n);
    const wire = Number(t.value & 7n);
    if (!field) break;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      out.push({ field, wire, num: v.value });
    } else if (wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const len = Number(l.value);
      if (!Number.isFinite(len) || len < 0 || pos + len > buf.length) break;
      out.push({ field, wire, buf: buf.slice(pos, pos + len) });
      pos += len;
    } else if (wire === 5) {
      out.push({ field, wire, num: BigInt(buf.readUInt32LE(pos)), raw: buf.slice(pos, pos + 4) });
      pos += 4;
    } else if (wire === 1) {
      out.push({ field, wire, num: buf.readBigUInt64LE(pos), raw: buf.slice(pos, pos + 8) });
      pos += 8;
    } else {
      break; // неизвестный wire-тип — дальше разбирать нельзя
    }
  }
  return out;
}

function pbFirstString(fields, num) {
  for (const f of fields) if (f.field === num && f.wire === 2) return f.buf.toString("utf8");
  return "";
}

// ── gRPC поверх встроенного http2 ──────────────────────────────────────────
// Разбирает поток gRPC-кадров: 1 байт флага сжатия + 4 байта длины + тело.
// Сжатые кадры не поддерживаем (сервисы Яндекс Облака их и не шлют).
function grpcFrames(buf) {
  const out = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const flag = buf.readUInt8(pos);
    const len = buf.readUInt32BE(pos + 1);
    pos += 5;
    if (len < 0 || pos + len > buf.length) break;
    if (!flag) out.push(buf.slice(pos, pos + len));
    pos += len;
  }
  return out;
}

// Унарный вызов (и серверный поток — ответ собирается целиком: у YDB
// ExecuteQuery кадров немного, а порядок результата сохраняется).
//
// headers — готовые заголовки запроса (authorization и, у YDB, x-ydb-*).
// opts.service   — как назвать сервис в тексте ошибки;
// opts.timeoutMessage — свой текст таймаута;
// opts.hint      — (код gRPC) => строка-подсказка.
function grpcCall(origin, methodPath, headers, messageBuf, timeoutMs, opts) {
  const o = opts || {};
  const timeout = Math.max(2000, Number(timeoutMs) || 25000);
  const body = Buffer.isBuffer(messageBuf) ? messageBuf : Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = http2.connect(origin);
    } catch (e) {
      reject(new Error("не удалось подключиться к " + origin + ": " + ((e && e.message) || e)));
      return;
    }
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch {}
      fn(arg);
    };
    client.on("error", (e) => finish(reject, new Error("соединение с " + origin + ": " + ((e && e.message) || e))));

    let req;
    try {
      req = client.request(Object.assign({
        ":method": "POST",
        ":path": methodPath,
        "content-type": "application/grpc+proto",
        te: "trailers",
        "grpc-timeout": Math.max(1, Math.round(timeout / 1000)) + "S",
      }, headers || {}));
    } catch (e) {
      finish(reject, new Error("не удалось создать gRPC-запрос: " + ((e && e.message) || e)));
      return;
    }

    const chunks = [];
    let httpStatus = 0;
    let grpcStatus = null;
    let grpcMessage = "";
    const takeHeaders = (h) => {
      if (h[":status"] !== undefined) httpStatus = Number(h[":status"]);
      if (h["grpc-status"] !== undefined) grpcStatus = Number(h["grpc-status"]);
      if (h["grpc-message"] !== undefined) {
        try {
          grpcMessage = decodeURIComponent(String(h["grpc-message"]));
        } catch {
          grpcMessage = String(h["grpc-message"]);
        }
      }
    };

    req.on("response", takeHeaders);
    req.on("trailers", takeHeaders);
    req.on("data", (d) => chunks.push(d));
    req.on("error", (e) => finish(reject, new Error("gRPC-запрос: " + ((e && e.message) || e))));
    req.setTimeout(timeout, () => {
      try { req.close(); } catch {}
      finish(reject, new Error((o.timeoutMessage || "таймаут gRPC-запроса") + " (" + Math.round(timeout / 1000) + " с)"));
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (grpcStatus !== null && grpcStatus !== 0) {
        const hint = typeof o.hint === "function" ? o.hint(grpcStatus) : "";
        return finish(reject, new Error("gRPC " + grpcStatus + hint + ": " + (grpcMessage || "ошибка " + (o.service || "сервиса"))));
      }
      if (httpStatus && httpStatus !== 200) {
        return finish(reject, new Error("HTTP " + httpStatus + ": " + raw.toString("utf8").slice(0, 300)));
      }
      finish(resolve, grpcFrames(raw));
    });

    const frame = Buffer.alloc(5 + body.length);
    frame.writeUInt8(0, 0);
    frame.writeUInt32BE(body.length, 1);
    body.copy(frame, 5);
    req.end(frame);
  });
}

module.exports = {
  varint,
  tag,
  pbString,
  pbBytes,
  pbMessage,
  pbInt,
  pbBool,
  pbTimestamp,
  readVarint,
  pbDecode,
  pbFirstString,
  grpcFrames,
  grpcCall,
};
