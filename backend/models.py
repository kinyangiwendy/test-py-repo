from sqlalchemy import Column, Integer, Float, Boolean, String, DateTime
from sqlalchemy.sql import func
from database import Base


class SensorReading(Base):
    __tablename__ = "sensor_readings"

    id = Column(Integer, primary_key=True, index=True)
    voltage = Column(Float, nullable=False)
    current = Column(Float, nullable=False)
    temperature = Column(Float, nullable=False)
    flame_detected = Column(Boolean, default=False)
    soc = Column(Float, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())


class FaultEvent(Base):
    __tablename__ = "fault_events"

    id = Column(Integer, primary_key=True, index=True)
    fault_type = Column(String, nullable=False)  # OVER_VOLTAGE, UNDER_VOLTAGE, OVER_CURRENT, OVER_TEMP, FIRE
    value = Column(Float, nullable=False)
    threshold = Column(Float, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
