# Документация по исправлению селектора моделей, саб-агентов и Team Mode

**Дата:** 12 августа 2026 г.  
**Сервер:** `192.168.55.117`  
**Путь:** `/workspace/tech/opencode-antigravity-auth-fork/docs/MODEL_SELECTOR_AND_SUBAGENT_FIX.md`  
**Компоненты:** OpenCode Web (`opencode-web.service`), `oh-my-openagent`, `@mrsib/opencode-antigravity-auth`.

---

## 📋 Содержание

1. [Проблема 1: Падение селектора моделей (`TypeError: Object.entries`)](#1-проблема-1-падение-селектора-моделей-typeerror-objectentries)
2. [Проблема 2: Сбой вызова саб-агентов (Momus, Oracle, Metis)](#2-проблема-2-сбой-вызова-саб-агентов-momus-oracle-metis)
3. [Проблема 3: Отсутствие и отказ Team Mode (`team_*` tools)](#3-проблема-3-отсутствие-и-отказ-team-mode-team_-tools)
4. [Чек-лист для обслуживания и перезапуска](#4-чек-лист-для-обслуживания-и-перезапуска)

---

## 1. Проблема 1: Падение селектора моделей (`TypeError: Object.entries`)

### Симптомы
- При нажатии на выпадающий список выбора моделей в веб-интерфейсе OpenCode (`opencode web`) возникала ошибка:  
  `Unexpected server error. Check server logs for details.`
- В логах службы `journalctl -u opencode-web` фиксировалось исключение:
  ```text
  TypeError: Object.entries requires that input parameter not be null or undefined
      at Provider.list (definition)
      at ProviderHttpApi.list
  ```
- Команда CLI `opencode models` падала с аналогичной ошибкой `exit code 1`.

### Причина
В конфигурационном файле `/root/.config/opencode/opencode.json` содержались устаревшие блоки провайдеров `google_api` и `local`, у которых отсутствовало обязательное ключевое поле `"npm"` (`@ai-sdk/...`), либо содержалась неполная структура полей `models` и `variants`. При вызове функции `Provider.list` в ядрах OpenCode маппер пытался выполнить `Object.entries` над несуществующими свойствами.

### Решение
Конфигурация провайдеров в `/root/.config/opencode/opencode.json` была приведена к строгому стандарту:
1. Удалены некорректные незарегистрированные блоки `google_api` и `local`.
2. Провайдеры `wdsa` и `google` описаны со всеми необходимыми атрибутами (`npm`, `options`, `models`, `variants`, `limit`, `modalities`):

```json
{
  "provider": {
    "wdsa": {
      "name": "WDSA LLM Gateway",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://llm.wdsa.ru/v1"
      },
      "models": {
        "gemini-3.6-flash-high": { "name": "Gemini 3.6 Flash High (WDSA)" }
      }
    },
    "google": {
      "name": "Google",
      "npm": "@ai-sdk/google",
      "options": {
        "baseURL": "http://127.0.0.1:51128/v1beta",
        "apiKey": "antigravity-dummy-key"
      },
      "models": {
        "antigravity-gemini-3.6-flash": {
          "name": "Gemini 3.6 Flash (Antigravity)",
          "variants": { "high": { "thinkingLevel": "high" } }
        }
      }
    }
  }
}
```

---

## 2. Проблема 2: Сбой вызова саб-агентов (Momus, Oracle, Metis)

### Симптомы
- Основной агент в сессии (например, Prometheus) работал нормально, но при попытке вызвать саб-агента **Momus** (Plan Critic) или **Oracle** вызов сбрасывался с ошибкой неверной модели или переключался на сторонние неработающие модели.
- В метаданных саб-агента фигурировал технический ID `antigravity-gemini-3.6-flash-high`.

### Причина
1. **Проверка через `models.json`:** Перед вызовом любого саб-агента плагин `oh-my-openagent` выполняет функцию `resolveSubagentModel()`, которая проверяет наличие модели в файле кэша провайдеров `/root/.cache/opencode/models.json` (массив `data["models"]["google"]`).
2. **Недостающие записи кэша:** Если массив `models.json` не содержал записи `antigravity-gemini-3.6-flash-high`, плагин считал модель недоступной и молча активировал аварийную цепочку `fallbackChain`, переключая саб-агентов на сторонние незарегистрированные модели.
3. **`ULTIMATE_FALLBACK` в JS-бандлах:** В скомпилированных JS-файлах плагина `oh-my-openagent` по умолчанию стоял хардкод спас-моделей `opencode/gpt-5-nano` или `deepseek-v4-flash`.

### Решение
1. **Запущен скрипт настройки моделей (`apply_desktop_gemini_fix.py`):**
   Кэш `/root/.cache/opencode/models.json` принудительно заполнен квалифицированными идентификаторами:
   ```json
   {
     "models": {
       "google": [
         { "id": "antigravity-gemini-3.6-flash-high", "name": "Gemini 3.6 Flash High" },
         { "id": "antigravity-gemini-3.6-flash-medium", "name": "Gemini 3.6 Flash Medium" },
         { "id": "antigravity-gemini-3.6-flash-low", "name": "Gemini 3.6 Flash Low" },
         { "id": "antigravity-gemini-3.1-pro-high", "name": "Gemini 3.1 Pro High" }
       ]
     },
     "connected": ["google"]
   }
   ```
2. **Пропатчены JS-бандлы `oh-my-openagent`:**  
   В файлах `/root/.cache/opencode/packages/oh-my-openagent/node_modules/oh-my-openagent/dist/` заменены захардкоженные не-Gemini модели и `ULTIMATE_FALLBACK` на `"google/antigravity-gemini-3.6-flash-high"`.

---

## 3. Проблема 3: Отсутствие и отказ Team Mode (`team_*` tools)

### Симптомы
- При выполнении команд `/hyperplan` или `/security-research` система выдавала предупреждение:
  ```text
  Team-mode tools (team_*) are currently unavailable in this session.
  To enable team-mode for /hyperplan, please update your configuration...
  ```
- Инструменты `team_create`, `team_task_create` и др. отсутствовали в реестре доступных инструментов агента.

### Причина
1. **Ошибочная вложенность `"[opencode]": {` в `omo.jsonc`:**  
   В файлах `~/.omo/omo.jsonc` параметры конфигурации были обёрнуты во внутрисистемный ключ `"[opencode]": { "team_mode": { "enabled": true } }`. Плагин `oh-my-openagent` парсит схему только на **верхнем (root) уровне** JSON-структуры, из-за чего получал `undefined` и сбрасывал `team_mode.enabled` в `false`.
2. **Перекрытие наследуемыми JSON-файлами:**  
   В директории `/root/.config/opencode/` находились legacy-файлы `oh-my-openagent.json` и `oh-my-opencode.json`. Плагин считывает их и объединяет поверх `omo.jsonc`. Если в этих файлах отсутствовал блок `"team_mode": { "enabled": true }`, они перекрывали значение из `omo.jsonc`.

### Решение
1. **Исправлена структура `omo.jsonc`:**  
   Все ключевые секции (`team_mode`, `agents`, `categories`, `model_fallback`) вынесены на верхний уровень:
   ```jsonc
   {
     "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json",
     "team_mode": {
       "enabled": true
     },
     "model_fallback": false,
     "agents": { ... },
     "categories": { ... }
   }
   ```
2. **Синхронизированы все файлы конфигурации на сервере:**  
   Секция `"team_mode": { "enabled": true }` добавлена во все используемые конфиги:
   - `/root/.config/opencode/oh-my-openagent.json`
   - `/root/.config/opencode/oh-my-opencode.json`
   - `/root/.config/opencode/opencode.json`
   - `/root/.omo/omo.jsonc`

---

## 4. Чек-лист для обслуживания и перезапуска

При любых изменениях в конфигурациях или обновлении OpenCode выполнять следующую последовательность:

1. **Проверка кэша моделей:**
   Убедиться, что `/root/.cache/opencode/models.json` содержит массив моделей `google`.
2. **Проверка валидности CLI:**
   ```bash
   opencode models
   ```
   Должна возвращать список моделей и `exit code 0`.
3. **Принудительный перезапуск веб-службы:**
   ```bash
   restart-opencode
   ```
   *(Команда перезапускает `opencode-web.service` и применяет изменённый кэш моделей и конфигурацию `team_mode` для всех новых сессий).*
