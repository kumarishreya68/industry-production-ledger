# 🤖 Robotic Line Live Validation Console & Career Ledger

An end-to-end industrial automation prototype designed to eliminate manual shift logging for manufacturing operators. This system captures real-time data streams from simulated machine sensors and surfaces them on a validation console, shifting the operator's role from tedious data entry to a single-click verification audit.

---

## ⚡ Key Features

- **Automated Data Ingestion:** Streams production output, reject cycles, and system faults directly from simulated PLC feeds without manual paperwork.
- **State Timeline Graph:** Features a continuous, real-time status matrix that maps normal runs, defects, and critical line stoppages sequentially.
- **One-Click Reason Tagging:** Equips operators with immediate context buttons to assign root causes to system jams or quality alerts before sign-off.
- **Long-Term Career Ledger:** Persists verified shift logs in a relational database, transforming standard performance tracking into a personal career portfolio.

---

## 🏗️ System Architecture & Data Flow

```text
[Simulated Machine Sensors] ──(3s Intervals)──> [In-Memory Express Engine]
                                                        │
[PostgreSQL Career Ledger] <──(Verified Submission)── [Live UI Graph Dashboard]
```

---

## 🛠️ Built With

- **Frontend:** HTML5, CSS3 (Dynamic Animations & Grid Framework), Vanilla JavaScript Core
- **Backend:** Node.js, Express.js
- **Database Engine:** PostgreSQL (`pg` Connection Pool Driver)

---

## 🚀 Getting Started

### 1. Database Initialization
Log into your local PostgreSQL instance and execute this table schema command:

```sql
CREATE DATABASE industry_production_db;

\c industry_production_db;

CREATE TABLE shift_logs (
    id SERIAL PRIMARY KEY,
    operator_name VARCHAR(100) NOT NULL,
    good_output INT NOT NULL DEFAULT 0,
    reject_count INT NOT NULL DEFAULT 0,
    downtime_minutes INT NOT NULL DEFAULT 0,
    stop_reason VARCHAR(255) NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE,
    timeline_data TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 2. Installation & Launch
Clone the project, install dependencies, and run the Express app execution loop:

```bash
# Install node packages
npm install express pg

# Boot up the local runtime server instance
node server.js
```
Open your browser and navigate to `http://localhost:3000` to view the running dashboard console.
