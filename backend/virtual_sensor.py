"""
Virtual Sensor — simulates STM32 serial output for a 3S Li-ion battery pack.

Runs a TCP server on 127.0.0.1:9000.
Each connected client receives one JSON line per second:
  {"voltage": 11.5, "current": 2.3, "temperature": 35.2, "flame": 0, "soc": 74.1, "charging": 0}

Fault scenarios fire automatically every ~2 minutes to exercise the BMS logic:
  - Over-voltage    (>12.6 V)
  - Over-temperature (>50 °C)
  - Fire detection  (flame = 1)
  - Low battery     (~9.5 V — warning zone, above hard cutoff)

Charging simulation fires every ~3 minutes:
  - Voltage ramps from current level up to 12.6 V
  - Current goes negative (~−1.5 A, charge current)
  - Triggers CHARGE_COMPLETE fault when voltage reaches 12.6 V
"""

import asyncio
import json
import math
import random


class BatterySimulator:
    """Simulates a 3S 18650 Li-ion pack (9.0 V – 12.6 V nominal)."""

    FAULT_CYCLE = 120        # ticks between fault injections
    FAULT_DURATION = 6       # ticks each fault lasts

    CHARGE_CYCLE = 180       # ticks between charging sessions
    CHARGE_DURATION = 25     # max ticks a charging session lasts

    SCENARIOS = [
        "over_voltage",
        "over_temp",
        "fire",
        "low_battery",
        None, None, None,    # weight toward normal operation
    ]

    def __init__(self):
        self.tick = 0
        self.fault_mode = None
        self.fault_timer = 0

        # Charging state
        self.charging = False
        self.charge_tick = 0
        self.base_voltage = 11.5    # voltage when charging began

    # ------------------------------------------------------------------
    def _next_fault(self):
        """Inject a random fault scenario every FAULT_CYCLE ticks."""
        if self.tick % self.FAULT_CYCLE == 0 and self.tick != 0:
            # Don't inject faults while charging (would mask CHARGE_COMPLETE)
            if not self.charging:
                self.fault_mode = random.choice(self.SCENARIOS)
                self.fault_timer = self.FAULT_DURATION

        if self.fault_timer > 0:
            self.fault_timer -= 1
        else:
            self.fault_mode = None

    # ------------------------------------------------------------------
    def _update_charging(self, current_voltage: float) -> bool:
        """Start/advance/stop a charging session. Returns True while charging."""
        if not self.charging:
            # Start a new charge session every CHARGE_CYCLE ticks
            if self.tick % self.CHARGE_CYCLE == 0 and self.tick != 0:
                self.charging = True
                self.charge_tick = 0
                self.base_voltage = current_voltage
                # Clear any active fault so charging isn't masked
                self.fault_mode = None
                self.fault_timer = 0
        else:
            self.charge_tick += 1
            # Stop charging after max duration or when battery is full
            if self.charge_tick >= self.CHARGE_DURATION:
                self.charging = False
        return self.charging

    # ------------------------------------------------------------------
    def update(self) -> dict:
        self.tick += 1
        self._next_fault()

        # --- Base voltage (before fault/charge overrides) ---------------
        base = 11.8 - (self.tick * 0.0015)          # slow discharge
        base_v = base + math.sin(self.tick * 0.12) * 0.4 + random.uniform(-0.05, 0.05)
        base_v = max(9.2, min(12.5, base_v))

        # --- Charging mode --------------------------------------------
        charging = self._update_charging(base_v)

        if charging:
            # Ramp voltage from base_voltage toward 12.6 V
            progress = self.charge_tick / self.CHARGE_DURATION
            voltage = self.base_voltage + (12.6 - self.base_voltage) * progress
            voltage = min(12.65, voltage + random.uniform(-0.02, 0.02))
            current = -(1.5 + random.uniform(-0.1, 0.1))   # negative = charging
        else:
            # --- Fault overrides ---
            if self.fault_mode == "over_voltage":
                voltage = 13.1 + random.uniform(-0.1, 0.2)
            elif self.fault_mode == "low_battery":
                # 9.5 V: above 9.0 V hard cutoff but below 10.0 V warning
                voltage = 9.5 + random.uniform(-0.1, 0.1)
            else:
                voltage = base_v
            current = 2.8 + math.sin(self.tick * 0.18) * 1.8 + random.uniform(-0.3, 0.3)
            current = max(0.1, round(current, 2))

        # --- Temperature -----------------------------------------------
        if self.fault_mode == "over_temp":
            temperature = 53.0 + random.uniform(-1.0, 2.0)
        else:
            temperature = 32.0 + math.sin(self.tick * 0.06) * 7 + random.uniform(-0.5, 0.5)
            temperature = max(22.0, min(47.0, temperature))

        # --- Flame sensor (digital) ------------------------------------
        flame = 1 if self.fault_mode == "fire" else 0

        # --- State of Charge (simplified voltage-based) ----------------
        soc = ((voltage - 9.0) / (12.6 - 9.0)) * 100.0
        soc = max(0.0, min(100.0, soc))

        return {
            "voltage": round(voltage, 2),
            "current": round(current, 2),
            "temperature": round(temperature, 1),
            "flame": flame,
            "soc": round(soc, 1),
            "charging": 1 if charging else 0,
        }


# -----------------------------------------------------------------------
# TCP server — one simulator shared across all connections
# -----------------------------------------------------------------------

simulator = BatterySimulator()


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    addr = writer.get_extra_info("peername")
    print(f"[sensor] client connected: {addr}")
    try:
        while True:
            data = simulator.update()
            line = json.dumps(data) + "\n"
            writer.write(line.encode())
            await writer.drain()
            await asyncio.sleep(1.0)
    except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
        pass
    finally:
        print(f"[sensor] client disconnected: {addr}")
        writer.close()


async def main():
    host, port = "127.0.0.1", 9000
    server = await asyncio.start_server(handle_client, host, port)
    print(f"[sensor] virtual STM32 running on {host}:{port}")
    print("[sensor] press Ctrl-C to stop\n")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[sensor] stopped")
