# 2ГИС Личный кабинет — внутренний API (reverse-engineered)

> Недокументированный API веб-кабинета `account.2gis.com`. Снято 2026-10-27 из сетевых запросов
> и JS-бандла (`/react/index.*.js`). Может измениться без предупреждения.

## Базовые хосты

Берутся из `window.APP_CONFIG` на странице `https://account.2gis.com/`:

| Ключ | Значение | Назначение |
|---|---|---|
| `accountAPI` | `https://api.account.2gis.com/api/1.0` | основной API кабинета |
| `authAPI` | `https://api.auth.2gis.com/2.1` | SSO (client_id `bizaccount`) |
| `flampAPI` | `https://public-api.reviews.2gis.com` | API отзывов (закреп, жалобы) |
| `lkApiKeyWeb` | 10 символов | значение заголовка `X-Api-Key` |

`X-Api-Key` выбирается по User-Agent (`lkApiKeyAndroid` / `lkApiKeyIOS` / `lkApiKeyWeb`).
Ключ публичный (лежит в HTML), но в репо не коммитим — читаем из `APP_CONFIG` при старте или из env.

## Заголовки

```
Authorization: Bearer <access_token>
X-Api-Key: <lkApiKeyWeb>
Content-Type: application/json
Locale: ru
```

Ответы обёрнуты: `{ "meta": { "code": 200, "errors": {...} }, "result": ... }`.

## Аутентификация

`access_token` = cookie `dg_session_token` (40 символов, не JWT), `refresh_token` = cookie `dg_refresh_token`.

| Метод | Путь | Тело | Ответ `result` |
|---|---|---|---|
| POST | `users/auth` | `{login, password}` | `{access_token, refresh_token, expires_in, biz_user_id}` |
| POST | `users/refreshToken` | `{refreshToken}` (без `Authorization`) | `{access_token, refresh_token, expires_in}` |
| GET | `users` | — | текущий пользователь |

→ MCP может работать headless: логин/пароль из env или refresh-token, автообновление по `expires_in`/401.

## Организация и филиалы

| Метод | Путь | Примечание |
|---|---|---|
| GET | `orgs?fields=orgDetails` | список организаций пользователя |
| GET | `orgs/{orgId}?fields=country,legalForm` | |
| GET | `branches?orgId=&page=&pageSize=&fields=` | список филиалов |
| GET | `branches/{branchId}?fields=contactGroupsWithSplittedPhone,schedule,country,rubrics` | карточка филиала |
| PUT | `branches/{branchId}` | **diff** изменённых полей (name, schedule, …) |
| PUT | `branches/{branchId}/contacts` | `{contacts: [...]}` |
| PUT | `orgs/{orgId}/contacts` | `{contacts: [...]}` — общие контакты компании |
| GET/PUT | `branches/{branchId}/attributes?language=ru` | атрибуты (оплата картой, парковка…) |
| GET/PUT | `branches/{branchId}/special-days` | особый график (праздники) |
| POST | `branches/{branchId}/actualize` | «данные актуальны» |
| GET | `branches/{branchId}/tips` | подсказки по заполнению |

Формат `schedule`:

```json
{
  "days": {
    "Mon": {"from": "09:00", "to": "18:00", "breaks": [{"from": "13:00", "to": "14:00"}]},
    "Sat": {"from": null, "to": null}
  },
  "comment": null,
  "isTemporarilyClosed": false
}
```

`rubrics`: `[{id, name, hasAds}]`.

## Отзывы

| Метод | Путь | Параметры / тело |
|---|---|---|
| GET | `presence/org/{orgId}/reviews` | `limit`, `catalogs=2gis`, `withoutAnswer=true`, пагинация |
| GET | `presence/branch/{branchId}/reviews` | то же по филиалу |
| GET | `presence/reviews/{reviewId}` | один отзыв; обязателен `catalog` |
| GET | `presence/reviews/{reviewId}/comments` | ответы; обязательны `catalog` и `limit` (без него сервер подставляет 200 и сам же отклоняет) |
| **POST** | `presence/reviews/{reviewId}/comments` | `{text, catalog: "2gis", isOfficialAnswer: bool}` |
| DELETE | `presence/reviews/{reviewId}/comments/{commentId}?catalog=&type=` | удалить ответ |
| POST | `presence/reviews/{reviewId}/complaints` | `{text, catalog, isNoClientComplaint}` |
| POST | `review/generateComment` | встроенная генерация ответа 2ГИС |
| GET | `presence/org/{orgId}/rating`, `presence/branch/{branchId}/rating` | обязательно `group=day\|month`, `periodStart`, `periodEnd` (`YYYY-MM-DD`). Ответ `{items:[{start,end,value:{"1".."5": count}}]}` — число отзывов по звёздам за период, не средний балл. `404` = в периоде нет отзывов |
| GET | `presence/org/{orgId}/catalogs`, `.../availableCatalogs` | подключённые площадки |
| POST/DELETE | `{flampAPI}/2.0/reviews/{reviewId}/ispinned` | закрепить отзыв |
| POST | `{flampAPI}/2.0/branches/{branchId}/requestreviews` | запрос отзывов |

Элемент списка отзывов:

```
id, rating, catalog{id,name}, text, dateCreated, dateEdited, commentsCount, likesCount, url,
user{name, photoPreviewUrls, reviewsCount},
attributes{isHidden, isRated, hasUnresolvedComplains, pinStatus},   # isRated=false — неподтверждённый, не входит в рейтинг
allowedActions{reply, replyInCatalog, complain, pin, setMainComment, ...},
hasCompanyComment, firstAnswer, photos, media
```

Обёртка списка: `{2gisReviewsCount, 2gisRating, rdReviewsCount, totalCount, items}`.

## Прочее (на будущее)

`orgs/{orgId}/users`, `orgs/{orgId}/managers`, `geometr/branches/{id}/*` (аналитика),
`branches/{id}/media`, `{photosAPI}` (фото), `competitors/{id}`.

## Не проверено вживую

Запись (POST comments, PUT branches) извлечена из бандла, реальными запросами не проверялась —
проверить на тестовом отзыве/поле с подтверждением владельца аккаунта.
