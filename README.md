# EV Battery Management System (BMS)

Real-time monitoring dashboard for a 3S Li-ion battery pack using an STM32 microcontroller, FastAPI backend, and Expo React Native mobile app.

---

## Project Structure

```
bms-project/
├── backend/
│   ├── main.py             # FastAPI app — WebSocket, REST API, fault detection
│   ├── models.py           # SQLAlchemy ORM models
│   ├── database.py         # Async SQLite engine setup
│   ├── virtual_sensor.py   # Simulates STM32 serial output via TCP
│   └── requirements.txt
├── mobile/
│   ├── App.js
│   ├── app.json
│   ├── babel.config.js
│   ├── package.json
│   └── screens/
│       └── DashboardScreen.js
└── README.md
```

---

## Architecture

```
STM32 (or virtual sensor)
        │  serial / TCP JSON lines
        ▼
  FastAPI backend (port 8000)
   ├── fault detection
   ├── SQLite logging
   ├── REST API  GET /api/readings  /api/faults  /api/status
   └── WebSocket  ws://…/ws  ──► Expo React Native app
```

---

## Safety Thresholds (from paper)

| Parameter      | Trigger     | Action                              |
|----------------|-------------|-------------------------------------|
| Over-Voltage   | > 12.6 V    | Open relay, buzzer, red LED         |
| Under-Voltage  | < 9.0 V     | Open relay, buzzer, red LED         |
| Over-Current   | > 10 A      | Open relay, buzzer, red LED         |
| Over-Temp      | > 50 °C     | Open relay, buzzer, red LED         |
| Fire (flame sensor) | detected | Immediate shutdown + continuous buzzer |

---

## Setup & Run

### 1. Backend

```bash
cd backend
pip3 install -r requirements.txt
```

**Terminal 1 — start the virtual sensor (simulates STM32):**

```bash
python3 virtual_sensor.py
# [sensor] virtual STM32 running on 127.0.0.1:9000
```

**Terminal 2 — start the FastAPI server:**

```bash
uvicorn main:app --reload --port 8000
# Browse http://127.0.0.1:8000/docs  for interactive API docs
```

#### Using a real STM32

Set the `SERIAL_PORT` environment variable before starting uvicorn:

```bash
export SERIAL_PORT=/dev/ttyUSB0   # Linux
export SERIAL_PORT=COM3           # Windows
uvicorn main:app --reload --port 8000
```

The STM32 firmware should output one JSON line per second:

```
{"voltage":11.50,"current":2.30,"temperature":35.2,"flame":0,"soc":74.1}
```

---

### 2. Mobile App (Expo React Native)

```bash
cd mobile
npm install
npx expo start
```

Scan the QR code with **Expo Go** (iOS/Android), or press `w` for the web preview.

> **Physical device:** update `WS_URL` in `mobile/screens/DashboardScreen.js` to your machine's LAN IP, e.g.:
> ```js
> const WS_URL = "ws://192.168.1.42:8000/ws";
> ```

---

## REST API Reference

| Method | Endpoint          | Description                        |
|--------|-------------------|------------------------------------|
| GET    | `/api/status`     | Latest sensor reading              |
| GET    | `/api/readings`   | Recent DB readings (`?limit=50`)   |
| GET    | `/api/faults`     | Recent fault events (`?limit=20`)  |
| GET    | `/api/thresholds` | Safety threshold values            |
| WS     | `/ws`             | Live JSON stream (1 Hz)            |
| GET    | `/docs`           | Swagger UI                         |

### Example WebSocket payload

```json
{
  "voltage": 11.52,
  "current": 2.84,
  "temperature": 33.1,
  "flame": 0,
  "soc": 74.6,
  "faults": [],
  "relay_open": false,
  "timestamp": "2026-04-07T10:23:45.123456"
}
```

When a fault fires:

```json
{
  "voltage": 13.1,
  "current": 2.84,
  "temperature": 33.1,
  "flame": 0,
  "soc": 100.0,
  "faults": [
    { "type": "OVER_VOLTAGE", "value": 13.1, "threshold": 12.6 }
  ],
  "relay_open": true,
  "timestamp": "2026-04-07T10:24:01.654321"
}
```

---

## Virtual Sensor Fault Scenarios

The virtual sensor injects the following faults automatically every ~2 minutes to exercise the BMS logic:

- **Over-voltage** — voltage jumps to ~13.1 V for 6 seconds  
- **Over-temperature** — temperature climbs to ~54 °C for 6 seconds  
- **Fire** — flame sensor asserts `1` for 6 seconds  

---

## Hardware Reference (from project paper)

| Component             | Part                   | Purpose                       |
|-----------------------|------------------------|-------------------------------|
| Microcontroller       | STM32F103C8 (72 MHz)   | Central processing unit       |
| Battery pack          | 3× 18650 Li-ion (3S)   | 9.0 V – 12.6 V                |
| Voltage sensor        | Voltage divider 10k/3.3k | Scales to 0–3.3 V ADC       |
| Current sensor        | ACS712 (20 A)          | Hall-effect, 100 mV/A         |
| Temperature sensor    | LM35                   | 10 mV/°C                      |
| Flame sensor          | IR photodiode module   | Digital + analogue output     |
| Relay                 | 5 V 2-channel (opto)   | Disconnects load/charger      |
| Display               | 16×2 LCD + I2C         | Real-time parameter display   |
| Buzzer                | 5 V piezo              | Audible fault alerts          |
| Load simulator        | DC motor 6–12 V        | Simulates vehicle motion      |

---

## Further Development (from paper recommendations)

- Individual cell-level monitoring & active balancing  
- Bluetooth / Wi-Fi remote monitoring  
- SD card data logging for post-incident analysis  
- ML-based predictive fault detection (Kalman filter SOC)  
