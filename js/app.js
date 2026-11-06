"use strict";

(() => {
  const config = window.WANANA_CONFIG;
  const parameters = new URLSearchParams(window.location.search);
  const demo = config.USE_DEMO_DATA || parameters.get("demo") === "1";
  const requestedNode = parameters.get("node");
  const byId = (id) => document.getElementById(id);
  const sensorTones = { OPEN: "danger", CLOSED: "ok", ONLINE: "cyan", OFFLINE: "danger", UNKNOWN: "neutral" };
  const batteryTones = { NORMAL: "ok", LOW: "warning", CRITICAL: "danger", INVALID: "neutral" };
  const temperatureTones = { NORMAL: "ok", WARM: "warning", HOT: "hot", CRITICAL: "danger", INVALID: "neutral" };
  const eventTones = { BOOT: "hot", MAGNET: "cyan", TRAP_OPEN: "danger", TRAP_CLOSED: "ok", HEALTH_TIMER: "blue", RECEIVER_BOOT: "purple", RECEIVER_HEALTH: "cyan", UNKNOWN: "neutral" };
  const logFields = ["timestamp", "node", "sessionId", "event", "sensor", "battery", "batteryStatus", "temperature", "temperatureStatus", "messageId", "boot", "send", "wifiRssi", "loraRssi"];
  const chartDefinitions = [
    { key: "battery", label: "Battery Voltage", unit: "V", empty: "Batteryデータなし" },
    { key: "temperature", label: "Temperature", unit: "℃", empty: "Temperatureデータなし" },
    { key: "lora", field: "loraRssi", label: "LoRa RSSI", unit: "dBm", empty: "LoRa RSSIデータなし" }
  ];
  const charts = new Map();
  let logs = [];
  let busy = false;
  let lastSuccess = null;
  let invalidRows = 0;
  let selectedNode = null; // null = ALL
  let focusNode = null;
  let firstSelection = true;
  let latestByNode = new Map();
  let lastAlertSignature = null;
  let overviewStates = [];
  let nodeChips = [];

  function number(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function sessionId(value) {
    const id = typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : null;
    return id?.trim() ? id : null;
  }

  function known(value, tones, fallback) {
    return typeof value === "string" && Object.hasOwn(tones, value) ? value : fallback;
  }

  // タイムゾーンなし日時はJSTとして扱い、端末のタイムゾーンに依存させない。
  function parseTimestamp(value) {
    if (typeof value !== "string") return null;
    // ISO日時は明示されたタイムゾーンで読む。
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      if (parseTimestamp(value.slice(0, 19).replace("T", " ")) === null) return null;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
    return local.getTime() - 9 * 60 * 60 * 1000;
  }

  function formatJst(timestamp) {
    if (timestamp === null) return "日時不明";
    const date = new Date(timestamp + 9 * 60 * 60 * 1000);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }

  function normalize(data) {
    if (!Array.isArray(data)) throw new Error("APIの応答はJSON配列である必要があります。");
    const rows = data.filter((row) => row !== null && typeof row === "object" && !Array.isArray(row)
      && logFields.every((field) => Object.hasOwn(row, field))
      && typeof row.node === "string" && row.node.trim() && row.node.length <= 200);
    if (data.length && !rows.length) throw new Error("応答に有効な14フィールドのログがありません。");
    const normalized = rows.map((row) => ({
      timestamp: parseTimestamp(row.timestamp),
      sessionId: sessionId(row.sessionId),
      node: row.node,
      sensor: row.sensor === "OPEN" || row.sensor === "CLOSED" ? row.sensor : "UNKNOWN",
      event: known(row.event, eventTones, "UNKNOWN"),
      battery: number(row.battery),
      batteryStatus: known(row.batteryStatus, batteryTones, "INVALID"),
      temperature: number(row.temperature),
      temperatureStatus: known(row.temperatureStatus, temperatureTones, "INVALID"),
      loraRssi: number(row.loraRssi),
      wifiRssi: number(row.wifiRssi),
      messageId: number(row.messageId),
      boot: number(row.boot),
      send: number(row.send)
    }));
    // 日時不明の行は履歴末尾へ。正しい日時の最新ログを現在状態に採用する。
    normalized.sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity));
    return { rows: normalized.slice(0, config.MAX_LOGS), invalidRows: data.length - rows.length };
  }

  function badge(text, tone) {
    const element = document.createElement("span");
    element.className = `badge tone-${tone}`;
    element.textContent = text;
    return element;
  }

  function setBadge(id, text, tones) {
    const element = byId(id);
    element.textContent = text;
    element.className = `badge tone-${tones[text] ?? "neutral"}`;
  }

  function formatNumber(value, digits) {
    return value === null || value === undefined ? "-" : value.toFixed(digits);
  }

  function visibleLogs() {
    return selectedNode === null ? logs : logs.filter((log) => log.node === selectedNode);
  }

  function isReceiver(log) {
    return log?.node.startsWith("receiver-") ?? false;
  }

  function warningThreshold(log) {
    return isReceiver(log) ? config.RECEIVER_NO_COMMUNICATION_WARNING_MS : config.NO_COMMUNICATION_WARNING_MS;
  }

  function nodeState(log) {
    if (!log || log.timestamp === null || log.sessionId === null) return "UNKNOWN";
    if (!isReceiver(log)) return log?.sensor ?? "UNKNOWN";
    return Date.now() - log.timestamp >= warningThreshold(log) ? "OFFLINE" : "ONLINE";
  }

  function metricValue(log, field, digits) {
    return isReceiver(log) && log[field] === null ? "—" : formatNumber(log?.[field], digits);
  }

  function updateUrl() {
    const url = new URL(window.location.href);
    if (selectedNode === null) url.searchParams.delete("node");
    else url.searchParams.set("node", selectedNode);
    try {
      window.history.replaceState(null, "", url.href);
    } catch (error) {
      // 状態表示は継続する。通常のHTTP(S)配信では同一ページのqueryだけを変更する。
      console.warn("[わなな] Node選択URLを更新できません", error);
    }
  }

  function updateNodes() {
    latestByNode = new Map();
    // logs is already sorted newest first.
    for (const log of logs) {
      if (!latestByNode.has(log.node)) latestByNode.set(log.node, log);
    }
    if (firstSelection) {
      selectedNode = requestedNode || null;
      firstSelection = false;
    }
    if (!latestByNode.has(selectedNode)) selectedNode = null;
    renderNodeChips();
    renderOverview();
    updateUrl();
  }

  function renderNodeChips() {
    const focusedNode = nodeChips.find((chip) => chip.button === document.activeElement)?.node;
    const container = byId("node-chips");
    container.replaceChildren();
    nodeChips = [];
    for (const node of [null, ...[...latestByNode.keys()].sort((a, b) => a.localeCompare(b, "ja", { numeric: true }))]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "node-chip";
      button.dataset.node = node ?? "";
      button.setAttribute("aria-pressed", String(node === selectedNode));
      const name = document.createElement("span");
      name.className = "chip-name";
      name.textContent = node ?? "ALL";
      button.append(name);
      const log = latestByNode.get(node);
      const stateBadge = log ? badge(nodeState(log), sensorTones[nodeState(log)]) : null;
      if (stateBadge) button.append(stateBadge);
      button.addEventListener("click", () => selectNode(node));
      nodeChips.push({ node, button, stateBadge, log });
      container.append(button);
    }
    if (focusedNode !== undefined) (nodeChips.find((chip) => chip.node === focusedNode) ?? nodeChips[0])?.button.focus({ preventScroll: true });
  }

  function selectNode(node) {
    selectedNode = latestByNode.has(node) ? node : null;
    for (const chip of nodeChips) chip.button.setAttribute("aria-pressed", String(chip.node === selectedNode));
    updateUrl();
    renderView();
  }

  function setReceivedTime(element, log) {
    element.textContent = log ? formatJst(log.timestamp) : "-";
    if (log?.timestamp != null) element.dateTime = new Date(log.timestamp).toISOString();
    else element.removeAttribute("datetime");
  }

  function receivedAge(log) {
    if (!log) return "受信データなし";
    if (log.timestamp === null) return "受信日時不明";
    const age = Date.now() - log.timestamp;
    if (age < 0) return "受信日時が未来です";
    const minutes = Math.floor(age / 60000);
    return minutes < 1 ? "1分以内に受信" : `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}時間` : ""}${minutes % 60}分前に受信`;
  }

  function renderOverview() {
    const list = byId("node-list");
    list.replaceChildren();
    overviewStates = [];
    byId("overview-empty").hidden = latestByNode.size > 0;
    for (const [node, log] of [...latestByNode].sort(([a], [b]) => a.localeCompare(b, "ja", { numeric: true }))) {
      const button = document.createElement("button");
      button.type = "button";
      const state = nodeState(log);
      button.className = `node-summary tone-${sensorTones[state]}`;
      button.dataset.node = node;
      button.setAttribute("aria-label", `${node} ${state}、最終受信 ${formatJst(log.timestamp)} JST。詳細を表示`);
      const name = document.createElement("span");
      name.className = "summary-node";
      name.textContent = node;
      const battery = document.createElement("span");
      battery.className = "summary-battery";
      const batteryState = log.battery === null ? "INVALID" : log.batteryStatus;
      battery.append(isReceiver(log) && log.battery === null ? badge("—", "neutral") : badge(`${formatNumber(log.battery, 3)} V · ${batteryState}`, batteryTones[batteryState]));
      const lora = document.createElement("span");
      lora.className = "summary-lora";
      lora.textContent = log.loraRssi === null ? (isReceiver(log) ? "—" : "-") : `${formatNumber(log.loraRssi, 0)} dBm`;
      const time = document.createElement("time");
      time.className = "summary-time";
      setReceivedTime(time, log);
      const stateBadge = badge(state, sensorTones[state]);
      button.append(name, stateBadge, battery, lora, time);
      overviewStates.push({ button, stateBadge, log });
      button.addEventListener("click", () => selectNode(node));
      list.append(button);
    }
  }

  function updateFocusNode() {
    if (selectedNode !== null) {
      focusNode = selectedNode;
      return;
    }
    focusNode = null;
    let newest = -Infinity;
    for (const [node, log] of latestByNode) {
      const timestamp = log.timestamp ?? -Infinity;
      // 同時刻・全件日時不明の場合はNode名順で安定させる。配列の並びには依存しない。
      if (focusNode === null || timestamp > newest || (timestamp === newest && node.localeCompare(focusNode, "ja", { numeric: true }) < 0)) {
        focusNode = node;
        newest = timestamp;
      }
    }
  }

  function renderCurrent() {
    const latest = latestByNode.get(focusNode);
    const all = selectedNode === null;
    byId("current-heading").textContent = "最新の状態";
    byId("all-overview").hidden = !all;
    byId("single-overview").hidden = false;
    byId("detail-section").hidden = false;
    renderNodeStates();
    byId("node-value").textContent = latest?.node ?? "-";
    setReceivedTime(byId("last-received"), latest);
    byId("received-age").textContent = receivedAge(latest);
    byId("battery-value").textContent = metricValue(latest, "battery", 3);
    byId("temperature-value").textContent = metricValue(latest, "temperature", 1);
    byId("lora-value").textContent = metricValue(latest, "loraRssi", 0);
    byId("wifi-value").textContent = metricValue(latest, "wifiRssi", 0);
    setBadge("battery-status", latest?.battery != null ? latest.batteryStatus : isReceiver(latest) ? "—" : "INVALID", batteryTones);
    setBadge("temperature-status", latest?.temperature != null ? latest.temperatureStatus : isReceiver(latest) ? "—" : "INVALID", temperatureTones);
    setBadge("event-value", latest?.event ?? "UNKNOWN", eventTones);
    setBadge("latest-event-value", latest?.event ?? "UNKNOWN", eventTones);
    byId("session-value").textContent = latest?.sessionId ?? "—";
    for (const [id, field] of [["message-value", "messageId"], ["boot-value", "boot"], ["send-value", "send"]]) {
      byId(id).textContent = latest?.[field] == null ? "-" : String(latest[field]);
    }
    renderAlerts();
  }

  function renderNodeStates() {
    const state = nodeState(latestByNode.get(focusNode));
    byId("sensor-card").className = `sensor-card tone-${sensorTones[state]}`;
    if (byId("sensor-value").textContent !== state) byId("sensor-value").textContent = state;
    for (const { button, stateBadge, log } of overviewStates) {
      const current = nodeState(log);
      if (stateBadge.textContent === current) continue;
      stateBadge.textContent = current;
      stateBadge.className = `badge tone-${sensorTones[current]}`;
      button.className = `node-summary tone-${sensorTones[current]}`;
      button.setAttribute("aria-label", `${log.node} ${current}、最終受信 ${formatJst(log.timestamp)} JST。詳細を表示`);
    }
    for (const { stateBadge, log } of nodeChips) {
      if (!stateBadge) continue;
      const current = nodeState(log);
      if (stateBadge.textContent === current) continue;
      stateBadge.textContent = current;
      stateBadge.className = `badge tone-${sensorTones[current]}`;
    }
    const latest = latestByNode.get(focusNode);
    const age = latest?.timestamp == null ? null : Date.now() - latest.timestamp;
    byId("received-age").className = age === null || age < 0 ? "freshness-unknown" : age >= warningThreshold(latest) ? "freshness-stale" : age >= warningThreshold(latest) / 2 ? "freshness-warning" : "freshness-fresh";
  }

  function renderAlerts() {
    const alerts = byId("alerts");
    const messages = [];
    const targets = selectedNode === null ? [...latestByNode.values()] : [latestByNode.get(selectedNode)].filter(Boolean);
    function add(log, message, danger = false) {
      messages.push({ text: `${log.node} · ${message}`, danger });
    }
    for (const latest of targets) {
      if (nodeState(latest) === "OPEN") add(latest, "状態：OPEN。", true);
      if (latest.timestamp === null) {
        add(latest, "受信日時が不明です。無通信時間を判定できません。");
      } else {
        const age = Date.now() - latest.timestamp;
        if (age < 0) add(latest, "受信日時が未来です。記録時刻を確認してください。");
        if (age >= warningThreshold(latest)) add(latest, `無通信警告：最終受信から${Math.floor(age / 60000)}分経過しています。`, true);
      }
      if (latest.battery !== null && ["LOW", "CRITICAL"].includes(latest.batteryStatus)) add(latest, `電池警告：${latest.batteryStatus}。電池を確認してください。`, latest.batteryStatus === "CRITICAL");
      if (latest.temperature !== null && ["HOT", "CRITICAL"].includes(latest.temperatureStatus)) add(latest, `温度警告：${latest.temperatureStatus}。`, latest.temperatureStatus === "CRITICAL");
    }
    byId("received-age").textContent = receivedAge(latestByNode.get(focusNode));
    // 同じ警告を毎秒aria-liveへ再挿入しない。
    const signature = JSON.stringify(messages);
    if (signature === lastAlertSignature) return;
    lastAlertSignature = signature;
    alerts.replaceChildren();
    for (const message of messages) {
      const element = document.createElement("p");
      element.className = `alert${message.danger ? " danger" : ""}`;
      element.textContent = message.text;
      alerts.append(element);
    }
    alerts.hidden = !alerts.childElementCount;
  }

  function renderView() {
    updateFocusNode();
    renderCurrent();
    renderHistory();
    renderCharts();
  }

  function renderHistory() {
    const body = byId("history-body");
    body.replaceChildren();
    const filtered = visibleLogs();
    for (const log of filtered.slice(0, 50)) {
      const row = document.createElement("tr");
      if (log.event === "TRAP_OPEN") row.className = "important-row";
      const batteryStatus = log.battery === null ? "INVALID" : log.batteryStatus;
      const temperatureStatus = log.temperature === null ? "INVALID" : log.temperatureStatus;
      const cells = [
        formatJst(log.timestamp), log.node, log.sessionId ?? "—",
        badge(log.event, eventTones[log.event]), isReceiver(log) ? "—" : badge(log.sensor, sensorTones[log.sensor]),
        isReceiver(log) && log.battery === null ? "—" : badge(`${formatNumber(log.battery, 3)} V · ${batteryStatus}`, batteryTones[batteryStatus]),
        isReceiver(log) && log.temperature === null ? "—" : badge(`${formatNumber(log.temperature, 1)} ℃ · ${temperatureStatus}`, temperatureTones[temperatureStatus]),
        log.loraRssi === null ? (isReceiver(log) ? "—" : "-") : `${formatNumber(log.loraRssi, 0)} dBm`
      ];
      for (const value of cells) {
        const cell = document.createElement("td");
        if (value instanceof Element) cell.append(value);
        else cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    if (!filtered.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.className = "empty-row";
      cell.textContent = "受信ログはありません";
      row.append(cell);
      body.append(row);
    }
    byId("history-count").textContent = `直近${Math.min(filtered.length, 50)}件`;
  }

  // Node名だけから決定するため、取得順・Nodeの増減・ページ更新で色が変わらない。
  function nodeColor(node) {
    const palette = ["#8ac5dc", "#b7a0df", "#d9bb75", "#8fc4a0", "#dc9da6", "#91ace0", "#b7c88d", "#c99dc4"];
    let hash = 2166136261;
    for (const character of node) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
    return palette[hash % palette.length];
  }

  // 最新timestampのログに付いたIDを使う。IDの大小・boot・messageIdは比較しない。
  function latestSessionId(node) {
    return latestByNode.get(node)?.sessionId ?? null;
  }

  function renderCharts() {
    const all = selectedNode === null;
    const nodes = (all ? [...latestByNode.keys()] : [selectedNode])
      .filter((node) => !node.startsWith("receiver-"))
      .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
    const sessions = new Map(nodes.map((node) => [node, latestSessionId(node)]));
    const series = new Map(nodes.map((node) => [node, []]));
    let invalidDates = 0;
    // Group once in chronological order for all three charts.
    for (let index = logs.length - 1; index >= 0; index--) {
      const log = logs[index];
      if (!series.has(log.node) || log.sessionId === null || log.sessionId !== sessions.get(log.node)) continue;
      if (log.timestamp === null) invalidDates++;
      else series.get(log.node).push(log);
    }
    byId("chart-section").hidden = selectedNode !== null && isReceiver(latestByNode.get(selectedNode));
    byId("chart-grid").classList.toggle("comparison", all);
    const notes = [];
    if (invalidDates) notes.push(`日時不明の${invalidDates}件は履歴末尾に表示し、グラフから除外しています。`);
    if (invalidRows) notes.push(`不正なログ${invalidRows}件を除外しました。`);
    const missingSessions = visibleLogs().filter((log) => log.sessionId === null).length;
    if (missingSessions) notes.push(`Session不明の${missingSessions}件はグラフから除外しています。`);
    const available = typeof window.Chart === "function";
    if (!available) notes.push("グラフを読み込めません。接続を確認してください。");
    for (const definition of chartDefinitions) {
      const canvas = byId(`${definition.key}-chart`);
      const empty = byId(`${definition.key}-empty`);
      const datasets = nodes.map((node) => {
        const color = nodeColor(node);
        // Node間の時刻を揃えず、各点に実際のUnix時刻（ms）を持たせる。
        const data = series.get(node).map((log) => ({ x: log.timestamp, y: log[definition.field ?? definition.key] }));
        return {
          label: node, data, borderColor: color, backgroundColor: `${color}0c`,
          borderWidth: 1.8, fill: !all, pointRadius: data.length === 1 ? 3 : 1,
          pointHoverRadius: 5, pointHoverBorderWidth: 2, spanGaps: false, tension: 0
        };
      });
      const hasData = datasets.some((dataset) => dataset.data.some((point) => point.y !== null));
      canvas.hidden = !hasData || !available;
      empty.hidden = hasData && available;
      empty.textContent = hasData && !available ? "グラフを読み込めません" : definition.empty;
      if (!hasData || !available) {
        charts.get(definition.key)?.destroy();
        charts.delete(definition.key);
        continue;
      }
      const existing = charts.get(definition.key);
      if (existing) {
        existing.data.datasets = datasets;
        existing.options.plugins.legend.display = all;
        existing.update("none");
        continue;
      }
      charts.set(definition.key, new window.Chart(canvas, {
        type: "line",
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
          interaction: { mode: "nearest", intersect: false },
          plugins: {
            legend: { display: all, position: "top", align: "start", labels: { color: "#a9b1be", boxWidth: 8, boxHeight: 8, usePointStyle: true, padding: 8, font: { size: 10 } } },
            tooltip: {
              backgroundColor: "#1c222c", titleColor: "#f3f4f6", bodyColor: "#f3f4f6", borderColor: "#303744", borderWidth: 1,
              callbacks: {
                title: (items) => items.length ? `${formatJst(items[0].parsed.x)} JST` : "",
                label: (item) => `${item.dataset.label} · ${definition.label}: ${item.parsed.y} ${definition.unit}`
              }
            }
          },
          scales: {
            x: { type: "linear", grid: { display: false }, border: { display: false }, ticks: { color: "#a1a8b3", maxTicksLimit: 4, maxRotation: 0, font: { size: 10 }, callback: (value) => formatJst(Number(value)).slice(11, 16) } },
            y: { title: { display: true, text: definition.unit, color: "#a1a8b3" }, border: { display: false }, grid: { color: "#262c35" }, ticks: { color: "#a1a8b3", maxTicksLimit: 5, font: { size: 10 } } }
          }
        }
      }));
    }
    byId("data-note").textContent = notes.join(" ");
  }

  function demoData() {
    const rows = [];
    const now = Date.now();
    for (let index = 0; index < 48; index++) {
      const current = index >= 24;
      const base = {
        timestamp: formatJst(now - (47 - index) * 30 * 60000),
        node: "trap-01", sessionId: current ? "100" : "4000000000",
        event: index % 24 === 0 ? "BOOT" : "HEALTH_TIMER", sensor: "CLOSED",
        battery: Number((8.45 - (index % 24) * .013).toFixed(3)), batteryStatus: "NORMAL",
        temperature: Number((19 + Math.sin(index / 4) * 3).toFixed(1)), temperatureStatus: "NORMAL",
        messageId: index % 24 + 1, boot: index % 24 + 1, send: index % 24 + 1,
        wifiRssi: -31, loraRssi: index % 11 === 0 ? null : -84 - index % 9
      };
      rows.push(base);
      rows.push({
        ...base, timestamp: formatJst(now - (47 - index) * 30 * 60000 - 2 * 60000),
        node: "trap-02", sessionId: "2974510834",
        event: index === 0 ? "BOOT" : index === 28 ? "TRAP_OPEN" : "HEALTH_TIMER",
        sensor: index >= 28 ? "OPEN" : "CLOSED", battery: Number((8.35 - index * .012).toFixed(3)),
        temperature: Number((20 + Math.sin(index / 5) * 4).toFixed(1)),
        messageId: index + 1, boot: index + 1, send: index + 1, loraRssi: -94 - index % 7
      });
      if (index % 12 === 0 || index === 47) rows.push({
        ...base, timestamp: formatJst(now - (47 - index) * 30 * 60000 - 60000),
        node: "receiver-01", sessionId: current ? "700" : "900",
        event: index === 0 || index === 24 ? "RECEIVER_BOOT" : "RECEIVER_HEALTH",
        sensor: null, battery: null, batteryStatus: null, temperature: null, temperatureStatus: null,
        messageId: current ? index - 23 : index + 1, boot: 1, send: current ? index - 23 : index + 1,
        wifiRssi: -35, loraRssi: null
      });
    }
    return rows;
  }

  const configured = typeof config.GAS_READ_API_URL === "string" && config.GAS_READ_API_URL !== "YOUR_PUBLIC_GAS_READ_API_URL_HERE" && config.GAS_READ_API_URL.trim() !== "";

  async function refresh() {
    if (busy || (!demo && !configured)) return;
    busy = true;
    byId("refresh-button").setAttribute("aria-busy", "true");
    byId("refresh-button").disabled = true;
    byId("refresh-button").textContent = "更新中…";
    if (lastSuccess === null) byId("update-status").textContent = "取得中…";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    let phase = "configuration";
    try {
      let data;
      if (demo) data = demoData();
      else {
        const url = new URL(config.GAS_READ_API_URL);
        if (url.protocol !== "https:") throw new Error("API URLはhttpsで指定してください。");
        url.searchParams.set("action", "logs");
        url.searchParams.set("limit", String(config.MAX_LOGS));
        phase = "network";
        const response = await fetch(url.href, { signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "follow" });
        phase = "http";
        if (!response.ok) throw new Error(`API HTTP ${response.status}`);
        phase = "json";
        data = await response.json();
      }
      phase = "validation";
      const result = normalize(data);
      logs = result.rows;
      invalidRows = result.invalidRows;
      phase = "render";
      updateNodes();
      renderView();
      lastSuccess = Date.now();
      byId("update-error").hidden = true;
      byId("update-status").textContent = `最終更新 ${formatJst(lastSuccess).slice(11)}`;
    } catch (error) {
      const category = error?.name === "AbortError" ? "timeout" : phase;
      console.error(`[わなな] データ更新失敗 [${category}]`, error);
      byId("update-error").textContent = `データ更新失敗。${lastSuccess === null ? "まだデータを取得できていません。" : "前回のデータを表示しています。"}`;
      byId("update-error").hidden = false;
      byId("update-status").textContent = lastSuccess === null ? "未取得" : `最終更新 ${formatJst(lastSuccess).slice(11)}`;
      renderAlerts();
    } finally {
      window.clearTimeout(timeout);
      busy = false;
      byId("refresh-button").setAttribute("aria-busy", "false");
      byId("refresh-button").disabled = false;
      byId("refresh-button").textContent = "更新";
    }
  }

  function tick() {
    const now = Date.now();
    byId("current-clock").textContent = `${formatJst(now).slice(11)} JST`;
    byId("current-clock").dateTime = new Date(now).toISOString();
    renderNodeStates();
    renderAlerts();
  }

  byId("demo-notice").hidden = !demo;
  if (config.USE_DEMO_DATA) byId("demo-notice").querySelector("a").hidden = true;
  byId("setup-notice").hidden = demo || configured;
  byId("refresh-button").addEventListener("click", refresh);
  window.addEventListener("popstate", () => {
    const node = new URLSearchParams(window.location.search).get("node");
    if (firstSelection) return;
    selectNode(node);
  });
  renderNodeChips();
  renderView();
  tick();
  window.setInterval(tick, 1000);
  if (!demo && !configured) {
    byId("refresh-button").disabled = true;
    byId("update-status").textContent = "未接続";
  } else {
    refresh();
    window.setInterval(refresh, config.UPDATE_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }
})();
