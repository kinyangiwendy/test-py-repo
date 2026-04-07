"""
Virtual Sensor — simulates STM32 serial output for a 3S Li-ion battery pack.

Runs a TCP server on 127.0.0.1:9000.
Each connected client receives one JSON line per second:
  {"voltage": 11.5, "current": 2.3, "temperature": 35.2, "flame": 0, "soc": 74.1}

Fault scenarios fire automatically every ~2 minutes to exercise the BMS logic:
  - Over-voltage  (>12.6 V)
  - Over-temperature (>50 °C)
  - Fire detection (flame = 1)
"""

import asyncio
import json
import math
import random


class BatterySimulator:
    """Simulates a 3S 18650 Li-ion pack (9.0 V – 12.6 V nominal)."""

    FAULT_CYCLE = 120        # ticks between fault injections
    FAULT_DURATION = 6       # ticks each fault lasts
    SCENARIOS = [
        "over_voltage",
        "over_temp",
        "fire",
        None, None, None,    # weight toward normal operation
    ]

    def __init__(self):
        self.tick = 0
        self.fault_mode = None
        self.fault_timer = 0

    # ------------------------------------------------------------------
    def _next_fault(self):
        if self.tick % self.FAULT_CYCLE == 0 and self.tick != 0:
            self.fault_mode = random.choice(self.SCENARIOS)
            self.fault_timer = self.FAULT_DURATION

        if self.fault_timer > 0:
            self.fault_timer -= 1
        else:
            self.fault_mode = None

    # ------------------------------------------------------------------
    def update(self) -> dict:
        self.tick += 1
        self._next_fault()

        # --- Voltage ---------------------------------------------------
        if self.fault_mode == "over_voltage":
            voltage = 13.1 + random.uniform(-0.1, 0.2)
        else:
            base = 11.8 - (self.tick * 0.0015)          # slow discharge
            voltage = base + math.sin(self.tick * 0.12) * 0.4 + random.uniform(-0.05, 0.05)
            voltage = max(9.2, min(12.5, voltage))

        # --- Temperature -----------------------------------------------
        if self.fault_mode == "over_temp":
            temperature = 53.0 + random.uniform(-1.0, 2.0)
        else:
            temperature = 32.0 + math.sin(self.tick * 0.06) * 7 + random.uniform(-0.5, 0.5)
            temperature = max(22.0, min(47.0, temperature))

        # --- Current ---------------------------------------------------
        current = 2.8 + math.sin(self.tick * 0.18) * 1.8 + random.uniform(-0.3, 0.3)
        current = max(0.1, round(current, 2))

        # --- Flame sensor (digital) -----------------------------------
        flame = 1 if self.fault_mode == "fire" else 0

        # --- State of Charge (simplified voltage-based) ---------------
        soc = ((voltage - 9.0) / (12.6 - 9.0)) * 100.0
        soc = max(0.0, min(100.0, soc))

        return {
            "voltage": round(voltage, 2),
            "current": current,
            "temperature": round(temperature, 1),
            "flame": flame,
            "soc": round(soc, 1),
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
