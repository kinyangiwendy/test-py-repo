import { useEffect, useRef, useState, useCallback } from "react";
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// ---------------------------------------------------------------------------
// Configuration — update WS_URL to your machine's LAN IP when running on
// a physical device (e.g. "ws://192.168.1.42:8000/ws")
// ---------------------------------------------------------------------------
const WS_URL = "ws://127.0.0.1:8000/ws";

const THRESHOLDS = {
  over_voltage: 12.6,
  under_voltage: 9.0,
  over_current: 10.0,
  over_temperature: 50.0,
};

const COLORS = {
  bg: "#0d1117",
  card: "#161b22",
  border: "#30363d",
  green: "#3fb950",
  yellow: "#d29922",
  red: "#f85149",
  blue: "#58a6ff",
  text: "#c9d1d9",
  muted: "#8b949e",
  white: "#ffffff",
};

// ---------------------------------------------------------------------------
// Animated SOC bar
// ---------------------------------------------------------------------------
function SocBar({ soc }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: soc / 100,
      duration: 600,
      useNativeDriver: false,
    }).start();
  }, [soc]);

  const barColor = anim.interpolate({
    inputRange: [0, 0.2, 0.5, 1],
    outputRange: [COLORS.red, COLORS.yellow, COLORS.yellow, COLORS.green],
  });

  return (
    <View style={styles.socWrapper}>
      <View style={styles.socTrack}>
        <Animated.View
          style={[
            styles.socFill,
            {
              width: anim.interpolate({
                inputRange: [0, 1],
                outputRange: ["0%", "100%"],
              }),
              backgroundColor: barColor,
            },
          ]}
        />
      </View>
      <Text style={styles.socLabel}>{soc?.toFixed(1) ?? "--"}%</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Single metric card
// ---------------------------------------------------------------------------
function MetricCard({ label, value, unit, color, sub }) {
  return (
    <View style={[styles.card, { borderLeftColor: color, borderLeftWidth: 3 }]}>
      <Text style={styles.cardLabel}>{label}</Text>
      <View style={styles.cardRow}>
        <Text style={[styles.cardValue, { color }]}>
          {value ?? "--"}
        </Text>
        <Text style={styles.cardUnit}>{unit}</Text>
      </View>
      {sub ? <Text style={styles.cardSub}>{sub}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Fault badge
// ---------------------------------------------------------------------------
function FaultBadge({ fault }) {
  const labels = {
    OVER_VOLTAGE: "Over-Voltage",
    UNDER_VOLTAGE: "Under-Voltage",
    OVER_CURRENT: "Over-Current",
    OVER_TEMP: "Over-Temperature",
    FIRE_DETECTED: "FIRE DETECTED",
  };
  const isFire = fault.type === "FIRE_DETECTED";
  return (
    <View style={[styles.faultBadge, isFire && styles.fireBadge]}>
      <Text style={styles.faultText}>
        {isFire ? "🔥 " : "⚠️  "}
        {labels[fault.type] ?? fault.type}
        {fault.type !== "FIRE_DETECTED"
          ? `  ${fault.value?.toFixed(2)} / limit ${fault.threshold}`
          : ""}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
export default function DashboardScreen() {
  const ws = useRef(null);
  const reconnectTimer = useRef(null);
  const [data, setData] = useState(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const flashAnim = useRef(new Animated.Value(1)).current;

  // Flash the header on fault
  const triggerFlash = useCallback(() => {
    Animated.sequence([
      Animated.timing(flashAnim, { toValue: 0.2, duration: 150, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 0.2, duration: 150, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start();
  }, [flashAnim]);

  const connect = useCallback(() => {
    if (ws.current) {
      ws.current.close();
    }
    const socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      setConnected(true);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };

    socket.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        setData(payload);
        setLastUpdated(new Date().toLocaleTimeString());
        if (payload.faults && payload.faults.length > 0) {
          triggerFlash();
        }
      } catch (_) {}
    };

    socket.onerror = () => setConnected(false);

    socket.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 4000);
    };

    ws.current = socket;
  }, [triggerFlash]);

  useEffect(() => {
    connect();
    return () => {
      if (ws.current) ws.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  // Derived values
  const voltage = data?.voltage;
  const current = data?.current;
  const temp = data?.temperature;
  const soc = data?.soc ?? 0;
  const flame = data?.flame;
  const faults = data?.faults ?? [];
  const relayOpen = data?.relay_open ?? false;

  const voltageColor =
    voltage != null
      ? voltage > THRESHOLDS.over_voltage || voltage < THRESHOLDS.under_voltage
        ? COLORS.red
        : COLORS.green
      : COLORS.muted;

  const currentColor =
    current != null
      ? current > THRESHOLDS.over_current
        ? COLORS.red
        : current > 7
        ? COLORS.yellow
        : COLORS.green
      : COLORS.muted;

  const tempColor =
    temp != null
      ? temp > THRESHOLDS.over_temperature
        ? COLORS.red
        : temp > 40
        ? COLORS.yellow
        : COLORS.green
      : COLORS.muted;

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <Animated.View style={[styles.header, { opacity: flashAnim }]}>
        <View>
          <Text style={styles.headerTitle}>BMS Monitor</Text>
          <Text style={styles.headerSub}>3S Li-ion Battery Pack</Text>
        </View>
        <View style={styles.headerRight}>
          <View
            style={[
              styles.dot,
              { backgroundColor: connected ? COLORS.green : COLORS.red },
            ]}
          />
          <Text style={[styles.connLabel, { color: connected ? COLORS.green : COLORS.red }]}>
            {connected ? "Live" : "Offline"}
          </Text>
        </View>
      </Animated.View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* SOC section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>State of Charge</Text>
          <SocBar soc={soc} />
        </View>

        {/* Relay / Fire status banner */}
        {(relayOpen || flame === 1) && (
          <View style={[styles.banner, flame === 1 ? styles.fireBanner : styles.faultBanner]}>
            <Text style={styles.bannerText}>
              {flame === 1 ? "🔥  FIRE DETECTED — RELAY OPEN" : "⚡  FAULT — RELAY OPEN"}
            </Text>
          </View>
        )}

        {/* Metrics grid */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Live Readings</Text>
          <View style={styles.grid}>
            <MetricCard
              label="Voltage"
              value={voltage?.toFixed(2)}
              unit="V"
              color={voltageColor}
              sub={`Range: 9.0 – 12.6 V`}
            />
            <MetricCard
              label="Current"
              value={current?.toFixed(2)}
              unit="A"
              color={currentColor}
              sub={`Limit: 10 A`}
            />
            <MetricCard
              label="Temperature"
              value={temp?.toFixed(1)}
              unit="°C"
              color={tempColor}
              sub={`Limit: 50 °C`}
            />
            <MetricCard
              label="Flame Sensor"
              value={flame != null ? (flame === 1 ? "FIRE!" : "Clear") : "--"}
              unit=""
              color={flame === 1 ? COLORS.red : COLORS.green}
            />
          </View>
        </View>

        {/* Active faults */}
        {faults.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: COLORS.red }]}>
              Active Faults ({faults.length})
            </Text>
            {faults.map((f, i) => (
              <FaultBadge key={i} fault={f} />
            ))}
          </View>
        )}

        {/* All clear */}
        {data && faults.length === 0 && (
          <View style={styles.section}>
            <View style={styles.allClear}>
              <Text style={styles.allClearText}>✓  All parameters normal</Text>
            </View>
          </View>
        )}

        {/* Last updated */}
        {lastUpdated && (
          <Text style={styles.timestamp}>Last updated: {lastUpdated}</Text>
        )}

        {/* Reconnect button when offline */}
        {!connected && (
          <TouchableOpacity style={styles.reconnectBtn} onPress={connect}>
            <Text style={styles.reconnectText}>Reconnect</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: { color: COLORS.white, fontSize: 20, fontWeight: "700" },
  headerSub: { color: COLORS.muted, fontSize: 12, marginTop: 2 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  connLabel: { fontSize: 13, fontWeight: "600" },

  scroll: { padding: 16, paddingBottom: 32 },

  section: { marginBottom: 20 },
  sectionTitle: { color: COLORS.muted, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginBottom: 10, textTransform: "uppercase" },

  // SOC bar
  socWrapper: { flexDirection: "row", alignItems: "center", gap: 12 },
  socTrack: { flex: 1, height: 14, backgroundColor: COLORS.border, borderRadius: 7, overflow: "hidden" },
  socFill: { height: "100%", borderRadius: 7 },
  socLabel: { color: COLORS.white, fontSize: 16, fontWeight: "700", width: 56, textAlign: "right" },

  // Grid
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 10,
    padding: 14,
    width: "47.5%",
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  cardLabel: { color: COLORS.muted, fontSize: 11, fontWeight: "600", marginBottom: 6, textTransform: "uppercase" },
  cardRow: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  cardValue: { fontSize: 26, fontWeight: "700" },
  cardUnit: { color: COLORS.muted, fontSize: 14 },
  cardSub: { color: COLORS.muted, fontSize: 11, marginTop: 4 },

  // Banners
  banner: { borderRadius: 10, padding: 14, marginBottom: 16, alignItems: "center" },
  faultBanner: { backgroundColor: "#2d1500", borderColor: COLORS.yellow, borderWidth: 1 },
  fireBanner: { backgroundColor: "#2d0000", borderColor: COLORS.red, borderWidth: 2 },
  bannerText: { color: COLORS.white, fontWeight: "700", fontSize: 15 },

  // Faults
  faultBadge: {
    backgroundColor: "#1f1117",
    borderColor: COLORS.red,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  fireBadge: { borderWidth: 2 },
  faultText: { color: COLORS.red, fontSize: 13, fontWeight: "600" },

  // All clear
  allClear: { backgroundColor: "#0d2016", borderColor: COLORS.green, borderWidth: 1, borderRadius: 10, padding: 14, alignItems: "center" },
  allClearText: { color: COLORS.green, fontWeight: "700", fontSize: 14 },

  timestamp: { color: COLORS.muted, fontSize: 11, textAlign: "center", marginTop: 8 },

  reconnectBtn: { backgroundColor: COLORS.blue, borderRadius: 8, padding: 12, marginTop: 16, alignItems: "center" },
  reconnectText: { color: COLORS.white, fontWeight: "700", fontSize: 15 },
});
