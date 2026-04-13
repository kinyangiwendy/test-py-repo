"""
BMS FastAPI Backend

Endpoints:
  GET  /api/status        — latest sensor reading
  GET  /api/readings      — recent readings from DB  (?limit=50)
  GET  /api/faults        — recent fault events from DB (?limit=20)
  GET  /api/thresholds    — safety threshold values
  WS   /ws                — WebSocket stream (JSON pushed every second)

Serial / sensor source:
  Reads from the virtual sensor TCP server on 127.0.0.1:9000.
  Set SENSOR_HOST / SENSOR_PORT env vars to override, or set
  SERIAL_PORT to use a real COM/tty port instead (e.g. /dev/ttyUSB0).
"""

import asyncio 
import json
import os
from datetime import datetime
from typing import List

import serial_asyncio
from fastapi import Depends, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import AsyncSessionLocal, Base, engine, get_db
from models import FaultEvent, SensorReading

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SENSOR_HOST = os.getenv("SENSOR_HOST", "127.0.0.1")
SENSOR_PORT = int(os.getenv("SENSOR_PORT", "9000"))
SERIAL_PORT = os.getenv("SERIAL_PORT", "")          # e.g. "/dev/ttyUSB0"
SERIAL_BAUD = int(os.getenv("SERIAL_BAUD", "115200"))

THRESHOLDS = {
    "over_voltage": 12.6,
    "under_voltage": 9.0,
    "over_current": 10.0,
    "over_temperature": 50.0,
    "low_battery": 10.0,        # warning before hard cutoff — relay stays closed
    "charge_complete": 12.6,    # stop charging when battery is full
}

# Faults that warn the user but do NOT open the relay
WARN_ONLY_FAULTS = {"LOW_BATTERY"}

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="BMS API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, data: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()
latest_reading: dict = {}

# ---------------------------------------------------------------------------
# Fault detection
# ---------------------------------------------------------------------------

def detect_faults(data: dict) -> list:
    faults = []
    v, i, t = data["voltage"], data["current"], data["temperature"]
    is_charging = bool(data.get("charging", 0))

    # Over-voltage only when NOT charging (charging near 12.6 V is normal)
    if v > THRESHOLDS["over_voltage"] and not is_charging:
        faults.append({"type": "OVER_VOLTAGE", "value": v, "threshold": THRESHOLDS["over_voltage"]})
    if v < THRESHOLDS["under_voltage"]:
        faults.append({"type": "UNDER_VOLTAGE", "value": v, "threshold": THRESHOLDS["under_voltage"]})
    if i > THRESHOLDS["over_current"]:
        faults.append({"type": "OVER_CURRENT", "value": i, "threshold": THRESHOLDS["over_current"]})
    if t > THRESHOLDS["over_temperature"]:
        faults.append({"type": "OVER_TEMP", "value": t, "threshold": THRESHOLDS["over_temperature"]})
    if data.get("flame", 0) == 1:
        faults.append({"type": "FIRE_DETECTED", "value": 1.0, "threshold": 0.0})

    # Low battery warning — above hard cutoff but approaching it (relay stays closed)
    if THRESHOLDS["under_voltage"] <= v <= THRESHOLDS["low_battery"] and not is_charging:
        faults.append({"type": "LOW_BATTERY", "value": v, "threshold": THRESHOLDS["low_battery"]})

    # Charge complete — open charging relay when battery is full
    if is_charging and v >= THRESHOLDS["charge_complete"]:
        faults.append({"type": "CHARGE_COMPLETE", "value": v, "threshold": THRESHOLDS["charge_complete"]})

    return faults

# ---------------------------------------------------------------------------
# Data persistence helper
# ---------------------------------------------------------------------------

async def save_reading(data: dict, faults: list):
    async with AsyncSessionLocal() as db:
        db.add(SensorReading(
            voltage=data["voltage"],
            current=data["current"],
            temperature=data["temperature"],
            flame_detected=bool(data.get("flame", 0)),
            soc=data["soc"],
        ))
        for f in faults:
            db.add(FaultEvent(
                fault_type=f["type"],
                value=f["value"],
                threshold=f["threshold"],
            ))
        await db.commit()

# ---------------------------------------------------------------------------
# Generic line processor (used by both TCP and serial readers)
# ---------------------------------------------------------------------------

async def process_line(line: str):
    global latest_reading
    try:
        raw = json.loads(line.strip())
    except json.JSONDecodeError:
        return

    faults = detect_faults(raw)
    payload = {
        **raw,
        "faults": faults,
        "relay_open": any(f["type"] not in WARN_ONLY_FAULTS for f in faults),
        "timestamp": datetime.utcnow().isoformat(),
    }
    latest_reading = payload

    await save_reading(raw, faults)
    await manager.broadcast(payload)

# ---------------------------------------------------------------------------
# TCP sensor reader (virtual sensor)
# ---------------------------------------------------------------------------

async def tcp_sensor_loop():
    while True:
        try:
            reader, writer = await asyncio.open_connection(SENSOR_HOST, SENSOR_PORT)
            print(f"[backend] connected to virtual sensor at {SENSOR_HOST}:{SENSOR_PORT}")
            while True:
                line = await reader.readline()
                if not line:
                    break
                await process_line(line.decode())
        except ConnectionRefusedError:
            print("[backend] virtual sensor not available — retrying in 3 s …")
        except Exception as exc:
            print(f"[backend] TCP read error: {exc}")
        await asyncio.sleep(3)

# ---------------------------------------------------------------------------
# Serial sensor reader (real STM32)
# ---------------------------------------------------------------------------

async def serial_sensor_loop():
    while True:
        try:
            reader, _ = await serial_asyncio.open_serial_connection(
                url=SERIAL_PORT, baudrate=SERIAL_BAUD
            )
            print(f"[backend] connected to serial port {SERIAL_PORT}")
            while True:
                line = await reader.readline()
                await process_line(line.decode(errors="ignore"))
        except Exception as exc:
            print(f"[backend] serial error: {exc} — retrying in 5 s …")
        await asyncio.sleep(5)

# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    if SERIAL_PORT:
        asyncio.create_task(serial_sensor_loop())
    else:
        asyncio.create_task(tcp_sensor_loop())


@app.on_event("shutdown")
async def shutdown():
    await engine.dispose()

# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    # Send the most recent reading immediately on connect
    if latest_reading:
        await websocket.send_json(latest_reading)
    try:
        while True:
            # Keep the connection alive; we don't expect client messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/api/status")
async def get_status():
    return latest_reading or {"message": "Waiting for sensor data…"}


@app.get("/api/thresholds")
async def get_thresholds():
    return THRESHOLDS


@app.get("/api/readings")
async def get_readings(limit: int = 50, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SensorReading).order_by(desc(SensorReading.timestamp)).limit(limit)
    )
    rows = result.scalars().all()
    return [
        {
            "id": r.id,
            "voltage": r.voltage,
            "current": r.current,
            "temperature": r.temperature,
            "flame_detected": r.flame_detected,
            "soc": r.soc,
            "timestamp": r.timestamp.isoformat() if r.timestamp else None,
        }
        for r in rows
    ]


@app.get("/api/faults")
async def get_faults(limit: int = 20, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(FaultEvent).order_by(desc(FaultEvent.timestamp)).limit(limit)
    )
    rows = result.scalars().all()
    return [
        {
            "id": f.id,
            "fault_type": f.fault_type,
            "value": f.value,
            "threshold": f.threshold,
            "timestamp": f.timestamp.isoformat() if f.timestamp else None,
        }
        for f in rows
    ]
