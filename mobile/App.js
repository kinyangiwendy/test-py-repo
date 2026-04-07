import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import DashboardScreen from "./screens/DashboardScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <DashboardScreen />
    </SafeAreaProvider>
  );
}
