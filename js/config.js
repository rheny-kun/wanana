"use strict";

window.WANANA_CONFIG = Object.freeze({
  GAS_READ_API_URL: "https://script.google.com/macros/s/AKfycbz1zosytwL26M5kegZUUu0n_-4UsQ4_RyjcWaiR2PVxD3hn3FUMlcJlR4VISzXPiEX3hw/exec",
  UPDATE_INTERVAL_MS: 60 * 1000,
  NO_COMMUNICATION_WARNING_MS: (2 * 60 + 30) * 60 * 1000,
  RECEIVER_NO_COMMUNICATION_WARNING_MS: 15 * 60 * 60 * 1000,
  MAX_LOGS: 1000,
  // ?demo=1 also enables demo mode.
  USE_DEMO_DATA: false
});
