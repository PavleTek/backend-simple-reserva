# WhatsApp message templates (Meta Business Manager)

Create and approve these templates in **Meta Business Suite** → your app → **WhatsApp** → **Message templates**.  
Template **names** and **body text** must match what [`src/services/whatsappService.js`](../src/services/whatsappService.js) sends.

Set the default template language in **Admin → WhatsApp** (or `WHATSAPP_TEMPLATE_LANGUAGE` in `.env` as fallback) to the **exact** language code you chose when creating each template (e.g. `es`, `es_LA`).

---

## 1. `reservation_confirmation`

- **Category:** UTILITY  
- **Language:** Spanish (match admin WhatsApp setting or `WHATSAPP_TEMPLATE_LANGUAGE`)

**Body** (5 variables: `{{1}}` … `{{5}}`):

```text
Tu reserva en {{1}} esta confirmada. {{2}} a las {{3}} para {{4}} persona(s). Ver o cancelar: {{5}}
```

| Variable | Content |
|----------|---------|
| {{1}} | Restaurant name |
| {{2}} | Date (display) |
| {{3}} | Time (display) |
| {{4}} | Party size (number as text) |
| {{5}} | Manage/cancel URL |

---

## 2. `reservation_reminder`

- **Category:** UTILITY  

**Body** (4 variables):

```text
Recordatorio: Tienes reserva manana en {{1}} a las {{2}} para {{3}} persona(s). Confirmar o cancelar: {{4}}
```

| Variable | Content |
|----------|---------|
| {{1}} | Restaurant name |
| {{2}} | Time |
| {{3}} | Party size |
| {{4}} | Manage URL |

---

## 3. `reservation_modified`

- **Category:** UTILITY  

**Body** (4 variables):

```text
Tu reserva en {{1}} ha sido actualizada. Nueva fecha: {{2}} a las {{3}} para {{4}} persona(s).
```

| Variable | Content |
|----------|---------|
| {{1}} | Restaurant name |
| {{2}} | New date |
| {{3}} | New time |
| {{4}} | Party size |

---

## 4. `reservation_cancelled`

- **Category:** UTILITY  

**Body** (1 variable):

```text
Tu reserva en {{1}} ha sido cancelada correctamente.
```

| Variable | Content |
|----------|---------|
| {{1}} | Restaurant name |

---

## Testing

- In development, add recipient numbers under **API Setup** → allowed test numbers if using a test sender.
- **Admin panel:** store token, sending phone number ID, and WABA ID under **WhatsApp**; sync templates from Meta.
- **Env fallback:** `WHATSAPP_AUTH_TOKEN`, `WHATSAPP_SENDING_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION` (e.g. `v21.0`).

See [WhatsApp Cloud API – Template messages](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates).
