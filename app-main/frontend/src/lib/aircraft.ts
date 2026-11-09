/** Readable aircraft name from the ICAO type code (A21N → A321N). Unknown codes are shown as they are.
 * The ATC strips keep the ICAO code, like real strips. */
const NAMES: Record<string, string> = {
  // Airbus
  A19N: "A319N", A20N: "A320N", A21N: "A321N",
  A332: "A330-200", A333: "A330-300", A338: "A330-800N", A339: "A330-900N",
  A359: "A350-900", A35K: "A350-1000", A388: "A380-800", A3ST: "A300 Beluga",
  A306: "A300-600", A310: "A310", BCS1: "A220-100", BCS3: "A220-300",
  // Boeing
  B736: "B737-600", B737: "B737-700", B738: "B737-800", B739: "B737-900",
  B37M: "B737 MAX 7", B38M: "B737 MAX 8", B39M: "B737 MAX 9", B3XM: "B737 MAX 10",
  B744: "B747-400", B748: "B747-8", B752: "B757-200", B753: "B757-300",
  B762: "B767-200", B763: "B767-300", B764: "B767-400",
  B772: "B777-200", B77L: "B777-200LR", B773: "B777-300", B77W: "B777-300ER", B778: "B777-8", B779: "B777-9",
  B788: "B787-8", B789: "B787-9", B78X: "B787-10",
  // Regional and others
  E170: "E170", E175: "E175", E190: "E190", E195: "E195", E290: "E190-E2", E295: "E195-E2",
  CRJ7: "CRJ-700", CRJ9: "CRJ-900", CRJX: "CRJ-1000", AT72: "ATR 72", AT76: "ATR 72-600", AT45: "ATR 42-500",
  DH8D: "Dash 8-400", MD11: "MD-11", C172: "Cessna 172", TBM9: "TBM 930", PC12: "PC-12",
};

export const aircraftName = (icao?: string | null) => (icao ? NAMES[icao.toUpperCase()] ?? icao : "");
