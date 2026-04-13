import { useCallback, useEffect, useRef, useState } from "react";
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
// Configuration — update WS_URL / API_URL to your machine's LAN IP when
// running on a physical device (e.g. "ws://192.168.1.42:8000/ws")
// ---------------------------------------------------------------------------
const WS_URL = "ws://127.0.0.1:8000/ws";
const API_URL = "http://127.0.0.1:8000";

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
  purple: "#bc8cff",
  text: "#c9d1d9",
  muted: "#8b949e",
  white: "#ffffff",
};

// ---------------------------------------------------------------------------
// Browser push notification helper (web only)
// ---------------------------------------------------------------------------
function sendPushNotification(title, body) {
  if (typeof window !== "undefined" && "Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        if (perm === "granted") new Notification(title, { body });
      });
    }
  }
}

// Request permission early so the first fault fires straight away
if (typeof window !== "undefined" && "Notification" in window) {
  if (Notification.permission === "default") {
    Notification.requestPermission();
  }
}

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
        <Text style={[styles.cardValue, { color }]}>{value ?? "--"}</Text>
        <Text style={styles.cardUnit}>{unit}</Text>
      </View>
      {sub ? <Text style={styles.cardSub}>{sub}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Fault badge — active faults (live)
// ---------------------------------------------------------------------------
function FaultBadge({ fault }) {
  const CONFIG = {
    OVER_VOLTAGE:   { label: "Over-Voltage",       icon: "⚠️",  color: COLORS.red    },
    UNDER_VOLTAGE:  { label: "Under-Voltage",       icon: "⚠️",  color: COLORS.red    },
    OVER_CURRENT:   { label: "Over-Current",        icon: "⚠️",  color: COLORS.red    },
    OVER_TEMP:      { label: "Over-Temperature",    icon: "⚠️",  color: COLORS.red    },
    FIRE_DETECTED:  { label: "FIRE DETECTED",       icon: "🔥",  color: COLORS.red    },
    LOW_BATTERY:    { label: "Low Battery Warning", icon: "🪫",  color: COLORS.yellow },
    CHARGE_COMPLETE:{ label: "Battery Full",        icon: "✅",  color: COLORS.green  },
  };

  const cfg = CONFIG[fault.type] ?? { label: fault.type, icon: "⚠️", color: COLORS.red };
  const showValue = !["FIRE_DETECTED", "CHARGE_COMPLETE"].includes(fault.type);

  return (
    <View style={[styles.faultBadge, { borderColor: cfg.color }]}>
      <Text style={[styles.faultText, { color: cfg.color }]}>
        {cfg.icon}  {cfg.label}
        {showValue ? `  ${fault.value?.toFixed(2)} / limit ${fault.threshold}` : ""}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Fault history row (from /api/faults)
// ---------------------------------------------------------------------------
function HistoryRow({ item }) {
  const TYPE_COLOR = {
    OVER_VOLTAGE: COLORS.red,
    UNDER_VOLTAGE: COLORS.red,
    OVER_CURRENT: COLORS.red,
    OVER_TEMP: COLORS.red,
    FIRE_DETECTED: COLORS.red,
    LOW_BATTERY: COLORS.yellow,
    CHARGE_COMPLETE: COLORS.green,
  };
  const color = TYPE_COLOR[item.fault_type] ?? COLORS.muted;
  const ts = item.timestamp
    ? new Date(item.timestamp + "Z").toLocaleTimeString()
    : "--";

  return (
    <View style={styles.historyRow}>
      <View style={[styles.historyDot, { backgroundColor: color }]} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.historyType, { color }]}>{item.fault_type}</Text>
        <Text style={styles.historyDetail}>
          {item.value?.toFixed(2)} / limit {item.threshold}
        </Text>
      </View>
      <Text style={styles.historyTime}>{ts}</Text>
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
  const [faultHistory, setFaultHistory] = useState([]);
  const flashAnim = useRef(new Animated.Value(1)).current;
  const prevFaultTypes = useRef(new Set());

  // Flash the header on fault
  const triggerFlash = useCallback(() => {
    Animated.sequence([
      Animated.timing(flashAnim, { toValue: 0.2, duration: 150, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 1,   duration: 150, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 0.2, duration: 150, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 1,   duration: 150, useNativeDriver: true }),
    ]).start();
  }, [flashAnim]);

  // Fetch fault history from REST API
  const fetchHistory = useCallback(() => {
    fetch(`${API_URL}/api/faults?limit=10`)
      .then((r) => r.json())
      .then((rows) => setFaultHistory(rows))
      .catch(() => {});
  }, []);

  const connect = useCallback(() => {
    if (ws.current) ws.current.close();
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

          // Push notification for new fault types that weren't in the last frame
          payload.faults.forEach((f) => {
            if (!prevFaultTypes.current.has(f.type)) {
              const LABELS = {
                OVER_VOLTAGE:    "Over-Voltage detected",
                UNDER_VOLTAGE:   "Under-Voltage detected",
                OVER_CURRENT:    "Over-Current detected",
                OVER_TEMP:       "Over-Temperature detected",
                FIRE_DETECTED:   "FIRE DETECTED — immediate shutdown",
                LOW_BATTERY:     "Low battery warning",
                CHARGE_COMPLETE: "Battery fully charged — charging stopped",
              };
              sendPushNotification(
                "BMS Alert",
                LABELS[f.type] ?? f.type
              );
            }
          });
          prevFaultTypes.current = new Set(payload.faults.map((f) => f.type));
        } else {
          prevFaultTypes.current = new Set();
        }
      } catch (_) {}
    };

    socket.onerror  = () => setConnected(false);
    socket.onclose  = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 4000);
    };

    ws.current = socket;
  }, [triggerFlash]);

  useEffect(() => {
    connect();
    // Poll fault history every 15 seconds
    fetchHistory();
    const historyInterval = setInterval(fetchHistory, 15000);
    return () => {
      if (ws.current) ws.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      clearInterval(historyInterval);
    };
  }, [connect, fetchHistory]);

  // Derived values
  const voltage   = data?.voltage;
  const current   = data?.current;
  const temp      = data?.temperature;
  const soc       = data?.soc ?? 0;
  const flame     = data?.flame;
  const faults    = data?.faults ?? [];
  const relayOpen = data?.relay_open ?? false;
  const charging  = data?.charging === 1;

  const voltageColor =
    voltage != null
      ? voltage > THRESHOLDS.over_voltage || voltage < THRESHOLDS.under_voltage
        ? COLORS.red
        : voltage <= 10.0
        ? COLORS.yellow
        : COLORS.green
      : COLORS.muted;

  const currentColor =
    current != null
      ? current < 0
        ? COLORS.purple                        // charging (negative current)
        : current > THRESHOLDS.over_current
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
          <View style={[styles.dot, { backgroundColor: connected ? COLORS.green : COLORS.red }]} />
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

        {/* Relay / Fire / Charge status banner */}
        {(relayOpen || flame === 1 || charging) && (
          <View style={[
            styles.banner,
            flame === 1 ? styles.fireBanner
              : charging ? styles.chargeBanner
              : styles.faultBanner,
          ]}>
            <Text style={styles.bannerText}>
              {flame === 1
                ? "🔥  FIRE DETECTED — RELAY OPEN"
                : charging
                ? "⚡  CHARGING IN PROGRESS"
                : "⚡  FAULT — RELAY OPEN"}
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
              sub="Range: 9.0 – 12.6 V"
            />
            <MetricCard
              label={charging ? "Charge Current" : "Current"}
              value={current != null ? Math.abs(current).toFixed(2) : null}
              unit="A"
              color={currentColor}
              sub={charging ? "Charging mode" : "Limit: 10 A"}
            />
            <MetricCard
              label="Temperature"
              value={temp?.toFixed(1)}
              unit="°C"
              color={tempColor}
              sub="Limit: 50 °C"
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

        {/* Fault history log */}
        {faultHistory.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Fault History (last 10)</Text>
            <View style={styles.historyCard}>
              {faultHistory.map((item) => (
                <HistoryRow key={item.id} item={item} />
              ))}
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
  headerSub:   { color: COLORS.muted, fontSize: 12, marginTop: 2 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot:         { width: 8, height: 8, borderRadius: 4 },
  connLabel:   { fontSize: 13, fontWeight: "600" },

  scroll: { padding: 16, paddingBottom: 32 },

  section:      { marginBottom: 20 },
  sectionTitle: {
    color: COLORS.muted, fontSize: 11, fontWeight: "700",
    letterSpacing: 1, marginBottom: 10, textTransform: "uppercase",
  },

  // SOC bar
  socWrapper: { flexDirection: "row", alignItems: "center", gap: 12 },
  socTrack:   { flex: 1, height: 14, backgroundColor: COLORS.border, borderRadius: 7, overflow: "hidden" },
  socFill:    { height: "100%", borderRadius: 7 },
  socLabel:   { color: COLORS.white, fontSize: 16, fontWeight: "700", width: 56, textAlign: "right" },

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
  cardRow:   { flexDirection: "row", alignItems: "baseline", gap: 4 },
  cardValue: { fontSize: 26, fontWeight: "700" },
  cardUnit:  { color: COLORS.muted, fontSize: 14 },
  cardSub:   { color: COLORS.muted, fontSize: 11, marginTop: 4 },

  // Banners
  banner:       { borderRadius: 10, padding: 14, marginBottom: 16, alignItems: "center" },
  faultBanner:  { backgroundColor: "#2d1500", borderColor: COLORS.yellow, borderWidth: 1 },
  fireBanner:   { backgroundColor: "#2d0000", borderColor: COLORS.red,    borderWidth: 2 },
  chargeBanner: { backgroundColor: "#0d1a2d", borderColor: COLORS.blue,   borderWidth: 1 },
  bannerText:   { color: COLORS.white, fontWeight: "700", fontSize: 15 },

  // Faults
  faultBadge: {
    backgroundColor: "#1f1117",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  faultText: { fontSize: 13, fontWeight: "600" },

  // All clear
  allClear: {
    backgroundColor: "#0d2016", borderColor: COLORS.green,
    borderWidth: 1, borderRadius: 10, padding: 14, alignItems: "center",
  },
  allClearText: { color: COLORS.green, fontWeight: "700", fontSize: 14 },

  // Fault history
  historyCard: {
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderColor: COLORS.border,
    borderWidth: 1,
    overflow: "hidden",
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 10,
  },
  historyDot:    { width: 8, height: 8, borderRadius: 4 },
  historyType:   { fontSize: 12, fontWeight: "700" },
  historyDetail: { color: COLORS.muted, fontSize: 11, marginTop: 1 },
  historyTime:   { color: COLORS.muted, fontSize: 11 },

  timestamp: { color: COLORS.muted, fontSize: 11, textAlign: "center", marginTop: 8 },

  reconnectBtn:  { backgroundColor: COLORS.blue, borderRadius: 8, padding: 12, marginTop: 16, alignItems: "center" },
  reconnectText: { color: COLORS.white, fontWeight: "700", fontSize: 15 },
});
