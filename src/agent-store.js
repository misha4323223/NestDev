"use strict";

/* ─── Хранилище агента: сборка ───────────────────────────────────────────────
   До части 38 это был один файл на 1536 строк; теперь здесь только сборка:
     store-files.js       — день и время по часам пользователя, маскировка
                            секретов, атомарная запись текста;
     notes-checkpoints.js — заметки проекта и точки отката;
     context-memory.js    — память диалогов (сжатые памятки контекста по датам);
     tasks.js             — дела со сроками и их повторы.

   Наружу отдаются ТЕ ЖЕ имена, что и раньше: main.js, mission-store.js, панель
   памяти и стенды берут хранилище одним require. Правки делать в модулях —
   кода поведения здесь нет. */

const {
  NOTE_MAX_LEN, NOTE_MAX_COUNT, memoryFile, noteSave, noteRead, noteDelete,
  DIARY_FILENAME, DIARY_MAX_BYTES, DIARY_MAX_ENTRY, diaryFile, diaryAppend, diaryRead,
  checkpointsDir, checkpointSave, checkpointList, checkpointRollback,
} = require("./notes-checkpoints.js");
const {
  CTX_MEMO_MAX_CHARS, CTX_MEMO_DAY_KEEP, contextMemoryDir, sanitizeMemoMessages, contextMemorySave, contextMemoryDays, contextMemoryRead, contextMemorySearch, contextMemoryPrune, contextMemoryClear, contextMemoryStats,
} = require("./context-memory.js");
const {
  TASK_MAX, TASK_STATUSES, TASK_PRIORITIES, TASK_REMIND_BEFORE_MS, TASK_REPEAT_MAX_MIN, TASK_AUTO_TRIES_MAX, tasksFile, parseDue, parseRepeat, repeatLabel, nextDueDate, advanceRepeat, tasksAdd, tasksList, tasksUpdate, tasksDone, tasksDelete, tasksBoard, tasksSummary, tasksTakeReminders, tasksTakeAuto, tasksAutoAck, tasksAutoRearm, tasksNextDue, tasksFormatText, tasksBrief, humanDue, taskLine,
} = require("./tasks.js");
const {
  localDayKey, redactSecrets,
} = require("./store-files.js");

module.exports = {
  NOTE_MAX_LEN,
  NOTE_MAX_COUNT,
  memoryFile,
  noteSave,
  noteRead,
  noteDelete,
  // дневник агента (.agent/AGENT.md) — читаемый человеком файл памяти в проекте
  DIARY_FILENAME,
  DIARY_MAX_BYTES,
  DIARY_MAX_ENTRY,
  diaryFile,
  diaryAppend,
  diaryRead,
  checkpointsDir,
  checkpointSave,
  checkpointList,
  checkpointRollback,
  // память диалогов (сжатые памятки контекста по датам)
  CTX_MEMO_MAX_CHARS,
  CTX_MEMO_DAY_KEEP,
  contextMemoryDir,
  localDayKey,
  redactSecrets,
  sanitizeMemoMessages,
  contextMemorySave,
  contextMemoryDays,
  contextMemoryRead,
  contextMemorySearch,
  contextMemoryPrune,
  contextMemoryClear,
  contextMemoryStats,
  // дела (задачи со сроками) — роль «Менеджер»
  TASK_MAX,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_REMIND_BEFORE_MS,
  TASK_REPEAT_MAX_MIN,
  tasksFile,
  parseDue,
  parseRepeat,
  repeatLabel,
  nextDueDate,
  advanceRepeat,
  tasksAdd,
  tasksList,
  tasksUpdate,
  tasksDone,
  tasksDelete,
  tasksBoard,
  tasksSummary,
  tasksTakeReminders,
  tasksTakeAuto,
  tasksAutoAck,
  tasksAutoRearm,
  TASK_AUTO_TRIES_MAX,
  tasksNextDue,
  tasksFormatText,
  tasksBrief,
  humanDue,
  taskLine,
};
