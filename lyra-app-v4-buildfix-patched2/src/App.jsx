import React from "react";
import LyraIntelligenceChat from "./components/LyraIntelligenceChat";

export default function App() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
      <LyraIntelligenceChat dataBaseUrl="/lyra-data" />
    </div>
  );
}
