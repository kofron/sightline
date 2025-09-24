import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import MorningCheckInFlow from "./checkin/MorningCheckInFlow";
import type { MorningCheckInState } from "./checkin/MorningCheckInFlow";
import TimelineWorkspace from "./components/TimelineWorkspace";

function App() {
  const [entryCount, setEntryCount] = useState<number | null>(null);
  const checkInFlow = useMemo(() => new MorningCheckInFlow(), []);
  const [checkInState, setCheckInState] = useState<MorningCheckInState>(
    checkInFlow.getState(),
  );

  async function loadEntryCount() {
    const count = await invoke<number>("entry_count");
    setEntryCount(count);
  }

  function startDebugCheckIn() {
    try {
      checkInFlow.start();
    } catch (error) {
      console.warn("Check-in already started", error);
    }
    setCheckInState(checkInFlow.getState());
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Sightline Timeline</h1>
          <p className="subtitle">
            Keep your daily reflections and plans in one evolving document.
          </p>
        </div>
        <div className="insights">
          <button onClick={loadEntryCount} type="button">
            Refresh entry summary
          </button>
          <p>
            {entryCount === null
              ? "Entry count unavailable."
              : `Tracking ${entryCount} entries.`}
          </p>
        </div>
      </header>

      <TimelineWorkspace />

      <section className="debug-panel">
        <h2>Debug Controls</h2>
        <button type="button" onClick={startDebugCheckIn}>
          Debug: Start Morning Check-in
        </button>
        <p>Check-in state: {checkInState}</p>
      </section>
    </main>
  );
}

export default App;
