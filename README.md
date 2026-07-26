# QA API Automation Tool — Privy Identitas Digital

Tools internal untuk generate test case dari curl, kelola environment (DEV/STG/PROD),
eksekusi test API, dan monitoring endpoint ala Datadog (health score, response time trend, drift detection).

## Struktur Project
```
qa-tool/
├── backend/           # Express API + PostgreSQL
│   └── src/
│       ├── db/        # schema.sql, connection pool
│       ├── routes/     # environments, endpoints, test-cases, runs, dashboard
│       └── services/   # curlParser, schemaTool, testRunner
├── frontend/          # React (Vite) dashboard
│   └── src/
│       ├── pages/      # Dashboard, ImportCurl, TestCases, Environments
│       └── api/        # axios client
└── docker-compose.yml # Postgres lokal
```

## Setup

### 1. Jalankan database
```bash
docker compose up -d
```
Ini otomatis create database `qa_tool` dan run `schema.sql` (termasuk seed environment DEV/STG/PROD sesuai config privysign).

### 2. Setup backend
```bash
cd backend
cp .env.example .env
npm install
npm run dev
```
Backend jalan di `http://localhost:4010`.

### 3. Setup frontend
```bash
cd frontend
npm install
npm run dev
```
Frontend jalan di `http://localhost:5180` (proxy otomatis ke backend `/api`).

> **Catatan port:** sengaja dibuat beda dari default Vite (5173) dan default Express (4000) supaya tidak bentrok dengan tools lain yang mungkin sudah jalan di komputer kamu (misalnya QA Checkpoint Builder). Kalau `5180` atau `4010` juga sudah kepakai, ganti di `frontend/vite.config.js` (server.port & proxy target) dan `backend/.env` (PORT).

## Alur Pakai
1. Buka menu **Import Curl** → paste curl command → tool auto-hit endpoint, generate schema, dan suggest assertion (status code, response time, field exists).
2. Simpan sebagai test case.
3. Buka menu **Test Cases** → pilih environment → klik **Run**. Kalau environment ditandai `protected` (contoh: PROD), akan muncul konfirmasi dulu.
4. Buka menu **Dashboard** untuk lihat health score tiap endpoint, response time trend (p95), dan alert list (fail/error/drift terbaru).
5. Buka menu **Environments** untuk tambah/import (Postman `.json` atau `.env`) / export environment.

## Yang Belum Diimplementasikan (next steps)
- Scheduler otomatis (cron) untuk trigger `run-batch` secara berkala
- Notifier ke Telegram bot (`@qa_001_bot`) dan auto-create Jira ticket via Atlassian MCP saat FAIL/DRIFT
- Auth token manager (auto-refresh token per environment)
- Import dari Postman Collection (endpoint-nya, bukan cuma environment)

Semua modul ini sudah punya tempat di arsitektur (lihat `services/` dan `routes/`), tinggal ditambahkan sesuai prioritas.
