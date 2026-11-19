# mu-places — ฐานข้อมูลกลางแผนที่สายมู (Cloudflare Worker + D1)

- `GET /places` รายการทั้งหมดสำหรับแผนที่
- `GET /place?id=` รายละเอียดสถานที่ (+ อัปเดตคะแนนจาก Google ถ้าตั้ง GOOGLE_KEY)
- `/admin/*` ต้องส่ง `Authorization: Bearer <ADMIN_KEY>`

Secrets: `ADMIN_KEY` (บังคับ), `GOOGLE_KEY` (ไม่บังคับ) · Vars: `REFRESH_DAYS` (30), `REFRESH_LIMIT` (900)
