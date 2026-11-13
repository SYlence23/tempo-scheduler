# HTTP API Tempo

API використовує JSON. Помилка має вигляд `{ "error": "Пояснення" }`. Авторизація: `Authorization: Bearer <token>`. Для SSE та завантаження інтерфейс може передавати токен у параметрі `?token=`. Nginx пише в access log лише шлях без query string.

## Маршрути

| Метод | Маршрут | Доступ | Результат |
| --- | --- | --- | --- |
| GET | `/api/health`, `/health` | відкритий | API-сервер, БД, час, ліміти |
| POST | `/api/auth/register` | відкритий | `{name,email,password}` → `{token,user}` |
| POST | `/api/auth/login` | відкритий | `{email,password}` → `{token,user}` |
| GET | `/api/auth/me` | користувач | `{user}` |
| POST | `/api/jobs` | користувач | новий розрахунок → `{job}` |
| GET | `/api/jobs` | користувач | власні останні 50 розрахунків → `{jobs}` |
| GET | `/api/jobs/:id` | власник / admin | `{job}` |
| POST | `/api/jobs/:id/cancel` | власник / admin | `{job}` зі статусом `cancelled` |
| GET | `/api/jobs/:id/events` | власник / admin | SSE, `data: <job JSON>` |
| GET | `/api/jobs/:id/download` | власник / admin | JSON-звіт вкладенням |
| GET | `/api/admin/metrics` | admin | черга, вузли, CPU/RAM, ціль воркерів, ліміти |

## Приклад вводу

```json
{
  "name": "Невеликий проєкт",
  "resources": [
    { "id": "R1", "name": "Команда A" },
    { "id": "R2", "name": "Команда B" }
  ],
  "tasks": [
    { "id": "T1", "name": "Дослідження", "duration": 3, "deadline": 5, "dependencies": [] },
    { "id": "T2", "name": "Розробка", "duration": 8, "deadline": 14, "dependencies": ["T1"], "eligibleResources": ["R2"] }
  ],
  "iterations": 200000,
  "seed": 42
}
```

Залежності мають утворювати DAG. Порожній список `eligibleResources` означає всі ресурси. Ідентифікатори унікальні, до 40 букв, цифр, `_` або `-`. Тривалість 0.001–1000 годин, дедлайн 0.001–100000 годин від початку плану; значення нормалізуються до трьох знаків. Ліміти кількості й тайм-аут повертає `/api/health`.

## Стани та результат

`queued → running → completed / failed / cancelled`.

Розрахунок містить ввід `input`, результат `result`, відсоток `progress`, опис `stage`, `worker_id`, `handled_by`, часові позначки й `execution_ms`. Для черги додаються `queue_position` та `estimated_wait_seconds`.

Результат має `baseline` і `optimized`. Кожен включає `schedule`, `makespan`, `tardiness`, `score`. Рядок розкладу: `taskId`, `name`, `resourceId`, `start`, `end`, `duration`, `deadline`, `late`. Додаткові показники: `improvementPercent`, `iterations`, `elapsedMs`, `resourceUtilization` у відсотках і `convergence`.

Оцінка очікування моделює час звільнення активних воркерів за їхнім прогресом і розподіляє наступні задачі по доступних слотах. Це приблизна оцінка, а не гарантований час старту.

Виконання після аварійного відновлення може повторитися. Захист за поточним статусом, власником і номером спроби не дозволяє застарілому обчисленню перезаписати актуальний результат.
